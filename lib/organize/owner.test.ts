import { describe, expect, it } from "vitest";
import { answerQuestion, undoAnswer } from "./owner";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function fakeDb(options: { rpc?: (name: string) => { data?: unknown; error?: { message: string } }; tables?: Record<string, unknown> } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in"]) query[name] = () => query;
    query.maybeSingle = () => Promise.resolve({ data: options.tables?.[table] ?? null, error: null });
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: options.tables?.[table] ?? [], error: null }).then(resolve);
    return query;
  };
  const rpc = (name: string, args: unknown) => { calls.push({ name, args }); const result = options.rpc?.(name); return Promise.resolve({ data: result?.data ?? null, error: result?.error ?? null }); };
  return { calls, db: { from, rpc } as never };
}

describe("answerQuestion", () => {
  it("labels the payee's rows first and only then closes the question with what was done", async () => {
    const batch = { memoryId: id(1), batchId: id(2), applied: 3 };
    const { calls, db } = fakeDb({ rpc: name => name === "confirm_organize_memory" ? { data: batch } : {} });
    await answerQuestion(db, { questionId: id(3), identityId: id(4), categoryId: id(5), merchantId: null });
    expect(calls.map(call => call.name)).toEqual(["confirm_organize_memory", "answer_organize_question"]);
    expect(calls[0].args).toMatchObject({ p_identity: id(4), p_category: id(5), p_apply_to_existing: true });
    expect(calls[1].args).toMatchObject({ p_question: id(3), p_status: "answered", p_answer: { batchId: id(2), applied: 3 } });
  });

  it("leaves the question open when labelling fails, so the owner can try again", async () => {
    const { calls, db } = fakeDb({ rpc: () => ({ error: { message: "Category not found" } }) });
    await expect(answerQuestion(db, { questionId: id(3), identityId: id(4), categoryId: id(5), merchantId: null })).rejects.toThrow("Category not found");
    expect(calls.map(call => call.name)).toEqual(["confirm_organize_memory"]);
  });
});

describe("undoAnswer", () => {
  it("undoes the batch with every row's current version", async () => {
    const { calls, db } = fakeDb({ tables: { transaction_batches: { selection: [{ id: id(1), version: 0 }, { id: id(2), version: 0 }] }, transactions: [{ id: id(1), version: 1 }, { id: id(2), version: 4 }] } });
    await undoAnswer(db, "w", id(9));
    expect(calls).toEqual([{ name: "undo_transaction_batch", args: { p_batch_id: id(9), p_rows: [{ id: id(1), version: 1 }, { id: id(2), version: 4 }] } }]);
  });

  it("refuses when a labelled row no longer exists instead of undoing part of the answer", async () => {
    const { calls, db } = fakeDb({ tables: { transaction_batches: { selection: [{ id: id(1), version: 0 }, { id: id(2), version: 0 }] }, transactions: [{ id: id(1), version: 1 }] } });
    await expect(undoAnswer(db, "w", id(9))).rejects.toThrow("no longer exist");
    expect(calls).toEqual([]);
  });
});
