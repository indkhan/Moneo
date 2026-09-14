import { sql, type SQL } from "drizzle-orm";
import type { ProvisionExecutor } from "./provisioning.js";
import { withWorkspaceTransaction } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";
import type { GroundedAccount, GroundedTransaction } from "@moneo/finance";

type Transaction = <T>(
  workspaceId: string,
  fn: (tx: ProvisionExecutor) => Promise<T>,
) => Promise<T>;
async function rows<T>(tx: ProvisionExecutor, query: SQL): Promise<T[]> {
  const result = (await tx.execute(query)) as { rows: T[] };
  return result.rows;
}
export interface AiSettings {
  mode: "included" | "custom";
  credentialCiphertext: string | null;
  credentialVersion: number;
  aiPolicyVersion: number;
  configuration: { model?: string; prompt?: string };
}
export interface AiConversation {
  id: string;
  title: string;
  updatedAt: string;
}
export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  evidence: Array<{ id: string; label: string; href: string }>;
  toolActivity: Array<{ name: string; status: string }>;
}
export interface AiSettingsUpdate {
  mode?: "included" | "custom";
  credentialCiphertext?: string | null;
  model?: string;
  prompt?: string;
  excludedAccountIds?: string[];
  expectedVersion?: number;
}
async function config(tx: ProvisionExecutor, wid: string): Promise<AiSettings> {
  return (
    (
      await rows<AiSettings>(
        tx,
        sql`SELECT mode, credential_ciphertext AS "credentialCiphertext", credential_version AS "credentialVersion", ai_policy_version AS "aiPolicyVersion", configuration FROM workspace_ai_config WHERE workspace_id=${wid}`,
      )
    )[0] ?? {
      mode: "included",
      credentialCiphertext: null,
      credentialVersion: 1,
      aiPolicyVersion: 1,
      configuration: {},
    }
  );
}
async function lock(tx: ProvisionExecutor, wid: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${wid}))`);
}

/** All calls are tenant transactions. Provider authorization and policy updates share a lock. */
export function createAiStore(
  transaction: Transaction = (wid, fn) => withWorkspaceTransaction(wid, fn),
) {
  const store = {
    settings: (wid: string) => transaction(wid, (tx) => config(tx, wid)),
    listConversations: (wid: string) =>
      transaction(wid, (tx) =>
        rows<AiConversation>(
          tx,
          sql`SELECT id,title,updated_at AS "updatedAt" FROM conversations WHERE workspace_id=${wid} ORDER BY updated_at DESC LIMIT 100`,
        ),
      ),
    createConversation: (wid: string, title: string) =>
      transaction(wid, async (tx) => {
        const cfg = await config(tx, wid);
        const row = (
          await rows<AiConversation>(
            tx,
            sql`INSERT INTO conversations(workspace_id,title,ai_policy_version) VALUES(${wid},${title.slice(0, 100)},${cfg.aiPolicyVersion}) RETURNING id,title,updated_at AS "updatedAt"`,
          )
        )[0];
        if (!row) throw new Error("Conversation could not be created");
        return row;
      }),
    getConversation: (wid: string, id: string) =>
      transaction(wid, async (tx) => {
        const conversation = (
          await rows<AiConversation>(
            tx,
            sql`SELECT id,title,updated_at AS "updatedAt" FROM conversations WHERE workspace_id=${wid} AND id=${id}`,
          )
        )[0];
        if (!conversation) return null;
        const messages = await rows<AiMessage>(
          tx,
          sql`SELECT id,role,content->>'text' AS content,coalesce(content->'evidence','[]') AS evidence,coalesce(content->'toolActivity','[]') AS "toolActivity" FROM messages WHERE workspace_id=${wid} AND conversation_id=${id} ORDER BY created_at,id LIMIT 500`,
        );
        return { conversation, messages };
      }),
    addMessage: (
      wid: string,
      id: string,
      role: string,
      content: Record<string, unknown>,
      version: number,
    ) =>
      transaction(wid, async (tx) => {
        const inserted = await rows(
          tx,
          sql`INSERT INTO messages(workspace_id,conversation_id,role,content,ai_policy_version) SELECT ${wid},id,${role},${JSON.stringify(content)}::jsonb,${version} FROM conversations WHERE workspace_id=${wid} AND id=${id} RETURNING id`,
        );
        if (!inserted.length) throw new Error("Conversation not found");
        await tx.execute(
          sql`UPDATE conversations SET updated_at=now() WHERE workspace_id=${wid} AND id=${id}`,
        );
      }),
    history: (wid: string, id: string) =>
      transaction(wid, async (tx) => {
        const cfg = await config(tx, wid);
        return (
          await rows<{ role: "user" | "assistant"; content: string }>(
            tx,
            sql`SELECT role,content->>'text' AS content FROM messages WHERE workspace_id=${wid} AND conversation_id=${id} AND ai_policy_version=${cfg.aiPolicyVersion} AND role IN ('user','assistant') ORDER BY created_at DESC,id DESC LIMIT 12`,
          )
        ).reverse();
      }),
    source: (wid: string) =>
      transaction(wid, async (tx) => {
        const accounts = await rows<GroundedAccount>(
          tx,
          sql`SELECT a.id,a.name,a.currency_code AS "currencyCode",(SELECT coalesce(s.current_amount_minor::text,s.available_amount_minor::text) FROM account_balance_snapshots s WHERE s.workspace_id=${wid} AND s.account_id=a.id ORDER BY s.observed_at DESC,s.id DESC LIMIT 1) AS "balanceMinor" FROM accounts a WHERE a.workspace_id=${wid} AND a.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_ai_access_policies p WHERE p.workspace_id=${wid} AND p.account_id=a.id AND NOT p.ai_access)`,
        );
        const transactions = await rows<GroundedTransaction>(
          tx,
          sql`SELECT t.id,t.account_id AS "accountId",t.direction,t.amount_minor::text AS "amountMinor",t.currency_code AS "currencyCode",t.effective_date::text AS "effectiveDate",t.description,c.name AS category,t.description AS counterparty,t.status,t.excluded_from_analytics AS "excludedFromAnalytics" FROM transactions t LEFT JOIN categories c ON c.workspace_id=t.workspace_id AND c.id=t.category_id JOIN accounts a ON a.workspace_id=t.workspace_id AND a.id=t.account_id WHERE t.workspace_id=${wid} AND t.archived_at IS NULL AND a.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_ai_access_policies p WHERE p.workspace_id=${wid} AND p.account_id=t.account_id AND NOT p.ai_access) ORDER BY t.effective_date DESC,t.id DESC LIMIT 10001`,
        );
        if (transactions.length > 10_000)
          throw new Error(
            "AI currently supports up to 10,000 eligible transactions. Narrow the workspace before analysis.",
          );
        return { accounts, transactions, dataCutoff: new Date().toISOString() };
      }),
    updateSettings: (wid: string, input: AiSettingsUpdate) =>
      transaction(wid, async (tx) => {
        await lock(tx, wid);
        const old = await config(tx, wid),
          version = old.aiPolicyVersion + 1;
        if (input.expectedVersion !== undefined && input.expectedVersion !== old.aiPolicyVersion)
          throw new Error("AI settings changed. Reload before saving.");
        if (input.excludedAccountIds) {
          for (const id of input.excludedAccountIds)
            if (
              !(await rows(tx, sql`SELECT id FROM accounts WHERE workspace_id=${wid} AND id=${id}`))
                .length
            )
              throw new Error("Account not found");
          await tx.execute(sql`DELETE FROM workspace_ai_access_policies WHERE workspace_id=${wid}`);
          for (const id of input.excludedAccountIds)
            await tx.execute(
              sql`INSERT INTO workspace_ai_access_policies(workspace_id,account_id,ai_access,policy_version) VALUES(${wid},${id},false,${version})`,
            );
        }
        const configuration = {
          ...old.configuration,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        };
        const ciphertext =
          input.credentialCiphertext === undefined
            ? old.credentialCiphertext
            : input.credentialCiphertext;
        const credentialVersion =
          old.credentialVersion + (input.credentialCiphertext === undefined ? 0 : 1);
        await tx.execute(
          sql`INSERT INTO workspace_ai_config(workspace_id,mode,credential_ciphertext,credential_version,ai_policy_version,configuration) VALUES(${wid},${input.mode ?? old.mode},${ciphertext},${credentialVersion},${version},${JSON.stringify(configuration)}::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET mode=excluded.mode,credential_ciphertext=excluded.credential_ciphertext,credential_version=excluded.credential_version,ai_policy_version=excluded.ai_policy_version,configuration=excluded.configuration,updated_at=now()`,
        );
        await tx.execute(
          sql`UPDATE ai_runs SET status='cancelled',finished_at=now(),error='{"message":"AI configuration changed"}' WHERE workspace_id=${wid} AND status IN ('queued','running')`,
        );
        await tx.execute(
          sql`INSERT INTO security_audit_events(workspace_id,event_type,metadata) VALUES(${wid},'ai.configuration.updated',${JSON.stringify({ policyVersion: version, credentialVersion, mode: input.mode ?? old.mode })}::jsonb)`,
        );
        return config(tx, wid);
      }),
    excludedAccounts: (wid: string) =>
      transaction(wid, (tx) =>
        rows<{ id: string; name: string; aiAccess: boolean }>(
          tx,
          sql`SELECT a.id,a.name,coalesce(p.ai_access,true) AS "aiAccess" FROM accounts a LEFT JOIN workspace_ai_access_policies p ON p.workspace_id=a.workspace_id AND p.account_id=a.id WHERE a.workspace_id=${wid} AND a.archived_at IS NULL ORDER BY a.name`,
        ),
      ),
    startRun: (
      wid: string,
      conversationId: string,
      version: number,
      budget: Record<string, unknown>,
    ) =>
      transaction(wid, async (tx) => {
        await lock(tx, wid);
        if ((await config(tx, wid)).aiPolicyVersion !== version)
          throw new Error("AI configuration changed. Retry.");
        await tx.execute(
          sql`UPDATE ai_runs SET status='failed',finished_at=now(),error='{"message":"Run interrupted"}' WHERE workspace_id=${wid} AND status='running' AND started_at < now()-interval '2 minutes'`,
        );
        const id = uuidv7();
        await tx.execute(
          sql`INSERT INTO ai_runs(id,workspace_id,conversation_id,capability_version_id,status,ai_policy_version,budget,started_at) VALUES(${id},${wid},${conversationId},'00000000-0000-4000-8000-000000000061','running',${version},${JSON.stringify(budget)}::jsonb,now())`,
        );
        return id;
      }),
    authorize: <T>(
      wid: string,
      runId: string,
      version: number,
      fn: (settings: AiSettings, tx: ProvisionExecutor) => Promise<T>,
    ) =>
      transaction(wid, async (tx) => {
        await lock(tx, wid);
        const cfg = await config(tx, wid);
        const active = await rows(
          tx,
          sql`SELECT id FROM ai_runs WHERE workspace_id=${wid} AND id=${runId} AND status='running'`,
        );
        if (cfg.aiPolicyVersion !== version || !active.length)
          throw new Error("AI settings changed or run stopped. Start a new request.");
        return fn(cfg, tx);
      }),
    finishRun: (
      wid: string,
      id: string,
      status: "succeeded" | "failed" | "cancelled",
      error?: string,
    ) =>
      transaction(wid, async (tx) => {
        await tx.execute(
          sql`UPDATE ai_runs SET status=${status},finished_at=now(),error=${error ? JSON.stringify({ message: error }) : null}::jsonb WHERE workspace_id=${wid} AND id=${id} AND status='running'`,
        );
      }),
    recordModel: (
      wid: string,
      runId: string,
      call: {
        requestedModel: string;
        resolvedModel: string | null;
        resolvedProvider: string | null;
        inputTokens: number | null;
        outputTokens: number | null;
        cachedTokens: number | null;
        costMicros: number | null;
        latencyMs: number;
        finishReason: string | null;
      },
    ) =>
      transaction(wid, async (tx) => {
        await tx.execute(
          sql`INSERT INTO ai_model_calls(workspace_id,run_id,requested_model,resolved_model,resolved_provider,input_tokens,output_tokens,cached_tokens,cost_micros,latency_ms,finish_reason) VALUES(${wid},${runId},${call.requestedModel},${call.resolvedModel},${call.resolvedProvider},${call.inputTokens},${call.outputTokens},${call.cachedTokens},${call.costMicros},${call.latencyMs},${call.finishReason})`,
        );
      }),
    recordTool: (
      wid: string,
      runId: string,
      name: string,
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) =>
      transaction(wid, async (tx) => {
        const id = uuidv7();
        await tx.execute(
          sql`INSERT INTO ai_tool_calls(id,workspace_id,run_id,tool_name,input,output,status) VALUES(${id},${wid},${runId},${name},${JSON.stringify(input)}::jsonb,${JSON.stringify(output)}::jsonb,'succeeded')`,
        );
        return id;
      }),
    evidence: (wid: string, id: string) =>
      transaction(wid, async (tx) => {
        const cfg = await config(tx, wid);
        return (
          (
            await rows<{
              toolName: string;
              input: Record<string, unknown>;
              output: Record<string, unknown>;
            }>(
              tx,
              sql`SELECT t.tool_name AS "toolName",t.input,t.output FROM ai_tool_calls t JOIN ai_runs r ON r.workspace_id=t.workspace_id AND r.id=t.run_id WHERE t.workspace_id=${wid} AND t.id=${id} AND r.ai_policy_version=${cfg.aiPolicyVersion}`,
            )
          )[0] ?? null
        );
      }),
    usage: (wid: string) =>
      transaction(wid, (tx) =>
        rows(
          tx,
          sql`SELECT c.requested_model AS "requestedModel",c.resolved_model AS "resolvedModel",c.resolved_provider AS "resolvedProvider",c.input_tokens AS "inputTokens",c.output_tokens AS "outputTokens",c.cost_micros AS "costMicros",c.created_at AS "createdAt",r.status FROM ai_model_calls c JOIN ai_runs r ON r.workspace_id=c.workspace_id AND r.id=c.run_id WHERE c.workspace_id=${wid} ORDER BY c.created_at DESC LIMIT 100`,
        ),
      ),
  };
  return store;
}
