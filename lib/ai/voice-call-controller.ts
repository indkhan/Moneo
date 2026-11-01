import type { ChatAnswer, ChatStreamEvent } from "./use-chat-request";

export type CallCaption = { id: number; role: "user" | "assistant"; text: string };
export type CallTask = { requestId: string; text: string; step: string; status: "running" | "done" | "failed" | "canceled"; delegationId: string | null; cards: string[] };
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
  finance_scenario: "comparing a what-if", analytics_cashflow: "adding up income and spending", accounts_list: "checking accounts", accounts_getBalances: "checking balances",
  forecast_evaluate: "running the forecast", goals_list: "checking goals", wealth_list: "checking what you lent and own", recurring_list: "checking recurring payments", reviews_investigate: "reviewing finances",
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
/** Words still unclaimed after the user has been quiet this long were a request GPT-Live said yes to but never handed off.
 * Once GPT-Live has replied to them ("on that one too"), a short pause is enough, so the user's next words stay apart. */
export const UNCLAIMED_MS = 4000;
const SMALL_TALK = /\b(hi|hey|hello|yo|thanks|thank you|bye|good (morning|evening|night)|how are you( doing)?( today)?|i'?m (good|fine|okay)|okay|ok|yeah|yes|no|um+|uh+|mm+|mm-?hm|(can|could|would|will) you( also)?( please)?( tell me| say)?)\b/gi;
const ASKS = /\?|\b(how much|what|when|where|who|which|why|check|show|tell|add|spent|spend|paid|pay|lent|lend|borrowed?|owe|bought|received|transfer|budget|save|balance|cancel|remove|change)\b/i;
/** Whether unclaimed words ask for something, rather than being small talk GPT-Live answered itself. */
export function looksLikeRequest(text: string) {
  const rest = text.replace(SMALL_TALK, " ").trim();
  return rest.split(/\s+/).filter(Boolean).length >= 3 && ASKS.test(rest);
}
/** How long a hand-off with no new words waits for them to be transcribed. */
export const LATE_WORDS_MS = 1500;
export const SLOW_TASK_MS = 8000;
/** Moneo silent this long after it began saying a result means it said all of it. The user's words are transcribed
 * about a second late, so words arriving sooner than this were said over the result. */
export const RESULT_DONE_MS = 2500;
/** Moneo silent this long, with the mic quiet since, also means it said all of it: the mic hears the user at once,
 * so nobody talked over it, and the next result follows without a long gap. */
export const RESULT_PAUSE_MS = 1200;
/** Longest wait for Moneo to start saying a result before the next is handed over anyway. */
export const RESULT_TURN_MS = 20_000;
/** A pause this long ends the user's turn for handing over a result; people pause mid-sentence ("uh… like…"). */
export const USER_PAUSE_MS = 1500;
/** How long Moneo gets to answer an interruption before it is asked to finish the result it was cut off in. */
export const RESUME_AFTER_MS = 3000;

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
  /** What Moneo has said since the user last spoke. */
  private reply = "";
  private lastDelegation: string | null = null;
  /** A request started from unclaimed words, which a late hand-off of the same words takes over instead of repeating. */
  private unclaimedTask: string | null = null;
  private answers = new Map<string, string>();
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
  private current: { delegationId: string | null; content: string; at: number } | null = null;
  /** A result the user talked over, with what they said since, until Moneo is asked to finish it. */
  private cut: { delegationId: string | null; content: string; words: string } | null = null;
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
  /** When Moneo last made a sound: its metered voice once there is one, else its transcript. */
  private get lastMoneo() { return this.metered ? this.lastAudible : this.lastAssistantSpeech; }
  /** Someone is talking right now. */
  speaking(by: "user" | "moneo" | "any" = "any") {
    const last = by === "user" ? this.lastUserSpeech : by === "moneo" ? this.lastMoneo : Math.max(this.lastUserSpeech, this.lastMoneo);
    return this.now() - last < SPEAKING_HOLD_MS;
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
      case "session.input_transcript.delta":
        // Talking over a result GPT-Live is saying stops it, and the rest would be lost.
        if (this.current && this.lastMoneo > this.current.at && !this.resultSaid()) {
          this.cut = { delegationId: this.current.delegationId, content: this.current.content, words: "" };
          this.deps.log?.(`cut off: ${this.current.content.slice(0, 60)}`);
          this.current = null;
          this.resume();
        }
        if (this.cut) this.cut.words += event.delta ?? "";
        this.lastUserSpeech = this.now();
        this.reply = "";
        this.heard.push({ text: event.delta ?? "", start: event.start_ms ?? event.end_ms ?? Infinity });
        this.caption("user", event.delta ?? "");
        this.schedule(() => this.claimUnheard(), UNCLAIMED_MS);
        break;
      case "session.output_transcript.delta":
        this.lastAssistantSpeech = this.now();
        this.caption("assistant", event.delta ?? "");
        this.reply += event.delta ?? "";
        if (this.replied()) this.schedule(() => this.claimUnheard(), USER_PAUSE_MS);
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
   * Starts a hand-off's request from the words up to its offset. With none yet, a request already started from the
   * same unclaimed words answers through it; otherwise its words may still be on their way from the transcriber. A
   * hand-off that never gets words of its own starts nothing, so a request never runs twice.
   */
  private claim(delegationId: string, offset: number, wait = true) {
    // A word the user began before the hand-off is part of its request, even if it ended just after.
    const before = (piece: { start: number }) => offset === Infinity || piece.start < offset;
    const claimed = this.heard.some(before) ? this.heard.filter(before) : wait ? this.heard : [];
    this.heard = this.heard.filter(piece => !claimed.includes(piece));
    const words = claimed.map(piece => piece.text).join("").replace(/\[[^\]]*\]/g, "").trim();
    if (words) { this.unclaimedTask = null; this.start(words, delegationId); }
    else if (this.unclaimedTask) { this.update(this.unclaimedTask, { delegationId }); this.unclaimedTask = null; }
    else if (wait) this.schedule(() => this.claim(delegationId, offset, false), LATE_WORDS_MS);
    else this.deps.log?.("hand-off with no new words: nothing to start");
  }

  /**
   * GPT-Live sometimes says it is on a request ("sure, I'll check that too") without handing it off. Words that stay
   * unclaimed once the user has been quiet a while, and ask for something, become their own request, answered
   * through the latest hand-off. Small talk GPT-Live answered itself stays with it, and is dropped so the next
   * request doesn't start with it.
   */
  private claimUnheard() {
    const quiet = this.now() - this.lastUserSpeech;
    if (quiet < UNCLAIMED_MS && !(this.replied() && quiet >= USER_PAUSE_MS)) return;
    const text = this.heard.map(piece => piece.text).join("").replace(/\[[^\]]*\]/g, "").trim();
    if (!looksLikeRequest(text)) { this.heard = []; return; }
    if (!this.lastDelegation) return;
    this.heard = [];
    this.deps.log?.(`claimed words GPT-Live never handed off: ${text.slice(0, 60)}`);
    this.unclaimedTask = this.start(text, this.lastDelegation);
  }

  /** GPT-Live has answered the user's last words with more than a backchannel. */
  private replied() { return this.reply.replace(/\[[^\]]*\]/g, "").replace(SMALL_TALK, " ").trim().split(/\s+/).filter(Boolean).length >= 3; }

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
      answered: this.tasks.filter(task => this.answers.has(task.requestId)).slice(-4).map(task => ({ text: task.text.slice(0, 150), answer: this.answers.get(task.requestId)!.slice(0, 300) })),
    };
  }

  private start(text: string, delegationId: string | null) {
    const requestId = this.newId();
    const context = this.brief();
    this.tasks = [...this.tasks, { requestId, text, step: "starting", status: "running", delegationId, cards: [] }];
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
        if (event.type !== "tool" || event.state !== "running") return;
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
      // Quiet context, so GPT-Live never tells the user it is still waiting on a request that has finished.
      if (via()) this.deps.send({ type: "session.thinking.append", delegation_id: via(), content: `Finished ${label}; its result is next in line.` });
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

  /** One short spoken update for a task that runs long, once nobody is talking. */
  private watchSlow(requestId: string, delay = SLOW_TASK_MS) {
    this.schedule(() => {
      const task = this.tasks.find(item => item.requestId === requestId);
      if (task?.status !== "running") return;
      // Never in the middle of saying a result, or before one waiting to be said.
      if (this.speaking() || this.current || this.cut || this.outbox.length) return this.watchSlow(requestId, 1000);
      this.deps.send({ type: "session.commentary.append", delegation_id: task.delegationId, content: `Still working on "${task.text.slice(0, 120)}" (${task.step}). Say so in a few words${task.delegationId ? "" : ", in the language of their quoted words"}.` });
    }, delay);
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
    this.outbox = this.outbox.filter(item => item.requestId !== task.requestId);
    this.update(task.requestId, { status: "canceled", step: "replaced" });
  }

  /**
   * Hands over the next result once Moneo has said the previous one and nobody is talking. A result never says what
   * else is still running: by the time Moneo reaches the end of it, that may have finished too.
   */
  private flush() {
    if (this.flushing || !this.outbox.length || this.cut) return;
    if (this.speaking() || this.now() - this.lastUserSpeech < USER_PAUSE_MS || !this.resultSaid()) {
      this.flushing = true;
      this.schedule(() => { this.flushing = false; this.flush(); }, 300);
      return;
    }
    const { delegationId, content } = this.outbox.shift()!;
    this.current = { delegationId, content, at: this.now() };
    this.deps.log?.(`handed over: ${content.slice(0, 60)}`);
    this.deps.send({ type: "session.commentary.append", delegation_id: delegationId, content });
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
      const words = cut.words.trim().split(/\s+/).length;
      this.deps.log?.(words >= 3 ? "resuming the cut-off result" : "not resuming: only a backchannel");
      if (words >= 3) this.outbox.unshift({ delegationId: cut.delegationId,
        content: `The user talked over you while you were giving this result. If you hadn't finished it, finish the part you hadn't said yet, without repeating what you already said; if you had, or they asked you to stop or skip it, say nothing more about it. ${cut.content}` });
      this.flush();
    }, 300);
  }

  /** Marks a task canceled; the caller asks the server to stop it. */
  cancel(requestId: string) { this.update(requestId, { status: "canceled", step: "stopped" }); }
}
