import { fetch as streamingFetch } from "expo/fetch";
import { devlog } from "./devlog";

export const API_URL =process.env.EXPO_PUBLIC_API_URL ?? "https://jarvis-api.edgeformmedia.workers.dev";

export type Settings = {
  assistantName: string;
  personality: string;
  memoryEnabled: boolean;
  stepGoal: number;
  fallDetection: boolean;
  autoApprove: boolean;
};
export type User = { id: string; email: string; name: string; created_at: number; settings: Settings };
export type Message = { id: string; role: "user" | "assistant"; content: string; created_at: number };
export type Memory = { id: string; content: string; created_at: number };

export type StepDay = { day: string; steps: number };
export type Contact = { id: string; name: string; phone: string };
export type SafetyEvent = {
  id: string;
  kind: "fall" | "sos";
  status: "ok" | "alerted";
  latitude: number | null;
  longitude: number | null;
  created_at: number;
};

export type PendingAction = {
  id: string;
  summary: string;
  created_at: number;
  /** Present when the app carries out the action on the phone itself. */
  phone?: { tool: string; args: Record<string, any> };
  /** "Approve for me" is on: run it without a card unless it needs a choice. */
  auto?: boolean;
};
export type PhoneResult = { ok: boolean; detail: string };
export type PhoneCaps = { lookups: boolean; capabilities: string[]; autoSendTexts?: boolean };
/** Something the assistant wants looked up on the phone before it can answer. */
export type PhoneCall = { id: string; name: string; args: Record<string, any> };
/** A chat turn either finishes, or pauses until the app sends lookup results to `resume`. */
export type ChatResponse = (
  | { messages: Message[]; pendingActions: PendingAction[]; paused?: undefined; ignored?: boolean }
  | { paused: { turnId: string; calls: PhoneCall[] }; pendingActions: PendingAction[]; messages?: undefined; ignored?: undefined }
) & {
  /** Which model answered and how long the server took, for the log. */
  meta?: { engine: string; ms: number };
};
/** A connected Google account. `label` is the tag the user (or the assistant) gave it. */
export type GoogleAccount = {
  id: string;
  email: string;
  name: string | null;
  label: string | null;
  isDefault: boolean;
  scopes: string[];
  connectedAt: number;
};
/** The top-level fields describe the default account; `accounts` has all of them. */
export type GoogleStatus =
  | { connected: false; accounts: GoogleAccount[] }
  | { connected: true; email: string; name: string | null; scopes: string[]; connectedAt: number; accounts: GoogleAccount[] };

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 60_000;

export async function request<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  // Auth bodies hold passwords and tokens; keep them out of the log.
  const secret = path.startsWith("/auth/") || path.startsWith("/me/password");
  devlog("req", `${method} ${path}`, secret ? undefined : (init.body as string | undefined));
  const started = Date.now();
  // Never wait forever: a request frozen while iOS suspended the app would
  // otherwise hang the voice loop until the connection drops (seen: 15 min).
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      signal: timeout.signal,
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
        ...init.headers,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    devlog("err", `${method} ${path} failed after ${Date.now() - started} ms`, String(err));
    if (timeout.signal.aborted) throw new Error(`No answer from the server after ${REQUEST_TIMEOUT_MS / 1000} s`);
    throw err;
  }
  clearTimeout(timer);
  const body = await res.json().catch(() => ({}));
  devlog(res.ok ? "res" : "err", `${res.status} ${method} ${path} · ${Date.now() - started} ms`, secret ? undefined : body);
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

type StreamLine =
  | { type: "sentence"; text: string }
  | ({ type: "done" } & ChatResponse)
  | { type: "error"; error: string };

/**
 * A chat turn with the reply streamed: `onSentence` gets each sentence as soon as
 * the server has it (so it can be spoken while the rest is written), then this
 * resolves with the same response a plain request would.
 */
async function streamedTurn(
  path: string,
  token: string,
  body: Record<string, unknown>,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  devlog("req", `POST ${path} (streamed)`, JSON.stringify(body));
  const started = Date.now();
  // No progress for this long means the connection is dead (the whole reply can take longer).
  const timeout = new AbortController();
  let timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  // The caller gave up (the user talked over the reply): stop reading.
  let dropped = false;
  const drop = () => {
    dropped = true;
    timeout.abort();
  };
  if (signal?.aborted) drop();
  signal?.addEventListener("abort", drop);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  };
  try {
    const res = await streamingFetch(`${API_URL}${path}`, {
      method: "POST",
      signal: timeout.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      devlog("err", `${res.status} POST ${path} · ${Date.now() - started} ms`, err);
      throw new ApiError(err.error ?? `Request failed (${res.status})`, res.status);
    }
    // A server without streaming answers plain JSON.
    if (!res.headers.get("content-type")?.includes("ndjson") || !res.body) {
      const json = (await res.json()) as ChatResponse;
      devlog("res", `${res.status} POST ${path} · ${Date.now() - started} ms (not streamed)`, json);
      return json;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentences = 0;
    let final: ChatResponse | null = null;
    const handle = (line: string) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as StreamLine;
      if (msg.type === "sentence") {
        if (!sentences++) devlog("res", `first sentence after ${Date.now() - started} ms`, msg.text);
        onSentence(msg.text);
      } else if (msg.type === "error") {
        throw new ApiError(msg.error, 500);
      } else {
        const { type: _, ...rest } = msg;
        final = rest as ChatResponse;
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      alive();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handle(line);
      }
    }
    handle(buffer);
    if (!final) throw new Error("The reply was cut off");
    const done = final as ChatResponse;
    devlog("res", `200 POST ${path} · ${Date.now() - started} ms, ${sentences} sentences streamed`, done.meta ?? done);
    return done;
  } catch (err) {
    if (dropped) {
      devlog("voice", `stopped reading the reply after ${Date.now() - started} ms (talked over)`);
      throw new Error("Cancelled");
    }
    if (timeout.signal.aborted) {
      devlog("err", `POST ${path} stalled after ${Date.now() - started} ms`);
      throw new Error(`No answer from the server after ${REQUEST_TIMEOUT_MS / 1000} s`);
    }
    if (!(err instanceof ApiError)) devlog("err", `POST ${path} failed after ${Date.now() - started} ms`, String(err));
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", drop);
  }
}

export const api = {
  signup: (email: string, password: string, name: string) =>
    request<{ token: string; user: User }>("/auth/signup", null, {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>("/auth/login", null, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: (token: string) => request("/auth/logout", token, { method: "POST" }),
  me: (token: string) => request<{ user: User }>("/me", token),
  updateMe: (token: string, patch: Partial<Settings> & { name?: string }) =>
    request<{ user: User }>("/me", token, { method: "PATCH", body: JSON.stringify(patch) }),
  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request("/me/password", token, { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
  deleteAccount: (token: string) => request("/me", token, { method: "DELETE" }),

  messages: (token: string) => request<{ messages: Message[] }>("/chat/messages", token),
  /**
   * `voice`: the user spoke this and the reply will be read aloud.
   * `ambient`: overheard by always-listening; the server replies only if it was
   * meant for the assistant, and otherwise answers `ignored` and saves nothing.
   */
  send: (token: string, message: string, phone: PhoneCaps, voice = false, ambient = false) =>
    request<ChatResponse>("/chat", token, {
      method: "POST",
      body: JSON.stringify({ message, timeZone: timeZone(), phone, voice, ambient }),
    }),
  resume: (token: string, turnId: string, results: Record<string, unknown>) =>
    request<ChatResponse>("/chat/resume", token, { method: "POST", body: JSON.stringify({ turnId, results }) }),
  /** `send` for a spoken turn, with the reply's sentences delivered as they're written. */
  sendStreamed: (
    token: string,
    message: string,
    phone: PhoneCaps,
    ambient: boolean,
    onSentence: (sentence: string) => void,
    signal?: AbortSignal,
  ) => streamedTurn("/chat", token, { message, timeZone: timeZone(), phone, voice: true, ambient }, onSentence, signal),
  resumeStreamed: (
    token: string,
    turnId: string,
    results: Record<string, unknown>,
    onSentence: (sentence: string) => void,
    signal?: AbortSignal,
  ) => streamedTurn("/chat/resume", token, { turnId, results }, onSentence, signal),
  clearMessages: (token: string) => request("/chat/messages", token, { method: "DELETE" }),

  memories: (token: string) => request<{ memories: Memory[] }>("/memories", token),
  deleteMemory: (token: string, id: string) => request(`/memories/${id}`, token, { method: "DELETE" }),
  clearMemories: (token: string) => request("/memories", token, { method: "DELETE" }),

  syncSteps: (token: string, days: StepDay[]) =>
    request("/steps", token, { method: "PUT", body: JSON.stringify({ days }) }),

  contacts: (token: string) => request<{ contacts: Contact[] }>("/contacts", token),
  addContact: (token: string, name: string, phone: string) =>
    request<{ contact: Contact }>("/contacts", token, { method: "POST", body: JSON.stringify({ name, phone }) }),
  deleteContact: (token: string, id: string) => request(`/contacts/${id}`, token, { method: "DELETE" }),

  logSafetyEvent: (
    token: string,
    event: Pick<SafetyEvent, "kind" | "status"> & { latitude?: number; longitude?: number },
  ) =>
    request<{ event: SafetyEvent }>("/safety-events", token, { method: "POST", body: JSON.stringify(event) }),
  safetyEvents: (token: string) => request<{ events: SafetyEvent[] }>("/safety-events", token),

  googleStatus: (token: string) => request<GoogleStatus>("/google/status", token),
  /** `accountId` reconnects that account instead of adding another one. */
  googleConnectUrl: (token: string, returnUrl: string, accountId?: string) =>
    request<{ url: string }>("/google/connect", token, {
      method: "POST",
      body: JSON.stringify({ returnUrl, accountId }),
    }),
  googleUpdateAccount: (token: string, id: string, patch: { label?: string; isDefault?: true }) =>
    request<{ accounts: GoogleAccount[] }>(`/google/accounts/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  googleRemoveAccount: (token: string, id: string) =>
    request<{ accounts: GoogleAccount[] }>(`/google/accounts/${id}`, token, { method: "DELETE" }),

  pendingActions: (token: string) => request<{ actions: PendingAction[] }>("/actions", token),
  approveAction: (token: string, id: string, phoneResult?: PhoneResult) =>
    request<{ message: Message }>(`/actions/${id}/approve`, token, {
      method: "POST",
      body: JSON.stringify({ timeZone: timeZone(), phoneResult }),
    }),
  cancelAction: (token: string, id: string) => request(`/actions/${id}`, token, { method: "DELETE" }),

  createSiriKey: (token: string) => request<{ key: string; url: string }>("/siri/key", token, { method: "POST" }),
  deleteSiriKey: (token: string) => request("/siri/key", token, { method: "DELETE" }),
};
