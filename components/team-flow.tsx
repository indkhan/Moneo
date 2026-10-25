import { AGENTS, WAVES, type AgentId } from "@/lib/ai/agent-team";

type Status = string | undefined;
const TERMINAL = new Set(["done", "failed", "skipped", "canceled"]);
const TONE: Record<string, string> = {
  running: "border-brand bg-brand/10 ring-4 ring-brand/20 animate-pulse",
  done: "border-success bg-success-soft",
  failed: "border-danger bg-danger-soft",
  skipped: "border-dashed border-border opacity-50",
  canceled: "border-dashed border-border opacity-50",
};
const LABEL: Record<string, string> = { running: "Running…", done: "Done", failed: "Failed", skipped: "Skipped", canceled: "Canceled", pending: "Waiting" };

const Node = ({ agent, status, lead }: { agent: AgentId; status?: Status; lead?: boolean }) => <div data-status={status ?? "idle"}
  className={`w-full max-w-60 rounded-xl border bg-card p-3 text-center shadow-sm transition-all duration-500 ${status ? TONE[status] ?? "border-border" : lead ? "border-brand/50 ring-1 ring-brand/20" : "border-border"}`}>
  <p className="text-sm font-semibold">{AGENTS[agent].name}</p><p className="text-xs text-muted-foreground">{AGENTS[agent].role}</p>
  {status && <p className={`mt-1 text-[11px] font-medium ${status === "running" ? "text-brand" : status === "done" ? "text-success" : status === "failed" ? "text-danger" : "text-muted-foreground"}`}>{LABEL[status] ?? status}</p>}
</div>;

// Connector with a travelling pulse; only pulses while the step below it is live (or always in the static overview).
const Arrow = ({ label, live = true, lit }: { label?: string; live?: boolean; lit?: boolean }) => <div className="flex flex-col items-center py-1" aria-hidden="true">
  <div className={`relative h-8 w-px ${lit ? "bg-success" : "bg-gradient-to-b from-brand/60 to-border"}`}>{live && <span className="absolute left-1/2 top-0 size-2 -translate-x-1/2 animate-ping rounded-full bg-brand" />}</div>
  {label && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{label}</span>}
  <div className={`size-0 border-x-4 border-t-[6px] border-x-transparent ${lit ? "border-t-success" : "border-t-brand/60"}`} /></div>;

const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => <li className="flex w-full flex-col items-center gap-2">
  <span className="flex items-center gap-2 eyebrow"><span className="flex size-5 items-center justify-center rounded-full bg-brand text-[11px] text-white">{n}</span>{title}</span>
  {children}</li>;

/** The run as a flowchart. Pass live task statuses to light up what is running; omit them for the static overview. */
export function TeamFlow({ statuses, finished }: { statuses?: Partial<Record<AgentId, string>>; finished?: boolean }) {
  const live = Boolean(statuses);
  const of = (agent: AgentId): Status => live ? statuses?.[agent] ?? "pending" : undefined;
  const started = (agents: AgentId[]) => agents.some(agent => of(agent) !== "pending");
  const settled = (agents: AgentId[]) => agents.every(agent => TERMINAL.has(of(agent) ?? ""));
  const writers = WAVES[WAVES.length - 1], beforeWriters = WAVES.slice(0, -1).flat();
  // The lead plans first and merges before the writer; its task row covers both, so derive each phase.
  const plan: Status = !live ? undefined : started(WAVES[0]) || finished ? "done" : of("lead") === "failed" ? "failed" : "running";
  const merge: Status = !live ? undefined : started(writers) || finished ? "done" : settled(beforeWriters) ? "running" : "pending";
  const lit = (status: Status) => status === "done";
  return <section aria-label="How a run works" className="rounded-2xl border border-border bg-gradient-to-b from-brand/5 to-transparent p-4 sm:p-6">
    <h2 className="mb-4 text-center text-base font-semibold">{live ? "Live run" : "How a run works"}</h2>
    <ol className="flex flex-col items-center">
      <Step n={1} title="Plan"><Node agent="lead" status={plan} lead /></Step>
      {WAVES.map((wave, i) => {
        const waveRunning = wave.some(agent => of(agent) === "running") || (wave === writers && merge === "running");
        return <div key={i} className="contents"><li aria-hidden="true" className="w-full"><Arrow label={i === 0 ? "assigns work" : "then"} live={!live || waveRunning} lit={live && started(wave)} /></li>
          <Step n={i + 2} title={wave.length > 1 ? `Wave ${i + 1} · in parallel` : `Wave ${i + 1}`}>
            {wave === writers && <><Node agent="lead" status={merge} lead /><Arrow label="merges & resolves conflicts" live={!live || of(writers[0]) === "running"} lit={lit(merge)} /></>}
            <div className={`grid w-full gap-2 rounded-xl border border-dashed p-2 transition-colors duration-500 ${wave.length > 1 ? "sm:grid-cols-2" : ""} ${wave.length > 2 ? "lg:grid-cols-4" : ""} ${waveRunning ? "border-brand bg-brand/5" : "border-brand/30"}`}>
              {wave.map(agent => <div key={agent} className="flex justify-center"><Node agent={agent} status={of(agent)} /></div>)}</div>
          </Step></div>;
      })}
      <li aria-hidden="true" className="w-full"><Arrow label="proposals + briefing" live={!live} lit={live && finished} /></li>
      <Step n={WAVES.length + 2} title="You decide"><div className={`rounded-xl border px-4 py-3 text-center text-sm font-medium transition-all duration-500 ${live && finished ? "border-brand bg-brand text-white ring-4 ring-brand/20" : "border-brand bg-brand/10 text-brand"}`}>{live && finished ? "Ready: review the proposals below" : "Review each proposal: accept or dismiss"}</div></Step>
    </ol>
    {!live && <p className="mt-3 text-center text-xs text-muted-foreground">Agents with nothing to do are skipped. Nothing changes until you accept.</p>}
  </section>;
}
