import { AGENTS, WAVES, type AgentId } from "@/lib/ai/agent-team";

type Status = string | undefined;
const TERMINAL = new Set(["done", "failed", "skipped", "canceled"]);
const LABEL: Record<string, string> = { running: "Running…", done: "Done", failed: "Failed", skipped: "Skipped", canceled: "Canceled", pending: "Waiting" };
const DOT: Record<string, string> = { running: "bg-ai animate-pulse", done: "bg-brand", failed: "bg-danger", skipped: "bg-input", canceled: "bg-input", pending: "bg-input" };

// One agent inside a stage: name, role, and its live status when a run is shown.
const Agent = ({ agent, status }: { agent: AgentId; status?: Status }) => <div data-status={status ?? "idle"}
  className={`flex min-w-0 flex-col gap-0.5 rounded-[10px] bg-muted p-2.5 transition-opacity duration-500 ${status === "skipped" || status === "canceled" ? "opacity-50" : ""}`}>
  <span className="flex items-center gap-2 text-[13px]"><span className={`size-1.5 shrink-0 rounded-full ${status ? DOT[status] ?? "bg-input" : "bg-ai"}`} aria-hidden="true" />{AGENTS[agent].name}</span>
  <span className={`text-[11px] ${status ? "font-mono" : ""} ${status === "failed" ? "text-danger" : status === "running" ? "text-ai" : "text-muted-foreground"}`}>{status ? LABEL[status] ?? status : AGENTS[agent].role}</span>
</div>;

// A numbered stage; the lead's stages are violet like the rest of the AI's own work.
const Stage = ({ n, title, lead, wide, status, children }: { n: number; title: string; lead?: boolean; wide?: boolean; status?: Status; children: React.ReactNode }) =>
  <li data-status={status ?? "idle"} className={`flex min-w-0 flex-col gap-2.5 rounded-[14px] border p-3.5 ${wide ? "flex-[3_1_420px]" : "flex-[1_1_150px]"} ${lead ? "border-ai-border bg-ai-soft" : "border-border"} ${status === "running" ? "ring-2 ring-ai/30" : ""}`}>
    <span className={`font-mono text-[10px] uppercase ${lead ? "text-ai" : "text-subtle"}`}>{String(n).padStart(2, "0")} · {title}{status ? ` · ${LABEL[status] ?? status}` : ""}</span>
    {children}
  </li>;

/** The run as left-to-right stages. Pass live task statuses to light up what is running; omit them for the static overview. */
export function TeamFlow({ statuses, finished }: { statuses?: Partial<Record<AgentId, string>>; finished?: boolean }) {
  const live = Boolean(statuses);
  const of = (agent: AgentId): Status => live ? statuses?.[agent] ?? "pending" : undefined;
  const started = (agents: AgentId[]) => agents.some(agent => of(agent) !== "pending");
  const settled = (agents: AgentId[]) => agents.every(agent => TERMINAL.has(of(agent) ?? ""));
  const writers = WAVES[WAVES.length - 1], beforeWriters = WAVES.slice(0, -1).flat();
  // The lead plans first and merges before the writer; its task row covers both, so derive each phase.
  const plan: Status = !live ? undefined : started(WAVES[0]) || finished ? "done" : of("lead") === "failed" ? "failed" : "running";
  const merge: Status = !live ? undefined : started(writers) || finished ? "done" : settled(beforeWriters) ? "running" : "pending";
  return <section aria-label="How a run works" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
    <h2 className="text-sm font-medium">{live ? "Live run" : "How a run works"}</h2>
    <ol className="flex flex-wrap items-stretch gap-2.5">
      <Stage n={1} title="Plan" lead status={plan}><span className="text-sm font-medium">Lead</span><span className="text-xs text-muted-foreground">Splits the work across the team</span></Stage>
      {WAVES.slice(0, -1).map((wave, index) => <Stage key={index} n={index + 2} title={wave.length > 1 ? "In parallel" : "Next"} wide>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-2">{wave.map(agent => <Agent key={agent} agent={agent} status={of(agent)} />)}</div>
      </Stage>)}
      <Stage n={WAVES.length + 1} title="Merge + write" lead status={merge}>
        <span className="text-sm font-medium">Lead · {writers.map(agent => AGENTS[agent].name).join(" · ")}</span>
        <span className="text-xs text-muted-foreground">Resolves conflicts, verifies findings, writes the briefing</span>
      </Stage>
      <Stage n={WAVES.length + 2} title="You decide" status={live ? finished ? "done" : "pending" : undefined}>
        <span className="text-sm font-medium">{live && finished ? "Ready: review the proposals below" : "Review each proposal: accept or dismiss"}</span>
      </Stage>
    </ol>
    {!live && <p className="text-xs text-muted-foreground">Agents with nothing to do are skipped. Nothing changes until you accept.</p>}
  </section>;
}
