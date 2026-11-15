import type { ChatAnswer, ChatStreamEvent } from "./use-chat-request";

export type CallCaption = { id: number; role: "user" | "assistant"; text: string };
export type CallTask = { requestId: string; text: string; title?: string; step: string; status: "running" | "done" | "failed" | "canceled"; delegationId: string | null; cards: string[] };
export type CallAsk = (payload: { conversationId: string; requestId: string; message: string; context: Record<string, unknown> }, onEvent: (event: ChatStreamEvent) => void)
  => Promise<{ ok: boolean; status?: number; body: { error?: string } & Partial<ChatAnswer> }>;

type ServerEvent = { type: string; delta?: string; start_ms?: number; end_ms?: number; offset_ms?: number | null; delegation?: { id: string }; error?: { message?: string }; message?: string };
type Deps = {
  conversationId: string;
  send: (event: Record<string, unknown>) => void;
  ask: CallAsk;
  onAnswer?: (question: string, answer: ChatAnswer) => void;
  onChange: () => void;
  log?: (message: string) => void;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => unknown;
  newId?: () => string;
};

const STEPS: Record<string, string> = {
  finance_investigate: "searching transactions", transactions_search: "searching transactions", finance_detail: "reading a transaction", finance_entities: "looking up names",
  finance_scenario: "comparing a what-if", analytics_cashflow: "adding up income and spending", accounts_list: "checking accounts", accounts_getBalances: "checking balances", net_worth: "working out your net worth",
  forecast_evaluate: "running the forecast", goals_list: "checking goals", wealth_list: "checking what you lent and own", recurring_list: "checking recurring payments", reviews_investigate: "reviewing finances",
  reviews_start: "starting a deep review", imports_status: "checking imports", agents_findings: "reading agent findings", agents_decide: "making a confirmation card",
  transaction_propose: "making a card", iou_propose: "making a loan card", balance_propose: "making a balance card", recurring_propose: "making a recurring card",
  organize_review: "checking what the organizer did", organize_propose: "making a labelling card",
  iou_findRepayments: "looking for repayments", investments_portfolio: "checking your Scalable portfolio", investments_transactions: "checking your Scalable trades",
  investments_security: "looking up the security", investments_watchlist: "checking your watchlist", investments_order: "getting Scalable's order preview", investments_cancelOrder: "making a cancel card", call_replace_task: "replacing the earlier request", app_help: "checking how Moneo works", document_read: "reading the attached file",
};
export const stepFor = (tool: string) => STEPS[tool] ?? "working";

export function answerCards(answer: string) {
  return [...new Set([...answer.matchAll(/```moneo-proposals?\n([\s\S]*?)```/g)].flatMap(match => match[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []))];
}
export function spokenAnswer(answer: string, max = 1500) {
  const text = answer.replace(/```[\w-]*\n[\s\S]*?```/g, "").replace(/\{\{cite\b[^}]*\}\}/g, "").replace(/[*_#`>|]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const SPEAKING_HOLD_MS = 700;
const SKIP = /\b(stop|skip|enough|never ?mind|forget (it|that)|move on|next (one|result|answer|thing)|stopp|weiter|n[äa]chste)\b/i;
const plain = (text: string) => text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
const TAKES_ON = /\b(on (it|that|this)|let me (check|look|see|pull|find)|i'?ll|checking|looking|pulling|making|adding|switching|noted)\b/i;
export const TAKEN_ON_MS = 2000;
export const isSkip = (text: string) => SKIP.test(text) && text.trim().split(/\s+/).length <= 8;
export const LATE_WORDS_MS = 1500;
export const TRANSCRIPT_SETTLE_MS = 600;
export const SLOW_TASK_MS = 8000;
export const REPLACE_WAIT_MS = 5000;
export const RESULT_DONE_MS = 2500;
export const RESULT_PAUSE_MS = 300;
export const RESULT_TURN_MS = 20_000;
export const USER_PAUSE_MS = 1500;
export const RESUME_AFTER_MS = 3000;
export const ONLY_THIS_RESULT = "Say this result now and don't mention other requests. Don't end with a question or wait for the user: if another result comes, go straight on with it.";

export class VoiceCallController {
  captions: CallCaption[] = [];
  tasks: CallTask[] = [];
  error = "";
  private heard: { text: string; start: number }[] = [];
  private answers = new Map<string, string>();
  private startedAt = new Map<string, number>();
  private lastDelegation: string | null = null;
  private reply = "";
  private takenOn = false;
  private lastUserSpeech = -Infinity;
  private lastAssistantSpeech = -Infinity;
  private lastAudible = -Infinity;
  private metered = false;
  private lastMic = -Infinity;
  private micMetered = false;
  private outbox: { requestId?: string; delegationId: string | null; content: string }[] = [];
  private flushing = false;
  private current: { requestId?: string; delegationId: string | null; content: string; at: number } | null = null;
  private cut: { requestId?: string; delegationId: string | null; content: string; words: string } | null = null;
  private announced = new Set<string>();
  private captionId = 0;
  private openTag: Record<CallCaption["role"], string> = { user: "", assistant: "" };
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
  get unsaid() { return new Set([...this.outbox.map(item => item.requestId), this.cut?.requestId].filter(Boolean)); }
  private get lastMoneo() { return this.metered ? this.lastAudible : this.lastAssistantSpeech; }
  speaking(by: "user" | "moneo" | "any" = "any") {
    const last = by === "user" ? this.lastUserSpeech : by === "moneo" ? this.lastMoneo : Math.max(this.lastUserSpeech, this.lastMoneo);
    return this.now() - last < SPEAKING_HOLD_MS;
  }
  get answering() {
    if (this.speaking("moneo") || this.outbox.length) return true;
    return !!this.current && this.lastMoneo <= this.current.at && this.now() - this.current.at < RESULT_TURN_MS;
  }
  heardMoneo() { this.metered = true; this.lastAudible = this.now(); }
  heardUser() { this.micMetered = true; this.lastMic = this.now(); }

  private resultSaid() {
    const current = this.current;
    if (!current) return true;
    if (this.lastMoneo <= current.at) return this.now() - current.at > RESULT_TURN_MS;
    const micQuiet = this.micMetered && this.lastMic < this.lastMoneo;
    return this.now() - this.lastMoneo >= (micQuiet ? RESULT_PAUSE_MS : RESULT_DONE_MS);
  }

  handle(event: ServerEvent) {
    switch (event.type) {
      case "session.input_transcript.delta": {
        const delta = (event.delta ?? "").replace(/[|>]/g, " ");
        if (this.current && this.lastMoneo > this.current.at && !this.resultSaid()) {
          this.cut = { ...this.current, words: "" };
          this.deps.log?.(`cut off: ${this.current.content.slice(0, 60)}`);
          this.current = null;
          this.resume();
        }
        if (this.cut) this.cut.words += delta;
        this.lastUserSpeech = this.now();
        this.reply = ""; this.takenOn = false;
        this.heard.push({ text: delta, start: event.start_ms ?? event.end_ms ?? -Infinity });
        this.caption("user", delta);
        break;
      }
      case "session.output_transcript.delta":
        this.lastAssistantSpeech = this.now();
        this.caption("assistant", event.delta ?? "");
        this.reply += event.delta ?? "";
        if (!this.takenOn && TAKES_ON.test(this.reply.slice(0, 80))) { this.takenOn = true; this.schedule(() => this.claimTakenOn(), TAKEN_ON_MS); }
        break;
      case "session.delegation.created": {
        const id = event.delegation?.id;
        if (!id) break;
        this.lastDelegation = id;
        this.claim(id, event.offset_ms ?? Infinity);
        break;
      }
      case "error":
        this.error = event.error?.message ?? event.message ?? "The call had a problem";
        this.deps.onChange();
        break;
    }
  }

  private claim(delegationId: string, offset: number, wait = true) {
    if (this.now() - this.lastUserSpeech < TRANSCRIPT_SETTLE_MS && !this.heard.some(piece => piece.start > offset)) {
      this.schedule(() => this.claim(delegationId, offset, wait), 100);
      return;
    }
    const claimed = this.heard.filter(piece => piece.start <= offset);
    this.heard = this.heard.filter(piece => piece.start > offset);
    const words = plain(claimed.map(piece => piece.text).join(""));
    if (words && !isSkip(words)) this.start(words, delegationId);
    else if (!words && wait) this.schedule(() => this.claim(delegationId, offset, false), LATE_WORDS_MS);
    else this.deps.log?.(`hand-off with nothing to start: ${words}`);
  }

  private claimTakenOn() {
    const text = plain(this.heard.map(piece => piece.text).join(""));
    if (!this.lastDelegation || text.split(/\s+/).length < 3 || isSkip(text)) return;
    if (this.now() - this.lastUserSpeech < TAKEN_ON_MS) { this.schedule(() => this.claimTakenOn(), 500); return; }
    this.heard = [];
    this.deps.log?.(`started words GPT-Live took on without a hand-off: ${text.slice(0, 60)}`);
    this.start(text, this.lastDelegation);
  }

  typed(text: string) {
    const message = text.trim();
    if (!message) return;
    this.captionId++;
    this.captions = [...this.captions, { id: this.captionId, role: "user", text: message }];
    this.start(message, null);
  }

  private caption(role: CallCaption["role"], words: string) {
    let delta = (this.openTag[role] + words).replace(/\[[^\]]*\]/g, "");
    const open = delta.length - delta.lastIndexOf("[") > 40 ? -1 : delta.lastIndexOf("[");
    this.openTag[role] = open < 0 ? "" : delta.slice(open);
    if (open >= 0) delta = delta.slice(0, open);
    if (!delta) return;
    const last = this.captions.at(-1);
    if (last?.role === role) this.captions = [...this.captions.slice(0, -1), { ...last, text: last.text + delta }];
    else this.captions = [...this.captions, { id: ++this.captionId, role, text: delta.trimStart() }];
    this.deps.onChange();
  }

  private update(requestId: string, change: Partial<CallTask>) {
    this.tasks = this.tasks.map(task => task.requestId === requestId ? { ...task, ...change } : task);
    this.deps.onChange();
  }

  private brief() {
    return {
      via: "call", input: "voice",
      runningTasks: this.running.slice(-5).map(task => ({ requestId: task.requestId, text: task.text.slice(0, 300) })),
      recentTurns: this.captions.slice(-6).map(caption => ({ role: caption.role, text: caption.text.slice(-300) })),
      answered: this.tasks.flatMap(task => {
        const answer = this.answers.get(task.requestId);
        return answer ? [{ requestId: task.requestId, text: task.text.slice(0, 150), answer: answer.slice(0, 300) }] : [];
      }).slice(-4),
    };
  }

  private start(text: string, delegationId: string | null) {
    const requestId = this.newId();
    const context = this.brief();
    this.tasks = [...this.tasks, { requestId, text, step: "starting", status: "running", delegationId, cards: [] }];
    this.startedAt.set(requestId, this.now());
    this.deps.onChange();
    this.watchSlow(requestId);
    void this.run(requestId, text, context);
    return requestId;
  }

  private async run(requestId: string, text: string, context: ReturnType<VoiceCallController["brief"]>) {
    const label = `"${text.slice(0, 120)}"`;
    const via = () => this.tasks.find(item => item.requestId === requestId)?.delegationId ?? null;
    try {
      const result = await this.deps.ask({ conversationId: this.deps.conversationId, requestId, message: text.slice(0, 4000), context }, event => {
        if (event.type === "title") return this.update(requestId, { title: event.title });
        if (event.type !== "tool" || event.state !== "running" || this.tasks.find(item => item.requestId === requestId)?.status === "canceled") return;
        if (event.name === "call_replace_task") this.replaced((event.input as { requestId?: unknown } | undefined)?.requestId);
        const step = stepFor(event.name);
        this.update(requestId, { step });
        if (via()) this.deps.send({ type: "session.thinking.append", delegation_id: via(), content: `Working on ${label}: ${step}.` });
      });
      const task = this.tasks.find(item => item.requestId === requestId);
      if (task?.status === "canceled") return;
      if (result.status === 409) { this.update(requestId, { status: "canceled", step: "stopped" }); return; }
      if (!result.ok || !result.body.answer) throw new Error(result.body.error ?? "No answer");
      const cards = answerCards(result.body.answer);
      this.answers.set(requestId, spokenAnswer(result.body.answer));
      this.update(requestId, { status: "done", step: "answered", cards });
      this.deps.onAnswer?.(text, result.body as ChatAnswer);
      const delegationId = via();
      this.deliver(requestId, delegationId, [`Result for ${label}${delegationId ? "" : " (typed by the user in the call; say the result to them now, in the language of their quoted words)"}: ${spokenAnswer(result.body.answer)}`,
        cards.length ? `${cards.length} card${cards.length > 1 ? "s" : ""} on screen to tap; nothing is saved until then.` : ""].filter(Boolean).join(" "));
    } catch {
      if (this.tasks.find(item => item.requestId === requestId)?.status === "canceled") return;
      this.update(requestId, { status: "failed", step: "failed" });
      this.deliver(requestId, via(), `Moneo couldn't get an answer for ${label}. Tell the user briefly and ask if they want you to try again.`);
    }
  }

  private watchSlow(requestId: string, delay = SLOW_TASK_MS) {
    this.schedule(() => {
      const task = this.tasks.find(item => item.requestId === requestId);
      if (task?.status !== "running" || this.announced.has(requestId)) return;
      if (this.speaking() || !this.resultSaid() || this.cut || this.outbox.length) return this.watchSlow(requestId, 1000);
      this.stillWorking([task]);
    }, delay);
  }

  private stillWorking(tasks: CallTask[]) {
    tasks.forEach(task => this.announced.add(task.requestId));
    const names = tasks.map(task => `"${task.text.slice(0, 120)}" (${task.step})`).join(", ");
    this.deps.send({ type: "session.commentary.append", delegation_id: tasks[0].delegationId,
      content: `Still working on ${names}. Say so in a few words${tasks.some(task => task.delegationId) ? "" : ", in the language of their quoted words"}.` });
  }

  private deliver(requestId: string, delegationId: string | null, content: string) {
    this.outbox.push({ requestId, delegationId, content });
    this.flush();
  }

  private replaced(requestId: unknown) {
    const task = this.tasks.find(item => item.requestId === requestId);
    if (!task || task.status === "failed" || task.status === "canceled") return;
    this.drop(task.requestId, { status: "canceled", step: "replaced", cards: [] });
  }

  private mayBeReplaced(requestId?: string) {
    if (this.takenOn && this.lastDelegation && plain(this.heard.map(piece => piece.text).join("")).split(/\s+/).length >= 3) return true;
    const index = this.tasks.findIndex(task => task.requestId === requestId);
    return index >= 0 && this.tasks.slice(index + 1).some(task => task.status === "running" && task.step === "starting"
      && this.now() - (this.startedAt.get(task.requestId) ?? -Infinity) < REPLACE_WAIT_MS);
  }

  private flush() {
    if (this.flushing || !this.outbox.length || this.cut) return;
    if (this.speaking("user") || this.now() - this.lastUserSpeech < USER_PAUSE_MS || !this.resultSaid() || this.mayBeReplaced(this.outbox[0].requestId)) {
      this.flushing = true;
      this.schedule(() => { this.flushing = false; this.flush(); }, 300);
      return;
    }
    const { requestId, delegationId, content } = this.outbox.shift()!;
    this.current = { requestId, delegationId, content, at: this.now() };
    this.deps.onChange();
    this.deps.log?.(`handed over: ${content.slice(0, 60)}`);
    this.deps.send({ type: "session.commentary.append", delegation_id: delegationId, content: `${content} ${ONLY_THIS_RESULT}` });
    this.flush();
  }

  private resume() {
    this.schedule(() => {
      const cut = this.cut;
      if (!cut) return;
      if (this.speaking() || this.now() - this.lastUserSpeech < USER_PAUSE_MS
        || (this.lastMoneo <= this.lastUserSpeech && this.now() - this.lastUserSpeech < RESUME_AFTER_MS)) return this.resume();
      this.cut = null;
      const resume = cut.words.trim().split(/\s+/).length >= 3 && !isSkip(cut.words);
      this.deps.log?.(resume ? "resuming the cut-off result" : "not resuming the cut-off result");
      if (resume) this.outbox.unshift({ requestId: cut.requestId, delegationId: cut.delegationId,
        content: `The user talked over you while you were giving this result. If you hadn't finished it, first say in a few words that you're going back to it (like "Anyway, back to your September spending…"), then finish the part you hadn't said yet, without repeating what you already said; if you had, say nothing more about it. ${cut.content}` });
      this.flush();
    }, 300);
  }

  cancel(requestId: string) { this.drop(requestId, { status: "canceled", step: "stopped" }); }

  private drop(requestId: string, change: Partial<CallTask>) {
    this.outbox = this.outbox.filter(item => item.requestId !== requestId);
    if (this.cut?.requestId === requestId) this.cut = null;
    this.update(requestId, change);
  }
}
