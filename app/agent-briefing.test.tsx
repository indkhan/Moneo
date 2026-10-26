import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentBriefing } from "./agent-briefing";

vi.mock("./ai/agents/start-run", () => ({ StartAgentRun: ({ label }: { label: string }) => <button>{label}</button> }));
const db = (run: unknown, proposals: unknown[] = [], tasks: unknown[] = []) => ({ from: (table: string) => {
  const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: run, error: null }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "agent_proposals" ? proposals : table === "agent_tasks" ? tasks : [], error: null }).then(resolve) };
  return q;
} }) as never;

it("shows each agent's result from the latest run and links to its proposals", async () => {
  const run = { id: "r1", status: "completed", created_at: "2026-10-26T06:00:00Z", finished_at: "2026-10-26T06:04:12Z" };
  const html = renderToStaticMarkup(await AgentBriefing({ db: db(run, [{ kind: "finding" }, { kind: "budget" }], [{ agent: "categorizer", status: "done", summary: "14 proposals · 2 new rules" }]), workspaceId: "w" }));
  for (const text of ["Agent team", "last run 06:00 · 4m 12s", "Categorizer", "14 proposals · 2 new rules", "Recurring detective", "Insight writer", "Review 2 proposals", 'href="/ai/agents/r1"']) expect(html).toContain(text);
  expect(html).not.toContain("Run again");
});

it("links to the live run while the team works and invites a run otherwise", async () => {
  expect(renderToStaticMarkup(await AgentBriefing({ db: db({ id: "r2", status: "running", created_at: "2026-10-26T06:00:00Z", finished_at: null }), workspaceId: "w" }))).toContain("Watch live");
  expect(renderToStaticMarkup(await AgentBriefing({ db: db({ id: "r3", status: "completed", created_at: "2026-10-26T06:00:00Z", finished_at: null }), workspaceId: "w" }))).toContain("Run again");
  expect(renderToStaticMarkup(await AgentBriefing({ db: db(null), workspaceId: "w" }))).toContain("Run agent team");
});
