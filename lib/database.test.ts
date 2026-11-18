import { describe, expectTypeOf, it } from "vitest";
import type { Db, ReadonlyDb } from "@/lib/database";

type Relation = ReturnType<ReadonlyDb["from"]>;
type ReadRpc = Parameters<ReadonlyDb["rpc"]>[0];

describe("ReadonlyDb", () => {
  it("lets an AI tool select from any table or view but never insert, update, upsert or delete", () => {
    expectTypeOf<keyof Relation>().toEqualTypeOf<"select">();
    expectTypeOf<Relation>().not.toHaveProperty("insert");
    expectTypeOf<Relation>().not.toHaveProperty("update");
    expectTypeOf<Relation>().not.toHaveProperty("upsert");
    expectTypeOf<Relation>().not.toHaveProperty("delete");
  });

  it("calls only the RPCs listed as read-only", () => {
    expectTypeOf<ReadRpc>().toEqualTypeOf<"data_query" | "similar_transaction_ids">();
    expectTypeOf<"create_manual_transaction">().not.toExtend<ReadRpc>();
    expectTypeOf<"apply_ai_organization">().not.toExtend<ReadRpc>();
  });

  it("accepts the full client wherever a read-only one is asked for", () => {
    expectTypeOf<Db>().toExtend<ReadonlyDb>();
    expectTypeOf<ReadonlyDb>().not.toExtend<Db>();
  });
});
