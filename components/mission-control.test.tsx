import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionControl } from "./mission-control";
import type { AgentRunView } from "@/lib/ai/agent-state";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/ai/agents/actions", () => ({ decideAgentProposals: vi.fn() }));

const task = (agent: string, status: string, extra = {}) => ({ agent, position: 0, status, step: null, summary: null, events: [], started_at: null, finished_at: null, ...extra });
const run = (status: string): AgentRunView => ({ id: "00000000-0000-4000-8000-000000000001", status, trigger: "import", import_id: null, briefing: status === "completed" ? "You paid EUR 5.00 in fees.\n\nThree changes are ready." : null,
  model_calls: 2, model_budget: 6, model_status: "available", error: null, created_at: "2026-10-16T10:00:00Z", finished_at: null,
  tasks: [task("lead", "running", { summary: "Planned 5 of 7 agents", events: [{ at: "t", type: "step", text: "Assigned 5 agents in 3 waves" }] }),
    task("categorizer", "running", { step: "Asking the model about 12 unfamiliar descriptions", events: [{ at: "t", type: "tool", text: "generateObject: suggest owned categories" }] }),
    task("recurring", "done", { summary: "4 patterns detected", started_at: "2026-10-16T10:00:00Z", finished_at: "2026-10-16T10:00:01.500Z" }),
    task("budget", "skipped", { summary: "Allow AI access to planning in Settings" }), task("writer", "pending")] as AgentRunView["tasks"],
  proposals: [{ id: "00000000-0000-4000-8000-000000000002", agent: "anomaly", kind: "finding", title: "3 fees and charges: EUR 5.00 in 90 days", detail: "Descriptions mention fees.", confidence: 75, notes: [],
    status: "proposed", result: null, evidence: { facts: [{ label: "Total", value: "EUR 5.00" }], transactions: [{ id: "00000000-0000-4000-8000-000000000003", date: "2026-10-05", description: "Monthly account fee", amountMinor: "-500", currency: "EUR" }], links: [] } },
  { id: "00000000-0000-4000-8000-000000000004", agent: "budget", kind: "budget", title: "Dining: EUR 210.00 a month", detail: "Median of three months.", confidence: 60, notes: ["2 rows proposed for this category are not in this history yet"],
    status: "accepted", result: { href: "/plan/spending", undo: "Turn the limit off in Plan → Spending" }, evidence: { facts: [], transactions: [], links: [] } }] });

it("streams each agent's status, step and tool calls while the run is live", () => {
  const html = renderToStaticMarkup(<MissionControl initial={run("running")} locale="en-GB" />);
  expect(html).toContain("Wave 1 · Analysts · in parallel");
  expect(html).toContain("Asking the model about 12 unfamiliar descriptions");
  expect(html).toContain("generateObject: suggest owned categories");
  expect(html).toContain("4 patterns detected");
  expect(html).toContain("1.5 s");
  expect(html).toContain("Allow AI access to planning in Settings");
  expect(html).toContain("Free model · 2/6 calls");
  expect(html).toContain(">Stop<");
  // Review stays closed until the lead has merged and the run finished.
  expect(html).toContain("Review opens when the team finishes");
  expect(html).not.toContain("Mark reviewed");
});

it("ends with the briefing and a review screen with evidence, lead notes and undo paths", () => {
  const html = renderToStaticMarkup(<MissionControl initial={run("completed")} locale="en-GB" />);
  expect(html).toContain("You paid EUR 5.00 in fees.");
  expect(html).toContain("Accept selected (0)");
  expect(html).toContain("Mark reviewed");
  expect(html).toContain("Monthly account fee");
  expect(html).toContain("Lead: 2 rows proposed");
  expect(html).toContain("Turn the limit off in Plan → Spending");
  expect(html).not.toContain(">Stop<");
});
