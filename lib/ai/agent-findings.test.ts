import { expect, it } from "vitest";
import { agentDecisionSchema, decisionBlock, openAgentProposalIds } from "@/lib/ai/agent-findings";

const id = "00000000-0000-4000-8000-000000000001";

it("writes a decision block the card can parse back", () => {
  const block = decisionBlock([id], "accept");
  expect(block.startsWith("```moneo-decision\n")).toBe(true);
  expect(agentDecisionSchema.parse(JSON.parse(block.split("\n")[1]))).toEqual({ ids: [id], decision: "accept" });
});

it("keeps only owned, open agent-run proposals", async () => {
  const filters: unknown[][] = [];
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "not"]) query[name] = (...args: unknown[]) => { filters.push([name, ...args]); return query; };
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id }], error: null }).then(resolve);
  expect(await openAgentProposalIds({ from: () => query } as never, "w", [id])).toEqual([id]);
  expect(filters).toEqual(expect.arrayContaining([["eq", "workspace_id", "w"], ["not", "run_id", "is", null], ["in", "status", ["proposed", "failed"]]]));
});
