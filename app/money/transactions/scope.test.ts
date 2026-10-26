import { expect, it } from "vitest";
import { scopeLedger } from "./scope";

const recorder = () => {
  const calls: string[] = [];
  const q: Record<string, unknown> = {};
  for (const name of ["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "is", "contains"]) q[name] = (column: string, value: unknown) => { calls.push(`${name}:${column}:${value}`); return q; };
  return { q, calls };
};

it("leaves transfers between own accounts out of money in and money out", () => {
  const outflow = recorder();
  scopeLedger(outflow.q, { direction: "outflow" } as never);
  expect(outflow.calls).toEqual(["neq:kind:transfer", "lt:amount_minor:0"]);
  const transfers = recorder();
  scopeLedger(transfers.q, { direction: "outflow", kind: "transfer" } as never);
  expect(transfers.calls).toEqual(["eq:kind:transfer", "lt:amount_minor:0"]);
});
