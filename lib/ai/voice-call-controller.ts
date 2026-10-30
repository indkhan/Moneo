import type { ChatAnswer, ChatStreamEvent } from "./use-chat-request";

export type CallCaption = { id: number; role: "user" | "assistant"; text: string };
export type CallTask = { requestId: string; text: string; step: string; status: "running" | "done" | "failed" | "canceled"; delegationId: string | null; cards: string[] };
export type CallAsk = (payload: { conversationId: string; requestId: string; message: string; context: Record<string, unknown> }, onEvent: (event: ChatStreamEvent) => void)
  => Promise<{ ok: boolean; status?: number; body: { error?: string } & Partial<ChatAnswer> }>;

type ServerEvent = { type: string; delta?: string; end_ms?: number; offset_ms?: number | null; delegation?: { id: string }; error?: { message?: string }; message?: string };
type Deps = {
  conversationId: string;
  /** Sends a client event on the oai-events data channel. */
  send: (event: Record<string, unknown>) => void;
  ask: CallAsk;
  /** Called when a task's answer is saved in the chat, so the chat view can show it. */
  onAnswer?: (question: string, answer: ChatAnswer) => void;
  onChange: () => void;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => unknown;
  newId?: () => string;
};

/** What each chat tool is doing, as a short progress line for the voice model. */
const STEPS: Record<string, string> = {
  finance_investigate: "searching transactions", transactions_search: "searching transactions", finance_detail: "reading a transaction", finance_entities: "looking up names",
  finance_scenario: "comparing a what-if", analytics_cashflow: "adding up income and spending", accounts_list: "checking accounts", accounts_getBalances: "checking balances",
  forecast_evaluate: "running the forecast", goals_list: "checking goals", recurring_list: "checking recurring payments", reviews_investigate: "reviewing finances",
  reviews_start: "starting a deep review", imports_status: "checking imports", agents_findings: "reading agent findings", agents_decide: "making a confirmation card",
  transaction_propose: "making a card", iou_propose: "making a loan card", balance_propose: "making a balance card", recurring_propose: "making a recurring card",
  iou_findRepayments: "looking for repayments", call_replace_task: "replacing the earlier request", app_help: "checking how Moneo works",
};
export const stepFor = (tool: string) => STEPS[tool] ?? "working";

/** The proposal card ids an answer shows, in order. */
export function answerCards(answer: string) {
  return [...new Set([...answer.matchAll(/```moneo-proposals?\n([\s\S]*?)```/g)].flatMap(match => match[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []))];
}
/** An answer as words to speak: no card, chart or decision blocks, bounded. */
export function spokenAnswer(answer: string, max = 1500) {
  const text = answer.replace(/```[\w-]*\n[\s\S]*?```/g, "").replace(/[*_#`>|]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const SPEAKING_HOLD_MS = 700;
export const SLOW_TASK_MS = 8000;
/** Longest wait for Moneo to say one result before the next is handed over anyway. */
export const RESULT_TURN_MS = 20_000;

/**
 * Runs a voice call's tasks: each GPT-Live delegation (or typed message) becomes one /api/chat request, and its
 * answer is handed back to be spoken: first finished, first said, one at a time, and never over the user.
 */
export class VoiceCallController {
  captions: CallCaption[] = [];
  tasks: CallTask[] = [];
  error = "";
  /** Words the user said that no hand-off has claimed yet, with when each piece ended in the session. */
  private heard: { text: string; end: number }[] = [];
  private lastUserTurn = "";
  private answers = new Map<string, string>();
  private lastUserSpeech = -Infinity;
  private lastAssistantSpeech = -Infinity;
  private outbox: { delegationId: string | null; content: string }[] = [];
  private flushing = false;
  /** When the result being said was handed over, until Moneo has said it. */
  private saying: number | null = null;
  private captionId = 0;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => unknown;
  private readonly newId: () => string;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms));
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  get running() { return this.tasks.filter(task => task.status === "running"); }
  get cards() { return this.tasks.flatMap(task => task.cards); }
  /** Someone is talking right now. */
  speaking(by: "user" | "any" = "any") {
    const last = by === "user" ? this.lastUserSpeech : Math.max(this.lastUserSpeech, this.lastAssistantSpeech);
    return this.now() - last < SPEAKING_HOLD_MS;
  }

  handle(event: ServerEvent) {
    switch (event.type) {
      case "session.input_transcript.delta":
        this.lastUserSpeech = this.now();
        this.heard.push({ text: event.delta ?? "", end: event.end_ms ?? Infinity });
        this.caption("user", event.delta ?? "");
        break;
      case "session.output_transcript.delta":
        this.lastAssistantSpeech = this.now();
        this.caption("assistant", event.delta ?? "");
        break;
      case "session.delegation.created": {
        // The delegation carries no task text: it is what the user said up to its offset since the previous one;
        // words said after the offset belong to the next request.
        const offset = event.offset_ms ?? Infinity;
        const claimed = this.heard.some(piece => piece.end <= offset) ? this.heard.filter(piece => piece.end <= offset) : this.heard;
        this.heard = this.heard.filter(piece => !claimed.includes(piece));
        const text = claimed.map(piece => piece.text).join("").trim() || this.lastUserTurn;
        if (event.delegation?.id && text) this.start(text, event.delegation.id);
        break;
      }
      case "error":
        this.error = event.error?.message ?? event.message ?? "The call had a problem";
        this.deps.onChange();
        break;
    }
  }

  /** A typed message starts a task directly; its answer is spoken the same way. */
  typed(text: string) {
    const message = text.trim();
    if (!message) return;
    this.captionId++;
    this.captions = [...this.captions, { id: this.captionId, role: "user", text: message }];
    this.start(message, null);
  }

  private caption(role: CallCaption["role"], delta: string) {
    if (!delta) return;
    const last = this.captions.at(-1);
    if (last?.role === role) this.captions = [...this.captions.slice(0, -1), { ...last, text: last.text + delta }];
    else this.captions = [...this.captions, { id: ++this.captionId, role, text: delta.trimStart() }];
    if (role === "user") this.lastUserTurn = this.captions.at(-1)!.text.trim();
    this.deps.onChange();
  }

  private update(requestId: string, change: Partial<CallTask>) {
    this.tasks = this.tasks.map(task => task.requestId === requestId ? { ...task, ...change } : task);
    this.deps.onChange();
  }

  /**
   * What Moneo needs to answer one request on its own: the requests still being answered separately, the call so far
   * to resolve "that" or "also", and what this call has already answered.
   */
  private brief() {
    return {
      via: "call", input: "voice",
      runningTasks: this.running.slice(-5).map(task => ({ requestId: task.requestId, text: task.text.slice(0, 300) })),
      recentTurns: this.captions.slice(-6).map(caption => ({ role: caption.role, text: caption.text.slice(-300) })),
      answered: this.tasks.filter(task => this.answers.has(task.requestId)).slice(-4).map(task => ({ text: task.text.slice(0, 150), answer: this.answers.get(task.requestId)!.slice(0, 300) })),
    };
  }

  private start(text: string, delegationId: string | null) {
    const requestId = this.newId();
    const context = this.brief();
    this.tasks = [...this.tasks, { requestId, text, step: "starting", status: "running", delegationId, cards: [] }];
    this.deps.onChange();
    this.watchSlow(requestId);
    void this.run(requestId, text, delegationId, context);
  }

  private async run(requestId: string, text: string, delegationId: string | null, context: ReturnType<VoiceCallController["brief"]>) {
    const label = `"${text.slice(0, 120)}"`;
    try {
      const result = await this.deps.ask({ conversationId: this.deps.conversationId, requestId, message: text.slice(0, 4000), context }, event => {
        if (event.type !== "tool" || event.state !== "running") return;
        const step = stepFor(event.name);
        this.update(requestId, { step });
        if (delegationId) this.deps.send({ type: "session.thinking.append", delegation_id: delegationId, content: `Working on ${label}: ${step}.` });
      });
      const task = this.tasks.find(item => item.requestId === requestId);
      // Canceled from the list, or stopped because a correction replaced it: nothing to say.
      if (task?.status === "canceled" || result.status === 409) { this.update(requestId, { status: "canceled", step: "stopped" }); return; }
      if (!result.ok || !result.body.answer) throw new Error(result.body.error ?? "No answer");
      const cards = answerCards(result.body.answer);
      this.answers.set(requestId, spokenAnswer(result.body.answer));
      this.update(requestId, { status: "done", step: "answered", cards });
      this.deps.onAnswer?.(text, result.body as ChatAnswer);
      // A typed request has no hand-off to answer through, so the result says outright that it is to be spoken.
      this.deliver(delegationId, [`Result for ${label}${delegationId ? "" : " (typed by the user in the call; say the result to them now, in the language they typed)"}: ${spokenAnswer(result.body.answer)}`,
        cards.length ? `${cards.length} card${cards.length > 1 ? "s" : ""} on screen to tap; nothing is saved until then.` : ""].filter(Boolean).join(" "));
    } catch {
      if (this.tasks.find(item => item.requestId === requestId)?.status === "canceled") return;
      this.update(requestId, { status: "failed", step: "failed" });
      this.deliver(delegationId, `Moneo couldn't get an answer for ${label}. Tell the user briefly and ask if they want you to try again.`);
    }
  }

  /** One short spoken update for a task that runs long, once nobody is talking. */
  private watchSlow(requestId: string, delay = SLOW_TASK_MS) {
    this.schedule(() => {
      const task = this.tasks.find(item => item.requestId === requestId);
      if (task?.status !== "running") return;
      if (this.speaking()) return this.watchSlow(requestId, 1000);
      this.deps.send({ type: "session.commentary.append", delegation_id: task.delegationId, content: `Still working on "${task.text.slice(0, 120)}" (${task.step}). Say so in a few words${task.delegationId ? "" : ", in the language they typed"}.` });
    }, delay);
  }

  /** Results queue in the order they finish. */
  private deliver(delegationId: string | null, content: string) {
    this.outbox.push({ delegationId, content });
    this.flush();
  }

  /**
   * Hands over the next result once Moneo has said the previous one and nobody is talking. What is still running is
   * read when it goes out, so a result never says another is pending after that one has finished.
   */
  private flush() {
    if (this.flushing || !this.outbox.length) return;
    const said = this.saying !== null && (this.lastAssistantSpeech >= this.saying || this.now() - this.saying > RESULT_TURN_MS);
    if (this.speaking() || (this.saying !== null && !said)) {
      this.flushing = true;
      this.schedule(() => { this.flushing = false; this.flush(); }, 300);
      return;
    }
    const { delegationId, content } = this.outbox.shift()!;
    const others = this.running.map(item => `"${item.text.slice(0, 80)}"`);
    this.saying = this.now();
    this.deps.send({ type: "session.commentary.append", delegation_id: delegationId, content: others.length ? `${content} Still working on ${others.join(", ")}.` : content });
    this.flush();
  }

  /** Marks a task canceled; the caller asks the server to stop it. */
  cancel(requestId: string) { this.update(requestId, { status: "canceled", step: "canceled" }); }
}
