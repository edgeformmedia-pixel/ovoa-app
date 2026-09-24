// The engines end to end, with the providers faked: a Workers AI binding that
// streams what a test hands it, and a fetch that plays Z.ai. These are the
// parts a pure function can't show: what is actually sent (the thinking field,
// the prompt-cache header), how a stream is read (reasoning timed, never
// spoken), when a round's preface is voiced, which model a paused turn comes
// back on, a tool name with junk after it, a reply that claims what no tool
// did (repairClaims), the spoken first-word deadline (Workers AI's, never
// Z.ai's), a call called off, and the last engine never being put out of
// reach. What a refusal for good does to the cooldowns is in
// llmCooldown.test.ts, on a fresh isolate. Which requests and replies count as
// a claim is in claims.test.ts.
//
// The cooldowns are per isolate, so the order of the sections matters: each
// says what it leaves cooling.

import { CLAIM_NUDGE } from "../src/claims";
import { sentenceStream } from "../src/sentences";
import {
  chatWithTools,
  DEFER,
  engineStatus,
  generateText,
  isAiUnreachable,
  isCooling,
  toolArgsFrom,
  toolNameFor,
  type EngineAttempt,
  type LlmEnv,
  type LlmUsage,
  type ToolSpec,
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

// ---------- A tool name with junk after it goes to the tool it meant ----------

const spec = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object" } });

{
  // Leaves nothing cooling. Workers AI's GLM streamed "money_afford</arg_value>" in production (2026-09-23).
  eq("an offered name is kept", toolNameFor("money_afford", ["money_afford"]), "money_afford");
  eq("junk after the name is dropped", toolNameFor("money_afford</arg_value>", ["money_status", "money_afford"]), "money_afford");
  eq("the longest offered name it starts with", toolNameFor("money_afford_now", ["money", "money_afford"]), "money_afford");
  eq("space around it too", toolNameFor(" alarm_set\n", ["alarm_set"]), "alarm_set");
  eq("a name that starts with no offered one is left alone", toolNameFor("wire_money", ["money_afford"]), "wire_money");
  eq("nothing offered, nothing changed", toolNameFor("alarm_set>", []), "alarm_set>");

  // Arguments: every resumed turn after a contacts lookup failed with Workers AI's
  // 8007 "function.arguments must be valid JSON" (error_events, 2026-09-23).
  eq("JSON as it should be", toolArgsFrom('{"query":"Ty"}'), { args: { query: "Ty" }, repaired: false });
  eq("nothing, for a tool that takes nothing", toolArgsFrom(""), { args: {}, repaired: false });
  eq("an object handed over as one", toolArgsFrom({ query: "Ty" }), { args: { query: "Ty" }, repaired: true });
  eq("a template's tail glued on", toolArgsFrom('{"query":"Ty"}</arg_value>'), { args: { query: "Ty" }, repaired: true });
  eq("encoded twice", toolArgsFrom(JSON.stringify('{"query":"Ty"}')), { args: { query: "Ty" }, repaired: true });
  eq(
    "GLM's own template",
    toolArgsFrom("<arg_key>query</arg_key><arg_value>Ty</arg_value><arg_key>limit</arg_key><arg_value>3</arg_value>"),
    { args: { query: "Ty", limit: 3 }, repaired: true },
  );
  eq("junk is nothing", toolArgsFrom("[object Object]"), { args: {}, repaired: true });

  const { ai, calls } = fakeAi([
    () => sse([toolCall("money_afford</arg_value>", { amount: 60 }), counts(100, 0, 9)]),
    () => sse([say("Yes, with room to spare."), counts(200, 100, 6)]),
  ]);
  const ran: string[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("money_status"), spec("money_afford")],
    turns: [{ role: "user", text: "Can I afford a sixty dollar dinner this week?" }],
    callTool: async (name) => {
      ran.push(name);
      return { verdict: "fine" };
    },
    usage,
    voice: true,
    onText: () => {},
  });
  eq("the call reaches the tool it meant", ran.join(","), "money_afford");
  const sentBack = calls[1].inputs.messages.find((m: any) => m.tool_calls)?.tool_calls[0].function.name;
  eq("and goes back to the model under that name", sentBack, "money_afford");
  eq("the turn answers", outcome.kind === "reply" && outcome.text, "Yes, with room to spare.");
}

{
  // Arguments that weren't JSON go to the tool as meant, and back to the model as JSON.
  const rawCall = (name: string, args: unknown, id: string) => ({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] } }],
  });
  const { ai, calls } = fakeAi([
    () => sse([rawCall("phone_contacts_search", '{"query":"Ty"}</arg_value>', "c1"), counts(100, 0, 9)]),
    () => sse([rawCall("alarm_list", "", "c2"), counts(120, 100, 4)]),
    () => sse([rawCall("todo_list", { day: "today" }, "c3"), counts(140, 120, 4)]),
    () => sse([say("Ty's number is saved, and your day is clear."), counts(200, 100, 6)]),
  ]);
  const got: string[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("phone_contacts_search"), spec("alarm_list"), spec("todo_list")],
    turns: [{ role: "user", text: "Do I have Ty's number, and what's on today?" }],
    callTool: async (name, args) => {
      got.push(`${name}:${JSON.stringify(args)}`);
      return { ok: true };
    },
    usage,
    voice: true,
    onText: () => {},
  });
  eq("each tool gets its arguments as meant", got, ['phone_contacts_search:{"query":"Ty"}', "alarm_list:{}", 'todo_list:{"day":"today"}']);
  const echoed = calls[3].inputs.messages.filter((m: any) => m.tool_calls).map((m: any) => m.tool_calls[0].function.arguments);
  eq("and every call goes back to the model as JSON", echoed, ['{"query":"Ty"}', "{}", '{"day":"today"}']);
  eq("the turn answers", outcome.kind === "reply" && outcome.text, "Ty's number is saved, and your day is clear.");
}

// ---------- A reply that claims what no tool did gets one more round ----------

{
  // Leaves nothing cooling. The spoken bench turn, 2026-09-23: "Noted — milk and eggs." and no tool.
  const { ai, calls } = fakeAi([
    () => sse([say("Noted — milk and eggs."), counts(6_700, 5_000, 6)]),
    () => sse([toolCall("note_add", { text: "milk and eggs" }), counts(6_720, 6_700, 8)]),
  ]);
  const heard: string[] = [];
  const ran: string[] = [];
  const usages: LlmUsage[] = [];
  const attempts: EngineAttempt[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("note_add")],
    turns: [{ role: "user", text: "[It is now Wednesday, September 23, 2026 at 7:37 PM.]\n\nAdd milk and eggs to my notes." }],
    callTool: async (name) => {
      ran.push(name);
      return { saved: true };
    },
    usage,
    onUsage: (u) => usages.push(u),
    onAttempt: (a) => attempts.push(a),
    voice: true,
    onText: (d) => void heard.push(d),
    repairClaims: true,
  });
  eq("the claimed tool runs", ran.join(","), "note_add");
  eq("the reply is the one that was given", outcome.kind === "reply" && outcome.text, "Noted — milk and eggs.");
  eq("and the outcome says it was repaired", outcome.claim, "repaired");
  eq("the claim's sentence is ended, and nothing from the repair round is heard", heard.join(""), "Noted — milk and eggs.\n");
  eq("one extra round, not two", calls.length, 2);
  // The array the loop went on to add the call and its result to: system, the turn, then what the repair round was sent.
  const [, , gave, nudge] = calls[1].inputs.messages;
  eq("the repair round has the reply it gave", JSON.stringify(gave), JSON.stringify({ role: "assistant", content: "Noted — milk and eggs." }));
  eq("then the nudge", `${nudge.role}: ${nudge.content === CLAIM_NUDGE}`, "user: true");
  eq("with the turn's tools", calls[1].inputs.tools?.map((t: any) => t.function.name).join(","), "web_search,note_add");
  eq("on the same model and the person's prompt cache", `${calls[1].model} ${calls[1].options.extraHeaders?.["x-session-affinity"]}`, "@cf/zai-org/glm-5.3-flash ovoa-u1");
  eq("its tokens are counted with the turn's", usages.length, 2);
  eq("and the engine table has one answer", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "workers:ok");
}

{
  // Leaves nothing cooling. The typed bench turn: a reminder claimed, and the repair round only talks.
  const { ai, calls } = fakeAi([
    () => sse([say("Reminder set for Friday at 9:00 am — submit the report."), counts(100, 0, 9)]),
    () => sse([say("Sorry about that."), counts(120, 100, 4)]),
  ]);
  const heard: string[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    turns: [{ role: "user", text: "Remind me to submit the report on Friday at 9am." }],
    callTool: async () => ({}),
    usage: { userId: "u1", purpose: "chat" },
    onText: (d) => void heard.push(d),
    repairClaims: true,
  });
  eq("a repair round that calls no tool leaves the reply", outcome.kind === "reply" && outcome.text, "Reminder set for Friday at 9:00 am — submit the report.");
  eq("and says it stands unrepaired", outcome.claim, "unrepaired");
  eq("its words aren't heard either", heard.join(""), "Reminder set for Friday at 9:00 am — submit the report.\n");
  eq("still only one extra round", calls.length, 2);
}

{
  // Leaves nothing cooling: a repair round that fails is no engine's failure to rest.
  const { ai } = fakeAi([() => sse([say("Done — 6:30 alarm set for tomorrow morning."), counts(100, 0, 9)])]);
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    turns: [{ role: "user", text: "Set an alarm for 6:30 tomorrow." }],
    callTool: async () => ({}),
    usage,
    onText: () => {},
    repairClaims: true,
  });
  eq("a repair round that fails still gives the reply", outcome.kind === "reply" && `${outcome.text} (${outcome.claim})`, "Done — 6:30 alarm set for tomorrow morning. (unrepaired)");
  eq("and rests nothing", isCooling("workers"), false);
}

{
  // A tool the repair round calls that fails doesn't make the claim true.
  const { ai } = fakeAi([
    () => sse([say("Done — 6:30 alarm set for tomorrow morning."), counts(100, 0, 9)]),
    () => sse([toolCall("alarm_set", { time: "06:30" }), counts(120, 100, 5)]),
  ]);
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("alarm_set")],
    turns: [{ role: "user", text: "Set an alarm for 6:30 tomorrow." }],
    callTool: async () => ({ error: "No band connected" }),
    usage,
    onText: () => {},
    repairClaims: true,
  });
  eq("a repair whose tool failed is unrepaired", outcome.claim, "unrepaired");
}

{
  // Sending for tools does nothing by itself: a turn whose only call was more_tools is still repaired.
  const tools = [...base.tools, spec("more_tools")];
  const { ai, calls } = fakeAi([
    () => sse([toolCall("more_tools", { need: "send an email" }), counts(100, 0, 5)]),
    () => sse([say("Sent — told Ty you're running late."), counts(200, 100, 8)]),
    () => sse([toolCall("gmail_send", { to: "Ty" }), counts(220, 200, 6)]),
  ]);
  const ran: string[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools,
    turns: [{ role: "user", text: "Email Ty that I'm running late." }],
    callTool: async (name) => {
      ran.push(name);
      if (name === "more_tools") tools.push(spec("gmail_send"));
      return { ok: true };
    },
    usage,
    onText: () => {},
    repairClaims: true,
  });
  eq("more_tools then a claim: the repair sends the email", `${ran.join(",")} ${outcome.claim}`, "more_tools,gmail_send repaired");
  eq("with the tools more_tools brought", calls[2].inputs.tools.some((t: any) => t.function.name === "gmail_send"), true);
}

{
  // Leaves nothing cooling. The claim is heard before the repair round goes out, not
  // once the turn ends: sentences.ts holds a last sentence until something follows it.
  const events: string[] = [];
  const spoken = sentenceStream((s) => events.push(`said: ${s}`), undefined, { firstClause: true });
  const { ai } = fakeAi([
    () => sse([say("Reminder set for Friday at 9:00 am — submit the report."), counts(100, 0, 9)]),
    () => {
      events.push("repair round asked");
      return sse([toolCall("reminder_set", { when: "Friday 09:00", text: "submit the report" }), counts(120, 100, 6)]);
    },
  ]);
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("reminder_set")],
    turns: [{ role: "user", text: "Remind me to submit the report on Friday at 9am." }],
    callTool: async (name) => {
      events.push(`ran: ${name}`);
      return { ok: true };
    },
    usage,
    voice: true,
    onText: (d) => spoken.push(d),
    repairClaims: true,
  });
  spoken.end();
  eq(
    "the whole claim is voiced before the repair round is asked",
    events,
    ["said: Reminder set for Friday at 9:00 am —", "said: submit the report.", "repair round asked", "ran: reminder_set"],
  );
  eq("and kept as it was said", spoken.text(), "Reminder set for Friday at 9:00 am — submit the report.");
  eq("repaired", outcome.claim, "repaired");
}

{
  // Leaves nothing cooling. A spoken turn carries few tools: the repair sends for the one
  // the claim needs, and calls it in the next round.
  const tools = [...base.tools, spec("more_tools")];
  const { ai, calls } = fakeAi([
    () => sse([say("Added eggs to your shopping list."), counts(100, 0, 7)]),
    () => sse([toolCall("more_tools", { need: "add to a list" }), counts(120, 100, 5)]),
    () => sse([toolCall("todo_add", { text: "eggs", list: "shopping" }), counts(140, 120, 6)]),
  ]);
  const ran: string[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools,
    turns: [{ role: "user", text: "Add eggs to my shopping list." }],
    callTool: async (name) => {
      ran.push(name);
      if (name === "more_tools") tools.push(spec("todo_add"));
      return { ok: true };
    },
    usage,
    voice: true,
    onText: () => {},
    repairClaims: true,
  });
  eq("a repair that sends for its tool goes on to call it", `${ran.join(",")} ${outcome.claim}`, "more_tools,todo_add repaired");
  eq("in the round after", calls.length, 3);
}

{
  // Leaves nothing cooling. The bench's "Cancel my seven o'clock alarm." looked up the
  // alarm's id first, every run (2026-09-23): a lookup isn't the repair, the call after it is.
  const { ai, calls } = fakeAi([
    () => sse([say("Done — your 7 AM alarm is off."), counts(100, 0, 8)]),
    () => sse([toolCall("alarm_list", {}), counts(120, 100, 4)]),
    () => sse([toolCall("alarm_cancel", { id: "a7" }), counts(140, 120, 5)]),
  ]);
  const ran: string[] = [];
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("alarm_list"), spec("alarm_cancel")],
    turns: [{ role: "user", text: "Cancel my seven o'clock alarm." }],
    callTool: async (name) => {
      ran.push(name);
      return name === "alarm_list" ? { alarms: [{ id: "a7", time: "07:00" }] } : { ok: true };
    },
    usage,
    onText: () => {},
    repairClaims: true,
  });
  eq("a lookup, then the call that uses it", `${ran.join(",")} ${outcome.claim}`, "alarm_list,alarm_cancel repaired");
  eq("which the alarm's id reaches", calls[2].inputs.messages.some((m: any) => m.role === "tool" && m.content.includes("a7")), true);
}

{
  // Leaves nothing cooling. A repair that only looked something up changed nothing.
  const { ai } = fakeAi([
    () => sse([say("Done — your 7 AM alarm is off."), counts(100, 0, 8)]),
    () => sse([toolCall("alarm_list", {}), counts(120, 100, 4)]),
    () => sse([say("It's off."), counts(140, 120, 3)]),
  ]);
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("alarm_list"), spec("alarm_cancel")],
    turns: [{ role: "user", text: "Cancel my seven o'clock alarm." }],
    callTool: async () => ({ alarms: [] }),
    usage,
    onText: () => {},
    repairClaims: true,
  });
  eq("a repair that only looked up is unrepaired", outcome.kind === "reply" && `${outcome.text} (${outcome.claim})`, "Done — your 7 AM alarm is off. (unrepaired)");
}

{
  // Leaves nothing cooling. Lookups don't go on for ever: three rounds, then the claim stands.
  const lookup = () => sse([toolCall("alarm_list", {}), counts(120, 100, 4)]);
  const { ai, calls } = fakeAi([() => sse([say("Done — your 7 AM alarm is off."), counts(100, 0, 8)]), lookup, lookup, lookup, () => sse([toolCall("alarm_cancel", { id: "a7" })])]);
  const outcome = await chatWithTools({ AI: ai }, {
    ...base,
    tools: [...base.tools, spec("alarm_list"), spec("alarm_cancel")],
    turns: [{ role: "user", text: "Cancel my seven o'clock alarm." }],
    callTool: async () => ({ alarms: [] }),
    usage,
    onText: () => {},
    repairClaims: true,
  });
  eq("a repair stops after three rounds of lookups", `${calls.length} ${outcome.claim}`, "4 unrepaired");
}

{
  // Leaves nothing cooling. A repair round that needs the phone pauses the turn, as any
  // round would, and the resumed turn finishes the repair.
  const pausedRepair = async (resumed: (() => ReadableStream<Uint8Array>)[]) => {
    const { ai, calls } = fakeAi([
      () => sse([say("Texting Danya now."), counts(100, 0, 5)]),
      () => sse([toolCall("phone_contacts_search", { query: "Danya" }, "call_7"), counts(120, 100, 6)]),
      ...resumed,
    ]);
    const ran: string[] = [];
    const turn = {
      ...base,
      tools: [...base.tools, spec("phone_contacts_search"), spec("phone_message_compose")],
      turns: [{ role: "user" as const, text: "Text Danya I'm on my way" }],
      callTool: async (name: string) => {
        ran.push(name);
        return name === "phone_contacts_search" ? DEFER : { status: "waiting_for_user_approval" };
      },
      usage: { userId: "u1", purpose: "chat" },
      onText: () => {},
      repairClaims: true,
    };
    const first = await chatWithTools({ AI: ai }, turn);
    // Stored as JSON between the two requests (index.ts paused_turns).
    const state = first.kind === "paused" ? JSON.parse(JSON.stringify(first.state)) : null;
    const id = first.kind === "paused" ? first.calls[0].id : "";
    const heard: string[] = [];
    const done = await chatWithTools(
      { AI: ai },
      { ...turn, onText: (d) => void heard.push(d), resume: { state, results: { [id]: { contacts: [{ name: "Danya", phone: "+1 555 010 0100" }] } } } },
    );
    return { first, state, done, ran: ran.join(","), heard: heard.join(""), requests: calls.length };
  };
  const compose = () => sse([toolCall("phone_message_compose", { to: "+1 555 010 0100", body: "I'm on my way" }, "call_8"), counts(140, 120, 9)]);

  // As the nudge asked: nothing more to say once the text is waiting to be sent.
  const quiet = await pausedRepair([compose, () => sse([counts(160, 140, 0)])]);
  eq("a repair round's phone lookup pauses the turn", `${quiet.first.kind} ${quiet.first.claim}`, "paused pending");
  eq("the pause carries the nudge on", quiet.state?.messages.some((m: any) => m.content === CLAIM_NUDGE), true);
  eq("and the claim it is making true", quiet.state?.claim, { reply: "Texting Danya now." });
  eq("the resumed turn sends the text", quiet.ran, "phone_contacts_search,phone_message_compose");
  eq("a last round with no words ends on the claim, not an error", quiet.done.kind === "reply" && quiet.done.text, "Texting Danya now.");
  eq("and the repair is done", `${quiet.done.claim} ${quiet.requests}`, "repaired 4");

  const said = await pausedRepair([compose, () => sse([say("Tap Approve to send it."), counts(160, 140, 6)])]);
  eq("words after the tool are the resumed turn's reply", said.done.kind === "reply" && `${said.done.text} / ${said.heard} (${said.done.claim})`, "Tap Approve to send it. / Tap Approve to send it. (repaired)");

  const none = await pausedRepair([() => sse([say("I couldn't find Danya in your contacts."), counts(140, 120, 8)])]);
  eq("a resumed repair that changes nothing is unrepaired", `${none.ran} ${none.done.claim}`, "phone_contacts_search unrepaired");
}

{
  // No repair round: a tool ran, the reply claims nothing, or the caller didn't ask.
  const run = async (first: ReturnType<typeof sse>[], text: string, repairClaims: boolean) => {
    const { ai, calls } = fakeAi(first.map((s) => () => s));
    const outcome = await chatWithTools({ AI: ai }, {
      ...base,
      tools: [...base.tools, spec("alarm_list")],
      turns: [{ role: "user", text }],
      callTool: async () => ({ alarms: [] }),
      usage,
      onText: () => {},
      repairClaims,
    });
    return `${calls.length} ${outcome.claim}`;
  };
  eq("a question answered", await run([sse([say("It's 7:37."), counts(10, 0, 3)])], "What time is it?", true), "1 undefined");
  eq(
    "a question back",
    await run([sse([say("Four this afternoon has already passed — did you mean 4 PM tomorrow?"), counts(10, 0, 9)])], "Remind me to call Mom at four this afternoon.", true),
    "1 undefined",
  );
  eq(
    "a turn that ran a tool, whatever it says",
    await run([sse([toolCall("alarm_list", {}), counts(10, 0, 3)]), sse([say("Done — alarm set for 6:30."), counts(20, 10, 6)])], "Set an alarm for 6:30 tomorrow.", true),
    "2 undefined",
  );
  eq("repairClaims not asked for", await run([sse([say("Noted — milk and eggs."), counts(10, 0, 5)])], "Add milk and eggs to my notes.", false), "1 undefined");
}

{
  // Leaves nothing cooling. The same on Gemini, whose round is rebuilt as contents.
  const bodies: any[] = [];
  const answers = [
    [{ candidates: [{ content: { role: "model", parts: [{ text: "Done — 6:30 alarm set." }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 6 } }],
    [{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "alarm_set", args: { time: "06:30" } } }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 5 } }],
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse(answers.shift() ?? []), { status: 200 });
  }) as typeof fetch;
  const ran: string[] = [];
  const outcome = await chatWithTools({ GEMINI_API_KEY: "g" }, {
    ...base,
    tools: [...base.tools, spec("alarm_set")],
    turns: [{ role: "user", text: "Set an alarm for 6:30 tomorrow." }],
    callTool: async (name) => {
      ran.push(name);
      return { ok: true };
    },
    usage: { userId: "u1", purpose: "chat" },
    onText: () => {},
    repairClaims: true,
  });
  eq("on Gemini: the claimed tool runs", `${ran.join(",")} ${outcome.engine} ${outcome.claim}`, "alarm_set gemini repaired");
  const contents = bodies[1]?.contents ?? [];
  eq("after its reply and the nudge", `${contents.at(-2)?.role}: ${contents.at(-2)?.parts[0].text} / ${contents.at(-1)?.parts[0].text === CLAIM_NUDGE}`, "model: Done — 6:30 alarm set. / true");
  eq("two requests in all", bodies.length, 2);
  globalThis.fetch = realFetch;
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

// ---------- Workers AI silent once: asked again, not handed to GLM ----------

{
  // Leaves nothing cooling. "On it — I'll buzz you" came 22 s after the question
  // when one silent Workers AI request sent the turn to Z.ai (2026-09-24).
  let cancelled = 0;
  const { ai, calls } = fakeAi([
    () => new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => void cancelled++ }),
    () => sse([say("Your alarm is at seven."), counts(6_700, 0, 7)]),
  ]);
  let glm = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    glm++;
    return new Response(sse([say("Wrong engine."), counts(10, 0, 2)]), { status: 200 });
  }) as typeof fetch;
  const attempts: EngineAttempt[] = [];
  const outcome = await chatWithTools({ AI: ai, GLM_API_KEY: "k", VOICE_FIRST_CONTENT_MS: "1000" }, {
    ...base,
    turns: [{ role: "user", text: "When's my alarm?" }],
    callTool: async () => ({}),
    usage,
    voice: true,
    onText: () => {},
    onAttempt: (a) => attempts.push(a),
  });
  eq("a second go at Workers AI answers", outcome.kind === "reply" && `${outcome.engine}: ${outcome.text}`, "workers: Your alarm is at seven.");
  eq("written down as a timeout, then an answer", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "workers:timeout,workers:ok");
  eq("the silent stream is let go of", cancelled, 1);
  eq("asked twice", calls.length, 2);
  eq("GLM never asked", glm, 0);
  eq("and Workers AI isn't cooled down for one silence", isCooling("workers"), false);
  globalThis.fetch = realFetch;
}

// ---------- Workers AI silent twice: the spoken turn moves on to GLM ----------

{
  // Leaves Workers AI cooling for 15 s.
  let cancelled = 0;
  const silent = () =>
    new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled++;
      },
    });
  const { ai } = fakeAi([silent, silent]);
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
  eq("after two first-word deadlines, not the 20 s connect one", ms >= 2000 && ms < 6000, true);
  eq("both silences are written down as timeouts", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "workers:timeout,workers:timeout,glm:ok");
  eq("both streams are let go of upstream", cancelled, 2);
  eq("and now Workers AI rests", isCooling("workers"), true);
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
