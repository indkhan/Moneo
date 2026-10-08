import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { expect, it } from "vitest";
import { createEvidenceReceipt } from "./evidence-receipts";

it.skipIf(process.env.RUN_VERIFIED_EVIDENCE_DB_TESTS !== "1")("atomically limits successful chat publication to the current owned trusted authority", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, connect_timeout: 10, onnotice: () => {},
    connection: { application_name: "moneo-chat-publication-test", lock_timeout: 10000, statement_timeout: 20000, idle_in_transaction_session_timeout: 30000 } });
  const actor = randomUUID(), foreign = randomUUID(), conversation = randomUUID(), request = randomUUID();
  const rollback = new Error("Successful rollback");
  try {
    const history = await db`select version,name,statements from supabase_migrations.schema_migrations order by version`;
    try {
    try { await db.begin(async tx => {
      if (process.env.VERIFIED_CHAT_BASELINE_RED !== "1") {
        const applied = history.find(row => row.version === "202610060014");
        expect(applied, "Deploy migration014 before running this live publication gate").toBeDefined();
        expect(applied!.name).toBe("verified_financial_evidence");
        expect(applied!.statements.join("\n").replaceAll("\r\n", "\n").trim()).toBe(
          readFileSync("supabase/migrations/202610060014_verified_financial_evidence.sql", "utf8").replaceAll("\r\n", "\n").trim());
      }
      await tx`insert into auth.users(id,email) values(${actor},${`qa-${actor}@example.invalid`}),(${foreign},${`qa-${foreign}@example.invalid`})`;
      const [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${actor}`;
      await tx`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace},array['transactions']) on conflict(workspace_id) do update set ai_data_scopes=array['transactions']`;
      await tx`insert into public.conversations(id,workspace_id,title) values(${conversation},${workspace},'Synthetic publication gate')`;
      await tx`insert into public.chat_requests(id,workspace_id,conversation_id,message) values(${request},${workspace},${conversation},'Synthetic question')`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true),set_config('request.jwt.claim.role','authenticated',true)`;
      await tx.unsafe("set local role authenticated");
      await expect(tx.savepoint(sp => sp`select public.finish_chat_request(${request},'completed','EUR999999',null)`)).rejects.toMatchObject({ code: "42501" });
      await expect(tx.savepoint(sp => sp`insert into public.messages(workspace_id,conversation_id,role,content) values(${workspace},${conversation},'assistant','EUR999999')`)).rejects.toMatchObject({ code: "42501" });
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${actor},${workspace},'forged',array[]::uuid[],array[]::text[],null)`)).rejects.toMatchObject({ code: "42501" });
      await tx.unsafe("reset role");
      const receipt = createEvidenceReceipt({ workspaceId: workspace, fetchedAt: "2026-10-07T00:00:00Z", calculationVersion: "synthetic", sourceVersion: "synthetic", scopes: ["transactions"], query: { kind: "synthetic" }, sources: [], metrics: [] });
      await tx`insert into public.financial_evidence_receipts(id,workspace_id,scopes,receipt) values(${receipt.id},${workspace},array['transactions'],${tx.json(receipt)})`;
      await tx`select set_config('request.jwt.claim.role','service_role',true)`;
      await tx.unsafe("set local role service_role");
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${foreign},${workspace},'foreign',array[]::uuid[],array[]::text[],null)`)).rejects.toMatchObject({ code: "P0002" });
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${actor},${workspace},'revoked',array[]::uuid[],array['planning'],null)`)).rejects.toMatchObject({ code: "42501" });
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${actor},${workspace},'missing receipt',array[${randomUUID()}::uuid],array['transactions'],null)`)).rejects.toMatchObject({ code: "42501" });
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${actor},${workspace},'omitted receipt scope',array[${receipt.id}::uuid],array[]::text[],null)`)).rejects.toMatchObject({ code: "42501" });
      await tx.unsafe("reset role");
      await tx`update public.workspace_settings set ai_data_scopes=array[]::text[] where workspace_id=${workspace}`;
      await tx.unsafe("set local role service_role");
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${actor},${workspace},'revoked retained scope',array[${receipt.id}::uuid],array['transactions'],null)`)).rejects.toMatchObject({ code: "42501" });
      await tx.unsafe("reset role");
      await tx`update public.workspace_settings set ai_data_scopes=array['transactions'] where workspace_id=${workspace}`;
      await tx.unsafe("set local role service_role");
      await expect(tx.savepoint(sp => sp`select public.finish_verified_chat_request(${request},${actor},${workspace},'invalid usage',array[]::uuid[],array[]::text[],'{"model_id":"synthetic","total_tokens":-1}'::jsonb)`)).rejects.toMatchObject({ code: "22023" });
      expect(await tx`select public.finish_verified_chat_request(${request},${actor},${workspace},'Validated clarification',array[${receipt.id}::uuid],array['transactions'],'{"model_id":"synthetic","total_tokens":1}'::jsonb) as status`).toEqual([{ status: "completed" }]);
      expect(await tx`select public.finish_verified_chat_request(${request},${actor},${workspace},'Replacement must not publish',array[]::uuid[],array[]::text[],null) as status`).toEqual([{ status: "completed" }]);
      await tx.unsafe("reset role");
      expect(await tx`select content from public.messages where reply_to=${request}`).toEqual([{ content: "Validated clarification" }]);
      expect(await tx`select usage from public.chat_requests where id=${request}`).toEqual([{ usage: { model_id: "synthetic", total_tokens: 1 } }]);
      await tx`select set_config('request.jwt.claim.role','authenticated',true)`;
      await tx.unsafe("set local role authenticated");
      expect(await tx`update public.messages set content='Forged replacement' where reply_to=${request} returning id`).toHaveLength(0);
      await tx.unsafe("reset role");
      const canceled = randomUUID(), failed = randomUUID();
      await tx`insert into public.chat_requests(id,workspace_id,conversation_id,message) values(${canceled},${workspace},${conversation},'cancel'),(${failed},${workspace},${conversation},'fail')`;
      await tx.unsafe("set local role authenticated");
      expect(await tx`select public.cancel_chat_request(${canceled}) as status`).toEqual([{ status: "canceled" }]);
      expect(await tx`select public.finish_chat_request(${failed},'failed','Expected failure',null) as status`).toEqual([{ status: "failed" }]);
      await tx.unsafe("reset role");
      await tx`select set_config('request.jwt.claim.role','service_role',true)`;
      await tx.unsafe("set local role service_role");
      expect(await tx`select public.finish_verified_chat_request(${canceled},${actor},${workspace},'Canceled reply',array[]::uuid[],array[]::text[],null) as status`).toEqual([{ status: "canceled" }]);
      await tx.unsafe("reset role");
      expect(await tx`select id from public.messages where reply_to in (${canceled},${failed})`).toHaveLength(0);
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
  } finally {
      expect(await db`select id from auth.users where id in (${actor},${foreign})`).toHaveLength(0);
      expect(await db`select id from public.financial_evidence_receipts where workspace_id in(select id from public.workspaces where owner_id in(${actor},${foreign}))`).toHaveLength(0);
      expect(await db`select version,name,statements from supabase_migrations.schema_migrations order by version`).toEqual(history);
    }
  } finally { await db.end(); }
}, 30000);
