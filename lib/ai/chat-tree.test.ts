import { expect, it } from "vitest";
import { ancestors, answerPick, questionPick, visiblePath, type ChatNode } from "./chat-tree";

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
