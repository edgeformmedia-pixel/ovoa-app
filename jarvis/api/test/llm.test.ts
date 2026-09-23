// The engines end to end, with the providers faked: a Workers AI binding that
// streams what a test hands it, and a fetch that plays Z.ai. These are the
// parts a pure function can't show: what is actually sent (the thinking field,
// the prompt-cache header), how a stream is read (reasoning timed, never
// spoken), when a round's preface is voiced, which model a paused turn comes
// back on, the spoken first-word deadline (Workers AI's, never Z.ai's), a call
// called off, and the last engine never being put out of reach. What a refusal
// for good does to the cooldowns is in llmCooldown.test.ts, on a fresh isolate.
//
// The cooldowns are per isolate, so the order of the sections matters: each
// says what it leaves cooling.

import { sentenceStream } from "../src/sentences";
import {
  chatWithTools,
  DEFER,
  engineStatus,
  generateText,
  isAiUnreachable,
  isCooling,
  type EngineAttempt,
  type LlmEnv,
  type LlmUsage,
} from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const encoder = new TextEncoder();

/** A server-sent-events body carrying `chunks`, the way both hosts stream. */
function sse(chunks: unknown[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

const say = (content: string) => ({ choices: [{ delta: { content } }] });
const toolCall = (name: string, args: unknown, id = "call_1") => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});
const counts = (input: number, cached: number, output: number) => ({ choices: [], usage: { prompt_tokens: input, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: output } });

/** A Workers AI binding that answers each call with the next of `rounds`, and remembers what it was asked. */
function fakeAi(rounds: (() => ReadableStream<Uint8Array>)[]) {
  const calls: { model: string; inputs: any; options: any }[] = [];
  const ai = {
    run: async (model: string, inputs: any, options: any) => {
      calls.push({ model, inputs, options });
      const next = rounds.shift();
      if (!next) throw new Error("no more rounds");
      return next();
    },
  };
  return { ai: ai as unknown as Ai, calls };
}

/**
 * A fetch that plays Z.ai the way it streams GLM 5.3: reasoning at once, its
 * first word only after `firstWordMs`. Gemini refuses its key (403), as on
 * 2026-09-23. Counts who was asked; `restore` puts the real fetch back.
 */
function fakeHosts(firstWordMs: number) {
  const asked = { glm: 0, gemini: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("googleapis")) {
      asked.gemini++;
      return new Response('{"error":{"code":403,"status":"PERMISSION_DENIED"}}', { status: 403 });
    }
    asked.glm++;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "The user wants" } }] })}\n\n`));
        setTimeout(() => {
          for (const chunk of [say("Your alarm is at seven."), counts(6_700, 0, 7)]) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        }, firstWordMs);
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = realFetch) };
}

const usage = { userId: "u1", purpose: "voice" };
const base = { model: "gemini-3.5-flash-lite", system: "You are OVOA.", tools: [{ name: "web_search", description: "Search", parameters: { type: "object" } }] };

// ---------- A spoken turn on Workers AI ----------

{
  const { ai, calls } = fakeAi([
    () => sse([{ choices: [{ delta: { reasoning: "hmm" } }] }, say("Sure, "), say("it's seven."), counts(6_700, 5_000, 12)]),
  ]);
  const usages: LlmUsage[] = [];
  const heard: string[] = [];
  const outcome = await chatWithTools({ AI: ai, WORKERS_MODEL: "@cf/zai-org/glm-5.3-flash" }, {
    ...base,
    turns: [{ role: "user", text: "What time is my alarm?" }],
    callTool: async () => ({}),
    usage,
    onUsage: (u) => usages.push(u),
    voice: true,
    onText: (d) => void heard.push(d),
  });
  const sent = calls[0];
  eq("a spoken turn goes to Workers AI first", outcome.kind === "reply" && outcome.engine, "workers");
  eq("on GLM 5.3 Flash", sent.model, "@cf/zai-org/glm-5.3-flash");
  eq("asked for reasoning_effort low", sent.inputs.reasoning_effort, "low");
  eq("never chat_template_kwargs", "chat_template_kwargs" in sent.inputs, false);
  eq("streamed, with the counts asked for", `${sent.inputs.stream} ${sent.inputs.stream_options?.include_usage}`, "true true");
  eq("no Z.ai-only field", "tool_stream" in sent.inputs, false);
  eq("the person's prompt cache", sent.options.extraHeaders?.["x-session-affinity"], "ovoa-u1");
  eq("with a signal to stop it by", sent.options.signal instanceof AbortSignal, true);
  eq("the reasoning is never spoken", heard.join(""), "Sure, it's seven.");
  eq("the reply", outcome.kind === "reply" && outcome.text, "Sure, it's seven.");
  const u = usages[0];
  eq("the usage row is filed under workers", `${u.engine} ${u.model}`, "workers @cf/zai-org/glm-5.3-flash");
  eq("with the cached tokens", `${u.inputTokens} ${u.cachedTokens} ${u.outputTokens}`, "6700 5000 12");
  eq("and the round's timing marks", ["headersMs", "firstEventMs", "firstReasoningMs", "firstContentMs", "endMs"].every((k) => typeof (u.timing as any)?.[k] === "number"), true);
  eq("reasoning in `reasoning` is timed and counted", u.timing?.reasoningChars, 3);
  eq("no tool call, no tool mark", u.timing?.firstToolMs, undefined);
}

// ---------- The words before a tool call are spoken while it runs ----------

{
  const { ai } = fakeAi([
    () => sse([say("Checking the weather."), toolCall("web_search", { q: "weather" }), counts(100, 0, 10)]),
    () => sse([say("It's sunny and 22."), counts(200, 100, 8)]),
  ]);
  const events: string[] = [];
  const spoken = sentenceStream((s) => events.push(`said: ${s}`), undefined, { firstClause: true });
  const usages: LlmUsage[] = [];
  await chatWithTools({ AI: ai }, {
    ...base,
    turns: [{ role: "user", text: "What's the weather?" }],
    callTool: async (name) => {
      events.push(`ran: ${name}`);
      return { answer: "sunny, 22" };
    },
    usage,
    onUsage: (u) => usages.push(u),
    voice: true,
    onText: (d) => spoken.push(d),
  });
  spoken.end();
  eq("the preface is voiced before the tool runs", events, ["said: Checking the weather.", "ran: web_search", "said: It's sunny and 22."]);
  eq("and the next round isn't glued on to it", spoken.text(), "Checking the weather.\nIt's sunny and 22.");
  eq("the tool round has its tool mark", typeof usages[0].timing?.firstToolMs, "number");
}

// ---------- A paused turn comes back on the model it paused on ----------

{
  const { ai, calls } = fakeAi([
    () => sse([say("Looking her up."), toolCall("phone_contacts_search", { name: "Danya" }, "call_9"), counts(100, 0, 9)]),
    () => sse([say("Texting Danya now."), counts(300, 200, 6)]),
  ]);
  const turn = {
    ...base,
    turns: [{ role: "user" as const, text: "Text Danya I'm on my way" }],
    callTool: async () => DEFER,
    usage,
    voice: true,
    onText: () => {},
  };
  const first = await chatWithTools({ AI: ai, WORKERS_MODEL: "@cf/zai-org/glm-5.3-flash" }, turn);
  eq("the phone lookup pauses the turn", first.kind, "paused");
  // Stored as JSON between the two requests (index.ts paused_turns).
  const state = first.kind === "paused" ? JSON.parse(JSON.stringify(first.state)) : null;
  eq("the pause remembers the engine and the model", `${state?.engine} ${state?.model}`, "workers @cf/zai-org/glm-5.3-flash");
  const id = first.kind === "paused" ? first.calls[0].id : "";
  const attempts: EngineAttempt[] = [];
  const done = await chatWithTools(
    { AI: ai, WORKERS_MODEL: "@cf/zai-org/some-other-model" },
    { ...turn, onAttempt: (a) => attempts.push(a), resume: { state, results: { [id]: { contacts: [{ name: "Danya" }] } } } },
  );
  eq("the resumed turn answers", done.kind === "reply" && done.text, "Texting Danya now.");
  eq("on the model it paused on, though the var changed since", calls[1].model, "@cf/zai-org/glm-5.3-flash");
  eq("and says so in the engine table", attempts.map((a) => `${a.engine} ${a.model} ${a.outcome}`).join(","), "workers @cf/zai-org/glm-5.3-flash ok");
  const tool = calls[1].inputs.messages.find((m: any) => m.role === "tool");
  eq("with the phone's answer in its place", tool?.content, '{"contacts":[{"name":"Danya"}]}');
}

// ---------- A call called off ----------

{
  // Leaves nothing cooling.
  let upstream = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstream++;
    return new Response("unused", { status: 500 });
  }) as typeof fetch;
  const { ai } = fakeAi([
    () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(`data: ${JSON.stringify(say("Hel"))}\n\n`));
        },
      }),
  ]);
  const stop = new AbortController();
  let err: unknown = null;
  try {
    await chatWithTools({ AI: ai, GLM_API_KEY: "k" }, {
      ...base,
      turns: [{ role: "user", text: "and then the weather was" }],
      callTool: async () => ({}),
      usage,
      voice: true,
      signal: stop.signal,
      // The line turned out not to be for OVOA, as its first word streams.
      onText: () => stop.abort(new Error("not meant for OVOA")),
    });
  } catch (e) {
    err = e;
  }
  eq("called off: the call throws the reason it was called off for", (err as Error)?.message, "not meant for OVOA");
  eq("no other engine is tried", upstream, 0);
  eq("and the engine isn't cooled down for it", isCooling("workers"), false);
  let early: unknown = null;
  await generateText({ AI: ai }, { model: "m", system: "s", turns: [{ role: "user", text: "hi" }], usage, signal: stop.signal }).catch((e) => (early = e));
  eq("a call already called off sends nothing", (early as Error)?.message, "not meant for OVOA");
  globalThis.fetch = realFetch;
}

// ---------- voice_engine glm: Z.ai's slow first word is waited for ----------

{
  // Leaves nothing cooling. The first-word deadline is Workers AI's alone: with
  // GLM first (the rollback), its ordinary 4.5-6.6 s first word sat right at the
  // limit and was cut off on to Gemini's 403 (here 1.5 s against a 1 s limit).
  const { ai, calls } = fakeAi([() => sse([say("Wrong engine."), counts(10, 0, 2)])]);
  const hosts = fakeHosts(1_500);
  const attempts: EngineAttempt[] = [];
  const outcome = await chatWithTools({ AI: ai, GLM_API_KEY: "k", GEMINI_API_KEY: "g", VOICE_FIRST_CONTENT_MS: "1000" }, {
    ...base,
    turns: [{ role: "user", text: "When's my alarm?" }],
    callTool: async () => ({}),
    usage,
    voice: true,
    prefer: { voice: "glm" },
    onText: () => {},
    onAttempt: (a) => attempts.push(a),
  });
  eq("GLM first on a spoken turn answers, past the limit", outcome.kind === "reply" && `${outcome.engine}: ${outcome.text}`, "glm: Your alarm is at seven.");
  eq("with nothing else tried", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "glm:ok");
  eq("Gemini is never asked", hosts.asked.gemini, 0);
  eq("nor Workers AI", calls.length, 0);
  hosts.restore();
}

// ---------- Workers AI silent: the spoken turn moves on to GLM ----------

{
  // Leaves Workers AI cooling for 15 s.
  let cancelled = false;
  const { ai } = fakeAi([
    () =>
      new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => {}),
        cancel: () => {
          cancelled = true;
        },
      }),
  ]);
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse([say("Your alarm is at seven."), counts(6_700, 0, 7)]), { status: 200 });
  }) as typeof fetch;
  const attempts: EngineAttempt[] = [];
  const at = Date.now();
  const outcome = await chatWithTools({ AI: ai, GLM_API_KEY: "k", VOICE_FIRST_CONTENT_MS: "1000" }, {
    ...base,
    turns: [{ role: "user", text: "When's my alarm?" }],
    callTool: async () => ({}),
    usage,
    voice: true,
    onText: () => {},
    onAttempt: (a) => attempts.push(a),
  });
  const ms = Date.now() - at;
  eq("GLM answers instead", outcome.kind === "reply" && `${outcome.engine}: ${outcome.text}`, "glm: Your alarm is at seven.");
  eq("after the first-word deadline, not the 20 s connect one", ms >= 1000 && ms < 5000, true);
  eq("the silent engine is written down as a timeout", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "workers:timeout,glm:ok");
  eq("its stream is let go of upstream", cancelled, true);
  eq("Z.ai is asked to stream tool calls (GLM_TOOL_STREAM unset)", bodies[0].tool_stream, true);
  eq("and GLM 5.3 still thinks at its floor there", bodies[0].reasoning_effort, "low");
  globalThis.fetch = realFetch;
}

// ---------- Workers AI cooling: GLM, first now, is waited for ----------

{
  // Leaves Workers AI cooling from the section above. The case a scripted run
  // found (2026-09-23): the next spoken turn, GLM first and slow, was cut off at
  // the limit, Gemini refused it, and the person heard "can't reach the AI"
  // half a second before GLM would have spoken.
  const { ai } = fakeAi([]);
  const hosts = fakeHosts(1_500);
  const attempts: EngineAttempt[] = [];
  const outcome = await chatWithTools({ AI: ai, GLM_API_KEY: "k", GEMINI_API_KEY: "g", VOICE_FIRST_CONTENT_MS: "1000" }, {
    ...base,
    turns: [{ role: "user", text: "When's my alarm?" }],
    callTool: async () => ({}),
    usage,
    voice: true,
    onText: () => {},
    onAttempt: (a) => attempts.push(a),
  });
  eq("GLM answers the spoken turn", outcome.kind === "reply" && outcome.engine, "glm");
  eq("Workers AI skipped, GLM waited for", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "workers:skipped,glm:ok");
  eq("and Gemini's 403 never reached", hosts.asked.gemini, 0);
  eq("GLM isn't cooled down for being slow", isCooling("glm"), false);
  hosts.restore();
}

// ---------- GLM_TOOL_STREAM off ----------

{
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse([say("Done."), counts(10, 0, 1)]), { status: 200 });
  }) as typeof fetch;
  await chatWithTools({ GLM_API_KEY: "k", GLM_TOOL_STREAM: "off" }, {
    ...base,
    turns: [{ role: "user", text: "hi" }],
    callTool: async () => ({}),
    usage: { userId: "u1", purpose: "chat" },
    onText: () => {},
  });
  eq("GLM_TOOL_STREAM off: no tool_stream", "tool_stream" in bodies[0], false);
  globalThis.fetch = realFetch;
}

// ---------- The last engine able to answer is never put out of reach ----------

{
  // Leaves GLM cooling for up to 3 s.
  let upstream = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstream++;
    return new Response("upstream went away", { status: 500 });
  }) as typeof fetch;
  const glmOnly: LlmEnv = { GLM_API_KEY: "k" };
  const ask = async (attempts: EngineAttempt[]) => {
    try {
      await generateText(glmOnly, { model: "m", system: "s", turns: [{ role: "user", text: "hi" }], usage, onAttempt: (a) => attempts.push(a) });
      return null;
    } catch (err) {
      return err;
    }
  };
  const firstTry: EngineAttempt[] = [];
  eq("GLM failing alone: the AI is out of reach", isAiUnreachable(await ask(firstTry)), true);
  const glm = engineStatus(glmOnly).engines.find((e) => e.engine === "glm");
  eq("but GLM, the only engine, rests seconds, not 15 s", (glm?.coolingForS ?? 99) <= 3, true);
  const secondTry: EngineAttempt[] = [];
  eq("the next call still fails plainly", isAiUnreachable(await ask(secondTry)), true);
  eq("having tried GLM again rather than nothing", upstream, 2);
  // (Workers AI, still cooling from the section above, is written down as skipped.)
  eq("which is not written down as skipped", secondTry.filter((a) => a.engine === "glm").map((a) => `${a.engine}:${a.outcome}`).join(","), "glm:upstream_5xx");
  globalThis.fetch = realFetch;
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
