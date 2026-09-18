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
  | { kind: "reply"; text: string }
  | { kind: "paused"; state: LoopState; calls: DeferredCall[] };

type ToolLoopOptions = { model: string; system: string; turns: Turn[]; tools: ToolSpec[]; callTool: CallTool };

type Engine = "gemini" | OpenAiEngine;

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

/**
 * Engines in the order they're tried: Gemini and DeepSeek when their keys are set,
 * then Cloudflare Workers AI, so chat keeps working if the others fail or run out.
 */
function engines(env: LlmEnv): Engine[] {
  const keyed: (Engine | false)[] = [!!env.GEMINI_API_KEY && "gemini", !!env.DEEPSEEK_API_KEY && "deepseek"];
  return [...keyed.filter((e): e is Engine => !!e), "workers"];
}

function logFallback(from: Engine, to: Engine, err: unknown) {
  console.error(`${ENGINE_NAMES[from]} failed, using ${ENGINE_NAMES[to]} fallback`, err);
}

export async function generateText(env: LlmEnv, opts: Options): Promise<string> {
  const order = engines(env);
  for (const [i, engine] of order.entries()) {
    try {
      return engine === "gemini"
        ? await geminiGenerate({ apiKey: env.GEMINI_API_KEY!, ...opts })
        : await openAiGenerate(env, engine, opts);
    } catch (err) {
      if (i === order.length - 1) throw err;
      logFallback(engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

/**
 * Chat that may call tools. Moves to the next engine only if one fails before any tool ran.
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
      return geminiToolLoop(env.GEMINI_API_KEY!, opts, state);
    }
    for (const slot of state.slots) state.messages[slot.index].content = toolResultText(result(slot.id));
    return openAiToolLoop(env, state.engine, opts, state);
  }

  if (!opts.tools.length) return { kind: "reply", text: await generateText(env, opts) };
  let toolsRan = false;
  const tracked: CallTool = (name, args) => {
    toolsRan = true;
    return opts.callTool(name, args);
  };
  const order = engines(env);
  for (const [i, engine] of order.entries()) {
    try {
      return engine === "gemini"
        ? await geminiToolLoop(env.GEMINI_API_KEY!, { ...opts, callTool: tracked })
        : await openAiToolLoop(env, engine, { ...opts, callTool: tracked });
    } catch (err) {
      if (toolsRan || i === order.length - 1) throw err;
      logFallback(engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

// ---------- Gemini ----------

/** Gemini wants an object; oversized results go as truncated text. */
function geminiResponse(result: unknown) {
  const text = toolResultText(result);
  return { result: text.length > MAX_TOOL_RESULT_CHARS ? text : (result ?? null) };
}

async function geminiToolLoop(
  apiKey: string,
  { model, system, turns, tools, callTool }: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: "gemini" }>,
): Promise<ChatOutcome> {
  const contents: any[] = paused?.contents ?? turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));

  for (let round = paused?.round ?? 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        // No tools on the last round, so the model has to answer.
        ...(round < MAX_TOOL_ROUNDS && { tools: [{ functionDeclarations: tools }] }),
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as any;
    const content = data.candidates?.[0]?.content;
    const parts: any[] = content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("");
      if (!text) throw new Error(`Gemini ${model} returned no text`);
      return { kind: "reply", text };
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
      return { kind: "paused", state: { engine: "gemini", round: round + 1, contents, slots }, calls: deferred };
    }
  }
  throw new Error("Too many tool rounds");
}

// ---------- OpenAI-style engines (DeepSeek, Workers AI) ----------

type OpenAiEngine = "deepseek" | "workers";

type OpenAiOut = {
  response?: string | object;
  choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: any[] } }[];
};

type OpenAiRun = (body: { messages: any[]; tools?: any[]; max_tokens: number }) => Promise<OpenAiOut>;

function openAiRunner(env: LlmEnv, engine: OpenAiEngine): OpenAiRun {
  if (engine === "workers") {
    return (body) => env.AI.run(env.FALLBACK_MODEL as keyof AiModels, body as never) as Promise<OpenAiOut>;
  }
  return async (body) => {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: env.DEEPSEEK_MODEL, ...body }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${env.DEEPSEEK_MODEL} ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return res.json();
  };
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

async function openAiGenerate(env: LlmEnv, engine: OpenAiEngine, { system, turns, json }: Options): Promise<string> {
  const systemText = json
    ? `${system}\n\nRespond with only a JSON object matching this JSON schema, no other text:\n${JSON.stringify(json.schema)}`
    : system;

  const out = await openAiRunner(env, engine)({
    messages: [
      { role: "system", content: systemText },
      ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
    ],
    max_tokens: 2048,
  });

  let text = openAiText(out);
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
  { system, turns, tools, callTool }: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: OpenAiEngine }>,
): Promise<ChatOutcome> {
  const run = openAiRunner(env, engine);
  const messages: any[] = paused?.messages ?? [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
  ];
  const toolDefs = tools.map((t) => ({ type: "function", function: t }));

  for (let round = paused?.round ?? 0; round <= MAX_TOOL_ROUNDS; round++) {
    const out = await run({
      messages,
      ...(round < MAX_TOOL_ROUNDS && { tools: toolDefs }),
      max_tokens: 4096,
    });

    const message = out.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!calls.length) {
      const text = openAiText(out);
      if (!text) throw new Error(`${ENGINE_NAMES[engine]} returned no text`);
      return { kind: "reply", text };
    }

    // Workers AI rejects null content on assistant turns; DeepSeek wants its reasoning sent back.
    messages.push({
      role: "assistant",
      content: message?.content ?? "",
      tool_calls: calls,
      ...(message?.reasoning_content && { reasoning_content: message.reasoning_content }),
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
      return { kind: "paused", state: { engine, round: round + 1, messages, slots }, calls: deferred };
    }
  }
  throw new Error("Too many tool rounds");
}
