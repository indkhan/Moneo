import type { ChatAnswer, ChatStreamEvent } from "./use-chat-request";

export type CallCaption = { id: number; role: "user" | "assistant"; text: string };
/** text is what the user said, which the model and the voice work from; title is its short name for the screen. */
export type CallTask = { requestId: string; text: string; title?: string; step: string; status: "running" | "done" | "failed" | "canceled"; delegationId: string | null; cards: string[] };
export type CallAsk = (payload: { conversationId: string; requestId: string; message: string; context: Record<string, unknown> }, onEvent: (event: ChatStreamEvent) => void)
  => Promise<{ ok: boolean; status?: number; body: { error?: string } & Partial<ChatAnswer> }>;

type ServerEvent = { type: string; delta?: string; start_ms?: number; end_ms?: number; offset_ms?: number | null; delegation?: { id: string }; error?: { message?: string }; message?: string };
type Deps = {
  conversationId: string;
  /** Sends a client event on the oai-events data channel. */
  send: (event: Record<string, unknown>) => void;
  ask: CallAsk;
  /** Called when a task's answer is saved in the chat, so the chat view can show it. */
  onAnswer?: (question: string, answer: ChatAnswer) => void;
  onChange: () => void;
  /** Notes what the call decided and when, for debugging a call. */
  log?: (message: string) => void;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => unknown;
  newId?: () => string;
};

/** What each chat tool is doing, as a short progress line for the voice model. */
const STEPS: Record<string, string> = {
  finance_investigate: "searching transactions", transactions_search: "searching transactions", finance_detail: "reading a transaction", finance_entities: "looking up names",
  finance_scenario: "comparing a what-if", analytics_cashflow: "adding up income and spending", accounts_list: "checking accounts", accounts_getBalances: "checking balances", net_worth: "working out your net worth",
  forecast_evaluate: "running the forecast", goals_list: "checking goals", wealth_list: "checking what you lent and own", recurring_list: "checking recurring payments", reviews_investigate: "reviewing finances",
  reviews_start: "starting a deep review", imports_status: "checking imports", agents_findings: "reading agent findings", agents_decide: "making a confirmation card",
  transaction_propose: "making a card", iou_propose: "making a loan card", balance_propose: "making a balance card", recurring_propose: "making a recurring card",
  iou_findRepayments: "looking for repayments", investments_portfolio: "checking your Scalable portfolio", investments_transactions: "checking your Scalable trades",
  investments_security: "looking up the security", investments_watchlist: "checking your watchlist", investments_order: "getting Scalable's order preview", investments_cancelOrder: "making a cancel card", call_replace_task: "replacing the earlier request", app_help: "checking how Moneo works", document_read: "reading the attached file",
};
export const stepFor = (tool: string) => STEPS[tool] ?? "working";

/** The proposal card ids an answer shows, in order. */
export function answerCards(answer: string) {
  return [...new Set([...answer.matchAll(/```moneo-proposals?\n([\s\S]*?)```/g)].flatMap(match => match[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []))];
}
/** An answer as words to speak: no card, chart or decision blocks, bounded. */
export function spokenAnswer(answer: string, max = 1500) {
  const text = answer.replace(/```[\w-]*\n[\s\S]*?```/g, "").replace(/\{\{cite\b[^}]*\}\}/g, "").replace(/[*_#`>|]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const SPEAKING_HOLD_MS = 700;
/** "Stop", "skip that", "next one": the user wants the result being said dropped, and the next one. */
const SKIP = /\b(stop|skip|enough|never ?mind|forget (it|that)|move on|next (one|result|answer|thing)|stopp|weiter|n[äa]chste)\b/i;
/** Transcript text as plain words, without sound tags like "[scoff]". */
const plain = (text: string) => text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
/** GPT-Live saying it is on something ("checking this month", "let me look"), not "mm-hm" or "take your time". */
const TAKES_ON = /\b(on (it|that|this)|let me (check|look|see|pull|find)|i'?ll|checking|looking|pulling|making|adding|switching|noted)\b/i;
/** How long a request GPT-Live said it is on gets to be handed off before Moneo starts it itself. */
export const TAKEN_ON_MS = 2000;
/** A short command to stop or skip what Moneo is saying, which is not a request of its own. */
export const isSkip = (text: string) => SKIP.test(text) && text.trim().split(/\s+/).length <= 8;
/** How long a hand-off with no new words waits for them to be transcribed. */
export const LATE_WORDS_MS = 1500;
/** The transcript quiet this long has caught up with what the user said. */
export const TRANSCRIPT_SETTLE_MS = 600;
export const SLOW_TASK_MS = 8000;
/** Longest a result waits for a later request to decide whether it replaces it. */
export const REPLACE_WAIT_MS = 5000;
/** Moneo silent this long after it began saying a result means it said all of it. The user's words are transcribed
 * about a second late, so words arriving sooner than this were said over the result. */
export const RESULT_DONE_MS = 2500;
/** Moneo silent this long, with the mic quiet since, also means it said all of it: the mic hears the user at once,
 * so nobody talked over it, and the next result follows without a long gap. */
export const RESULT_PAUSE_MS = 300;
/** Longest wait for Moneo to start saying a result before the next is handed over anyway. */
export const RESULT_TURN_MS = 20_000;
/** A pause this long ends the user's turn for handing over a result; people pause mid-sentence ("uh… like…"). */
export const USER_PAUSE_MS = 1500;
/** How long Moneo gets to answer an interruption before it is asked to finish the result it was cut off in. */
export const RESUME_AFTER_MS = 3000;
/** Added to every result handed over: a request that runs long gets its own spoken update. */
export const ONLY_THIS_RESULT = "Say this result now and don't mention other requests. Don't end with a question or wait for the user: if another result comes, go straight on with it.";

/**
 * Runs a voice call's tasks: each GPT-Live delegation (or typed message) becomes one /api/chat request, and its
 * answer is handed back to be spoken: first finished, first said, one at a time, and never over the user.
 */
export class VoiceCallController {
  captions: CallCaption[] = [];
  tasks: CallTask[] = [];
  error = "";
  /** Words the user said that no hand-off has claimed yet, with when each piece began in the session. */
  private heard: { text: string; start: number }[] = [];
  private answers = new Map<string, string>();
  private startedAt = new Map<string, number>();
  private lastDelegation: string | null = null;
  /** What Moneo has said since the user last spoke. */
  private reply = "";
  private takenOn = false;
  private lastUserSpeech = -Infinity;
  private lastAssistantSpeech = -Infinity;
  /** When Moneo was last audible in the call's audio. Transcript text runs ahead of the voice, so once the audio is
   * metered it, not the transcript, says whether Moneo is talking. */
  private lastAudible = -Infinity;
  private metered = false;
  /** When the user was last loud on the mic, once it is metered. */
  private lastMic = -Infinity;
  private micMetered = false;
  private outbox: { requestId?: string; delegationId: string | null; content: string }[] = [];
  private flushing = false;
  /** The result Moneo was last handed and when, until it has said all of it or was talked over. */
  private current: { requestId?: string; delegationId: string | null; content: string; at: number } | null = null;
  /** A result the user talked over, with what they said since, until Moneo is asked to finish it. */
  private cut: { requestId?: string; delegationId: string | null; content: string; words: string } | null = null;
  /** Requests the user has been told are still running, so they hear it once. */
  private announced = new Set<string>();
  private captionId = 0;
  /** A sound tag ("[scoff]") still open at the end of a role's last words, held until it closes. */
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
  /** Requests whose result is answered but not yet said, so the user can still stop it. */
  get unsaid() { return new Set([...this.outbox.map(item => item.requestId), this.cut?.requestId].filter(Boolean)); }
  /** When Moneo last made a sound: its metered voice once there is one, else its transcript. */
  private get lastMoneo() { return this.metered ? this.lastAudible : this.lastAssistantSpeech; }
  /** Someone is talking right now. */
  speaking(by: "user" | "moneo" | "any" = "any") {
    const last = by === "user" ? this.lastUserSpeech : by === "moneo" ? this.lastMoneo : Math.max(this.lastUserSpeech, this.lastMoneo);
    return this.now() - last < SPEAKING_HOLD_MS;
  }
  /** Moneo is talking, or between results it still has to say, so the call screen doesn't flick to listening. */
  get answering() {
    if (this.speaking("moneo") || this.outbox.length) return true;
    return !!this.current && this.lastMoneo <= this.current.at && this.now() - this.current.at < RESULT_TURN_MS;
  }
  /** Called while Moneo's voice is audible in the call. */
  heardMoneo() { this.metered = true; this.lastAudible = this.now(); }
  /** Called while the user is loud on the mic. */
  heardUser() { this.micMetered = true; this.lastMic = this.now(); }

  /** Whether Moneo has said the result it was handed: it began, then went quiet with nobody talking over it. */
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
        // GPT-Live's transcript sometimes marks a break with "|" or ">" ("when is my| rent due").
        const delta = (event.delta ?? "").replace(/[|>]/g, " ");
        // Talking over a result GPT-Live is saying stops it, and the rest would be lost.
        if (this.current && this.lastMoneo > this.current.at && !this.resultSaid()) {
          this.cut = { ...this.current, words: "" };
          this.deps.log?.(`cut off: ${this.current.content.slice(0, 60)}`);
          this.current = null;
          this.resume();
        }
        if (this.cut) this.cut.words += delta;
        this.lastUserSpeech = this.now();
        this.reply = ""; this.takenOn = false;
        // Words without timing belong to the next hand-off, whatever its offset.
        this.heard.push({ text: delta, start: event.start_ms ?? event.end_ms ?? -Infinity });
        this.caption("user", delta);
        break;
      }
      case "session.output_transcript.delta":
        this.lastAssistantSpeech = this.now();
        this.caption("assistant", event.delta ?? "");
        this.reply += event.delta ?? "";
        // Checked once per reply, when it first says it is on something.
        if (!this.takenOn && TAKES_ON.test(this.reply.slice(0, 80))) { this.takenOn = true; this.schedule(() => this.claimTakenOn(), TAKEN_ON_MS); }
        break;
      case "session.delegation.created": {
        // The delegation carries no task text: it is what the user said up to its offset since the previous one;
        // words said after the offset belong to the next request.
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

  /**
   * Starts a hand-off's request from the words up to its offset; with none yet, they may still be on their way from
   * the transcriber. A hand-off that never gets words of its own (a repeat of the same words) starts nothing, so a
   * request never runs twice, and neither does "stop, next one".
   */
  private claim(delegationId: string, offset: number, wait = true) {
    // A hand-off can arrive before the user's last words are transcribed: claim once the transcript has caught up.
    if (this.now() - this.lastUserSpeech < TRANSCRIPT_SETTLE_MS && !this.heard.some(piece => piece.start > offset)) {
      this.schedule(() => this.claim(delegationId, offset, wait), 100);
      return;
    }
    // A word the user began at or before the hand-off (GPT-Live offsets it at the start of their last word) is part of its request, even if it ended just after; later words
    // belong to the next one.
    const claimed = this.heard.filter(piece => piece.start <= offset);
    this.heard = this.heard.filter(piece => piece.start > offset);
    const words = plain(claimed.map(piece => piece.text).join(""));
    if (words && !isSkip(words)) this.start(words, delegationId);
    else if (!words && wait) this.schedule(() => this.claim(delegationId, offset, false), LATE_WORDS_MS);
    else this.deps.log?.(`hand-off with nothing to start: ${words}`);
  }

  /**
   * GPT-Live sometimes says it is on a request ("okay, checking this month") without handing it off. If the words are
   * still unclaimed a moment later, and the user hasn't gone on talking, they become a request of their own.
   */
  private claimTakenOn() {
    const text = plain(this.heard.map(piece => piece.text).join(""));
    if (!this.lastDelegation || text.split(/\s+/).length < 3 || isSkip(text)) return;
    // The user is still talking: their hand-off may yet come.
    if (this.now() - this.lastUserSpeech < TAKEN_ON_MS) { this.schedule(() => this.claimTakenOn(), 500); return; }
    this.heard = [];
    this.deps.log?.(`started words GPT-Live took on without a hand-off: ${text.slice(0, 60)}`);
    this.start(text, this.lastDelegation);
  }

  /** A typed message starts a task directly; its answer is spoken the same way. */
  typed(text: string) {
    const message = text.trim();
    if (!message) return;
    this.captionId++;
    this.captions = [...this.captions, { id: this.captionId, role: "user", text: message }];
    this.start(message, null);
  }

  private caption(role: CallCaption["role"], words: string) {
    // Sound tags are not words, and can arrive in pieces between the other side's words.
    let delta = (this.openTag[role] + words).replace(/\[[^\]]*\]/g, "");
    // A "[" that never closes within a few words was just a bracket.
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

  /**
   * What Moneo needs to answer one request on its own: the requests still being answered separately, the call so far
   * to resolve "that" or "also", and what this call has already answered.
   */
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
    // Read when needed: a late hand-off can take a request over while it runs.
    const via = () => this.tasks.find(item => item.requestId === requestId)?.delegationId ?? null;
    try {
      const result = await this.deps.ask({ conversationId: this.deps.conversationId, requestId, message: text.slice(0, 4000), context }, event => {
        if (event.type === "title") return this.update(requestId, { title: event.title });
        // A stopped request's last progress notes are not shown or said.
        if (event.type !== "tool" || event.state !== "running" || this.tasks.find(item => item.requestId === requestId)?.status === "canceled") return;
        if (event.name === "call_replace_task") this.replaced((event.input as { requestId?: unknown } | undefined)?.requestId);
        const step = stepFor(event.name);
        this.update(requestId, { step });
        if (via()) this.deps.send({ type: "session.thinking.append", delegation_id: via(), content: `Working on ${label}: ${step}.` });
      });
      const task = this.tasks.find(item => item.requestId === requestId);
      // Canceled from the list, or stopped because a correction replaced it: nothing to say.
      if (task?.status === "canceled") return;
      if (result.status === 409) { this.update(requestId, { status: "canceled", step: "stopped" }); return; }
      if (!result.ok || !result.body.answer) throw new Error(result.body.error ?? "No answer");
      const cards = answerCards(result.body.answer);
      this.answers.set(requestId, spokenAnswer(result.body.answer));
      this.update(requestId, { status: "done", step: "answered", cards });
      this.deps.onAnswer?.(text, result.body as ChatAnswer);
      // A typed request has no hand-off to answer through, so the result says outright that it is to be spoken.
      const delegationId = via();
      this.deliver(requestId, delegationId, [`Result for ${label}${delegationId ? "" : " (typed by the user in the call; say the result to them now, in the language of their quoted words)"}: ${spokenAnswer(result.body.answer)}`,
        cards.length ? `${cards.length} card${cards.length > 1 ? "s" : ""} on screen to tap; nothing is saved until then.` : ""].filter(Boolean).join(" "));
    } catch {
      if (this.tasks.find(item => item.requestId === requestId)?.status === "canceled") return;
      this.update(requestId, { status: "failed", step: "failed" });
      this.deliver(requestId, via(), `Moneo couldn't get an answer for ${label}. Tell the user briefly and ask if they want you to try again.`);
    }
  }

  /** One short spoken update for a task that runs long, once nobody is talking. Re-checks every second; ends when the task does. */
  private watchSlow(requestId: string, delay = SLOW_TASK_MS) {
    this.schedule(() => {
      const task = this.tasks.find(item => item.requestId === requestId);
      if (task?.status !== "running" || this.announced.has(requestId)) return;
      // Never in the middle of saying a result, or before one waiting to be said.
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

  /** Results queue in the order they finish. */
  private deliver(requestId: string, delegationId: string | null, content: string) {
    this.outbox.push({ requestId, delegationId, content });
    this.flush();
  }

  /**
   * A correction is replacing an earlier request: its result is not said, so Moneo never gives the old answer before
   * the corrected one. The server stops it or dismisses its cards.
   */
  private replaced(requestId: unknown) {
    const task = this.tasks.find(item => item.requestId === requestId);
    if (!task || task.status === "failed" || task.status === "canceled") return;
    // Its cards are dismissed by the server, so they leave the tray.
    this.drop(task.requestId, { status: "canceled", step: "replaced", cards: [] });
  }

  /**
   * Hands over the next result once Moneo has said the previous one and nobody is talking. A result never says what
   * else is still running: by the time Moneo reaches the end of it, that may have finished too.
   */
  /**
   * A later request still choosing its first step may be a correction ("no, I meant this month") that replaces this
   * result, which it does first: the result waits a moment for it, so the old answer isn't said before the new one.
   */
  private mayBeReplaced(requestId?: string) {
    // Words GPT-Live said it is on, about to start as their own request, may be that correction too.
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
    // It is no longer waiting to be said, so it can't be stopped from the list.
    this.deps.onChange();
    this.deps.log?.(`handed over: ${content.slice(0, 60)}`);
    this.deps.send({ type: "session.commentary.append", delegation_id: delegationId, content: `${content} ${ONLY_THIS_RESULT}` });
    this.flush();
  }

  /**
   * Once the user has finished and Moneo has answered them (or had a few seconds to), Moneo is asked to finish the
   * result it was cut off in before any other. A short "mm-hm" over it is not an interruption.
   */
  private resume() {
    this.schedule(() => {
      const cut = this.cut;
      if (!cut) return;
      if (this.speaking() || this.now() - this.lastUserSpeech < USER_PAUSE_MS
        || (this.lastMoneo <= this.lastUserSpeech && this.now() - this.lastUserSpeech < RESUME_AFTER_MS)) return this.resume();
      this.cut = null;
      // A "mm-hm" is not an interruption, and "stop" or "next one" drops the result for the next.
      const resume = cut.words.trim().split(/\s+/).length >= 3 && !isSkip(cut.words);
      this.deps.log?.(resume ? "resuming the cut-off result" : "not resuming the cut-off result");
      if (resume) this.outbox.unshift({ requestId: cut.requestId, delegationId: cut.delegationId,
        content: `The user talked over you while you were giving this result. If you hadn't finished it, first say in a few words that you're going back to it (like "Anyway, back to your September spending…"), then finish the part you hadn't said yet, without repeating what you already said; if you had, say nothing more about it. ${cut.content}` });
      this.flush();
    }, 300);
  }

  /** Marks a task canceled and drops its result if it is still to be said; the caller asks the server to stop a running one. */
  cancel(requestId: string) { this.drop(requestId, { status: "canceled", step: "stopped" }); }

  /** A result that is not to be said: neither waiting in line nor, if the user cut it off, the rest of it. */
  private drop(requestId: string, change: Partial<CallTask>) {
    this.outbox = this.outbox.filter(item => item.requestId !== requestId);
    if (this.cut?.requestId === requestId) this.cut = null;
    this.update(requestId, change);
  }
}
