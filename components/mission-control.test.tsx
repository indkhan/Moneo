import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionControl } from "./mission-control";
import type { AgentRunView } from "@/lib/ai/agent-state";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/ai/agent-actions", () => ({ decideAgentProposals: vi.fn() }));

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

const stopControl = 'lucide-square ';

it("streams each agent's step, tool calls, duration and skip reason while the run is live, with no decisions to take yet", () => {
  const html = renderToStaticMarkup(<MissionControl initial={run("running")} locale="en-GB" />);
  expect(html).toContain("Asking the model about 12 unfamiliar descriptions");
  expect(html).toContain("generateObject: suggest owned categories");
  expect(html).toContain("4 patterns detected");
  expect(html).toContain("1.5 s");
  expect(html).toContain("Allow AI access to planning in Settings");
  expect(html).toContain(stopControl);
  expect(html).not.toContain('aria-label="Accept ');
});

it("ends with the briefing and a review screen with evidence, lead notes, undo paths and a link to Home", () => {
  const html = renderToStaticMarkup(<MissionControl initial={run("completed")} locale="en-GB" />);
  expect(html).toContain("You paid EUR 5.00 in fees.");
  expect(html).toContain('href="/"');
  expect(html).toContain("Monthly account fee");
  expect(html).toContain("2 rows proposed for this category are not in this history yet");
  expect(html).toContain('href="/plan/spending"');
  expect(html).toContain("Turn the limit off in Plan → Spending");
  expect(html).not.toContain(stopControl);
});

it("counts open decisions, filters by agent and previews a bulk accept instead of applying it at once", () => {
  const initial = run("completed");
  const limit = (n: number, confidence: number) => ({ ...initial.proposals[1], id: `00000000-0000-4000-8000-00000000010${n}`, title: `Limit ${n}`, status: "proposed", result: null, notes: [], confidence });
  const html = renderToStaticMarkup(<MissionControl initial={{ ...initial, proposals: [...initial.proposals, limit(1, 75), limit(2, 55)] }} locale="en-GB" />);
  expect(html).toContain("3 open decisions");
  expect(html).toContain("2 here, 1 on Home");
  expect(html).toContain("Accept 1 high confidence");
  expect(html).not.toContain('aria-label="Confirm accepting these"');
  expect(html).toContain('aria-label="Show results from"');
  expect(html).toContain("All (4)");
  expect(html).toContain('aria-label="Accept Limit 1"');
});

it("offers bulk decisions only within the 100 the action accepts", () => {
  const initial = run("completed");
  const limits = Array.from({ length: 101 }, (_, index) => ({ ...initial.proposals[1], id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: `Limit ${index}`, status: "proposed", result: null, notes: [], confidence: 75 }));
  const html = renderToStaticMarkup(<MissionControl initial={{ ...initial, proposals: limits }} locale="en-GB" />);
  expect(html).toContain("Accept 100 high confidence");
  expect(html).toContain("Accept first 100");
  expect(html).toContain("Reject first 100");
});
