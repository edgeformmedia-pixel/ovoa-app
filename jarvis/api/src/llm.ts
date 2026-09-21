import { generate as geminiGenerate, type Turn } from "./gemini";

export type { Turn };

export type LlmEnv = {
  AI: Ai;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  FALLBACK_MODEL: string;
};

type Options = {
  model: string;
  system: string;
  turns: Turn[];
  json?: { schema: Record<string, unknown> };
  /**
   * Quick yes/no calls: tried on Workers AI first so they don't spend the
   * Gemini/DeepSeek quota, and every engine skips most of its thinking.
   */
  fast?: boolean;
};

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** A CallTool returns this to pause the turn until the app supplies the result (see `resume`). */
export const DEFER = Symbol("defer");

export type DeferredCall = { id: string; name: string; args: Record<string, unknown> };

/** A paused tool loop. Plain JSON, so it can be stored between requests. */
export type LoopState =
  | { engine: "gemini"; round: number; contents: any[]; slots: { id: string; part: number }[] }
  | { engine: OpenAiEngine; round: number; messages: any[]; slots: { id: string; index: number }[] };

export type ChatOutcome =
  | { kind: "reply"; text: string; engine: Engine }
  | { kind: "paused"; state: LoopState; calls: DeferredCall[]; engine: Engine };

/**
 * Receives the reply as it's written. Returning false stops the model early
 * (a spoken reply that has gone on long enough, or is repeating itself).
 */
export type OnText = (delta: string) => boolean | void;

type ToolLoopOptions = {
  model: string;
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  callTool: CallTool;
  /** Spoken turn: think less, answer sooner. */
  voice?: boolean;
  /** Stream the reply: called with each piece of text as the model writes it. */
  onText?: OnText;
};

export type Engine = "gemini" | OpenAiEngine;

const ENGINE_NAMES: Record<Engine, string> = { gemini: "Gemini", deepseek: "DeepSeek", workers: "Workers AI" };

const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 12_000;

const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

function toolResultText(result: unknown) {
  const text = JSON.stringify(result ?? null);
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : text;
}

async function safeCall(callTool: CallTool, name: string, args: Record<string, unknown>) {
  try {
    return await callTool(name, args);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- Engine health ----------
//
// A failing engine (out of quota, out of credit, bad key) is skipped for a while
// instead of being tried, and failing, before every single reply. Per isolate,
// which is enough: a busy isolate serves many requests.

const cooldownUntil = new Map<Engine, number>();
const lastFailure = new Map<Engine, string>();

function coolDown(engine: Engine, err: unknown) {
  const text = String(err);
  lastFailure.set(engine, text.slice(0, 200));
  if (engine === "workers") {
    // The last resort is always tried, unless its free daily allocation is used up (4006):
    // then skip it until it resets at midnight UTC, so quick calls go to the others instead.
    if (/4006|daily free allocation/.test(text)) cooldownUntil.set(engine, new Date().setUTCHours(24, 0, 0, 0));
    return;
  }
  const status = Number(/ (\d{3}):/.exec(text)?.[1] ?? 0);
  // 429: rate limited, back soon, unless the (daily) quota is used up. 401/402/403/404: key,
  // credit or model problems that won't fix themselves.
  const ms =
    status === 429
      ? /quota/i.test(text)
        ? 30 * 60_000
        : 60_000
      : [401, 402, 403, 404].includes(status)
        ? 10 * 60_000
        : 15_000;
  cooldownUntil.set(engine, Date.now() + ms);
}

/**
 * Engines in the order they're tried: Gemini and DeepSeek when their keys are set
 * (and they haven't just failed), then Cloudflare Workers AI, so chat keeps working
 * if the others fail or run out.
 */
function engines(env: LlmEnv): Engine[] {
  const now = Date.now();
  const keyed: (Engine | false)[] = [!!env.GEMINI_API_KEY && "gemini", !!env.DEEPSEEK_API_KEY && "deepseek"];
  const ready = [...keyed, "workers" as const].filter((e): e is Engine => !!e && (cooldownUntil.get(e) ?? 0) < now);
  return ready.length ? ready : ["workers"];
}

/** The last engine's error, naming what the earlier ones failed with. */
function finalError(err: unknown, failures: string[]) {
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) {
    if (until > now && engine !== "workers") failures.push(`${ENGINE_NAMES[engine]} skipped, it failed with ${lastFailure.get(engine)}`);
  }
  if (!failures.length) return err;
  const brief = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);
  return new Error(`${brief(err)} (earlier: ${failures.join("; ")})`);
}

function logFallback(from: Engine, to: Engine, err: unknown) {
  coolDown(from, err);
  console.error(`${ENGINE_NAMES[from]} failed, using ${ENGINE_NAMES[to]} fallback`, err);
}

export async function generateText(env: LlmEnv, opts: Options): Promise<string> {
  const all = engines(env);
  const order: Engine[] = opts.fast && all.includes("workers") ? ["workers", ...all.filter((e) => e !== "workers")] : all;
  const failures: string[] = [];
  for (const [i, engine] of order.entries()) {
    try {
      return engine === "gemini"
        ? await geminiGenerate({ apiKey: env.GEMINI_API_KEY!, ...opts })
        : await openAiGenerate(env, engine, opts);
    } catch (err) {
      if (i === order.length - 1) {
        coolDown(engine, err);
        throw finalError(err, failures);
      }
      failures.push(`${ENGINE_NAMES[engine]}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
      logFallback(engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

/**
 * Chat that may call tools. Moves to the next engine only if one fails before
 * any tool ran and before any text was streamed.
 * Pass `resume` to continue a paused turn with the results of its deferred calls.
 */
export async function chatWithTools(
  env: LlmEnv,
  opts: ToolLoopOptions & { resume?: { state: LoopState; results: Record<string, unknown> } },
): Promise<ChatOutcome> {
  if (opts.resume) {
    const { state, results } = opts.resume;
    const result = (id: string) => results[id] ?? { error: "The app returned no result" };
    if (state.engine === "gemini") {
      const last = state.contents[state.contents.length - 1];
      for (const slot of state.slots) {
        last.parts[slot.part].functionResponse.response = geminiResponse(result(slot.id));
      }
      let streamed = false;
      const onText: OnText | undefined = opts.onText
        ? (delta) => {
            streamed = true;
            return opts.onText!(delta);
          }
        : undefined;
      try {
        if ((cooldownUntil.get("gemini") ?? 0) > Date.now()) throw new Error("Gemini is cooling down");
        return await geminiToolLoop(env.GEMINI_API_KEY!, { ...opts, onText }, state);
      } catch (err) {
        // Out of quota halfway through: finish the turn on Workers AI with what's been looked up.
        if (streamed || (cooldownUntil.get("workers") ?? 0) > Date.now()) {
          coolDown("gemini", err);
          throw err;
        }
        logFallback("gemini", "workers", err);
        const messages = geminiToOpenAi(opts.system, state.contents);
        return openAiToolLoop(env, "workers", opts, { engine: "workers", round: state.round, messages, slots: [] });
      }
    }
    for (const slot of state.slots) state.messages[slot.index].content = toolResultText(result(slot.id));
    return openAiToolLoop(env, state.engine, opts, state);
  }

  let committed = false;
  const tracked: CallTool = (name, args) => {
    committed = true;
    return opts.callTool(name, args);
  };
  const onText: OnText | undefined = opts.onText
    ? (delta) => {
        committed = true;
        return opts.onText!(delta);
      }
    : undefined;
  const order = engines(env);
  const failures: string[] = [];
  for (const [i, engine] of order.entries()) {
    try {
      const run = { ...opts, callTool: tracked, onText };
      return engine === "gemini"
        ? await geminiToolLoop(env.GEMINI_API_KEY!, run)
        : await openAiToolLoop(env, engine, run);
    } catch (err) {
      if (committed || i === order.length - 1) {
        coolDown(engine, err);
        throw finalError(err, failures);
      }
      failures.push(`${ENGINE_NAMES[engine]}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
      logFallback(engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

// ---------- Streaming ----------

/** The `data:` payloads of a server-sent-events stream. */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const payload = (line: string) => {
    const l = line.trim();
    if (!l.startsWith("data:")) return null;
    const data = l.slice(5).trim();
    return data && data !== "[DONE]" ? data : null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const data = payload(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (data) yield data;
      }
    }
    const data = payload(buffer);
    if (data) yield data;
  } finally {
    // Stopping early (a long-enough spoken reply) also stops the model upstream.
    reader.cancel().catch(() => {});
  }
}

// ---------- Gemini ----------

/** Gemini wants an object; oversized results go as truncated text. */
function geminiResponse(result: unknown) {
  const text = toolResultText(result);
  return { result: text.length > MAX_TOOL_RESULT_CHARS ? text : (result ?? null) };
}

/** One model turn. Streamed when `onText` is set; either way returns the full turn. */
async function geminiRound(apiKey: string, model: string, body: unknown, onText?: OnText): Promise<{ role: string; parts: any[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${onText ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  if (!onText) {
    const data = (await res.json()) as any;
    return data.candidates?.[0]?.content ?? { role: "model", parts: [] };
  }
  // Keep every part as it arrived: function calls carry thought signatures Gemini wants back.
  const parts: any[] = [];
  for await (const data of sseData(res.body!)) {
    const chunk = JSON.parse(data);
    let stop = false;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      parts.push(part);
      if (part.text && !part.thought && onText(part.text) === false) stop = true;
    }
    if (stop) break;
  }
  return { role: "model", parts };
}

async function geminiToolLoop(
  apiKey: string,
  { model, system, turns, tools, callTool, voice, onText }: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: "gemini" }>,
): Promise<ChatOutcome> {
  const contents: any[] = paused?.contents ?? turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));

  for (let round = paused?.round ?? 0; round <= MAX_TOOL_ROUNDS; round++) {
    const content = await geminiRound(
      apiKey,
      model,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        // No tools on the last round, so the model has to answer.
        ...(round < MAX_TOOL_ROUNDS && tools.length && { tools: [{ functionDeclarations: tools }] }),
        // Spoken replies are short: a little thinking is plenty, and much faster.
        // ("minimal" would be faster still, but gemini-3.8-flash rejects it: 400,
        // "Thinking level MINIMAL is not supported for this model", 2026-09-21.)
        ...(voice && { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }),
      },
      onText,
    );
    const parts: any[] = content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("");
      if (!text) throw new Error(`Gemini ${model} returned no text`);
      return { kind: "reply", text, engine: "gemini" };
    }

    // Send the model's turn back verbatim: it carries thought signatures Gemini requires.
    contents.push(content);
    const responses = [];
    const slots: { id: string; part: number }[] = [];
    const deferred: DeferredCall[] = [];
    for (const { functionCall: fc } of calls) {
      const args = fc.args ?? {};
      const result = await safeCall(callTool, fc.name, args);
      let response;
      if (result === DEFER) {
        const id = crypto.randomUUID();
        slots.push({ id, part: responses.length });
        deferred.push({ id, name: fc.name, args });
        response = { result: null }; // filled in on resume
      } else {
        response = geminiResponse(result);
      }
      responses.push({ functionResponse: { ...(fc.id && { id: fc.id }), name: fc.name, response } });
    }
    contents.push({ role: "user", parts: responses });
    if (deferred.length) {
      return { kind: "paused", state: { engine: "gemini", round: round + 1, contents, slots }, calls: deferred, engine: "gemini" };
    }
  }
  throw new Error("Too many tool rounds");
}

/** A Gemini conversation (with its tool calls and results) as OpenAI-style messages. */
function geminiToOpenAi(system: string, contents: any[]): any[] {
  const messages: any[] = [{ role: "system", content: system }];
  let callCount = 0;
  const pending: string[] = []; // ids of calls waiting for their results, in order
  for (const content of contents) {
    const parts: any[] = content.parts ?? [];
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    const calls = parts.filter((p) => p.functionCall);
    const results = parts.filter((p) => p.functionResponse);
    if (content.role === "model") {
      const toolCalls = calls.map((p) => {
        const id = `call_${callCount++}`;
        pending.push(id);
        return { id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
      });
      messages.push({ role: "assistant", content: text, ...(toolCalls.length && { tool_calls: toolCalls }) });
    } else if (results.length) {
      for (const p of results) {
        messages.push({ role: "tool", tool_call_id: pending.shift() ?? `call_${callCount++}`, content: toolResultText(p.functionResponse.response) });
      }
    } else {
      messages.push({ role: "user", content: text });
    }
  }
  return messages;
}

// ---------- OpenAI-style engines (DeepSeek, Workers AI) ----------

type OpenAiEngine = "deepseek" | "workers";

type OpenAiOut = {
  response?: string | object;
  choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: any[] } }[];
};

type OpenAiBody = { messages: any[]; tools?: any[]; max_tokens: number; reasoning_effort?: "low" | "medium" | "high" };

/** One assistant message, however it arrived. */
type OpenAiMessage = { content: string; reasoning_content?: string; tool_calls: any[] };

/** Workers AI's gpt-oss takes `reasoning_effort`; DeepSeek gets only standard fields. */
function openAiBody(engine: OpenAiEngine, body: OpenAiBody): OpenAiBody {
  if (engine === "workers") return body;
  const { reasoning_effort: _, ...rest } = body;
  return rest;
}

async function openAiCall(env: LlmEnv, engine: OpenAiEngine, body: OpenAiBody, stream: boolean): Promise<any> {
  if (engine === "workers") {
    return env.AI.run(env.FALLBACK_MODEL as keyof AiModels, { ...openAiBody(engine, body), ...(stream && { stream: true }) } as never);
  }
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: env.DEEPSEEK_MODEL, ...openAiBody(engine, body), ...(stream && { stream: true }) }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${env.DEEPSEEK_MODEL} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return stream ? res.body : res.json();
}

function openAiText(out: OpenAiOut) {
  const text =
    typeof out.response === "string"
      ? out.response
      : out.response
        ? JSON.stringify(out.response)
        : (out.choices?.[0]?.message?.content ?? "");
  return stripThinking(text);
}

/** One model turn. Streamed when `onText` is set; either way returns the whole message. */
async function openAiRound(env: LlmEnv, engine: OpenAiEngine, body: OpenAiBody, onText?: OnText): Promise<OpenAiMessage> {
  if (!onText) {
    const out = (await openAiCall(env, engine, body, false)) as OpenAiOut;
    const message = out.choices?.[0]?.message;
    return { content: openAiText(out), reasoning_content: message?.reasoning_content, tool_calls: message?.tool_calls ?? [] };
  }
  const stream = (await openAiCall(env, engine, body, true)) as ReadableStream<Uint8Array>;
  let content = "";
  let reasoning = "";
  const calls: any[] = [];
  for await (const data of sseData(stream)) {
    const chunk = JSON.parse(data);
    const delta = chunk.choices?.[0]?.delta;
    // Workers AI ends with {"response": "", usage}; older models stream only `response`.
    const text: string = delta?.content ?? (typeof chunk.response === "string" ? chunk.response : "");
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
    for (const tc of delta?.tool_calls ?? []) {
      const slot = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (text) {
      content += text;
      if (onText(text) === false) break;
    }
  }
  return { content: stripThinking(content), reasoning_content: reasoning || undefined, tool_calls: calls.filter(Boolean) };
}

async function openAiGenerate(env: LlmEnv, engine: OpenAiEngine, { system, turns, json, fast }: Options): Promise<string> {
  const systemText = json
    ? `${system}\n\nRespond with only a JSON object matching this JSON schema, no other text:\n${JSON.stringify(json.schema)}`
    : system;

  const { content } = await openAiRound(env, engine, {
    messages: [
      { role: "system", content: systemText },
      ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
    ],
    max_tokens: 2048,
    ...(fast && { reasoning_effort: "low" as const }),
  });

  let text = content;
  if (json) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${ENGINE_NAMES[engine]} returned no JSON: ${text.slice(0, 200)}`);
    text = match[0];
  }
  if (!text) throw new Error(`${ENGINE_NAMES[engine]} returned no text`);
  return text;
}

async function openAiToolLoop(
  env: LlmEnv,
  engine: OpenAiEngine,
  { system, turns, tools, callTool, voice, onText }: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: OpenAiEngine }>,
): Promise<ChatOutcome> {
  const messages: any[] = paused?.messages ?? [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
  ];
  const toolDefs = tools.map((t) => ({ type: "function", function: t }));

  for (let round = paused?.round ?? 0; round <= MAX_TOOL_ROUNDS; round++) {
    const message = await openAiRound(
      env,
      engine,
      {
        messages,
        ...(round < MAX_TOOL_ROUNDS && toolDefs.length && { tools: toolDefs }),
        max_tokens: 4096,
        // Measured on gpt-oss-120b: about 4x faster to a spoken answer, and tool calls still work.
        ...(voice && { reasoning_effort: "low" as const }),
      },
      onText,
    );

    const calls = message.tool_calls;
    if (!calls.length) {
      if (!message.content) throw new Error(`${ENGINE_NAMES[engine]} returned no text`);
      return { kind: "reply", text: message.content, engine };
    }

    // Workers AI rejects null content on assistant turns; DeepSeek wants its reasoning sent back.
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: calls,
      ...(message.reasoning_content && { reasoning_content: message.reasoning_content }),
    });
    const slots: { id: string; index: number }[] = [];
    const deferred: DeferredCall[] = [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {}
      const result = await safeCall(callTool, call.function?.name, args);
      let content = "";
      if (result === DEFER) {
        const id = crypto.randomUUID();
        slots.push({ id, index: messages.length }); // filled in on resume
        deferred.push({ id, name: call.function?.name, args });
      } else {
        content = toolResultText(result);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    if (deferred.length) {
      return { kind: "paused", state: { engine, round: round + 1, messages, slots }, calls: deferred, engine };
    }
  }
  throw new Error("Too many tool rounds");
}
