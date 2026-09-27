// Outlook and Microsoft 365 (microsoft.ts): nothing at all while it's off; when
// connected, mail and calendar through Graph; sending and inviting wait for
// approval unless Approve for me or a standing rule covers them; an expired
// token refreshes (keeping Microsoft's new refresh token); a revoked one
// disconnects; the connect flow only finishes for the session that started it.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { sha256 } from "../src/auth";
import { encrypt } from "../src/crypto";
import { approveAction } from "../src/google/assistant";
import { hasOutlook, microsoftAssistant, microsoftAuthed, microsoftPublic, outlookEvents, sendOutlookMail } from "../src/microsoft";
import { addRule, kindOfTool } from "../src/rules";
import type { Env, Vars } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
for (const id of ["sam", "alex"]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id, `${id}@example.com`, id);
}
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const base = { DB: d1(sqlite), TOKEN_ENC_KEY: KEY, PUBLIC_URL: "https://api.test" };
const ai = { toMarkdown: async (f: { name: string }) => ({ id: "1", name: f.name, mimeType: "application/pdf", format: "markdown", tokens: 1, data: "Invoice total $42" }) };
const on = { ...base, AI: ai, MS_CLIENT_ID: "cid", MS_CLIENT_SECRET: "secret" } as unknown as Env;
const off = base as unknown as Env;

type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const calls: Call[] = [];
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: { access_token: "fresh", expires_in: 3600, refresh_token: "rotated", scope: "Mail.Send" } };
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  const call = { url, method: init.method ?? "GET", body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> };
  calls.push(call);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/oauth2/v2.0/token")) return json(tokenAnswer.status, tokenAnswer.body);
  if (url.includes("/me?$select=mail")) return json(200, { mail: "sam@contoso.com", displayName: "Sam Lee" });
  if (url.includes("/me/messages?$search")) {
    return json(200, { value: [{ id: "m1", subject: "Lease", from: { emailAddress: { name: "Pat", address: "pat@x.com" } }, receivedDateTime: "2026-09-26T10:00:00Z", bodyPreview: "Hi", isRead: false }] });
  }
  if (url.includes("/me/messages/m1/attachments?$select")) {
    return json(200, {
      value: [
        { "@odata.type": "#microsoft.graph.itemAttachment", id: "i1", name: "Fwd", contentType: "message/rfc822", size: 9 },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "Invoice.pdf", contentType: "application/pdf", size: 3 },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "a2", name: "Scan.pdf", contentType: "application/pdf", size: 40_000_000 },
      ],
    });
  }
  if (url.endsWith("/me/messages/m1/attachments/a1")) return json(200, { contentBytes: btoa("pdf") });
  if (url.includes("/me/messages/m1?$select=subject,from,toRecipients")) {
    return json(200, { subject: "Invoice", from: { emailAddress: { address: "pat@x.com" } }, body: { content: "attached" }, hasAttachments: true });
  }
  // An email whose Reply-To isn't its sender: a reply goes to the Reply-To.
  if (url.includes("/me/messages/m2?$select=subject,from,replyTo")) {
    return json(200, { subject: "Quick favor", from: { emailAddress: { address: "pat@x.com" } }, replyTo: [{ emailAddress: { address: "evil@x.com" } }] });
  }
  if (url.includes("/me/messages/m1?$select=subject,from")) return json(200, { subject: "Lease", from: { emailAddress: { name: "Pat", address: "pat@x.com" } } });
  if (url.includes("/me/people?$search")) {
    return json(200, { value: [{ displayName: "Pat Kim", scoredEmailAddresses: [{ address: "pat@x.com" }], phones: [{ number: "+1 555 0100" }] }] });
  }
  // The brief's read (outlookEvents asks for 15): all-day events for the day before, the day, and the day after.
  if (url.includes("/me/calendarView") && url.includes("$top=15")) {
    return json(200, {
      value: [
        { id: "d0", subject: "Yesterday off", isAllDay: true, start: { dateTime: "2026-09-27T00:00:00.0000000" } },
        { id: "d1", subject: "Standup", start: { dateTime: "2026-09-28T09:00:00.0000000" } },
        { id: "d2", subject: "Vacation", isAllDay: true, start: { dateTime: "2026-09-28T00:00:00.0000000" } },
        { id: "d3", subject: "Tomorrow off", isAllDay: true, start: { dateTime: "2026-09-29T00:00:00.0000000" } },
      ],
    });
  }
  if (url.includes("/me/calendarView")) return json(200, { value: [{ subject: "Standup", start: { dateTime: "2026-09-28T09:00:00.0000000" }, end: { dateTime: "2026-09-28T09:15:00.0000000" } }] });
  if (url.endsWith("/me/events")) return json(201, { id: "e1", webLink: "https://outlook.live.com/e1" });
  if (url.endsWith("/me/sendMail") || url.endsWith("/reply")) return new Response(null, { status: 202 });
  return json(404, { error: { message: `no fake for ${url}` } });
}) as typeof fetch;

const graphCalls = () => calls.filter((c) => c.url.startsWith("https://graph.microsoft.com"));

async function connect(userId: string, accessExpiresAt: number) {
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO microsoft_accounts (user_id, email, name, scopes, refresh_token_enc, access_token_enc, access_expires_at, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    )
    .run(userId, `${userId}@contoso.com`, userId, "Mail.Send", await encrypt(KEY, "refresh-1"), await encrypt(KEY, "access-1"), accessExpiresAt);
}

async function main() {
  // Off: no tools, and not one read of the database.
  const throwingDb = { prepare: () => { throw new Error("read while off"); } } as unknown as D1Database;
  const none = await microsoftAssistant({ ...off, DB: throwingDb } as Env, "sam", "UTC", false);
  eq("off: no tools and no read", [none.tools.length, none.prompt], [0, ""]);
  eq("on, not connected: no tools", (await microsoftAssistant(on, "sam", "UTC", false)).tools.length, 0);

  await connect("sam", Date.now() + 3_600_000);
  const sam = await microsoftAssistant(on, "sam", "America/New_York", false, null);
  eq("connected: the outlook tools", sam.tools.map((t) => t.name), ["outlook_search", "outlook_read", "outlook_attachment", "outlook_contacts_search", "outlook_send", "outlook_calendar_events", "outlook_calendar_create"]);
  eq("the prompt names the account", sam.prompt.includes("sam@contoso.com"), true);

  // Reading.
  const found = (await sam.callTool("outlook_search", { query: 'lease "renewal"' })) as { messages: { id: string; from: string; unread: boolean }[] };
  eq("search", found.messages.map((m) => [m.id, m.from, m.unread]), [["m1", "Pat <pat@x.com>", true]]);
  eq("with the stored token", graphCalls().at(-1)?.headers.authorization, "Bearer access-1");
  eq("quotes in the query can't break Graph's $search", decodeURIComponent(graphCalls().at(-1)!.url).includes('$search="lease  renewal"'), true);

  const opened = (await sam.callTool("outlook_read", { id: "m1" })) as { attachments?: unknown[] };
  eq("read lists file attachments only", opened.attachments, [
    { name: "Invoice.pdf", type: "application/pdf", size: 3 },
    { name: "Scan.pdf", type: "application/pdf", size: 40_000_000 },
  ]);
  const invoice = (await sam.callTool("outlook_attachment", { id: "m1" })) as { name: string; text: string };
  eq("and reads one", [invoice.name, invoice.text], ["Invoice.pdf", "Invoice total $42"]);
  eq("a missing one", await sam.callTool("outlook_attachment", { id: "m1", name: "receipt" }), { error: "No attachment called receipt. It has: Invoice.pdf, Scan.pdf" });
  calls.length = 0;
  eq("one too big isn't downloaded at all", [await sam.callTool("outlook_attachment", { id: "m1", name: "scan" }), graphCalls().some((c) => c.url.endsWith("/attachments/a2"))], [
    { error: "Scan.pdf is too big to read (over 8 MB)." },
    false,
  ]);

  eq("contacts", await sam.callTool("outlook_contacts_search", { query: "Pat" }), { people: [{ name: "Pat Kim", emails: ["pat@x.com"], phones: ["+1 555 0100"] }] });
  eq("contacts need a query", await sam.callTool("outlook_contacts_search", { query: " " }), { error: "query is required" });

  const events = (await sam.callTool("outlook_calendar_events", { start_day: "2026-09-28", days: 2 })) as { events: { title: string; start: string }[] };
  eq("calendar", events.events, [{ title: "Standup", start: "2026-09-28T09:00", end: "2026-09-28T09:15" }]);
  const view = decodeURIComponent(graphCalls().at(-1)!.url);
  eq("from their local midnight, for two days", [view.includes("startDateTime=2026-09-28T04:00:00.000Z"), view.includes("endDateTime=2026-09-30T04:00:00.000Z")], [true, true]);
  eq("times in their zone", graphCalls().at(-1)!.headers.prefer.includes('outlook.timezone="America/New_York"'), true);

  // Sending waits for approval, and nothing is sent until then.
  calls.length = 0;
  const waiting = (await sam.callTool("outlook_send", { to: "pat@x.com, not-an-address", subject: "Lease — next steps", body: "Sounds good — see you then" })) as { status: string };
  eq("send waits", waiting.status, "waiting_for_user_approval");
  eq("nothing sent yet", graphCalls().some((c) => c.url.endsWith("/sendMail")), false);
  eq("the app gets the card", sam.pending.length, 1);
  eq("the card", sam.pending[0]?.summary.split("\n")[0], "Send an email from Outlook to pat@x.com");
  eq("no em dashes in what's approved", sam.pending[0]?.summary.includes("—"), false);
  const approved = await approveAction(on, "sam", sam.pending[0]!.id);
  eq("approved", approved?.content, "Done: Send an email from Outlook to pat@x.com");
  const sent = graphCalls().find((c) => c.url.endsWith("/sendMail"));
  const mail = JSON.parse(sent?.body ?? "{}") as { message: { subject: string; toRecipients: unknown[]; body: { content: string } } };
  eq("sent to the real address only", mail.message.toRecipients, [{ emailAddress: { address: "pat@x.com" } }]);
  eq("the words approved are the words sent", mail.message.body.content.includes("—"), false);
  eq("logged as an email sent", (sqlite.prepare("SELECT kind FROM action_log WHERE user_id = 'sam'").get() as { kind: string } | undefined)?.kind, "email_send");

  // A reply's card says who it goes to.
  const reply = await microsoftAssistant(on, "sam", "UTC", false, null);
  await reply.callTool("outlook_send", { reply_to: "m1", body: "Yes" });
  eq("reply card", reply.pending[0]?.summary.split("\n").slice(0, 2), ["Send an email from Outlook to pat@x.com", "Subject: Re: Lease"]);

  // A standing rule, and Approve for me.
  eq("rules know outlook_send is email", [kindOfTool("outlook_send"), kindOfTool("outlook_calendar_create")], ["email", "calendar"]);
  await addRule(on.DB, "sam", "email", "pat@x.com");
  const ruled = await microsoftAssistant(on, "sam", "UTC", false, (tool, args) => import("../src/rules").then((r) => r.ruleAllows(on.DB, "sam", tool, args)));
  calls.length = 0;
  eq("a rule for Pat sends without asking", await ruled.callTool("outlook_send", { to: "pat@x.com", subject: "hi", body: "hi" }), { sent: true });
  eq("but not to someone else", ((await ruled.callTool("outlook_send", { to: "lee@x.com", subject: "hi", body: "hi" })) as { status: string }).status, "waiting_for_user_approval");
  // A reply goes to the email's Reply-To whatever `to` says: the rule and the card see that address.
  const tricked = (await ruled.callTool("outlook_send", { to: "pat@x.com", reply_to: "m2", body: "the code is 1234" })) as { status: string };
  eq("a reply to a Reply-To nobody approved still asks", tricked.status, "waiting_for_user_approval");
  eq("and the card names where it really goes", ruled.pending.at(-1)?.summary.split("\n")[0], "Send an email from Outlook to evil@x.com");
  const auto = await microsoftAssistant(on, "sam", "UTC", Promise.resolve(true), null);
  eq("Approve for me sends", await auto.callTool("outlook_send", { to: "lee@x.com", subject: "hi", body: "hi" }), { sent: true });

  // The calendar: an event of their own is just added; guests get invitations, so it asks.
  const cal = await microsoftAssistant(on, "sam", "America/Chicago", false, null);
  calls.length = 0;
  eq("an event without guests", await cal.callTool("outlook_calendar_create", { subject: "Dentist", start: "2026-10-02T15:00", end: "2026-10-02T16:00" }), { created: true, link: "https://outlook.live.com/e1" });
  const event = JSON.parse(graphCalls().at(-1)!.body) as { start: { timeZone: string } };
  eq("in their zone", event.start.timeZone, "America/Chicago");
  eq("with guests, it asks", ((await cal.callTool("outlook_calendar_create", { subject: "Lunch", start: "2026-10-02T12:00", end: "2026-10-02T13:00", attendees: ["pat@x.com"] })) as { status: string }).status, "waiting_for_user_approval");
  calls.length = 0;
  const invited = await approveAction(on, "sam", cal.pending[0]!.id);
  eq("approved, the invitation goes out", [invited?.content.startsWith("Done: Add \"Lunch\""), JSON.parse(graphCalls().at(-1)!.body).start.timeZone], [true, "America/Chicago"]);
  eq("bad times are refused", await cal.callTool("outlook_calendar_create", { subject: "x", start: "tomorrow", end: "later" }), { error: "start and end are local times like 2026-10-02T15:00" });

  // An expired access token refreshes, and Microsoft's new refresh token is kept.
  await connect("alex", Date.now() - 1000);
  const alex = await microsoftAssistant(on, "alex", "UTC", false, null);
  calls.length = 0;
  await alex.callTool("outlook_search", { query: "x" });
  eq("refreshed", [calls[0]?.url.endsWith("/token"), graphCalls()[0]?.headers.authorization], [true, "Bearer fresh"]);
  eq("asking only for what was granted", new URLSearchParams(calls[0]!.body).get("scope"), "Mail.Send offline_access");
  const kept = sqlite.prepare("SELECT refresh_token_enc FROM microsoft_accounts WHERE user_id = 'alex'").get() as { refresh_token_enc: string };
  const { decrypt } = await import("../src/crypto");
  eq("the rotated refresh token is stored", await decrypt(KEY, kept.refresh_token_enc), "rotated");

  // Revoked: disconnected, and the model is told to ask for a reconnect.
  sqlite.prepare("UPDATE microsoft_accounts SET access_expires_at = 0 WHERE user_id = 'alex'").run();
  tokenAnswer = { status: 400, body: { error: "invalid_grant" } };
  const revoked = (await alex.callTool("outlook_search", {})) as { error: string };
  eq("revoked: reconnect", revoked.error.includes("reconnect Microsoft"), true);
  eq("and forgotten", sqlite.prepare("SELECT COUNT(*) AS n FROM microsoft_accounts WHERE user_id = 'alex'").get(), { n: 0 });
  tokenAnswer = { status: 200, body: { access_token: "fresh2", expires_in: 3600, refresh_token: "r2", scope: "Mail.Send" } };

  // An approved campaign's email (campaigns.ts) goes out from Outlook for someone without Gmail.
  eq("hasOutlook", [await hasOutlook(on, "sam"), await hasOutlook(on, "nobody"), await hasOutlook(off, "sam")], [true, false, false]);
  calls.length = 0;
  await sendOutlookMail(on, "sam", { to: "kim@example.com", subject: "Hi Kim", body: "Is the unit open?" });
  const campaignMail = JSON.parse(graphCalls().find((c) => c.url.endsWith("/sendMail"))?.body ?? "{}") as { message?: { subject: string; toRecipients: unknown[] } };
  eq("a campaign email from Outlook", [campaignMail.message?.subject, campaignMail.message?.toRecipients], ["Hi Kim", [{ emailAddress: { address: "kim@example.com" } }]]);

  // The morning brief's calendar (rhythm.ts): Outlook events as instants, like Google's.
  calls.length = 0;
  // Sam's Monday in Chicago: 05:00Z Monday to 05:00Z Tuesday.
  const monday: [number, number] = [Date.parse("2026-09-28T05:00:00Z"), Date.parse("2026-09-29T05:00:00Z")];
  eq(
    "brief: Outlook events, in UTC, and only that day's all-day ones",
    (await outlookEvents(on, "sam", ...monday, "America/Chicago")).map((e) => [e.title, e.start, e.account]),
    [
      ["Standup", "2026-09-28T09:00:00Z", "sam@contoso.com"],
      ["Vacation", "2026-09-28", "sam@contoso.com"],
    ],
  );
  eq("asked for in UTC (no time zone preference)", graphCalls().at(-1)?.headers.prefer.includes("outlook.timezone"), false);
  eq("brief: nothing, and no read, while it's off", await outlookEvents({ ...off, DB: throwingDb } as Env, "sam", 0, 1), []);
  eq("brief: nothing for someone not connected", await outlookEvents(on, "nobody", 0, 1), []);

  // Connecting from the app.
  const token = "session-token";
  sqlite.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 'alex', 0, ?)").run(await sha256(token), Date.now() + 86_400_000);
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId", "alex");
    c.set("token", token);
    await next();
  });
  app.route("/", microsoftAuthed);
  const pub = new Hono<{ Bindings: Env }>();
  pub.route("/", microsoftPublic);

  eq("off: the app is told it isn't available", await (await app.request("/microsoft/status", {}, off)).json(), { available: false, connected: false });
  eq("off: connect says so", (await app.request("/microsoft/connect", { method: "POST" }, off)).status, 503);
  const started = (await (await app.request("/microsoft/connect", { method: "POST", body: JSON.stringify({ returnUrl: "ovoa://settings" }) }, on)).json()) as { url: string };
  const authorize = new URL(started.url);
  const state = authorize.searchParams.get("state")!;
  eq("to Microsoft's sign-in, with PKCE", [authorize.host, authorize.searchParams.get("code_challenge_method"), state.startsWith("ms_")], ["login.microsoftonline.com", "S256", true]);
  eq("asks for mail and calendar, and offline access", ["offline_access", "Mail.Send", "Calendars.ReadWrite"].every((s) => authorize.searchParams.get("scope")!.split(" ").includes(s)), true);

  sqlite.prepare("INSERT INTO oauth_states (state, user_id, code_verifier, return_url, expires_at, session_hash) VALUES ('googles', 'alex', 'v', NULL, ?, NULL)").run(Date.now() + 60_000);
  eq("a Google state isn't taken here", (await (await pub.request("/microsoft/callback?state=googles&code=c", {}, on)).text()).includes("Missing state"), true);
  eq("and stays for Google", sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = 'googles'").get(), { n: 1 });

  const back = await pub.request(`/microsoft/callback?state=${state}&code=abc`, {}, on);
  eq("back to the app", [back.status, back.headers.get("location")], [302, "ovoa://settings?microsoft=connected"]);
  eq("connected", await (await app.request("/microsoft/status", {}, on)).json().then((s) => [(s as { connected: boolean }).connected, (s as { email: string }).email]), [true, "sam@contoso.com"]);
  const again = await pub.request(`/microsoft/callback?state=${state}&code=abc`, {}, on);
  eq("a used state can't finish twice", (await again.text()).includes("expired"), true);

  // Signed out between starting and finishing: nothing is connected.
  const second = (await (await app.request("/microsoft/connect", { method: "POST" }, on)).json()) as { url: string };
  sqlite.prepare("DELETE FROM sessions WHERE user_id = 'alex'").run();
  sqlite.prepare("DELETE FROM microsoft_accounts WHERE user_id = 'alex'").run();
  const late = await pub.request(`/microsoft/callback?state=${new URL(second.url).searchParams.get("state")}&code=abc`, {}, on);
  eq("signed out: not connected", [(await late.text()).includes("signed out"), sqlite.prepare("SELECT COUNT(*) AS n FROM microsoft_accounts WHERE user_id = 'alex'").get()], [true, { n: 0 }]);

  eq("DELETE /microsoft", (await app.request("/microsoft", { method: "DELETE" }, on)).status, 200);
  sqlite.prepare("DELETE FROM users WHERE id = 'sam'").run();
  eq("gone with the account", sqlite.prepare("SELECT COUNT(*) AS n FROM microsoft_accounts").get(), { n: 0 });

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
