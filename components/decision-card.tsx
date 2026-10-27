"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { decideAgentProposals, loadAgentProposals } from "@/app/ai/agents/actions";
import { agentDecisionSchema } from "@/lib/ai/agent-findings";

type Row = Awaited<ReturnType<typeof loadAgentProposals>>[number];
const label = { proposed: "Open", failed: "Failed", applying: "Applying", accepted: "Accepted", rejected: "Dismissed" } as Record<string, string>;

/** Agent-team proposals the chat suggested accepting or dismissing; nothing changes until Confirm is pressed. */
export function DecisionCard({ source }: { source: string }) {
  let request: ReturnType<typeof agentDecisionSchema.parse> | null = null;
  try { request = agentDecisionSchema.parse(JSON.parse(source)); } catch { /* not a decision block */ }
  const ids = request?.ids.join(",");
  const [rows, setRows] = useState<Row[]>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  useEffect(() => { if (ids) loadAgentProposals(ids.split(",")).then(setRows, () => setRows([])); }, [ids]);
  if (!request) return null;
  if (!rows) return <p className="my-3 text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!rows.length) return null;
  const { decision } = request;
  const open = rows.filter(row => row.status === "proposed" || row.status === "failed");
  const confirm = () => start(async () => {
    setError(undefined);
    try {
      const outcomes = await decideAgentProposals(open.map(row => row.id), decision);
      const failed = outcomes.filter(outcome => outcome.error);
      if (failed.length) setError(`${failed.length} could not be ${decision === "accept" ? "applied" : "dismissed"}: ${failed[0].error}`);
      setRows(await loadAgentProposals(rows.map(row => row.id)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save"); }
  });
  return <section aria-label="Agent team decision" className="my-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <p className="font-medium">{decision === "accept" ? "Accept" : "Dismiss"} {rows.length === 1 ? "this finding" : `these ${rows.length} findings`}</p>
    <ul className="mt-2 space-y-1 text-sm">{rows.map(row => <li key={row.id} className="flex justify-between gap-3"><span className="min-w-0 [overflow-wrap:anywhere]">{row.title}</span><span className="shrink-0 text-muted-foreground">{label[row.status] ?? row.status}</span></li>)}</ul>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {open.length > 0 && <button type="button" disabled={pending} onClick={confirm} className="min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{decision === "accept" ? `Accept ${open.length}` : `Dismiss ${open.length}`}</button>}
      <Link href={`/ai/agents/${rows[0].run_id}`} className="text-sm underline">Open in Agent team</Link>
    </div>
  </section>;
}
