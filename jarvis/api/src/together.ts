import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { say } from "./obs";
import { reach } from "./reach";
import { BUILDS_PER_DAY, freePath, MAX_SITES, pathProblem, queueBuild, siteLink, slugify } from "./sites";
import { inSlice, type Slice } from "./sweep";
import { localMinutes } from "./time";
import type { Env } from "./types";
import { suggestUsername } from "./usernames";

// "Made something for you two" (2026-09-26, docs/instinct-more.md).
//
// "Make a game for me and my girlfriend": OVOA works out who that is (the people
// it knows, what it remembers, and who their OVOA is connected to), has the
// sites lane build a small two-player game (sites.ts, kind 'game', the one kind
// of page that runs script, in its own sandbox), texts them the link, and hands
// it to the other person's OVOA through their connection (network.ts share, with
// that connection's limits), whose OVOA texts it to them. Someone not on OVOA:
// the link is theirs to forward. The send to the other OVOA happens because the
// owner asked for it in their own turn; a background run can't call game_make
// (commands.ts FORBIDDEN_FOR_COMMANDS, and it isn't in agent.ts READ_ALONE).
//
// Now and then OVOA offers to make one (togetherTick): only to someone who texts
// OVOA, is connected to a partner's OVOA, at most once a month, in the early
// evening, as a text sent first (reach.ts: a news text, so paced and capped).

/** Words for the people a game is for, as said. */
const RELATIONS = [
  "girlfriend", "boyfriend", "partner", "wife", "husband", "fiancee", "fiance", "spouse", "gf", "bf",
  "best friend", "bestie", "mom", "mum", "mother", "dad", "father", "sister", "brother", "son", "daughter", "roommate", "friend",
];
/** Of those, the ones an occasional game idea is offered for. */
const COUPLE = new Set(["girlfriend", "boyfriend", "partner", "wife", "husband", "fiancee", "fiance", "spouse", "gf", "bf"]);
const SAME: Record<string, string> = { gf: "girlfriend", bf: "boyfriend", mum: "mom", mother: "mom", father: "dad", fiance: "fiancee", bestie: "best friend" };

/** The relation a phrase names ("my girlfriend", "my gf"), normalized, or null. Pure. */
export function relationIn(said: string): string | null {
  const s = ` ${said.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `;
  for (const r of RELATIONS) if (s.includes(` ${r} `) || s.includes(` ${r}s `)) return SAME[r] ?? r;
  return null;
}

/**
 * Names a memory gives for a relation: "Maria is my girlfriend", "Thomas's
 * girlfriend is Maria", "my girlfriend Maria", "girlfriend named Maria". Pure.
 */
export function namesFor(relation: string, memories: string[]) {
  const words = [relation, ...Object.entries(SAME).filter(([, v]) => v === relation).map(([k]) => k)].join("|");
  const name = "([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)";
  const patterns = [
    new RegExp(`${name},? (?:is|was) (?:my|his|her|their|the user's|[A-Z][a-z]+'s) (?:${words})\\b`, "g"),
    new RegExp(`\\b(?:${words})(?:,| is| named| called| -|:)? ${name}`, "g"),
  ];
  const found: string[] = [];
  for (const m of memories) {
    for (const p of patterns) {
      for (const hit of m.matchAll(p)) {
        const n = hit[1].split(" ")[0];
        if (!/^(She|He|They|The|Their|His|Her|My|Is|And|Named|Called)$/.test(n) && !found.includes(n)) found.push(n);
      }
    }
  }
  return found;
}

type Connected = { username: string; name: string };

/** Their accepted connections: the other side's username and name. */
async function connectedTo(db: D1Database, userId: string): Promise<Connected[]> {
  const { results } = await db
    .prepare(
      `SELECT u.username, u.name FROM connections c
         JOIN users u ON u.id = CASE WHEN c.requester_id = ?1 THEN c.addressee_id ELSE c.requester_id END
        WHERE (c.requester_id = ?1 OR c.addressee_id = ?1) AND c.status = 'accepted' AND u.username IS NOT NULL`,
    )
    .bind(userId)
    .all<{ username: string; name: string }>();
  return results;
}

const first = (name: string) => name.trim().split(/\s+/)[0].toLowerCase();

export type Partner =
  | { name: string; username: string | null; how: string }
  | { ask: string; options?: string[] };

/**
 * Who "my girlfriend" (or "Maria", or "@maria") is: from their connections,
 * the people OVOA knows and what it remembers. Asks rather than guesses when
 * it can't be sure.
 */
export async function resolvePartner(db: D1Database, userId: string, said: string): Promise<Partner> {
  const text = said.trim();
  const connections = await connectedTo(db, userId);
  const handle = /@([a-z0-9-]{3,30})/i.exec(text)?.[1]?.toLowerCase();
  if (handle) {
    const c = connections.find((x) => x.username === handle);
    return c ? { name: c.name.split(" ")[0], username: c.username, how: "their connection" } : { ask: `@${handle} isn't connected to their OVOA. Ask whether to connect first (ovoa_connect), or make the game anyway and give them the link to forward.` };
  }
  const relation = relationIn(text);
  let names: string[] = [];
  if (relation) {
    const [people, memories] = await Promise.all([
      db
        .prepare("SELECT name, relation, facts FROM people WHERE user_id = ?")
        .bind(userId)
        .all<{ name: string; relation: string | null; facts: string }>(),
      db.prepare("SELECT content FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").bind(userId).all<{ content: string }>(),
    ]);
    for (const p of people.results) {
      const about = `${p.relation ?? ""} ${p.facts}`.toLowerCase();
      if (relationIn(about) === relation || about.includes(relation)) names.push(p.name.split(" ")[0]);
    }
    for (const n of namesFor(relation, memories.results.map((m) => m.content))) if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  } else {
    const plain = text.replace(/^(me and|with|for)\s+/i, "").replace(/\s+and me$/i, "").trim();
    if (plain) names = [plain.split(/\s+/)[0]];
  }
  names = names.filter((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);
  const matches = connections.filter((c) => names.some((n) => first(c.name) === n.toLowerCase() || c.username === n.toLowerCase() || c.username.startsWith(`${n.toLowerCase()}-`)));
  if (matches.length === 1) {
    const c = matches[0];
    return { name: c.name.split(" ")[0], username: c.username, how: relation ? `their ${relation}, from what you remember, and connected on OVOA` : "their connection" };
  }
  if (matches.length > 1) return { ask: `Which one: ${matches.map((c) => `${c.name} (@${c.username})`).join(" or ")}?`, options: matches.map((c) => `@${c.username}`) };
  if (names.length === 1) return { name: names[0], username: null, how: relation ? `their ${relation}, from what you remember; not connected on OVOA` : "not connected on OVOA" };
  if (names.length > 1) return { ask: `Which ${relation ?? "person"}: ${names.join(" or ")}?`, options: names };
  // A relation nobody's named yet: one connection is a good guess, but it's still a guess.
  if (relation && connections.length) {
    return {
      ask: `Ask who their ${relation} is${connections.length <= 3 ? `: is it ${connections.map((c) => `${c.name.split(" ")[0]} (@${c.username})`).join(" or ")}?` : "."} Then call game_make again with the @username, and remember it with person_remember.`,
      options: connections.slice(0, 3).map((c) => `@${c.username}`),
    };
  }
  return { ask: `Ask their ${relation ?? "person"}'s first name (and remember it with person_remember). If they're on OVOA, their @username sends it to their OVOA.` };
}

function specs(): ToolSpec[] {
  return [
    {
      name: "game_make",
      description:
        "Makes a small playable two-player game (a web page) for them and someone close: their girlfriend, a friend, family. Built in a few minutes; they get the link by text, and when that person's OVOA is connected to theirs, it's sent there too. Only when they ask for it (or said yes to your offer).",
      parameters: {
        type: "object",
        properties: {
          with: { type: "string", description: "Who it's for, as they said it: \"my girlfriend\", \"Maria\", \"@maria\"" },
          idea: {
            type: "string",
            description: "The game they want, and everything that makes it theirs: the kind of game, inside jokes, things they both like, the mood. Only what they said or you know.",
          },
          name: { type: "string", description: "A short title for the game, e.g. \"Thomas vs Maria: Movie Night Quiz\"" },
        },
        required: ["with", "idea"],
      },
    },
  ];
}

const NAMES = new Set(specs().map((t) => t.name));
export const isTogetherTool = (name: string) => NAMES.has(name);

export function togetherAssistant(env: Env, userId: string) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    if (name !== "game_make") return { error: `Unknown tool ${name}` };
    const idea = String(args.idea ?? "").trim().slice(0, 3_000);
    const said = String(args.with ?? "").trim().slice(0, 80);
    if (!idea || !said) return { error: "with and idea are both needed" };
    const partner = await resolvePartner(db, userId, said);
    if ("ask" in partner) return { needsWho: true, note: partner.ask, ...(partner.options && { options: partner.options }) };
    const me = await db.prepare("SELECT name, username FROM users WHERE id = ?").bind(userId).first<{ name: string; username: string | null }>();
    if (!me?.username) {
      const suggestion = await suggestUsername(db, me?.name ?? "me", userId);
      return {
        needsUsername: true,
        ...(suggestion && { suggestion }),
        note: `Games live at <username>.ovoa.ai/<game>, and they don't have a username yet. Ask them to pick one${suggestion ? `, suggesting @${suggestion}` : ""}; set it with username_set (confirm: true) once they agree, then call game_make again.`,
      };
    }
    const [count, today] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?").bind(userId).first<{ n: number }>(),
      db.prepare("SELECT COUNT(*) AS n FROM site_builds WHERE user_id = ? AND created_at > ?").bind(userId, Date.now() - 86_400_000).first<{ n: number }>(),
    ]);
    if ((count?.n ?? 0) >= MAX_SITES) return { error: `They have ${MAX_SITES} websites and games, the most there can be. Deleting one makes room.` };
    if ((today?.n ?? 0) >= BUILDS_PER_DAY) return { error: "That's as many builds as can be made today. Say you'll make it tomorrow." };
    const title = String(args.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || `${me.name.split(" ")[0]} & ${partner.name}`;
    const base = slugify(`game ${partner.name}`);
    const path = pathProblem(base) ? await freePath(db, me.username, "our-game") : await freePath(db, me.username, base);
    if (!path) return { error: "No free name for the game. Try another title." };
    const slug = `${me.username}/${path}`;
    const now = Date.now();
    const site = { id: crypto.randomUUID(), user_id: userId };
    await db
      .prepare(
        `INSERT INTO sites (id, user_id, slug, name, client, brief, status, created_at, updated_at, owner_username, path, kind, share_to, share_for)
         VALUES (?, ?, ?, ?, NULL, ?, 'building', ?, ?, ?, ?, 'game', ?, ?)`,
      )
      .bind(site.id, userId, slug, title, `Players: ${me.name.split(" ")[0]} and ${partner.name}.\n${idea}`, now, now, me.username, path, partner.username, partner.name)
      .run();
    await queueBuild(db, site, "create", idea);
    say("game", { outcome: "queued", user: userId, shared: !!partner.username });
    return {
      making: true,
      for: partner.name,
      who: partner.how,
      link: await siteLink(env, slug),
      note: partner.username
        ? `It's being made (a few minutes). Say so, and that you'll text them the link when it's ready and send it to ${partner.name}'s OVOA (@${partner.username}) too. Don't say it's ready yet.`
        : `It's being made (a few minutes). Say so, and that you'll text them the link when it's ready to forward to ${partner.name}, who isn't connected on OVOA. Don't say it's ready yet.`,
    };
  };
  return {
    tools: specs(),
    callTool,
    prompt: [
      "Games for two: when they ask for a game (or something fun to do) with someone close, call game_make with who it's for as they said it and the idea, with what you know that makes it personal. It works out who \"my girlfriend\" is from what you remember and their OVOA connections; if it asks who, ask them in one short question.",
      "The finished link goes to them by text and, when that person's OVOA is connected, to theirs too; otherwise they forward it. Never say it's ready or sent before you've told them so.",
    ].join("\n"),
  };
}

// ---------- Offering one, now and then ----------

/** An offer of a game at most this often. */
const OFFER_EVERY_MS = 30 * 86_400_000;

/**
 * The cron's occasional offer (index.ts runTick, the slow lane): someone who
 * texts OVOA (texting first on) and is connected to their partner's OVOA gets,
 * at most once a month, around six in the evening their time, one text offering
 * a game for the two of them. Their "yes" is a turn, which calls game_make.
 */
export async function togetherTick(env: Env, slice?: Slice, now = Date.now()) {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT l.user_id, s.time_zone FROM text_links l JOIN settings s ON s.user_id = l.user_id
        WHERE l.proactive = 1
          AND EXISTS (SELECT 1 FROM connections c WHERE (c.requester_id = l.user_id OR c.addressee_id = l.user_id) AND c.status = 'accepted')
          AND NOT EXISTS (SELECT 1 FROM ovoa_suggestions g WHERE g.user_id = l.user_id AND g.kind = 'game' AND g.sent_at > ?)
        LIMIT 200`,
    )
    .bind(now - OFFER_EVERY_MS)
    .all<{ user_id: string; time_zone: string | null }>();
  let offered = 0;
  for (const u of results) {
    if (!inSlice(u.user_id, slice)) continue;
    const minutes = localMinutes(now, validTimeZone(u.time_zone));
    if (minutes < 17 * 60 + 30 || minutes > 19 * 60 + 30) continue;
    let partner: Partner | null = null;
    for (const r of COUPLE) {
      const p = await resolvePartner(db, u.user_id, `my ${r}`);
      if ("username" in p && p.username) {
        partner = p;
        break;
      }
    }
    if (!partner || !("username" in partner)) continue;
    const text = `Idea for tonight: want me to make a little two-player game for you and ${partner.name}? A quiz about each other, would-you-rather, whatever you like. Reply "make us a game" (and what kind) and I'll build it and send it to ${partner.name}'s OVOA too.`;
    const how = await reach(env, u.user_id, { kind: "idea", text, push: { title: `A game for you and ${partner.name}?`, body: text.slice(0, 180), data: { type: "idea" } } });
    if (how === "held") continue;
    await db
      .prepare("INSERT INTO ovoa_suggestions (user_id, kind, sent_at) VALUES (?, 'game', ?) ON CONFLICT (user_id, kind) DO UPDATE SET sent_at = excluded.sent_at")
      .bind(u.user_id, now)
      .run();
    offered++;
  }
  return { offered };
}
