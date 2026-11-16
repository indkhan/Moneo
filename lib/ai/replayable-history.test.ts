import { expect, it } from "vitest";
import { replayableHistory } from "./replayable-history";

const ask = (request_id: string) => ({ role: "user", request_id });
const answer = (id: string, answer_of: string) => ({ id, role: "assistant", answer_of });

it("shows the model only the newest reply of a regenerated question", () => {
  const history = [answer("second", "q2"), answer("first", "q2"), ask("q2"), answer("older", "q1"), ask("q1")];
  expect(replayableHistory(history).map(item => "id" in item ? item.id : item.request_id)).toEqual(["second", "q2", "older", "q1"]);
});

it("leaves out the question being regenerated and every reply to it", () => {
  const history = [answer("second", "q2"), answer("first", "q2"), ask("q2"), answer("older", "q1"), ask("q1")];
  expect(replayableHistory(history, "q2").map(item => "id" in item ? item.id : item.request_id)).toEqual(["older", "q1"]);
});

it("drops steering sent during the run being regenerated", () => {
  const steer = { id: "steer", role: "user", request_id: null };
  const history = [answer("first", "q2"), steer, ask("q2"), answer("older", "q1"), ask("q1")];
  expect(replayableHistory(history, "q2").map(item => "id" in item ? item.id : item.request_id)).toEqual(["older", "q1"]);
});
