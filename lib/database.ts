import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Json, Database as Generated } from "@/lib/database.types";

export const jsonObject = z.record(z.string(), z.unknown());

type Wire<Value> = [NonNullable<Json>] extends [NonNullable<Value>] ? unknown : Value extends number ? Value | string : Value;
type WireFields<Fields> = { [Field in keyof Fields]: Wire<Fields[Field]> };
type WireArgs<Args> = { [Arg in keyof Args]: Wire<Args[Arg]> | null };

type JsonReturns = {
  start_chat_request: { started: boolean; status: string; answer: string | null };
  control_import: { started: boolean; totalRows: number; runVersion: number };
  create_organization_review: { id: string };
  create_manual_transaction: { id: string | null };
};

type FilledByTrigger = { spending_plans: "rollover_from" };
type Optional<Fields, Keys> = Omit<Fields, Extract<keyof Fields, Keys>> & { [Key in Extract<keyof Fields, Keys>]?: Fields[Key] };
type InsertFields<Table, Insert> = Table extends keyof FilledByTrigger ? Optional<WireFields<Insert>, FilledByTrigger[Table]> : WireFields<Insert>;

type WithWireTypes<Schema> = {
  [Section in keyof Schema]: Section extends "Tables"
    ? { [Table in keyof Schema[Section]]: Schema[Section][Table] extends { Insert: infer Insert; Update: infer Update }
        ? Omit<Schema[Section][Table], "Insert" | "Update"> & { Insert: InsertFields<Table, Insert>; Update: WireFields<Update> }
        : Schema[Section][Table] }
    : Section extends "Functions"
      ? { [Fn in keyof Schema[Section]]: Schema[Section][Fn] extends { Args: infer Args }
          ? Omit<Schema[Section][Fn], "Args" | "Returns"> & { Args: WireArgs<Args>; Returns: Fn extends keyof JsonReturns ? JsonReturns[Fn] : Schema[Section][Fn] extends { Returns: infer Returns } ? Returns : never }
          : Schema[Section][Fn] }
      : Schema[Section];
};

export type Database = { public: WithWireTypes<Generated["public"]> };
export type Db = SupabaseClient<Database>;
export type { Json };
