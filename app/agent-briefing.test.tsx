import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentBriefing } from "./agent-briefing";

vi.mock("./ai/agents/start-run", () => ({ StartAgentRun: ({ label }: { label: string }) => <button>{label}</button> }));
const db = (run: unknown, proposals: unknown[] = []) => ({ from: (table: string) => {
  const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: run, error: null }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "agent_proposals" ? proposals : [], error: null }).then(resolve) };
  return q;
} }) as never;

it("shows the latest briefing with what waits for review", async () => {
  const html = renderToStaticMarkup(await AgentBriefing({ db: db({ id: "r1", status: "completed", briefing: "Fees cost EUR 5.00.\n\nMore.", created_at: "t" }, [{ kind: "finding" }, { kind: "budget" }, { kind: "categorize" }]), workspaceId: "w" }));
  expect(html).toContain("Briefing from your agent team");
  expect(html).toContain("Fees cost EUR 5.00.");
  expect(html).not.toContain("More.");
  expect(html).toContain("2 changes to review · 1 findings");
  expect(html).toContain("Run again");
});

it("links to the live run while the team works and invites a first run otherwise", async () => {
  expect(renderToStaticMarkup(await AgentBriefing({ db: db({ id: "r2", status: "running", briefing: null, created_at: "t" }), workspaceId: "w" }))).toContain('href="/ai/agents/r2"');
  expect(renderToStaticMarkup(await AgentBriefing({ db: db(null), workspaceId: "w" }))).toContain("Run agent team");
});
