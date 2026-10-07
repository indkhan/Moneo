import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("closes owner-written assistant replies and reserves successful publication for the trusted service", () => {
  const sql = readFileSync("supabase/migrations/202610060014_verified_financial_evidence.sql", "utf8");
  expect(sql).toContain("create function public.finish_verified_chat_request");
  expect(sql).toContain("from public,anon,authenticated");
  expect(sql).toContain("Successful chat publication requires trusted validation");
  expect(sql).toContain("drop policy own_messages on public.messages");
  expect(sql).toContain("role='user'");
});
