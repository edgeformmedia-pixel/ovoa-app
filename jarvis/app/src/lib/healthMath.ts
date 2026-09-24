import type { SleepNight } from "./api";

// The arithmetic behind Apple Health sync (health.ts, healthSync.ts): nights of
// sleep, thinning a watch's heart rate, naming sources, whether reading is
// switched off and the sync's log line. Nothing here touches HealthKit or
// React Native, so it runs in node (api/test/healthMath.test.ts).

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local time `hour`:00 on `day` ("YYYY-MM-DD") moved by `addDays`. Built from parts, so a DST change lands right. */
export function localTime(day: string, addDays = 0, hour = 0) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + addDays, hour);
}

/** The last `count` local days up to `now`, oldest first. */
export function daysBack(count: number, now = new Date()) {
  const today = dayKey(now);
  return Array.from({ length: count }, (_, i) => dayKey(localTime(today, i - (count - 1))));
}

/** Every local day from `from` to `to`, both included, oldest first. */
export function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 400; day = dayKey(localTime(day, 1))) out.push(day);
  return out;
}

// ---------- Sleep ----------

/** One HKCategoryTypeIdentifierSleepAnalysis sample. value: 0 in bed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM. */
export type SleepSample = { start: number; end: number; value: number; source: string };

const ASLEEP = new Set([1, 3, 4, 5]);
const STAGES = { 2: "awake", 3: "core", 4: "deep", 5: "rem" } as const;

/** Minutes the spans cover, overlaps counted once. */
export function unionMinutes(spans: { start: number; end: number }[]) {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let open: { start: number; end: number } | null = null;
  for (const s of sorted) {
    if (open && s.start <= open.end) {
      open.end = Math.max(open.end, s.end);
      continue;
    }
    if (open) total += open.end - open.start;
    open = { ...s };
  }
  if (open) total += open.end - open.start;
  return Math.round(total / 60_000);
}

/** The samples that belong to `day`'s night: those that ended between 18:00 the evening before and 18:00 on the day. */
export function nightSamples(samples: SleepSample[], day: string) {
  const from = localTime(day, -1, 18).getTime();
  const to = localTime(day, 0, 18).getTime();
  return samples.filter((s) => s.end > from && s.end <= to);
}

/**
 * The night that belongs to `day` (nightSamples), so last night's sleep is
 * today's.
 *
 * Asleep time is the union of every source's asleep samples. It used to be
 * their sum, and a watch plus a sleep app both writing counted the night twice
 * (health.ts before 2026-09-23). "In bed" (value 0) is kept apart and never
 * called asleep: an iPhone with a Sleep schedule and no watch writes only that,
 * and it was thrown away, so those phones had no sleep at all. Stages come from
 * the one source that records them, the one with the most staged time, since
 * two sources' stages would overlap.
 */
export function sleepNight(samples: SleepSample[], day: string): SleepNight | null {
  const night = nightSamples(samples, day);
  const asleep = night.filter((s) => ASLEEP.has(s.value));
  const inBed = night.filter((s) => s.value === 0);
  const main = asleep.length ? asleep : inBed;
  if (!main.length) return null;

  const staged = new Map<string, SleepSample[]>();
  for (const s of night) if (s.value >= 3) staged.set(s.source, [...(staged.get(s.source) ?? []), s]);
  const stager = [...staged.entries()].sort((a, b) => unionMinutes(b[1]) - unionMinutes(a[1]))[0]?.[0];
  const stages: NonNullable<SleepNight["stages"]> = {};
  if (stager !== undefined) {
    for (const [value, name] of Object.entries(STAGES)) {
      const min = unionMinutes(night.filter((s) => s.source === stager && s.value === Number(value)));
      if (min) stages[name] = min;
    }
  }

  const inBedMin = unionMinutes(inBed);
  return {
    asleepMin: unionMinutes(asleep),
    ...(inBedMin > 0 && { inBedMin }),
    start: Math.min(...main.map((s) => s.start)),
    end: Math.max(...main.map((s) => s.end)),
    ...(Object.keys(stages).length > 0 && { stages }),
    source: [...new Set(main.map((s) => s.source))].join(" and "),
  };
}

// ---------- Heart rate ----------

/**
 * Oldest first, at most one reading per `gapMs`. A watch writes one every few
 * seconds through a workout; the server's graph and workout finder work in
 * minutes, and every row is a D1 write.
 */
export function thinReadings<T extends { ts: number }>(readings: T[], gapMs: number): T[] {
  const out: T[] = [];
  for (const r of [...readings].sort((a, b) => a.ts - b.ts)) {
    if (!out.length || r.ts - out[out.length - 1].ts >= gapMs) out.push(r);
  }
  return out;
}

// ---------- Sources ----------

/**
 * Where a sample came from, in words that name no one. Apple's own devices are
 * named after their owner ("Tom's Apple Watch") and these go to the server and
 * the log, so they're said by kind; an app is its own name ("AutoSleep").
 * productType ("Watch6,1") is on samples, not on statistics, so it's optional.
 */
export function sourceLabel(source: { name: string; bundleIdentifier: string }, productType?: string) {
  if (!/^com\.apple\.health(\.|$)/.test(source.bundleIdentifier)) return source.name;
  if (productType?.startsWith("Watch") || /watch/i.test(source.name)) return "Apple Watch";
  if (productType?.startsWith("iPhone") || /iphone/i.test(source.name)) return "iPhone";
  return "an Apple device";
}

// ---------- Can Health be read? ----------

/**
 * What reading Apple Health comes to. iOS never says whether reading was
 * allowed (that would itself leak what's there), so it's inferred.
 * unknown: no sync has looked yet. not_asked: the Health sheet hasn't been
 * shown. ok: something other than OVOA gave Health a reading. off: nothing
 * came back while the iPhone's own step counter has steps today, and the
 * iPhone always writes its steps to Health, so reading is switched off.
 * empty: nothing came back and there's nothing to say why.
 */
export type HealthReads = "unknown" | "not_asked" | "ok" | "off" | "empty";

/** `sources`: how many sources other than OVOA answered (OVOA can always read back what it wrote). */
export function readsVerdict(sources: number, phoneStepsToday: number | null): "ok" | "off" | "empty" {
  if (sources > 0) return "ok";
  return (phoneStepsToday ?? 0) > 200 ? "off" : "empty";
}

/**
 * The health sync's line for device_logs (healthSync.ts), written to say from
 * outside the app whether Health can be read at all (switched off and "no
 * watch" look the same from inside) and what writes to it.
 *
 * `key` is the facts the line states, and a sync writes the line only when
 * they change, plus once a launch; the counts ride in its detail. A release
 * build uploads the line, a warning as any warning is and the rest as a
 * milestone (remoteLog.ts MILESTONES, /^health sync: /), and one per sync would
 * be 96 rows a phone a day saying the same thing (2026-09-23). Sources are
 * sorted for the key, since Health doesn't give them in a fixed order.
 *
 * `problem`, which makes the line a warning: Health gave nothing at all, which
 * over days the iPhone wrote its own steps to means reading is switched off, or
 * an Apple Watch writes but none of its heart rate comes through, which means
 * heart rate's own switch is.
 */
export function syncReport(f: {
  reads: "ok" | "off" | "empty";
  phoneStepsToday: number | null;
  sources: { any: string[]; heart: string[]; sleep: string[]; steps: string[] };
  writeHeart: "on" | "off" | "not_asked";
  needsPrompt: boolean;
  /** No AI consent: the days go up as steps only. */
  stepsOnly: boolean;
}) {
  const sorted = (names: string[]) => [...new Set(names)].sort();
  const list = (names: string[]) => (names.length ? names.join(", ") : "none");
  const heart = sorted(f.sources.heart);
  const sleep = sorted(f.sources.sleep);
  const steps = sorted(f.sources.steps);
  const heartOff = !heart.length && f.sources.any.includes("Apple Watch");
  const reads =
    f.reads === "off"
      ? `reads OFF (Health gave nothing while the iPhone counted ${f.phoneStepsToday} steps today)`
      : f.reads === "empty"
        ? "reads empty (Health gave nothing, and no iPhone step count to compare)"
        : "reads ok";
  const text = [
    reads,
    `heart rate from ${list(heart)}${heartOff ? " (though an Apple Watch writes other numbers: reading heart rate looks switched off)" : ""}`,
    `sleep from ${list(sleep)}`,
    `steps from ${list(steps)}`,
    `saving the Band's heart rate to Health: ${f.writeHeart.replace("_", " ")}`,
    ...(f.needsPrompt ? ["the Health sheet has more to ask"] : []),
    ...(f.stepsOnly ? ["days sent as steps only (no AI consent)"] : []),
  ].join(" · ");
  return {
    text,
    key: JSON.stringify([f.reads, heart, heartOff, sleep, steps, f.writeHeart, f.needsPrompt, f.stepsOnly]),
    problem: f.reads !== "ok" || heartOff,
  };
}

// ---------- What's changed since the last sync ----------

/** A short fingerprint of a value (FNV-1a over its JSON). */
export function hashOf(value: unknown) {
  const s = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The days whose numbers differ from what was last sent, and the fingerprints
 * to keep once they're sent. Fingerprints of days before `keepFrom` are
 * dropped, so what's stored stays a few hundred bytes (it lives in the
 * keychain, lib/storage.ts).
 */
export function changedDays<T extends { day: string }>(days: T[], sent: Record<string, string>, keepFrom: string) {
  const next: Record<string, string> = {};
  for (const [day, hash] of Object.entries(sent)) if (day >= keepFrom) next[day] = hash;
  const changed = days.filter((d) => {
    const hash = hashOf(d);
    if (next[d.day] === hash) return false;
    next[d.day] = hash;
    return true;
  });
  return { changed, next };
}
