import { base64url } from "../crypto";

export type ToolContext = { token: string; timeZone: string };

type Schema = Record<string, unknown>;
type Args = Record<string, any>;

export type Tool = {
  name: string;
  description: string;
  parameters: Schema;
  /** Returns a human-readable summary when the action must be approved by the user first. */
  confirm?: (ctx: ToolContext, args: Args) => Promise<string | null>;
  run: (ctx: ToolContext, args: Args) => Promise<unknown>;
};

// ---------- helpers ----------

async function g<T = any>(ctx: ToolContext, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json", ...init.headers },
  });
  if (res.status === 204) return {} as T;
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Google API error ${res.status}: ${body?.error?.message ?? "unknown"}`);
  return body as T;
}

const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  required,
});
const str = (description: string): Schema => ({ type: "string", description });
const int = (description: string): Schema => ({ type: "integer", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const strList = (description: string): Schema => ({ type: "array", items: { type: "string" }, description });
const rows = (description: string): Schema => ({
  type: "array",
  description,
  items: { type: "array", items: { type: "string" } },
});

const ONLY_OVOA_FILES =
  "OVOA can only see Drive files it created; it can't search the rest of their Drive. For another Doc or Sheet, ask for its link.";

/**
 * Under drive.file, a file OVOA didn't create looks like one that doesn't exist (a 404), or answers a 403 whose
 * message says the user "has not granted the app … access to the file" (reason appNotAuthorizedToFile). Says which.
 * Any other 403 (rate limits, a file they can only view) is passed on as it is.
 */
async function ovoaFile<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (
      err instanceof Error &&
      (/^Google API error 404:/.test(err.message) || /^Google API error 403:.*has not granted the app/i.test(err.message))
    ) {
      throw new Error(`That file isn't one OVOA created, or it no longer exists. ${ONLY_OVOA_FILES}`);
    }
    throw err;
  }
}

/** Accepts a bare ID or a docs.google.com / drive.google.com link. */
const idFrom = (value: string) => value.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? value.trim();
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const clamp = (n: unknown, def: number, max: number) => Math.min(Math.max(Number(n) || def, 1), max);

/** Local time without an offset gets the user's time zone; dates alone mean all-day. */
function calTime(value: string, timeZone: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value, timeZone };
}

function header(headers: { name: string; value: string }[] | undefined, name: string) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const b64decode = (data: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

function messageText(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return b64decode(part.body.data);
  if (part.parts) {
    const plain = part.parts.map(messageText).find(Boolean);
    if (plain) return plain;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return b64decode(part.body.data)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;

function rawEmail(a: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string }) {
  const lines = [
    `To: ${a.to}`,
    a.cc ? `Cc: ${a.cc}` : "",
    `Subject: ${encodeHeader(a.subject)}`,
    a.inReplyTo ? `In-Reply-To: ${a.inReplyTo}` : "",
    a.inReplyTo ? `References: ${a.inReplyTo}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    btoa(String.fromCharCode(...new TextEncoder().encode(a.body))),
  ].filter((l, i, all) => l !== "" || i === all.length - 2);
  return base64url(new TextEncoder().encode(lines.join("\r\n")));
}

async function emailSummary(ctx: ToolContext, id: string) {
  const m = await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
  return `"${header(m.payload?.headers, "Subject") || "(no subject)"}" from ${header(m.payload?.headers, "From")}`;
}

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MIME: Record<string, string> = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
  pdf: "application/pdf",
};

// ---------- tools ----------

export const googleTools: Tool[] = [
  // Calendar
  {
    name: "calendar_list_events",
    description: "List events on the user's primary Google Calendar. Defaults to the next 7 days.",
    parameters: obj({
      start: str("ISO 8601 start, e.g. 2026-09-18T00:00:00-04:00. Defaults to now."),
      end: str("ISO 8601 end. Defaults to 7 days after start."),
      query: str("Optional text to search for"),
      maxResults: int("Max events, up to 50"),
    }),
    run: async (ctx, a) => {
      const start = a.start ? new Date(a.start) : new Date();
      const end = a.end ? new Date(a.end) : new Date(start.getTime() + 7 * 864e5);
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(clamp(a.maxResults, 25, 50)),
        timeZone: ctx.timeZone,
      });
      if (a.query) params.set("q", a.query);
      const r = await g(ctx, `${CAL}?${params}`);
      // Trimmed for the model, which reads all of this on every later round of
      // the turn: a location cut short, guests by count past the first three,
      // and nothing that is empty.
      return (r.items ?? []).map((e: any) => {
        const guests: string[] = e.attendees?.map((x: any) => x.email).filter(Boolean) ?? [];
        return {
          id: e.id,
          title: e.summary,
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          ...(e.location && { location: String(e.location).slice(0, 80) }),
          ...(guests.length && { attendees: guests.length > 3 ? [...guests.slice(0, 3), `and ${guests.length - 3} more`] : guests }),
        };
      });
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Create an event on the user's primary calendar. Times without an offset use the user's time zone. Use YYYY-MM-DD for all-day events (end date is exclusive).",
    parameters: obj(
      {
        title: str("Event title"),
        start: str("Start, e.g. 2026-09-18T15:00:00 or 2026-09-18"),
        end: str("End, e.g. 2026-09-18T16:00:00 or 2026-09-19"),
        description: str("Optional notes"),
        location: str("Optional location"),
        attendees: strList("Optional guest email addresses. Guests receive an invitation email."),
      },
      ["title", "start", "end"],
    ),
    confirm: async (_ctx, a) =>
      a.attendees?.length ? `Create "${a.title}" (${a.start}) and email invites to ${a.attendees.join(", ")}` : null,
    run: async (ctx, a) => {
      const params = a.attendees?.length ? "?sendUpdates=all" : "";
      const e = await g(ctx, `${CAL}${params}`, {
        method: "POST",
        body: JSON.stringify({
          summary: a.title,
          description: a.description,
          location: a.location,
          start: calTime(a.start, ctx.timeZone),
          end: calTime(a.end, ctx.timeZone),
          attendees: a.attendees?.map((email: string) => ({ email })),
        }),
      });
      return { id: e.id, link: e.htmlLink, start: e.start, end: e.end };
    },
  },
  {
    name: "calendar_update_event",
    description: "Change fields of an existing calendar event. Only include fields to change.",
    parameters: obj(
      {
        eventId: str("Event id from calendar_list_events"),
        title: str("New title"),
        start: str("New start"),
        end: str("New end"),
        description: str("New notes"),
        location: str("New location"),
      },
      ["eventId"],
    ),
    run: async (ctx, a) => {
      const patch: Args = {};
      if (a.title) patch.summary = a.title;
      if (a.description) patch.description = a.description;
      if (a.location) patch.location = a.location;
      if (a.start) patch.start = calTime(a.start, ctx.timeZone);
      if (a.end) patch.end = calTime(a.end, ctx.timeZone);
      const e = await g(ctx, `${CAL}/${encodeURIComponent(a.eventId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { id: e.id, title: e.summary, start: e.start, end: e.end };
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event.",
    parameters: obj({ eventId: str("Event id from calendar_list_events") }, ["eventId"]),
    confirm: async (ctx, a) => {
      const e = await g(ctx, `${CAL}/${encodeURIComponent(a.eventId)}`);
      return `Delete calendar event "${e.summary}" (${e.start?.dateTime ?? e.start?.date})`;
    },
    run: async (ctx, a) => {
      await g(ctx, `${CAL}/${encodeURIComponent(a.eventId)}`, { method: "DELETE" });
      return { deleted: true };
    },
  },

  // Gmail
  {
    name: "gmail_search",
    description:
      "Search the user's Gmail using Gmail search syntax (e.g. 'is:unread', 'from:amy newer_than:7d'). Returns sender, subject, date, snippet.",
    parameters: obj({ query: str("Gmail search query"), maxResults: int("Up to 20; ten unless more are needed") }, ["query"]),
    run: async (ctx, a) => {
      const list = await g(
        ctx,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: a.query, maxResults: String(clamp(a.maxResults, 10, 20)) })}`,
      );
      // Trimmed for the model: the snippet cut at 160 characters (Gmail's own are
      // about 200), and the recipient only kept when it isn't just the user.
      return Promise.all(
        (list.messages ?? []).map(async ({ id }: { id: string }) => {
          const m = await g(
            ctx,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          );
          const h = m.payload?.headers;
          const to = header(h, "To");
          return {
            id,
            from: header(h, "From"),
            ...(to && to.includes(",") && { to: to.slice(0, 120) }),
            subject: header(h, "Subject"),
            date: header(h, "Date"),
            ...(m.labelIds?.includes("UNREAD") && { unread: true }),
            snippet: String(m.snippet ?? "").slice(0, 160),
          };
        }),
      );
    },
  },
  {
    name: "gmail_read",
    description: "Read the full text of one email.",
    parameters: obj({ messageId: str("Message id from gmail_search") }, ["messageId"]),
    run: async (ctx, a) => {
      const m = await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.messageId}?format=full`);
      const h = m.payload?.headers;
      return {
        from: header(h, "From"),
        to: header(h, "To"),
        subject: header(h, "Subject"),
        date: header(h, "Date"),
        body: messageText(m.payload).slice(0, 8000),
      };
    },
  },
  {
    name: "gmail_create_draft",
    description: "Save an email draft in the user's Gmail without sending it.",
    parameters: obj(
      { to: str("Recipient emails, comma separated"), subject: str("Subject"), body: str("Plain text body"), cc: str("Optional CC") },
      ["to", "subject", "body"],
    ),
    run: async (ctx, a) => {
      const d = await g(ctx, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST",
        body: JSON.stringify({ message: { raw: rawEmail(a as any) } }),
      });
      return { draftId: d.id };
    },
  },
  {
    name: "gmail_send",
    description: "Send an email from the user's Gmail. To reply, pass replyToMessageId.",
    parameters: obj(
      {
        to: str("Recipient emails, comma separated"),
        subject: str("Subject"),
        body: str("Plain text body"),
        cc: str("Optional CC"),
        replyToMessageId: str("Optional id of the message being replied to"),
      },
      ["to", "subject", "body"],
    ),
    confirm: async (_ctx, a) => `Send email to ${a.to}${a.cc ? ` (cc ${a.cc})` : ""}\nSubject: ${a.subject}\n\n${a.body}`,
    run: async (ctx, a) => {
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      if (a.replyToMessageId) {
        const orig = await g(
          ctx,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.replyToMessageId}?format=metadata&metadataHeaders=Message-ID`,
        );
        threadId = orig.threadId;
        inReplyTo = header(orig.payload?.headers, "Message-ID") || undefined;
      }
      const sent = await g(ctx, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw: rawEmail({ ...(a as any), inReplyTo }), threadId }),
      });
      return { sent: true, id: sent.id };
    },
  },
  {
    name: "gmail_mark_read",
    description: "Mark an email as read or unread.",
    parameters: obj({ messageId: str("Message id"), read: bool("true for read, false for unread") }, ["messageId", "read"]),
    run: async (ctx, a) => {
      await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.messageId}/modify`, {
        method: "POST",
        body: JSON.stringify(a.read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] }),
      });
      return { ok: true };
    },
  },
  {
    name: "gmail_trash",
    description: "Move an email to the trash.",
    parameters: obj({ messageId: str("Message id") }, ["messageId"]),
    confirm: async (ctx, a) => `Move email ${await emailSummary(ctx, a.messageId)} to trash`,
    run: async (ctx, a) => {
      await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.messageId}/trash`, { method: "POST" });
      return { trashed: true };
    },
  },

  // Drive: the drive.file scope (oauth.ts) only reaches files OVOA created, so
  // these search and trash those and nothing else. Any other file answers 404,
  // or a 403 "has not granted the app … access" (ovoaFile explains both).
  {
    name: "drive_search",
    description:
      "Find files OVOA created in the user's Google Drive (the sheets and docs it made for them), by name or content. It can't see or search anything else in their Drive.",
    parameters: obj(
      {
        query: str("Words to search for"),
        type: { type: "string", enum: ["any", "document", "spreadsheet", "presentation", "folder", "pdf"], description: "File type" },
        maxResults: int("Up to 25"),
      },
      ["query"],
    ),
    run: async (ctx, a) => {
      const parts = [`(name contains '${q(a.query)}' or fullText contains '${q(a.query)}')`, "trashed = false"];
      if (a.type && MIME[a.type]) parts.push(`mimeType = '${MIME[a.type]}'`);
      const r = await g(
        ctx,
        `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
          q: parts.join(" and "),
          pageSize: String(clamp(a.maxResults, 10, 25)),
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
          orderBy: "modifiedTime desc",
        })}`,
      );
      const files = r.files ?? [];
      return files.length ? files : { files, note: `Nothing OVOA created matches. ${ONLY_OVOA_FILES}` };
    },
  },
  {
    name: "drive_trash",
    description: "Move a file OVOA created in the user's Google Drive to the trash. It can't reach any other file in their Drive.",
    parameters: obj({ fileId: str("File id or link") }, ["fileId"]),
    confirm: async (ctx, a) => {
      const f = await ovoaFile(g(ctx, `https://www.googleapis.com/drive/v3/files/${idFrom(a.fileId)}?fields=name`));
      return `Move "${f.name}" in Google Drive to trash`;
    },
    run: async (ctx, a) => {
      await ovoaFile(
        g(ctx, `https://www.googleapis.com/drive/v3/files/${idFrom(a.fileId)}`, {
          method: "PATCH",
          body: JSON.stringify({ trashed: true }),
        }),
      );
      return { trashed: true };
    },
  },

  // Sheets
  {
    name: "sheets_get_info",
    description: "Get a spreadsheet's title and its tabs (sheet names and sizes).",
    parameters: obj({ spreadsheet: str("Spreadsheet id or link") }, ["spreadsheet"]),
    run: async (ctx, a) => {
      const s = await g(
        ctx,
        `https://sheets.googleapis.com/v4/spreadsheets/${idFrom(a.spreadsheet)}?fields=properties.title,sheets.properties(title,gridProperties)`,
      );
      return {
        title: s.properties?.title,
        sheets: s.sheets?.map((x: any) => ({
          name: x.properties.title,
          rows: x.properties.gridProperties?.rowCount,
          columns: x.properties.gridProperties?.columnCount,
        })),
      };
    },
  },
  {
    name: "sheets_read",
    description: "Read cell values from a spreadsheet range in A1 notation, e.g. 'Sheet1!A1:D20'.",
    parameters: obj({ spreadsheet: str("Spreadsheet id or link"), range: str("A1 range") }, ["spreadsheet", "range"]),
    run: async (ctx, a) => {
      const r = await g(
        ctx,
        `https://sheets.googleapis.com/v4/spreadsheets/${idFrom(a.spreadsheet)}/values/${encodeURIComponent(a.range)}`,
      );
      return { range: r.range, values: (r.values ?? []).slice(0, 200) };
    },
  },
  {
    name: "sheets_append",
    description: "Add rows after the last row of data in a sheet.",
    parameters: obj(
      { spreadsheet: str("Spreadsheet id or link"), range: str("Sheet name or A1 range, e.g. 'Sheet1'"), rows: rows("Rows to add") },
      ["spreadsheet", "range", "rows"],
    ),
    run: async (ctx, a) => {
      const r = await g(
        ctx,
        `https://sheets.googleapis.com/v4/spreadsheets/${idFrom(a.spreadsheet)}/values/${encodeURIComponent(a.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: "POST", body: JSON.stringify({ values: a.rows }) },
      );
      return { updatedRange: r.updates?.updatedRange, rowsAdded: r.updates?.updatedRows };
    },
  },
  {
    name: "sheets_update",
    description: "Overwrite cells in a range with new values. Formulas starting with = are allowed.",
    parameters: obj(
      { spreadsheet: str("Spreadsheet id or link"), range: str("A1 range, e.g. 'Sheet1!B2'"), rows: rows("New values") },
      ["spreadsheet", "range", "rows"],
    ),
    run: async (ctx, a) => {
      const r = await g(
        ctx,
        `https://sheets.googleapis.com/v4/spreadsheets/${idFrom(a.spreadsheet)}/values/${encodeURIComponent(a.range)}?valueInputOption=USER_ENTERED`,
        { method: "PUT", body: JSON.stringify({ values: a.rows }) },
      );
      return { updatedRange: r.updatedRange, updatedCells: r.updatedCells };
    },
  },
  {
    name: "sheets_create",
    description: "Create a new Google Sheet, optionally with starting rows.",
    parameters: obj({ title: str("Spreadsheet title"), rows: rows("Optional starting rows, first row as headers") }, ["title"]),
    run: async (ctx, a) => {
      const s = await g(ctx, "https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        body: JSON.stringify({ properties: { title: a.title } }),
      });
      if (a.rows?.length) {
        const sheet = s.sheets?.[0]?.properties?.title ?? "Sheet1";
        await g(
          ctx,
          `https://sheets.googleapis.com/v4/spreadsheets/${s.spreadsheetId}/values/${encodeURIComponent(sheet)}!A1?valueInputOption=USER_ENTERED`,
          { method: "PUT", body: JSON.stringify({ values: a.rows }) },
        );
      }
      return { id: s.spreadsheetId, link: s.spreadsheetUrl };
    },
  },

  // Docs
  {
    name: "docs_read",
    description: "Read the text of a Google Doc.",
    parameters: obj({ document: str("Document id or link") }, ["document"]),
    run: async (ctx, a) => {
      const d = await g(ctx, `https://docs.googleapis.com/v1/documents/${idFrom(a.document)}`);
      const text = (d.body?.content ?? [])
        .flatMap((b: any) => b.paragraph?.elements ?? [])
        .map((e: any) => e.textRun?.content ?? "")
        .join("");
      return { title: d.title, text: text.slice(0, 12000) };
    },
  },
  {
    name: "docs_create",
    description: "Create a new Google Doc with optional starting text.",
    parameters: obj({ title: str("Document title"), text: str("Optional body text") }, ["title"]),
    run: async (ctx, a) => {
      const d = await g(ctx, "https://docs.googleapis.com/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: a.title }),
      });
      if (a.text) {
        await g(ctx, `https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: a.text } }] }),
        });
      }
      return { id: d.documentId, link: `https://docs.google.com/document/d/${d.documentId}/edit` };
    },
  },
  {
    name: "docs_append",
    description: "Add text to the end of a Google Doc.",
    parameters: obj({ document: str("Document id or link"), text: str("Text to add") }, ["document", "text"]),
    run: async (ctx, a) => {
      const id = idFrom(a.document);
      const d = await g(ctx, `https://docs.googleapis.com/v1/documents/${id}?fields=body.content(endIndex)`);
      const end = Math.max((d.body?.content?.at(-1)?.endIndex ?? 2) - 1, 1);
      await g(ctx, `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ insertText: { location: { index: end }, text: `\n${a.text}` } }] }),
      });
      return { ok: true };
    },
  },

  // Tasks
  {
    name: "tasks_list",
    description: "List the user's Google Tasks from their default list.",
    parameters: obj({ showCompleted: bool("Include completed tasks") }),
    run: async (ctx, a) => {
      const r = await g(
        ctx,
        `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?${new URLSearchParams({
          showCompleted: String(!!a.showCompleted),
          showHidden: String(!!a.showCompleted),
          maxResults: "50",
        })}`,
      );
      return (r.items ?? []).map((t: any) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due, status: t.status }));
    },
  },
  {
    name: "tasks_add",
    description: "Add a task to the user's default Google Tasks list.",
    parameters: obj({ title: str("Task"), notes: str("Optional notes"), due: str("Optional due date YYYY-MM-DD") }, ["title"]),
    run: async (ctx, a) => {
      const t = await g(ctx, "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks", {
        method: "POST",
        body: JSON.stringify({ title: a.title, notes: a.notes, due: a.due ? `${a.due}T00:00:00.000Z` : undefined }),
      });
      return { id: t.id };
    },
  },
  {
    name: "tasks_complete",
    description: "Mark a Google Task as completed.",
    parameters: obj({ taskId: str("Task id from tasks_list") }, ["taskId"]),
    run: async (ctx, a) => {
      await g(ctx, `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(a.taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "completed" }),
      });
      return { ok: true };
    },
  },

  // Contacts
  {
    name: "contacts_search",
    description: "Look up the user's Google Contacts by name, email, or phone.",
    parameters: obj({ query: str("Name, email, or phone") }, ["query"]),
    run: async (ctx, a) => {
      const base = "https://people.googleapis.com/v1/people:searchContacts";
      const readMask = "names,emailAddresses,phoneNumbers";
      // Google asks for an empty warm-up query so the search cache is fresh.
      await g(ctx, `${base}?${new URLSearchParams({ query: "", readMask })}`).catch(() => {});
      const r = await g(ctx, `${base}?${new URLSearchParams({ query: a.query, readMask, pageSize: "10" })}`);
      return (r.results ?? []).map(({ person: p }: any) => ({
        name: p.names?.[0]?.displayName,
        emails: p.emailAddresses?.map((e: any) => e.value),
        phones: p.phoneNumbers?.map((n: any) => n.value),
      }));
    },
  },
];

export const toolsByName = new Map(googleTools.map((t) => [t.name, t]));
