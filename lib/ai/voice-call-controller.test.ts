import { expect, it, vi } from "vitest";
import { VoiceCallController, answerCards, spokenAnswer, type CallAsk } from "./voice-call-controller";

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
    await new Promise(resolve => setTimeout(resolve));
  };
  const say = (text: string) => call.handle({ type: "session.input_transcript.delta", delta: text });
  const delegate = (id: string) => call.handle({ type: "session.delegation.created", delegation: { id } });
  const answer = async (message: string, text: string, status = 200) => { pending[message]({ ok: status < 400, status, body: status < 400 ? { answer: text, conversationId: "c" } : { error: "x" } }); await new Promise(resolve => setTimeout(resolve)); };
  return { call, sent, asks, advance, say, delegate, answer, onAnswer };
}

it("turns each delegation into a call request with the words since the previous one", async () => {
  const { call, asks, say, delegate, sent } = setup();
  say("How much at Netto"); say(" this month?"); delegate("d1");
  say("And when is rent due?"); delegate("d2");
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much at Netto this month?", "And when is rent due?"]);
  expect(asks[0][0]).toMatchObject({ conversationId: "c", requestId: "r1", context: { via: "call", input: "voice", runningTasks: [] } });
  // The second request knows the first is still running, so it can replace it.
  expect(asks[1][0].context).toEqual({ via: "call", input: "voice", runningTasks: [{ requestId: "r1", text: "How much at Netto this month?" }] });
  asks[0][1]({ type: "tool", name: "finance_investigate", state: "running" });
  expect(call.tasks[0].step).toBe("searching transactions");
  expect(sent).toContainEqual({ type: "session.thinking.append", delegation_id: "d1", content: 'Working on "How much at Netto this month?": searching transactions.' });
  expect(call.captions).toEqual([{ id: 1, role: "user", text: "How much at Netto this month?And when is rent due?" }]);
});

it("speaks results in arrival order, names the question, notes cards and what is still running", async () => {
  const { sent, say, delegate, answer, advance, onAnswer } = setup();
  say("Netto?"); delegate("d1"); say("Rent?"); delegate("d2");
  await advance(1000);
  await answer("Rent?", "Rent is **EUR 850.00** on Nov 1.");
  await answer("Netto?", `I spent it.\n\n\`\`\`moneo-proposal\n${card}\n\`\`\``);
  const spoken = sent.filter(event => event.type === "session.commentary.append");
  expect(spoken).toEqual([
    { type: "session.commentary.append", delegation_id: "d2", content: 'Result for "Rent?": Rent is EUR 850.00 on Nov 1. Still working on "Netto?".' },
    { type: "session.commentary.append", delegation_id: "d1", content: 'Result for "Netto?": I spent it. 1 card on screen to tap; nothing is saved until then.' },
  ]);
  expect(onAnswer).toHaveBeenCalledTimes(2);
});

it("holds results while the user is speaking", async () => {
  const { sent, say, delegate, answer, advance } = setup();
  say("Netto?"); delegate("d1");
  await advance(2000);
  say("um, also"); // the user is talking when the answer lands
  await answer("Netto?", "42 euros.");
  expect(sent.some(event => event.type === "session.commentary.append")).toBe(false);
  await advance(800);
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
  await advance(1000);
  expect(call.tasks.map(task => task.status)).toEqual(["canceled", "canceled", "failed"]);
  expect(sent.filter(event => event.type === "session.commentary.append")).toEqual([{ type: "session.commentary.append", delegation_id: null, content: expect.stringContaining("couldn't get an answer") }]);
});

it("reads card ids and strips blocks for speech", () => {
  expect(answerCards(`a\n\`\`\`moneo-proposals\n["${card}"]\n\`\`\``)).toEqual([card]);
  expect(spokenAnswer("Hi **there** [link](/x)\n```moneo-chart\n{}\n```", 10)).toBe("Hi there …");
});

it("starts a task for words GPT-Live never handed off, once the user has been quiet", async () => {
  const { call, asks, say, delegate, advance } = setup();
  say("How much at Netto?"); delegate("d1");
  say("btw I spent 12 at Rewe");
  await advance(1000);
  expect(asks).toHaveLength(1);
  await advance(2500);
  expect(asks.map(([payload]) => payload.message)).toEqual(["How much at Netto?", "btw I spent 12 at Rewe"]);
  expect(call.tasks[1].delegationId).toBe("d1");
  say("thanks"); await advance(5000);
  expect(asks).toHaveLength(2);
});
