import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { expect, it } from "vitest";
import { createEvidenceReceipt } from "./evidence-receipts";

it.skipIf(process.env.RUN_VERIFIED_EVIDENCE_DB_TESTS !== "1")("enforces owned scope reads, server-only writes and immutable receipts in a rolled-back disposable schema", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const disposable = `qa_evidence_${randomUUID().replaceAll("-", "")}`, owner = randomUUID(), foreign = randomUUID();
  const rolledBack = new Error("Successful rollback");
  try {
    try { await db.begin(async tx => {
      await tx.unsafe(`create schema ${disposable}; grant usage on schema ${disposable} to authenticated,anon,service_role`);
      const migration = readFileSync("supabase/migrations/202610060014_verified_financial_evidence.sql", "utf8")
        .split("-- Verified chat publication:")[0]
        .replaceAll("public.financial_evidence_receipts", `${disposable}.financial_evidence_receipts`)
        .replaceAll("public.prevent_financial_evidence_update", `${disposable}.prevent_financial_evidence_update`);
      await tx.unsafe(migration);
      await tx`insert into auth.users(id,email) values(${owner},${`qa-${owner}@example.invalid`}),(${foreign},${`qa-${foreign}@example.invalid`})`;
      const [{ id: workspaceId }] = await tx`select id from public.workspaces where owner_id=${owner}`;
      const receipt = createEvidenceReceipt({ workspaceId, fetchedAt: "2026-10-01T00:00:00Z", calculationVersion: "test-v1", sourceVersion: "test-source-v1",
        query: { kind: "synthetic" }, scopes: ["transactions"], sources: [], metrics: [{ id: "spending", label: "Spending", valueMinor: "0", currency: "EUR", period: { from: "2026-09-01", to: "2026-09-30" }, qualifiers: ["partial_coverage"], sourceIds: [], calculation: "sum empty reviewed selection" }] });
      await tx.unsafe(`insert into ${disposable}.financial_evidence_receipts(id,workspace_id,scopes,receipt) values($1,$2,array['transactions'],$3::jsonb)`, [receipt.id, workspaceId, tx.json(receipt)]);
      await expect(tx.savepoint(async sp => sp.unsafe(`insert into ${disposable}.financial_evidence_receipts(id,workspace_id,scopes,receipt) values($1,$2,array[]::text[],'{}'::jsonb)`, [randomUUID(), workspaceId]))).rejects.toMatchObject({ code: "23514" });
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx.unsafe("set local role authenticated");
      expect(await tx.unsafe(`select id from ${disposable}.financial_evidence_receipts`)).toHaveLength(1);
      await expect(tx.savepoint(async sp => sp.unsafe(`insert into ${disposable}.financial_evidence_receipts(id,workspace_id,scopes,receipt) select id,workspace_id,scopes,receipt from ${disposable}.financial_evidence_receipts`))).rejects.toMatchObject({ code: "42501" });
      await tx`select set_config('request.jwt.claim.sub',${foreign},true)`;
      expect(await tx.unsafe(`select id from ${disposable}.financial_evidence_receipts`)).toHaveLength(0);
      await tx.unsafe("reset role");
      await tx`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspaceId},array['accounts']) on conflict(workspace_id) do update set ai_data_scopes=array['accounts']`;
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx.unsafe("set local role authenticated");
      expect(await tx.unsafe(`select id from ${disposable}.financial_evidence_receipts`)).toHaveLength(0);
      await tx.unsafe("reset role");
      // Even a privileged server cannot edit retained evidence.
      await expect(tx.savepoint(async sp => sp.unsafe(`update ${disposable}.financial_evidence_receipts set receipt=receipt where id=$1`, [receipt.id]))).rejects.toMatchObject({ code: "55000" });
      throw rolledBack;
    }); } catch (error) { if (error !== rolledBack) throw error; }
    expect(await db`select id from auth.users where id in (${owner},${foreign})`).toHaveLength(0);
    expect(await db`select schema_name from information_schema.schemata where schema_name=${disposable}`).toHaveLength(0);
  } finally { await db.end(); }
}, 30000);

it.skipIf(process.env.RUN_VERIFIED_EVIDENCE_DB_TESTS !== "1")("concurrent captures retain exactly one immutable receipt and clean the disposable fixture", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 3, onnotice: () => {} });
  const disposable = `qa_evidence_${randomUUID().replaceAll("-", "")}`, owner = randomUUID();
  try {
    const workspaceId = await db.begin(async tx => {
      await tx.unsafe(`create schema ${disposable}`);
      const migration = readFileSync("supabase/migrations/202610060014_verified_financial_evidence.sql", "utf8")
        .split("-- Verified chat publication:")[0]
        .replaceAll("public.financial_evidence_receipts", `${disposable}.financial_evidence_receipts`)
        .replaceAll("public.prevent_financial_evidence_update", `${disposable}.prevent_financial_evidence_update`);
      await tx.unsafe(migration);
      await tx`insert into auth.users(id,email) values(${owner},${`qa-${owner}@example.invalid`})`;
      const [{ id }] = await tx`select id from public.workspaces where owner_id=${owner}`;
      return id as string;
    });
    const receipt = createEvidenceReceipt({ workspaceId, fetchedAt: "2026-10-01T00:00:00Z", calculationVersion: "concurrency-v1", sourceVersion: "v1", query: { kind: "synthetic" }, scopes: [], sources: [], metrics: [] });
    const inserted = await Promise.all([0, 1].map(() => db.begin(async tx => {
      const rows = await tx.unsafe(`insert into ${disposable}.financial_evidence_receipts(id,workspace_id,scopes,receipt) values($1,$2,array[]::text[],$3::jsonb) on conflict(id) do nothing returning id`, [receipt.id, workspaceId, tx.json(receipt)]);
      await tx`select pg_sleep(0.05)`;
      return rows.length;
    })));
    expect(inserted.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await db.unsafe(`select receipt from ${disposable}.financial_evidence_receipts where id=$1`, [receipt.id])).toEqual([{ receipt }]);
  } finally {
    try {
      await db.unsafe(`drop schema if exists ${disposable} cascade`);
      await db`delete from auth.users where id=${owner}`;
      expect(await db`select id from auth.users where id=${owner}`).toHaveLength(0);
      expect(await db`select schema_name from information_schema.schemata where schema_name=${disposable}`).toHaveLength(0);
    } finally { await db.end(); }
  }
}, 30000);
