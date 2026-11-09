import { expect, it, vi } from "vitest";
import { ONLY_THIS_RESULT, VoiceCallController, TRANSCRIPT_SETTLE_MS, answerCards, isSkip, spokenAnswer, type CallAsk } from "./voice-call-controller";

const card = "11111111-1111-4111-8111-111111111111";
function setup() {
  let clock = 0, ids = 0;
  const timers: { at: number; run: () => void }[] = [];
  const sent: Record<string, unknown>[] = [];
  const pending: Record<string, (value: Awaited<ReturnType<CallAsk>>) => void> = {};
  const asks: Parameters<CallAsk>[] = [];
  const ask: CallAsk = (payload, onEvent) => { asks.push([payload, onEvent]); return new Promise(resolve => { pending[payload.message] = resolve; }); };
  const onAnswer = vi.fn();
  const call = new VoiceCallController({ conversationId: "c", send: event => sent.push(event), ask, onAnswer, onChange: () => {}, now: () => clock,
    schedule: (run, ms) => timers.push({ at: clock + ms, run }), newId: () => `r${++ids}` });
  const advance = async (ms: number) => {
    clock += ms;
    for (let due = timers.filter(timer => timer.at <= clock); due.length; due = timers.filter(timer => timer.at <= clock))
      for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  const say = (text: string, endMs?: number, startMs?: number) => call.handle({ type: "session.input_transcript.delta", delta: text, start_ms: startMs, end_ms: endMs });
  // A hand-off arrives once the transcript has caught up, unless a test says otherwise.
  const delegate = (id: string, offsetMs?: number, settled = true) => { if (settled) clock += TRANSCRIPT_SETTLE_MS; call.handle({ type: "session.delegation.created", offset_ms: offsetMs, delegation: { id } }); };
  const answer = async (message: string, text: string, status = 200) => { pending[message]({ ok: status < 400, status, body: status < 400 ? { answer: text, conversationId: "c" } : { error: "x" } }); await new Promise(resolve => setImmediate(resolve)); };
  // Time passes in small steps, so retries the controller schedules run too; Moneo's voice is metered every 100 ms.
  const wait = async (ms: number) => { for (let time = 0; time < ms; time += 100) await advance(100); };
  const moneoTalks = async (ms: number) => { for (let time = 0; time < ms; time += 100) { call.heardMoneo(); await advance(100); } };
  return { call, sent, asks, advance, wait, moneoTalks, say, delegate, answer, onAnswer };
}

it("turns each delegation into a call request with the words since the previous one", async () => {
  const { call, asks, say, delegate, sent } = setup();
  say("How much at Netto"); say(" this month?"); delegate("d1");
  say("And when is rent due?"); delegate("d2");
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much at Netto this month?", "And when is rent due?"]);
  expect(asks[0][0]).toMatchObject({ conversationId: "c", requestId: "r1", context: { via: "call", input: "voice", runningTasks: [], answered: [] } });
  // The second request knows the first is still running, so it neither answers it again nor misses a correction.
  expect(asks[1][0].context).toMatchObject({ via: "call", input: "voice", runningTasks: [{ requestId: "r1", text: "How much at Netto this month?" }] });
  asks[0][1]({ type: "tool", name: "finance_investigate", state: "running" });
  expect(call.tasks[0].step).toBe("searching transactions");
  expect(sent).toContainEqual({ type: "session.thinking.append", delegation_id: "d1", content: 'Working on "How much at Netto this month?": searching transactions.' });
  expect(call.captions).toEqual([{ id: 1, role: "user", text: "How much at Netto this month?And when is rent due?" }]);
});

it("shows a task's title while the model and the voice keep working from what the user said", async () => {
  const { call, asks, sent, say, delegate, answer, wait } = setup();
  say("hey so um how much at Netto"); delegate("d1");
  expect(call.tasks[0].title).toBeUndefined();
  asks[0][1]({ type: "title", title: "Netto spending" });
  expect(call.tasks[0]).toMatchObject({ text: "hey so um how much at Netto", title: "Netto spending", status: "running" });
  say("and rent"); delegate("d2");
  expect(asks[1][0].context).toMatchObject({ runningTasks: [{ text: "hey so um how much at Netto" }] });
  await answer("hey so um how much at Netto", "42 euros");
  await wait(6000);
  expect(JSON.stringify(sent)).toContain('Result for \\"hey so um how much at Netto\\"');
});

it("says the first finished result first, then the next once Moneo has said it", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks, onAnswer } = setup();
  say("Netto?"); delegate("d1"); say("Rent?"); delegate("d2");
  await wait(2000);
  await answer("Rent?", "Rent is **EUR 850.00** on Nov 1.");
  await answer("Netto?", `I spent it.

\`\`\`moneo-proposal
${card}
\`\`\``);
  const spoken = () => sent.filter(event => event.type === "session.commentary.append");
  expect(spoken()).toHaveLength(1);
  await moneoTalks(2000);
  expect(spoken()).toHaveLength(1);
  await wait(2700);
  expect(spoken()).toEqual([
    { type: "session.commentary.append", delegation_id: "d2", content: `Result for "Rent?": Rent is EUR 850.00 on Nov 1. ${ONLY_THIS_RESULT}` },
    { type: "session.commentary.append", delegation_id: "d1", content: `Result for "Netto?": I spent it. 1 card on screen to tap; nothing is saved until then. ${ONLY_THIS_RESULT}` },
  ]);
  expect(onAnswer).toHaveBeenCalledTimes(2);
});

it("never says a request is still running once it has finished while another result is being said", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks } = setup();
  say("Netto?"); delegate("d1"); say("Rent?"); delegate("d2");
  await answer("Netto?", "42 euros.");
  await wait(1600);
  await moneoTalks(1000);
  // Rent finishes while Moneo is still saying the Netto result.
  await answer("Rent?", "EUR 850.");
  // Nothing about it reaches GPT-Live before its result: a note that it finished made GPT-Live announce an amount it made up.
  expect(sent.some(event => String(event.content).startsWith("Finished"))).toBe(false);
  await moneoTalks(1000);
  await wait(2700);
  const spoken = sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content));
  expect(spoken).toEqual([`Result for "Netto?": 42 euros. ${ONLY_THIS_RESULT}`, `Result for "Rent?": EUR 850. ${ONLY_THIS_RESULT}`]);
});

it("hands over the next result after a short pause when the mic stayed quiet, and waits for late words when it didn't", async () => {
  const { call, sent, say, delegate, answer, wait, moneoTalks } = setup();
  const spoken = () => sent.filter(event => event.type === "session.commentary.append");
  call.heardUser();
  say("A?"); delegate("d1"); say("B?"); delegate("d2"); say("C?"); delegate("d3");
  await answer("A?", "one"); await answer("B?", "two"); await answer("C?", "three");
  await wait(1600);
  await moneoTalks(1000);
  await wait(1300);
  expect(spoken()).toHaveLength(2);
  await moneoTalks(1000);
  // The user is loud on the mic as Moneo stops; their words are not transcribed yet.
  call.heardUser();
  await wait(1300);
  expect(spoken()).toHaveLength(2);
});

it("says what is still running once a result has been said and it runs long, and only once", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks, asks } = setup();
  const spoken = () => sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content));
  say("Netto?"); delegate("d1"); say("Rent?"); delegate("d2");
  asks[1][1]({ type: "tool", name: "finance_investigate", state: "running" });
  await answer("Netto?", "42 euros.");
  await wait(1600);
  await moneoTalks(1000);
  expect(spoken()).toHaveLength(1);
  await wait(5500);
  expect(spoken()[1]).toMatch(/^Still working on "Rent\?"/);
  await wait(10_000);
  expect(spoken()).toHaveLength(2);
});

it("still gives a slow request its spoken update after an earlier result was said", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks } = setup();
  say("Netto?"); delegate("d1");
  await answer("Netto?", "42 euros.");
  await wait(1600);
  await moneoTalks(1000);
  await wait(2700);
  say("Forecast?"); delegate("d2");
  await wait(9500);
  expect(sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content))[1]).toMatch(/^Still working on "Forecast\?"/);
});

it("holds results while the user is speaking", async () => {
  const { sent, say, delegate, answer, advance } = setup();
  say("Netto?"); delegate("d1");
  await advance(2000);
  say("um, also"); // the user is talking when the answer lands
  await answer("Netto?", "42 euros.");
  expect(sent.some(event => event.type === "session.commentary.append")).toBe(false);
  await advance(800); await advance(800);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(1);
});

it("gives one spoken update for a slow task once nobody is talking", async () => {
  const { sent, say, delegate, advance } = setup();
  say("Forecast?"); delegate("d1");
  await advance(7900); say("hm");
  await advance(200);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(0);
  await advance(1000);
  expect(sent.filter(event => event.type === "session.commentary.append")).toEqual([expect.objectContaining({ delegation_id: "d1", content: expect.stringContaining("Still working on \"Forecast?\"") })]);
  await advance(20_000);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(1);
});

it("says a failure briefly, and stays quiet for canceled or replaced requests", async () => {
  const { call, sent, say, delegate, answer, advance } = setup();
  say("A?"); delegate("d1"); say("B?"); delegate("d2"); call.typed("C?");
  call.cancel("r1");
  await answer("A?", "late");
  await answer("B?", "", 409);
  await answer("C?", "", 502);
  await advance(1000); await advance(1000);
  expect(call.tasks.map(task => task.status)).toEqual(["canceled", "canceled", "failed"]);
  expect(sent.filter(event => event.type === "session.commentary.append")).toEqual([{ type: "session.commentary.append", delegation_id: null, content: expect.stringContaining("couldn't get an answer") }]);
});

it("never says the result of a request a correction replaced", async () => {
  const { call, sent, asks, say, delegate, answer, wait } = setup();
  say("Add 12 at Netto"); delegate("d1"); say("No, make it 15"); delegate("d2");
  asks[1][1]({ type: "tool", name: "call_replace_task", state: "running", input: { requestId: "r1" } });
  await answer("Add 12 at Netto", "Card for 12 euros is on screen.");
  await answer("No, make it 15", "Card for 15 euros is on screen.");
  await wait(2000);
  expect(call.tasks.map(task => [task.status, task.step])).toEqual([["canceled", "replaced"], ["done", "answered"]]);
  expect(sent.filter(event => event.type === "session.commentary.append").map(event => event.content)).toEqual([`Result for "No, make it 15": Card for 15 euros is on screen. ${ONLY_THIS_RESULT}`]);
});

it("hands a typed message's result to GPT-Live to say, without a delegation", async () => {
  const { call, sent, answer } = setup();
  call.typed("What did I spend?");
  await answer("What did I spend?", "42 euros", 200);
  expect(call.captions).toEqual([{ id: 1, role: "user", text: "What did I spend?" }]);
  expect(sent.filter(event => event.type === "session.commentary.append")).toEqual([
    { type: "session.commentary.append", delegation_id: null, content: `Result for "What did I spend?" (typed by the user in the call; say the result to them now, in the language of their quoted words): 42 euros ${ONLY_THIS_RESULT}` }]);
  expect(sent.filter(event => event.type === "session.thinking.append")).toEqual([]);
});

it("reads card ids and strips blocks for speech", () => {
  expect(answerCards(`a\n\`\`\`moneo-proposals\n["${card}"]\n\`\`\``)).toEqual([card]);
  expect(spokenAnswer("Hi **there** [link](/x)\n```moneo-chart\n{}\n```", 10)).toBe("Hi there …");
});

it("cuts each request at its hand-off's offset, leaving later words for the next one", () => {
  const { asks, say, delegate } = setup();
  say("Analyze last month.", 2000); say(" Also how much", 4000); delegate("d1", 2500);
  say(" did I spend?", 5000); delegate("d2", 5200);
  expect(asks.map(([payload]) => payload.message)).toEqual(["Analyze last month.", "Also how much did I spend?"]);
});

it("keeps a word the user began before the hand-off in its request, even if it ended just after", () => {
  const { asks, say, delegate } = setup();
  say("How much did I spend at Netto this", 3300, 2000); say(" month?", 3800, 3400); delegate("d1", 3600);
  say(" And when is my rent due?", 6000, 4500); delegate("d2", 6100);
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much did I spend at Netto this month?", "And when is my rent due?"]);
});

it("leaves GPT-Live's \"|\" break marks out of requests", () => {
  const { asks, say, delegate } = setup();
  say("And when is my|"); say(" rent due?"); delegate("d1");
  expect(asks.map(([payload]) => payload.message)).toEqual(["And when is my rent due?"]);
});

it("briefs each request with the call so far and what it already answered", async () => {
  const { asks, say, delegate, answer, call } = setup();
  call.handle({ type: "session.output_transcript.delta", delta: "Hi there!" });
  say("What did I spend in September?"); delegate("d1");
  await answer("What did I spend in September?", "You spent **EUR 1,607.37**.");
  say("And August?"); delegate("d2");
  expect(asks[1][0].context).toEqual({ via: "call", input: "voice", runningTasks: [],
    recentTurns: [{ role: "assistant", text: "Hi there!" }, { role: "user", text: "What did I spend in September?And August?" }],
    answered: [{ requestId: "r1", text: "What did I spend in September?", answer: "You spent EUR 1,607.37." }] });
});

it("asks Moneo to finish a result the user cut off, after it has answered them, before the next result", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks, asks } = setup();
  say("Analyze September?"); delegate("d1"); say(" Total?"); delegate("d2");
  await answer("Analyze September?", "You spent EUR 1607.37; insurance was highest.");
  await answer("Total?", "EUR 1607.37.");
  await wait(1600);
  const spoken = () => sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content));
  expect(spoken()).toHaveLength(1);
  await moneoTalks(1000);
  // GPT-Live goes quiet the moment the user cuts in; their words are transcribed a second later.
  await wait(1000);
  say("wait, who did I lend to?"); delegate("d3"); asks[2][1]({ type: "tool", name: "finance_investigate", state: "running" });
  await wait(1600);
  await moneoTalks(800);
  await wait(800);
  expect(spoken()).toHaveLength(2);
  expect(spoken()[1]).toMatch(/^The user talked over you while you were giving this result\. .*Result for "Analyze September\?": You spent EUR 1607\.37/);
  await moneoTalks(1500);
  await wait(2700);
  expect(spoken()[2]).toContain('Result for "Total?"');
});

it("finishes a cut-off result without saying a request that finished meanwhile is still running", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks, asks } = setup();
  say("Netto?"); delegate("d1"); say(" Rent?"); delegate("d2");
  asks[1][1]({ type: "tool", name: "finance_investigate", state: "running" });
  await answer("Netto?", "You spent EUR 42.00 at Netto this month.");
  await wait(1600);
  await moneoTalks(1000);
  await wait(1000);
  say("wait, and my savings goal?"); delegate("d3"); asks[2][1]({ type: "tool", name: "finance_investigate", state: "running" });
  await wait(1600);
  await moneoTalks(800);
  await wait(800);
  const spoken = () => sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content));
  expect(spoken()).toHaveLength(2);
  expect(spoken()[1]).toMatch(/Result for "Netto\?"/);
  expect(spoken()[1]).not.toMatch(/Still working/);
  // Rent finishes while Moneo is finishing the Netto result.
  await moneoTalks(500);
  await answer("Rent?", "Rent is EUR 850.00 on Nov 1.");
  await moneoTalks(1000);
  await wait(2700);
  expect(spoken()[2]).toBe(`Result for "Rent?": Rent is EUR 850.00 on Nov 1. ${ONLY_THIS_RESULT}`);
});

it("does not resume over a short mm-hm", async () => {
  const { sent, say, delegate, answer, wait, moneoTalks } = setup();
  say("Rent?"); delegate("d1");
  await answer("Rent?", "EUR 850.");
  await wait(1600);
  await moneoTalks(500);
  say("mm-hm");
  await wait(5000);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(1);
});

it("waits for Moneo's voice, not its transcript, before handing over the next result", async () => {
  const { call, sent, say, delegate, answer, wait, moneoTalks } = setup();
  say("This month?"); delegate("d1"); say(" September?"); delegate("d2");
  await answer("This month?", "Housing EUR 355.00, groceries EUR 327.30.");
  await answer("September?", "Bilal EUR 1011.34.");
  await wait(1600);
  // The whole transcript arrives at once, well ahead of the voice saying it.
  call.handle({ type: "session.output_transcript.delta", delta: "Housing 355, groceries 327.30." });
  await moneoTalks(4000);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(1);
  await wait(2700);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(2);
});

it("leaves sound tags out of captions, even when they arrive in pieces between the user's words", () => {
  const { call, say } = setup();
  call.handle({ type: "session.output_transcript.delta", delta: "Sure. [s" });
  say("are");
  call.handle({ type: "session.output_transcript.delta", delta: "coff" });
  call.handle({ type: "session.output_transcript.delta", delta: "] I'm good." });
  expect(call.captions.map(caption => caption.text)).toEqual(["Sure. ", "are", "I'm good."]);
});

it("never runs a request twice for a second hand-off of the same words, but waits for words transcribed late", async () => {
  const { asks, say, delegate, wait } = setup();
  say("How much at Netto?", 2000); delegate("d1", 2500); delegate("d2", 2500);
  await wait(2000);
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much at Netto?"]);
  delegate("d3", 6000);
  await wait(500);
  say("And rent?", 5800);
  await wait(1500);
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much at Netto?", "And rent?"]);
});

it("keeps a request whole when GPT-Live says \"take your time\" in the user's pause", async () => {
  const { call, asks, say, delegate, wait } = setup();
  say("Rent?"); delegate("d0");
  say("I paid twenty euros", 3000, 2000);
  call.handle({ type: "session.output_transcript.delta", delta: "Mm-hm. Take your time." });
  await wait(2000);
  say(" for groceries at Rewe", 6000, 5000); delegate("d1", 6100);
  expect(asks.map(([payload]) => payload.message)).toEqual(["Rent?", "I paid twenty euros for groceries at Rewe"]);
});

it("never makes a request of a word left after an early hand-off", () => {
  const { call, asks, say, delegate } = setup();
  say("Netto?"); delegate("d0");
  say("How much did I spend at Netto this", 3000, 2000); delegate("d1", 3100);
  say(" month", 3500, 3200);
  call.handle({ type: "session.output_transcript.delta", delta: "Sure, let me look through your transactions." });
  expect(asks.map(([payload]) => payload.message)).toEqual(["Netto?", "How much did I spend at Netto this"]);
});

it("never loses a request GPT-Live answers before its hand-off arrives", async () => {
  const { call, asks, say, delegate, wait } = setup();
  say("Rewe groceries twenty euros", 2000, 500);
  call.handle({ type: "session.output_transcript.delta", delta: "Got it, making a card." });
  await wait(500);
  delegate("d1", 2100);
  expect(asks.map(([payload]) => payload.message)).toEqual(["Rewe groceries twenty euros"]);
});

it("lets a late hand-off take over the request GPT-Live agreed to, not the words said after it", async () => {
  const { call, asks, say, delegate } = setup();
  say("Netto?", 1000, 500); delegate("d0", 1100);
  say(" Check my rent", 3000, 2000);
  call.handle({ type: "session.output_transcript.delta", delta: "Sure, on that one too." });
  say(" And my savings goal?", 5000, 4000);
  delegate("dA", 3100); delegate("dB", 5100);
  expect(asks.map(([payload]) => payload.message)).toEqual(["Netto?", "Check my rent", "And my savings goal?"]);
  expect(call.tasks.map(task => task.delegationId)).toEqual(["d0", "dA", "dB"]);
});

it("doesn't finish a cut-off result that a correction replaced", async () => {
  const { sent, asks, say, delegate, answer, wait, moneoTalks } = setup();
  say("Add coffee 5"); delegate("d1");
  await answer("Add coffee 5", "Card for 5 euros on screen.");
  await wait(1600);
  await moneoTalks(800);
  await wait(1000);
  say("No, make it fifteen"); delegate("d2");
  asks[1][1]({ type: "tool", name: "call_replace_task", state: "running", input: { requestId: "r1" } });
  await wait(1600);
  await moneoTalks(800);
  await wait(4000);
  expect(sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content))).toHaveLength(1);
});

it("stops an answered result that is still waiting to be said, and ignores a stopped request's progress", async () => {
  const { call, sent, asks, say, delegate, answer, wait, moneoTalks } = setup();
  say("Netto?"); delegate("d1"); say("Rent?"); delegate("d2");
  asks[1][1]({ type: "tool", name: "finance_investigate", state: "running" });
  await wait(2000);
  await answer("Netto?", "Netto was EUR 12.40.");
  await answer("Rent?", "Rent is EUR 850.00.");
  expect([...call.unsaid]).toEqual(["r2"]);
  call.cancel("r2");
  expect(call.unsaid.size).toBe(0);
  expect(call.tasks[1]).toMatchObject({ status: "canceled", step: "stopped" });
  await moneoTalks(2000); await wait(5000);
  expect(sent.filter(event => event.type === "session.commentary.append" && String(event.content).includes("Rent"))).toEqual([]);

  say("Groceries this month?"); delegate("d3");
  call.cancel("r3");
  asks[2][1]({ type: "tool", name: "finance_investigate", state: "running" });
  expect(call.tasks[2].step).toBe("stopped");
  expect(sent.filter(event => event.type === "session.thinking.append" && event.delegation_id === "d3")).toEqual([]);
});

it("drops a result the user stops mid-way for the next one in line, and never runs \"stop\" as a request", async () => {
  const { sent, asks, say, delegate, answer, wait, moneoTalks } = setup();
  say("Netto?"); delegate("d1"); say(" Rent?"); delegate("d2");
  await answer("Netto?", "You spent EUR 42.00 at Netto this month.");
  await answer("Rent?", "Rent is EUR 850.00 on Nov 1.");
  await wait(1600);
  await moneoTalks(1000);
  await wait(1000);
  say("Stop, go to the next one"); delegate("d3");
  await wait(1600);
  await moneoTalks(500);
  await wait(4000);
  const spoken = sent.filter(event => event.type === "session.commentary.append").map(event => String(event.content));
  expect(spoken).toHaveLength(2);
  expect(spoken[1]).toBe(`Result for "Rent?": Rent is EUR 850.00 on Nov 1. ${ONLY_THIS_RESULT}`);
  expect(asks).toHaveLength(2);
});

it("tells a stop or skip command from a request", () => {
  for (const text of ["Stop", "okay skip that", "stop and continue to the next one", "next one please", "nevermind", "stopp, weiter"]) expect(isSkip(text)).toBe(true);
  for (const text of ["What about next month?", "How much did I spend at the bus stop kiosk on snacks last week"]) expect(isSkip(text)).toBe(false);
});

it("waits for the user's last word when the hand-off arrives before it is transcribed", async () => {
  const { asks, say, delegate, wait } = setup();
  say("How much did I spend on groceries last", 5000, 4800);
  delegate("d1", 5600, false);
  expect(asks).toHaveLength(0);
  await wait(300);
  say(" month", 5400, 5200);
  await wait(700);
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much did I spend on groceries last month"]);
});

it("keeps the user's last word, which the hand-off's offset points at the start of", () => {
  const { asks, say, delegate } = setup();
  say("Wie viel für Lebensmittel", 5800, 5600); say(" ausgegeben", 6400, 6200); delegate("d1", 6200);
  expect(asks.map(([payload]) => payload.message)).toEqual(["Wie viel für Lebensmittel ausgegeben"]);
});

it("starts a request GPT-Live said it is on but never handed off, and only once", async () => {
  const { call, asks, say, delegate, wait } = setup();
  say("How much on groceries last month?"); delegate("d1");
  say("No wait, I meant this month");
  call.handle({ type: "session.output_transcript.delta", delta: "Okay, checking" });
  call.handle({ type: "session.output_transcript.delta", delta: " this month." });
  await wait(1500);
  expect(asks).toHaveLength(1);
  await wait(1000);
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much on groceries last month?", "No wait, I meant this month"]);
  delegate("d2");
  await wait(2000);
  expect(asks).toHaveLength(2);
});

it("holds a result while words GPT-Live took on without a hand-off are about to start", async () => {
  const { call, sent, asks, say, delegate, answer, wait } = setup();
  say("Groceries last month?"); delegate("d1");
  await wait(2000);
  say("No wait, I meant this month");
  call.handle({ type: "session.output_transcript.delta", delta: "Okay, checking this month." });
  await answer("Groceries last month?", "EUR 549.91.");
  await wait(2500);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(0);
  asks[1][1]({ type: "tool", name: "call_replace_task", state: "running", input: { requestId: "r1" } });
  await wait(5000);
  expect(sent.filter(event => event.type === "session.commentary.append" && String(event.content).includes("549"))).toHaveLength(0);
});

it("holds a result while a later request decides whether it replaces it", async () => {
  const { sent, asks, say, delegate, answer, wait } = setup();
  say("Groceries last month?"); delegate("d1");
  await wait(2000);
  say("No wait, I meant this month"); delegate("d2");
  await answer("Groceries last month?", "EUR 549.91.");
  await wait(2000);
  expect(sent.filter(event => event.type === "session.commentary.append")).toHaveLength(0);
  asks[1][1]({ type: "tool", name: "call_replace_task", state: "running", input: { requestId: "r1" } });
  await wait(5000);
  expect(sent.filter(event => event.type === "session.commentary.append" && String(event.content).includes("549"))).toHaveLength(0);
});
