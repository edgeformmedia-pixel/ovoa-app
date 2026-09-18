import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * OVOA "Running late" demo: an iPhone playing an iMessage conversation with
 * OVOA, voiced by the clips in `audioBase`. Self-contained — no Tailwind or
 * other dependencies beyond React.
 *
 *   <OvoaIphoneDemo />                       // clips at /audio/*.mp3
 *   <OvoaIphoneDemo audioBase="/voice/" maxWidth={320} />
 *
 * It starts when scrolled into view and loops, with sound on. Browsers only
 * allow audio once the visitor has interacted with the site, so until then it
 * plays silently and the voice joins in sync on their first click, tap or key
 * press anywhere on the page (or on "Play with sound").
 */

type Who = "me" | "ovoa";

interface Step {
  who: Who;
  text: string;
  /** Seconds after the previous message lands before this one starts. */
  wait: number;
  /** Seconds of typing (me) or of the typing indicator (OVOA). */
  dur: number;
  clip: string;
  /** Clip length in seconds, so the timeline is known before audio loads. */
  clipLen: number;
  /** Voice starts with the typing ("begin") or when the bubble appears ("lands"). */
  anchor: "begin" | "lands";
}

const STEPS: Step[] = [
  {
    who: "me", wait: 0, dur: 10.8, clip: "rachel1.mp3", clipLen: 10.815, anchor: "begin",
    text: "Hey OVOA, I’m going to be late. Let everyone on my 3 PM meeting know I’ll be about 15 minutes late, draft an apology, and move the meeting if there’s an opening later today.",
  },
  {
    who: "ovoa", wait: 0.8, dur: 2.5, clip: "ovoa1.mp3", clipLen: 4.545, anchor: "lands",
    text: "I can handle that. I found an opening at 4:30. Want me to move it?",
  },
  { who: "me", wait: 5.15, dur: 0.85, clip: "rachel2.mp3", clipLen: 0.836, anchor: "begin", text: "yes" },
  {
    who: "ovoa", wait: 0.6, dur: 1.8, clip: "ovoa2.mp3", clipLen: 1.985, anchor: "lands",
    text: "Done. Everyone’s been updated.",
  },
  {
    who: "me", wait: 2.6, dur: 2.2, clip: "rachel3.mp3", clipLen: 2.22, anchor: "begin",
    text: "Thanks, now make it an auto shortcut",
  },
  {
    who: "ovoa", wait: 0.8, dur: 2.5, clip: "ovoa3.mp3", clipLen: 10.266, anchor: "lands",
    text: "Done. Next time you’re running behind getting to the office at 123 Main Street, I’ll find the next available opening, notify the attendees, and handle the emails for you.",
  },
];

/** Playback gain per speaker; Rachel's recordings are much quieter than OVOA's. */
const VOICE_GAIN: Record<Who, number> = { me: 1.5, ovoa: 1 };

const START_DELAY = 1;
const LOOP_HOLD = 4;
const SEND_ANIM = 0.42;
const POP_ANIM = 0.14;

// Absolute times (seconds) for every beat of the script.
const TIMELINE = (() => {
  let t = START_DELAY;
  let end = 0;
  const rows = STEPS.map((s) => {
    const begin = t + s.wait;
    const typed = begin + s.dur;
    const lands = typed + (s.who === "me" ? SEND_ANIM : POP_ANIM);
    const voice = s.anchor === "lands" ? lands : begin;
    end = Math.max(end, voice + s.clipLen);
    t = lands;
    return { begin, typed, lands, voice, voiceEnd: voice + s.clipLen };
  });
  return { rows, total: Math.max(t, end) };
})();

type Island = "idle" | "listening" | "thinking" | "speaking";

/** What the Dynamic Island shows at a given moment. */
function islandAt(sec: number): Island {
  for (let i = 0; i < STEPS.length; i++) {
    const r = TIMELINE.rows[i];
    if (STEPS[i].who === "me") {
      if (sec >= r.begin && sec < Math.max(r.lands, r.voiceEnd)) return "listening";
    } else {
      if (sec >= r.begin && sec < r.lands) return "thinking";
      if (sec >= r.voice && sec < r.voiceEnd) return "speaking";
    }
  }
  return "idle";
}

interface Msg {
  id: number;
  who: Who;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

interface AudioRig {
  ctx: AudioContext;
  buffers: Map<string, AudioBuffer>;
  nodes: AudioBufferSourceNode[];
}

async function fetchClips(rig: AudioRig, base: string): Promise<AudioRig> {
  await Promise.all(
    STEPS.map(async (s) => {
      try {
        const res = await fetch(base + s.clip);
        if (!res.ok) throw new Error(String(res.status));
        rig.buffers.set(s.clip, await rig.ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (err) {
        console.warn(`OvoaIphoneDemo: could not load ${base}${s.clip}`, err);
      }
    }),
  );
  return rig;
}

export interface OvoaIphoneDemoProps {
  /** Folder the clips are served from, with trailing slash. */
  audioBase?: string;
  /** The phone scales down to fit its container, up to this width in px. */
  maxWidth?: number;
  /** Show the sound button under the phone. */
  showControls?: boolean;
  /** Start with sound on (subject to the browser's autoplay rules). */
  defaultSound?: boolean;
  dark?: boolean;
  className?: string;
}

// Design size of the device; everything inside is laid out at this size and scaled.
const DEVICE_W = 422;
const DEVICE_H = 876;

export default function OvoaIphoneDemo({
  audioBase = "/audio/",
  maxWidth = 360,
  showControls = true,
  defaultSound = true,
  dark = false,
  className,
}: OvoaIphoneDemoProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(maxWidth / DEVICE_W);

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [receipt, setReceipt] = useState<"Delivered" | "Read" | null>(null);
  const [island, setIsland] = useState<Island>("idle");
  const [inView, setInView] = useState(false);
  const [soundOn, setSoundOn] = useState(defaultSound);
  /** Sound is wanted but the browser hasn't allowed audio yet. */
  const [blocked, setBlocked] = useState(defaultSound);

  const t0 = useRef(0);
  const audio = useRef<AudioRig | null>(null);
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;
  const inViewRef = useRef(inView);
  inViewRef.current = inView;

  /* ---------- Fit to container ---------- */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(el.clientWidth || maxWidth, maxWidth) / DEVICE_W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  /* ---------- Only run while visible ---------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* ---------- Voice ---------- */
  const stopVoice = useCallback(() => {
    const a = audio.current;
    if (!a) return;
    a.nodes.forEach((n) => {
      try { n.stop(); } catch { /* already stopped */ }
    });
    a.nodes = [];
  }, []);

  /** Schedules every clip that is still to come, relative to the script clock. */
  const startVoice = useCallback(() => {
    const a = audio.current;
    if (!a || a.ctx.state !== "running" || !soundRef.current || !inViewRef.current) return;
    stopVoice();
    const now = (performance.now() - t0.current) / 1000;
    STEPS.forEach((s, i) => {
      const r = TIMELINE.rows[i];
      const buf = a.buffers.get(s.clip);
      if (!buf || r.voiceEnd <= now) return;
      const src = a.ctx.createBufferSource();
      src.buffer = buf;
      const gain = a.ctx.createGain();
      gain.gain.value = VOICE_GAIN[s.who];
      src.connect(gain).connect(a.ctx.destination);
      const into = Math.max(0, now - r.voice);
      src.start(a.ctx.currentTime + Math.max(0, r.voice - now), into);
      a.nodes.push(src);
    });
  }, [stopVoice]);

  // One shared load. Whenever the browser lets the context run, the voice
  // joins the conversation wherever it currently is.
  const loading = useRef<Promise<AudioRig> | null>(null);
  const loadAudio = useCallback(() => {
    if (!loading.current) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const rig: AudioRig = { ctx: new Ctx(), buffers: new Map(), nodes: [] };
      audio.current = rig;
      rig.ctx.onstatechange = () => {
        setBlocked(rig.ctx.state !== "running");
        if (rig.ctx.state === "running") startVoice();
      };
      setBlocked(rig.ctx.state !== "running");
      loading.current = fetchClips(rig, audioBase).then((r) => {
        startVoice();
        return r;
      });
    }
    return loading.current;
  }, [audioBase, startVoice]);

  // Sound on by default: try to start straight away. Browsers only allow audio
  // after the visitor has interacted with the site, so if it's refused, the
  // first click, tap or key press anywhere on the page unlocks it.
  useEffect(() => {
    if (!soundOn) return;
    void loadAudio();
    const unlock = () => { void audio.current?.ctx.resume(); };
    unlock();
    const events = ["pointerdown", "touchend", "keydown"] as const;
    events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, unlock, { capture: true }));
  }, [soundOn, loadAudio]);

  const toggleSound = () => {
    const ctx = audio.current?.ctx;
    // Wanted but blocked: this click is the permission, so unlock rather than mute.
    if (soundOn && ctx && ctx.state !== "running") {
      void ctx.resume();
      return;
    }
    if (soundOn) {
      setSoundOn(false);
      stopVoice();
      return;
    }
    soundRef.current = true;
    setSoundOn(true);
    void loadAudio();
    void audio.current?.ctx.resume();
    startVoice();
  };

  /* ---------- Script ---------- */
  useEffect(() => {
    if (!inView) return;
    let alive = true;
    let nextId = 0;
    const until = (sec: number) => sleep(t0.current + sec * 1000 - performance.now());

    const tick = window.setInterval(() => {
      setIsland(islandAt((performance.now() - t0.current) / 1000));
    }, 100);

    (async () => {
      while (alive) {
        setMsgs([]);
        setDraft("");
        setTyping(false);
        setReceipt(null);
        t0.current = performance.now();
        if (soundRef.current) startVoice();

        for (let i = 0; i < STEPS.length && alive; i++) {
          const s = STEPS[i];
          const r = TIMELINE.rows[i];

          if (s.who === "me") {
            await until(r.begin);
            const chars = Array.from(s.text);
            const per = s.dur / chars.length;
            for (let c = 0; c < chars.length && alive; c++) {
              const jitter = c < chars.length - 1 ? (Math.random() - 0.5) * per * 0.8 : 0;
              await until(r.begin + per * (c + 1) + jitter);
              setDraft(chars.slice(0, c + 1).join(""));
            }
            await until(r.typed);
            if (!alive) break;
            setDraft("");
            setReceipt(null);
            setMsgs((m) => [...m, { id: nextId++, who: "me", text: s.text }]);
            await until(r.lands);
            if (alive) setReceipt("Delivered");
          } else {
            // "Read" shows partway through the pause, as if OVOA opened it.
            await until(r.begin - s.wait * 0.5);
            if (alive) setReceipt("Read");
            await until(r.begin);
            if (alive) setTyping(true);
            await until(r.typed);
            if (alive) setTyping(false);
            await until(r.lands);
            if (!alive) break;
            setReceipt(null);
            setMsgs((m) => [...m, { id: nextId++, who: "ovoa", text: s.text }]);
          }
        }
        await until(TIMELINE.total + LOOP_HOLD);
      }
    })();

    return () => {
      alive = false;
      window.clearInterval(tick);
      stopVoice();
      setIsland("idle");
    };
  }, [inView, startVoice, stopVoice]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, typing, receipt]);

  useEffect(() => () => {
    stopVoice();
    void audio.current?.ctx.close();
    // Cleared so a remount (e.g. React StrictMode) builds a fresh context.
    audio.current = null;
    loading.current = null;
  }, [stopVoice]);

  /* ---------- Render ---------- */
  const expanded = island !== "idle";
  const audible = soundOn && !blocked;
  const lastIndex = msgs.length - 1;

  return (
    <div
      ref={rootRef}
      className={`ovp-root${dark ? " ovp-dark" : ""}${className ? " " + className : ""}`}
      style={{ maxWidth }}
    >
      <style>{CSS}</style>
      <div className="ovp-slot" style={{ height: DEVICE_H * scale }}>
        <div
          className="ovp-device"
          style={{ transform: `scale(${scale})` }}
          role="img"
          aria-label="iPhone showing a text conversation with OVOA rescheduling a meeting"
        >
          <span className="ovp-btn ovp-action" />
          <span className="ovp-btn ovp-volup" />
          <span className="ovp-btn ovp-voldown" />
          <span className="ovp-btn ovp-power" />

          <div className="ovp-bezel">
            <div className="ovp-screen">
              {/* Dynamic Island */}
              <div className={`ovp-island ovp-island-${island}${expanded ? " ovp-island-open" : ""}`}>
                <span className="ovp-island-glyph" />
                <span className="ovp-island-label">
                  {island === "listening" ? "Listening" : island === "thinking" ? "Working" : island === "speaking" ? "OVOA" : ""}
                </span>
                <span className="ovp-island-viz">
                  {island === "thinking" ? (
                    <span className="ovp-spin" />
                  ) : (
                    [0, 1, 2, 3, 4].map((b) => <i key={b} style={{ animationDelay: `${b * 0.11}s` }} />)
                  )}
                </span>
                <span className="ovp-lens" />
              </div>

              {/* Status bar */}
              <div className="ovp-status">
                <span>9:41</span>
                <span className="ovp-status-icons">
                  <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></svg>
                  <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.3c2.3 0 4.4.9 6 2.4l1.1-1.2A10.3 10.3 0 0 0 8 .6C5.3.6 2.8 1.6.9 3.5L2 4.7a8.6 8.6 0 0 1 6-2.4Zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.2-1.2A6.8 6.8 0 0 0 8 4a6.8 6.8 0 0 0-4.8 1.9l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.4c-.5 0-1 .2-1.3.5L8 11l1.3-1.4A1.9 1.9 0 0 0 8 9.1Z" /></svg>
                  <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="22" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4" /><rect x="2" y="2" width="17" height="9" rx="2" fill="currentColor" /><path d="M24 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2Z" fill="currentColor" opacity=".45" /></svg>
                </span>
              </div>

              {/* Conversation header */}
              <div className="ovp-nav">
                <span className="ovp-back">
                  <svg width="13" height="21" viewBox="0 0 13 21"><path d="M11 2 2.5 10.5 11 19" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span className="ovp-badge">3</span>
                </span>
                <div className="ovp-contact">
                  <span className="ovp-avatar" />
                  <span className="ovp-name">OVOA <span>›</span></span>
                </div>
                <span className="ovp-video">
                  <svg width="28" height="18" viewBox="0 0 28 18" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="1" y="1.5" width="18" height="15" rx="4" /><path d="m19 7 7-4v12l-7-4" strokeLinejoin="round" /></svg>
                </span>
              </div>

              {/* Thread */}
              <div className="ovp-thread" ref={threadRef}>
                <div className="ovp-stamp"><b>iMessage</b><br />Today 9:41 AM</div>
                {msgs.map((m, i) => {
                  const next = msgs[i + 1];
                  const tail = !next || next.who !== m.who;
                  const newRun = i === 0 || msgs[i - 1].who !== m.who;
                  return (
                    <div key={m.id} className={`ovp-row ovp-${m.who}${newRun ? " ovp-gap" : ""}`}>
                      <div className={`ovp-msg${tail ? " ovp-tail" : ""} ${m.who === "me" ? "ovp-send" : "ovp-pop"}`}>
                        {m.text}
                      </div>
                    </div>
                  );
                })}
                {receipt && msgs[lastIndex]?.who === "me" && (
                  <div className="ovp-receipt"><b>{receipt}</b>{receipt === "Read" ? " 9:41 AM" : ""}</div>
                )}
                {typing && (
                  <div className="ovp-row ovp-ovoa ovp-gap">
                    <div className="ovp-typing"><i /><i /><i /></div>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="ovp-composer">
                <span className="ovp-plus">
                  <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                </span>
                <div className="ovp-field">
                  <div className="ovp-draft">
                    {draft ? (
                      <span>{draft}<span className="ovp-caret" /></span>
                    ) : (
                      <span className="ovp-placeholder">iMessage</span>
                    )}
                  </div>
                  {draft ? (
                    <span className="ovp-sendbtn">
                      <svg width="14" height="16" viewBox="0 0 14 16"><path d="M7 14V2M1.5 7.5 7 2l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </span>
                  ) : (
                    <span className="ovp-mic">
                      <svg width="14" height="20" viewBox="0 0 14 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3.5" y="1" width="7" height="12" rx="3.5" /><path d="M1 9.5a6 6 0 0 0 12 0M7 15.5V19" /></svg>
                    </span>
                  )}
                </div>
              </div>
              <span className="ovp-home" />
            </div>
          </div>
        </div>
      </div>

      {showControls && (
        <div className="ovp-controls">
          <button type="button" onClick={toggleSound} aria-pressed={audible}>
            {audible ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></svg>
            )}
            {audible ? "Sound on" : "Play with sound"}
          </button>
        </div>
      )}
    </div>
  );
}

const CSS = `
.ovp-root {
  --ovp-screen: #ffffff;
  --ovp-ink: #000000;
  --ovp-chrome: rgba(249, 249, 249, 0.88);
  --ovp-line: rgba(0, 0, 0, 0.14);
  --ovp-blue: #0a84ff;
  --ovp-in: #e9e9eb;
  --ovp-meta: #8e8e93;
  --ovp-field: #c7c7cc;
  width: 100%;
  margin: 0 auto;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.ovp-root.ovp-dark {
  --ovp-screen: #000000;
  --ovp-ink: #ffffff;
  --ovp-chrome: rgba(22, 22, 24, 0.88);
  --ovp-line: rgba(255, 255, 255, 0.12);
  --ovp-in: #262629;
  --ovp-meta: #8d8d93;
  --ovp-field: #3a3a3c;
}
.ovp-root *, .ovp-root *::before, .ovp-root *::after { box-sizing: border-box; }
.ovp-slot { position: relative; width: 100%; }
.ovp-slot > .ovp-device { position: absolute; left: 50%; top: 0; margin-left: -${DEVICE_W / 2}px; transform-origin: top center; }

/* ----- Device: titanium frame, black bezel, side buttons ----- */
.ovp-device {
  width: ${DEVICE_W}px; height: ${DEVICE_H}px;
  border-radius: 72px;
  padding: 5px;
  background:
    linear-gradient(145deg, #6e6e73 0%, #2c2c2f 18%, #1b1b1d 40%, #3b3b3f 62%, #1e1e21 82%, #75757a 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.22),
    inset 0 0 3px 2px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(0, 0, 0, 0.55),
    0 60px 90px -30px rgba(10, 20, 40, 0.45),
    0 30px 50px -25px rgba(0, 0, 0, 0.5);
}
.ovp-btn {
  position: absolute; width: 5px; border-radius: 2px;
  background: linear-gradient(90deg, #1c1c1e, #5d5d62 45%, #2a2a2d);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.6);
}
.ovp-action  { left: -3px; top: 176px; height: 34px; }
.ovp-volup   { left: -3px; top: 240px; height: 64px; }
.ovp-voldown { left: -3px; top: 318px; height: 64px; }
.ovp-power   { right: -3px; top: 270px; height: 102px; }
.ovp-bezel {
  width: 100%; height: 100%;
  border-radius: 67px;
  padding: 11px;
  background: #000;
  box-shadow: inset 0 0 0 1.5px #1a1a1a;
}
.ovp-screen {
  position: relative; width: 100%; height: 100%;
  border-radius: 56px; overflow: hidden;
  background: var(--ovp-screen); color: var(--ovp-ink);
  display: flex; flex-direction: column;
  isolation: isolate;
}
.ovp-screen::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 40;
  background: linear-gradient(118deg, rgba(255, 255, 255, 0.07) 0%, rgba(255, 255, 255, 0) 38%);
}

/* ----- Dynamic Island ----- */
.ovp-island {
  position: absolute; top: 11px; left: 50%; z-index: 30;
  width: 124px; height: 36px; margin-left: -62px;
  border-radius: 20px; background: #000;
  display: flex; align-items: center; gap: 8px; padding: 0 10px;
  overflow: hidden;
  transition: width .55s cubic-bezier(.3, 1.35, .5, 1), margin-left .55s cubic-bezier(.3, 1.35, .5, 1);
}
/* Stays clear of the clock and the status icons on either side. */
.ovp-island-open { width: 184px; margin-left: -92px; }
.ovp-lens {
  position: absolute; right: 22px; top: 50%; width: 11px; height: 11px; margin-top: -5.5px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #2d3b58 0%, #0b1020 55%, #05070d 100%);
  box-shadow: inset 0 0 0 1.5px #10131a;
  transition: opacity .2s;
}
.ovp-island-open .ovp-lens { opacity: 0; }
.ovp-island-glyph, .ovp-island-label, .ovp-island-viz { opacity: 0; transition: opacity .25s ease .15s; }
.ovp-island-open .ovp-island-glyph,
.ovp-island-open .ovp-island-label,
.ovp-island-open .ovp-island-viz { opacity: 1; }
.ovp-island-glyph {
  flex: none; width: 20px; height: 20px; border-radius: 50%;
  border: 2.5px solid #fff; box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.14);
}
.ovp-island-label { flex: 1; color: #fff; font-size: 12px; font-weight: 600; white-space: nowrap; }
.ovp-island-viz { flex: none; display: flex; align-items: center; gap: 2.5px; height: 18px; }
.ovp-island-viz i {
  width: 3px; height: 16px; border-radius: 2px; background: #30d158;
  transform: scaleY(.3); animation: ovp-bar .9s ease-in-out infinite;
}
.ovp-island-listening .ovp-island-viz i { background: #0a84ff; }
@keyframes ovp-bar { 0%, 100% { transform: scaleY(.25); } 50% { transform: scaleY(1); } }
.ovp-spin {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, 0.2); border-top-color: #fff;
  animation: ovp-spin .8s linear infinite;
}
@keyframes ovp-spin { to { transform: rotate(360deg); } }

/* ----- Status bar + header ----- */
.ovp-status {
  position: absolute; top: 0; left: 0; right: 0; height: 56px; z-index: 20;
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 32px 0 50px; font-size: 17px; font-weight: 600;
}
.ovp-status-icons { display: flex; align-items: center; gap: 6px; }
.ovp-status-icons svg { display: block; }
.ovp-nav {
  position: absolute; top: 0; left: 0; right: 0; z-index: 10;
  height: 148px; padding-top: 56px;
  background: var(--ovp-chrome);
  -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 0.5px solid var(--ovp-line);
  display: flex; justify-content: center;
}
.ovp-back { position: absolute; left: 10px; top: 66px; display: flex; align-items: center; gap: 3px; color: var(--ovp-blue); }
.ovp-badge {
  background: var(--ovp-blue); color: #fff; font-size: 13px; font-weight: 600;
  min-width: 22px; height: 22px; line-height: 22px; border-radius: 11px; padding: 0 7px; text-align: center;
}
.ovp-video { position: absolute; right: 18px; top: 68px; color: var(--ovp-blue); }
.ovp-contact { display: flex; flex-direction: column; align-items: center; padding-top: 4px; }
.ovp-avatar {
  width: 56px; height: 56px; border-radius: 50%;
  background: linear-gradient(160deg, #3b3b40, #0c0c0e);
  display: grid; place-items: center;
}
.ovp-avatar::after {
  content: ""; width: 22px; height: 22px; border-radius: 50%;
  border: 3px solid #fff; box-shadow: 0 0 0 5px rgba(255, 255, 255, 0.12);
}
.ovp-name {
  margin-top: 6px; font-size: 12px; border-radius: 11px; padding: 2px 8px 2px 10px;
  background: var(--ovp-in);
}
.ovp-name span { color: var(--ovp-meta); }

/* ----- Thread ----- */
.ovp-thread {
  flex: 1; overflow: hidden;
  padding: 160px 16px 10px;
  display: flex; flex-direction: column;
}
.ovp-thread > :first-child { margin-top: auto; }
.ovp-stamp { text-align: center; color: var(--ovp-meta); font-size: 11px; margin: 10px 0 6px; }
.ovp-stamp b { font-weight: 600; }
.ovp-row { display: flex; margin-top: 2px; }
.ovp-row.ovp-gap { margin-top: 12px; }
.ovp-row.ovp-me { justify-content: flex-end; }
.ovp-msg {
  position: relative; max-width: 76%;
  padding: 7px 13px 8px; border-radius: 19px;
  font-size: 16.5px; line-height: 1.3; white-space: pre-wrap; overflow-wrap: anywhere;
}
.ovp-me .ovp-msg { background: var(--ovp-blue); color: #fff; transform-origin: bottom right; }
.ovp-ovoa .ovp-msg { background: var(--ovp-in); color: var(--ovp-ink); transform-origin: bottom left; }
.ovp-msg.ovp-tail::before, .ovp-msg.ovp-tail::after { content: ""; position: absolute; bottom: 0; height: 20px; }
.ovp-me .ovp-tail::before { right: -7px; width: 20px; background: var(--ovp-blue); border-bottom-left-radius: 16px 14px; }
.ovp-me .ovp-tail::after { right: -26px; width: 26px; background: var(--ovp-screen); border-bottom-left-radius: 10px; }
.ovp-ovoa .ovp-tail::before { left: -7px; width: 20px; background: var(--ovp-in); border-bottom-right-radius: 16px 14px; }
.ovp-ovoa .ovp-tail::after { left: -26px; width: 26px; background: var(--ovp-screen); border-bottom-right-radius: 10px; }
.ovp-send { animation: ovp-send .42s cubic-bezier(.2, .8, .25, 1) both; }
.ovp-pop { animation: ovp-pop .36s cubic-bezier(.3, .7, .4, 1) both; }
@keyframes ovp-send {
  0% { transform: translateY(70px) scale(.86); opacity: .5; }
  75% { transform: translateY(-5px) scale(1); opacity: 1; }
  100% { transform: none; opacity: 1; }
}
@keyframes ovp-pop {
  0% { transform: scale(.55) translateY(10px); opacity: 0; }
  60% { transform: scale(1.04); opacity: 1; }
  100% { transform: none; opacity: 1; }
}
.ovp-receipt { text-align: right; font-size: 11px; color: var(--ovp-meta); margin: 3px 4px 0 0; animation: ovp-fade .25s ease both; }
.ovp-receipt b { font-weight: 600; }
@keyframes ovp-fade { from { opacity: 0; } to { opacity: 1; } }
.ovp-typing {
  position: relative; display: flex; gap: 5px; margin-left: 2px;
  padding: 12px 14px; border-radius: 19px; background: var(--ovp-in);
  transform-origin: bottom left; animation: ovp-pop .3s ease-out both;
}
.ovp-typing::before, .ovp-typing::after { content: ""; position: absolute; border-radius: 50%; background: var(--ovp-in); }
.ovp-typing::before { width: 11px; height: 11px; left: -2px; bottom: -2px; }
.ovp-typing::after { width: 5px; height: 5px; left: -7px; bottom: -7px; }
.ovp-typing i { width: 8px; height: 8px; border-radius: 50%; background: var(--ovp-meta); animation: ovp-blink 1.3s infinite ease-in-out; }
.ovp-typing i:nth-child(2) { animation-delay: .18s; }
.ovp-typing i:nth-child(3) { animation-delay: .36s; }
@keyframes ovp-blink { 0%, 60%, 100% { opacity: .35; transform: none; } 30% { opacity: 1; transform: translateY(-3px); } }

/* ----- Composer ----- */
.ovp-composer {
  flex: none; display: flex; align-items: flex-end; gap: 8px;
  padding: 8px 12px 40px; background: var(--ovp-screen);
}
.ovp-plus {
  flex: none; width: 36px; height: 36px; border-radius: 50%;
  display: grid; place-items: center; background: var(--ovp-in); color: var(--ovp-meta);
}
.ovp-field {
  flex: 1; min-height: 36px; display: flex; align-items: flex-end;
  border: 1px solid var(--ovp-field); border-radius: 18px; padding: 0 3px 0 13px;
}
.ovp-draft {
  flex: 1; max-height: 112px; overflow: hidden; padding: 6px 0;
  display: flex; flex-direction: column; justify-content: flex-end;
  font-size: 16.5px; line-height: 21px;
}
.ovp-placeholder { color: var(--ovp-meta); }
.ovp-caret {
  display: inline-block; width: 2px; height: 19px; margin-left: 1px; vertical-align: -3px;
  background: var(--ovp-blue); animation: ovp-caret 1s steps(1) infinite;
}
@keyframes ovp-caret { 50% { opacity: 0; } }
.ovp-sendbtn {
  flex: none; width: 28px; height: 28px; margin: 3px 0; border-radius: 50%;
  display: grid; place-items: center; background: var(--ovp-blue); color: #fff;
  animation: ovp-grow .22s cubic-bezier(.3, 1.6, .5, 1) both;
}
@keyframes ovp-grow { from { transform: scale(0); } to { transform: scale(1); } }
.ovp-mic { flex: none; width: 28px; height: 34px; display: grid; place-items: center; color: var(--ovp-meta); }
.ovp-home {
  position: absolute; bottom: 9px; left: 50%; width: 140px; height: 5px; margin-left: -70px;
  border-radius: 3px; background: var(--ovp-ink); z-index: 5;
}

/* ----- Controls under the phone ----- */
.ovp-controls { display: flex; justify-content: center; gap: 10px; margin-top: 20px; }
.ovp-controls button {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: inherit; font-size: 14px; font-weight: 500; line-height: 1;
  padding: 9px 16px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(127, 127, 127, 0.3); background: rgba(127, 127, 127, 0.08); color: inherit;
  transition: background .15s, border-color .15s;
}
.ovp-controls button:hover { background: rgba(127, 127, 127, 0.16); }
.ovp-controls button[aria-pressed="true"] { border-color: #0a84ff; color: #0a84ff; }

@media (prefers-reduced-motion: reduce) {
  .ovp-root *, .ovp-root *::before, .ovp-root *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
