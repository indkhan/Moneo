import { expect, it } from "vitest";
import { ancestors, answerPick, branchOf, newestOnBranch, picksTo, questionPick, visiblePath, type ChatNode } from "./chat-tree";

let clock = 0;
const node = (id: string, parent: string | null, regenerates: string | null = null): ChatNode => ({ id, parent, regenerates, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString() });
const answers = (nodes: ChatNode[], picks = {}) => visiblePath(nodes, picks).map(step => step.answer);

it("follows the newest reply and the conversation that grew from it", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q2", "q1"), node("q2b", "q1", "q2"), node("q3", "q2b")];
  expect(answers(nodes)).toEqual(["q1", "q2b", "q3"]);
});

it("keeps showing an older reply once the owner continued from it", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q2", "q1"), node("q2b", "q1", "q2"), node("q2c", "q1", "q2"), node("q3", "q2b")];
  expect(answers(nodes)).toEqual(["q1", "q2b", "q3"]);
  expect(answers(nodes, { [answerPick({ question: "q2", answers: ["q2", "q2b", "q2c"] })]: "q2c" })).toEqual(["q1", "q2c"]);
});

it("shows an edited question as a branch beside the original and returns to it on request", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q2", "q1"), node("q3", "q2"), node("edit", "q1")];
  const path = visiblePath(nodes);
  expect(path.map(step => step.answer)).toEqual(["q1", "edit"]);
  expect(path[1]?.questions).toEqual(["q2", "edit"]);
  expect(answers(nodes, { [questionPick({ after: "q1", questions: ["q2", "edit"] })]: "q2" })).toEqual(["q1", "q2", "q3"]);
});

it("drops a choice once a newer version appears at that point", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q1b", null, "q1")];
  const picks = { [answerPick({ question: "q1", answers: ["q1", "q1b"] })]: "q1" };
  expect(answers(nodes, picks)).toEqual(["q1"]);
  expect(answers([...nodes, node("q1c", null, "q1")], picks)).toEqual(["q1c"]);
});

it("replays only the branch that leads to the reply being continued", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q2", "q1"), node("q2b", "q1", "q2"), node("q3", "q2")];
  expect(ancestors(nodes, "q2b").map(item => item.id)).toEqual(["q1", "q2b"]);
  expect(ancestors(nodes, "q3").map(item => item.id)).toEqual(["q1", "q2", "q3"]);
});

it("shows the artifact version made on the branch on screen, including one a running reply just saved", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q2", "q1"), node("q2b", "q1", "q2")];
  const versions = [{ version: 1, request_id: null }, { version: 2, request_id: "q1" }, { version: 3, request_id: "q2" }, { version: 4, request_id: "q2b" }];
  expect(newestOnBranch(versions, branchOf(nodes, "q2"))?.version).toBe(3);
  expect(newestOnBranch(versions, branchOf(nodes, "q2b"))?.version).toBe(4);
  expect(newestOnBranch(versions.slice(0, 1), branchOf(nodes, "q2"))?.version).toBe(1);
  expect(newestOnBranch([...versions, { version: 5, request_id: "q3" }], branchOf([...nodes, node("q3", "q2")], "q2"))?.version).toBe(5);
  expect(newestOnBranch([{ version: 6, request_id: "q2b" }], branchOf(nodes, "q2"))).toBeUndefined();
});

it("reopens the branch an address names, through regenerated replies and edited questions", () => {
  clock = 0;
  const nodes = [node("q1", null), node("q2", "q1"), node("q2b", "q1", "q2"), node("q3", "q2"), node("edit", "q1"), node("q4", "q3")];
  expect(answers(nodes, picksTo(nodes, "q4"))).toEqual(["q1", "q2", "q3", "q4"]);
  expect(answers(nodes, picksTo(nodes, "q2b"))).toEqual(["q1", "q2b"]);
  expect(answers(nodes, picksTo(nodes, "edit"))).toEqual(["q1", "edit"]);
  expect(answers(nodes, picksTo(nodes, "missing"))).toEqual(answers(nodes));
});
