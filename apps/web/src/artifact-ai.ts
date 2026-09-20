// E05-S06 contextual AI artifact proposals: the existing persistent chat
// can propose a new artifact or an edit against an explicit base version,
// but only the deterministic artifact pipeline validates and activates it.
// Models receive bounded synthetic/authorized context + the supported SDK
// contract — never credentials, raw SQL, or raw finance rows. Expected
// finance values stay authoritative tool results; user/host activates.
// One repair pass max, one artifact per request, two model calls max.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { ARTIFACT_LIMITS, RUNTIME_PERMISSIONS } from "./artifact-contract.ts";
import { validateArtifactSource } from "./artifact-validate.ts";
import {
  createArtifactDraft,
  submitArtifactBuild,
  settleArtifactVersion,
} from "./commands/artifacts.ts";
import {
  reserveDispatch,
  executeReserved,
  DispatchError,
  type DispatchTransport,
} from "./ai-dispatch.ts";
import { revalidateContext, ToolError, type ToolContext } from "./ai-tools.ts";
import { issuePermit } from "./ai-policy.ts";

export const ARTIFACT_BUILDER_CONFIG = {
  capability: "artifact_builder",
  promptVersion: "artifact-builder@prompt-1",
  route: "development",
  maxModelCalls: 2,
  maxRepairPasses: 1,
  wallClockMin: 20,
  maxArtifactsPerRequest: 1,
  inputEstimate: 2000,
  outputCeiling: 2000,
} as const;

export const ARTIFACT_REVIEWER_CONFIG = {
  capability: "artifact_reviewer",
  promptVersion: "artifact-reviewer@prompt-1",
  route: "development",
  maxModelCalls: 1,
  wallClockMin: 20,
  inputEstimate: 2000,
  outputCeiling: 2000,
} as const;

export type ArtifactAiOutput = {
  html: string;
  css: string;
  js: string;
  manifest: Record<string, unknown>;
};

export type OutputValidation =
  | { ok: true; value: ArtifactAiOutput }
  | { ok: false; errorClass: string; errorMessage: string };

const SDK_CONTRACT_SUMMARY = [
  "Approved Finance SDK (read-only aggregates, exact decimal-string money):",
  "- artifact.finance.spendingByCategory()",
  "- artifact.finance.cashflow()",
  "- artifact.finance.getBalances()",
  "- artifact.finance.transactionSummary()",
  "Approved UI: artifact.ui.render({type:'chart',rows}), artifact.ui.patch({slot,text}|{action:'scenario',value}), artifact.state.get/set.",
  "Forbidden: fetch/XHR/WebSocket, window/document/location, storage/cookies/credentials, eval/Function, dynamic import, npm/CDN, raw SQL, raw transaction descriptions.",
].join("\n");

export function buildBuilderPrompt(input: { kind: "create" | "edit"; instruction: string; basePermissions?: string[] }): string {
  const scope =
    input.kind === "create"
      ? "Create ONE new artifact."
      : `Edit ONE artifact in place. Keep approved permissions within: ${(input.basePermissions ?? []).join(", ") || "none"}. Never broaden permissions.`;
  return [
    "You are the artifact builder. Respond with JSON only: {\"html\":string,\"css\":string,\"js\":string,\"manifest\":object}.",
    scope,
    "Request: " + input.instruction.slice(0, 2000),
    SDK_CONTRACT_SUMMARY,
    `Limits: total source <= ${ARTIFACT_LIMITS.sourceBytes} bytes. Manifest permissions must be a subset of: ${RUNTIME_PERMISSIONS.join(", ")}.`,
  ].join("\n");
}

export function buildReviewerPrompt(errorClass: string, errorMessage: string): string {
  return [
    "You are the artifact reviewer. The previous output was rejected.",
    `Rejection: ${errorClass}: ${errorMessage.slice(0, 500)}`,
    "Respond with corrected JSON only: {\"html\":string,\"css\":string,\"js\":string,\"manifest\":object}.",
    SDK_CONTRACT_SUMMARY,
  ].join("\n");
}

/** Strict structured-output validation for model-produced sources. */
export function validateArtifactAiOutput(output: unknown): OutputValidation {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { ok: false, errorClass: "malformed_output", errorMessage: "Model output must be an object with html, css, js and manifest." };
  }
  const o = output as Record<string, unknown>;
  for (const key of ["html", "css", "js", "manifest"] as const) {
    if (!(key in o)) return { ok: false, errorClass: "malformed_output", errorMessage: `Model output is missing ${key}.` };
  }
  if (typeof o["html"] !== "string" || typeof o["css"] !== "string" || typeof o["js"] !== "string") {
    return { ok: false, errorClass: "malformed_output", errorMessage: "html, css and js must be strings." };
  }
  if (!o["manifest"] || typeof o["manifest"] !== "object" || Array.isArray(o["manifest"])) {
    return { ok: false, errorClass: "malformed_output", errorMessage: "manifest must be an object." };
  }
  const checked = validateArtifactSource(
    { html: o["html"] as string, css: o["css"] as string, js: o["js"] as string },
    o["manifest"],
  );
  if (!checked.ok) return { ok: false, errorClass: checked.errorClass, errorMessage: checked.errorMessage };
  return { ok: true, value: { html: o["html"] as string, css: o["css"] as string, js: o["js"] as string, manifest: o["manifest"] as Record<string, unknown> } };
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkInstruction(instruction: unknown): string {
  if (typeof instruction !== "string" || instruction.length < 1 || instruction.length > 2000) throw new TenantInvalid();
  return instruction;
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 200) throw new TenantInvalid();
  return name;
}

async function livePolicyVersion(client: PoolClient, workspaceId: string): Promise<string> {
  const rows = await client.query("SELECT policy_version AS v FROM ai_policies WHERE workspace_id = $1", [workspaceId]);
  if ((rows.rowCount ?? 0) === 0) return "1";
  return String((rows.rows[0] as { v: string }).v);
}

async function liveDataRevision(client: PoolClient, workspaceId: string): Promise<string> {
  const rows = await client.query("SELECT revision AS r FROM workspace_data_revision WHERE workspace_id = $1", [workspaceId]);
  if ((rows.rowCount ?? 0) === 0) return "0";
  return String((rows.rows[0] as { r: string }).r);
}

export type ArtifactAiInput =
  | { kind: "create"; name: string; description?: string; instruction: string; idempotencyKey: string; permitId: string; threadId?: string }
  | { kind: "edit"; artifactId: string; baseVersionId: string; instruction: string; idempotencyKey: string; permitId: string; threadId?: string };

export type ArtifactAiUsage = {
  builderReservationId: string;
  reviewerReservationId: string | null;
  repairPasses: number;
  modelCalls: number;
};

export type ArtifactAiResult =
  | { ok: true; artifactId: string; versionId: string; usage: ArtifactAiUsage }
  | { ok: false; errorClass: string; errorMessage: string; usage: ArtifactAiUsage };

async function runOneCall(
  pool: Pool,
  claims: TenantClaims,
  opts: { idempotencyKey: string; permitId: string; purpose: string; requestText: string; inputEstimate: number; outputCeiling: number },
  transport: DispatchTransport,
): Promise<{ reservationId: string; bodyText: string | null; terminalClass: string | null }> {
  const reserved = await reserveDispatch(pool, claims, {
    idempotencyKey: opts.idempotencyKey,
    permitId: opts.permitId,
    route: "development",
    purpose: opts.purpose,
    requestText: opts.requestText,
    inputEstimate: opts.inputEstimate,
    outputCeiling: opts.outputCeiling,
  });
  let captured: string | null = null;
  const recording: DispatchTransport = async (req, signal) => {
    const attempt = await transport(req, signal);
    if (attempt.bodyText !== null) captured = attempt.bodyText;
    return attempt;
  };
  const state = await executeReserved(pool, claims, reserved.id, recording, opts.requestText);
  if (state.reservation.status === "RECONCILED") return { reservationId: reserved.id, bodyText: captured, terminalClass: null };
  return { reservationId: reserved.id, bodyText: captured, terminalClass: state.usage?.errorClass ?? "unknown" };
}

function parseOutput(bodyText: string | null): OutputValidation {
  if (bodyText === null) return { ok: false, errorClass: "unavailable", errorMessage: "Model produced no output." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, errorClass: "malformed_output", errorMessage: "Model output is not valid JSON." };
  }
  return validateArtifactAiOutput(parsed);
}

/**
 * Run the bounded builder (+ at most one reviewer repair) flow. The model
 * proposes source; only the deterministic pipeline below creates versions,
 * and nothing here activates. Stale base/policy/revision, malformed output,
 * permission expansion, outage or failed repair all leave active code/state
 * unchanged with exact usage settlement.
 */
export async function runArtifactAiFlow(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  input: ArtifactAiInput,
  transport: DispatchTransport,
): Promise<ArtifactAiResult> {
  const startedAt = Date.now();
  if (!isUuid(actorId)) throw new TenantDenied();
  if (!isUuid(input.idempotencyKey) || !isUuid(input.permitId)) throw new TenantInvalid();
  const instruction = checkInstruction(input.instruction);
  if (input.threadId !== undefined && !isUuid(input.threadId)) throw new TenantInvalid();

  // Pre-checks: base artifacts/versions, policy + data freshness snapshots.
  const pre = await withTenant(pool, claims, async (client) => {
    if (input.kind === "edit") {
      if (!isUuid(input.artifactId) || !isUuid(input.baseVersionId)) throw new TenantInvalid();
      const art = await client.query("SELECT id FROM artifacts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.artifactId]);
      if ((art.rowCount ?? 0) === 0) throw new TenantDenied();
      const ver = await client.query("SELECT manifest FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3", [
        claims.workspaceId,
        input.artifactId,
        input.baseVersionId,
      ]);
      if ((ver.rowCount ?? 0) === 0) throw new TenantDenied();
      return {
        baseApproved: ((ver.rows[0] as { manifest: { approvedPermissions?: unknown } }).manifest.approvedPermissions ?? []) as string[],
        policyVersion: await livePolicyVersion(client, claims.workspaceId),
        dataRevision: await liveDataRevision(client, claims.workspaceId),
      };
    }
    return { baseApproved: [] as string[], policyVersion: await livePolicyVersion(client, claims.workspaceId), dataRevision: await liveDataRevision(client, claims.workspaceId) };
  });

  // Idempotent proposal replay: same key + same bytes converges.
  const keyHash = requestHash(
    input.kind === "create"
      ? { kind: input.kind, name: input.name, instruction }
      : { kind: input.kind, artifactId: input.artifactId, baseVersionId: input.baseVersionId, instruction },
  );
  const prior = await withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT artifact_id, version_id, kind, status, error_class, ai_run_id, request_hash FROM artifact_ai_proposals WHERE workspace_id = $1 AND idempotency_key = $2", [
      claims.workspaceId,
      input.idempotencyKey,
    ]);
    return (found.rowCount ?? 0) === 0 ? null : (found.rows[0] as { artifact_id: string | null; version_id: string | null; kind: string; status: string; error_class: string | null; ai_run_id: string | null; request_hash: string });
  });
  if (prior) {
    // Same key + same bytes replays; same key + different bytes conflicts.
    if (prior.kind !== input.kind || prior.request_hash !== keyHash) throw new TenantInvalid();
    if (prior.status === "proposed" && prior.artifact_id && prior.version_id) {
      return {
        ok: true as const,
        artifactId: prior.artifact_id,
        versionId: prior.version_id,
        usage: { builderReservationId: prior.ai_run_id ?? "", reviewerReservationId: null, repairPasses: 0, modelCalls: 0 },
      };
    }
    return { ok: false as const, errorClass: prior.error_class ?? "failed", errorMessage: "A previous attempt with this key failed.", usage: { builderReservationId: prior.ai_run_id ?? "", reviewerReservationId: null, repairPasses: 0, modelCalls: 0 } };
  }

  // Builder call (model call 1).
  const builderPrompt = buildBuilderPrompt(
    input.kind === "create" ? { kind: "create", instruction } : { kind: "edit", instruction, basePermissions: pre.baseApproved },
  );
  const builder = await runOneCall(
    pool,
    claims,
    {
      idempotencyKey: `artifact-builder:${input.idempotencyKey}`,
      permitId: input.permitId,
      purpose: ARTIFACT_BUILDER_CONFIG.capability,
      requestText: builderPrompt,
      inputEstimate: ARTIFACT_BUILDER_CONFIG.inputEstimate,
      outputCeiling: ARTIFACT_BUILDER_CONFIG.outputCeiling,
    },
    transport,
  ).catch((err) => {
    if (err instanceof DispatchError) {
      return { reservationId: "", bodyText: null as string | null, terminalClass: err.code, dispatchError: err as DispatchError };
    }
    throw err;
  });
  if ("dispatchError" in builder) {
    return { ok: false, errorClass: builder.dispatchError.code, errorMessage: "Builder dispatch refused.", usage: { builderReservationId: "", reviewerReservationId: null, repairPasses: 0, modelCalls: 0 } };
  }
  if (builder.terminalClass !== null || builder.bodyText === null) {
    return {
      ok: false,
      errorClass: builder.terminalClass ?? "unavailable",
      errorMessage: "Model unavailable; active version unchanged.",
      usage: { builderReservationId: builder.reservationId, reviewerReservationId: null, repairPasses: 0, modelCalls: 1 },
    };
  }
  let parsed = parseOutput(builder.bodyText);
  let reviewerReservationId: string | null = null;
  let repairPasses = 0;

  // Single repair pass through the reviewer on invalid output.
  if (!parsed.ok && repairPasses < ARTIFACT_BUILDER_CONFIG.maxRepairPasses) {
    const reviewerPermit = await issuePermit(pool, claims, ARTIFACT_REVIEWER_CONFIG.capability).catch(() => null);
    if (reviewerPermit) {
      const reviewer = await runOneCall(
        pool,
        claims,
        {
          idempotencyKey: `artifact-reviewer:${input.idempotencyKey}`,
          permitId: reviewerPermit.id,
          purpose: ARTIFACT_REVIEWER_CONFIG.capability,
          requestText: buildReviewerPrompt(parsed.errorClass, parsed.errorMessage),
          inputEstimate: ARTIFACT_REVIEWER_CONFIG.inputEstimate,
          outputCeiling: ARTIFACT_REVIEWER_CONFIG.outputCeiling,
        },
        transport,
      ).catch(() => null);
      repairPasses = 1;
      if (reviewer && reviewer.terminalClass === null && reviewer.bodyText !== null) {
        reviewerReservationId = reviewer.reservationId;
        parsed = parseOutput(reviewer.bodyText);
      } else if (reviewer) {
        reviewerReservationId = reviewer.reservationId;
      }
    }
  }
  const modelCalls = reviewerReservationId ? 2 : 1;
  const usage: ArtifactAiUsage = { builderReservationId: builder.reservationId, reviewerReservationId, repairPasses, modelCalls };

  if (!parsed.ok) {
    await withTenant(pool, claims, async (client) => {
      await client.query(
        `INSERT INTO artifact_ai_proposals (workspace_id, idempotency_key, request_hash, artifact_id, version_id, kind, status, error_class, ai_run_id, thread_id) VALUES ($1, $2, $3, NULL, NULL, $4, 'failed', $5, $6, $7)`,
        [claims.workspaceId, input.idempotencyKey, keyHash, input.kind, parsed.errorClass, builder.reservationId || null, input.threadId ?? null],
      );
      if (input.threadId) {
        await appendArtifactActivity(client, claims.workspaceId, input.threadId, "artifact-failed");
      }
    });
    return { ok: false, errorClass: parsed.errorClass, errorMessage: parsed.errorMessage, usage };
  }

  // Permission non-expansion gate before any write.
  const approved = (parsed.value.manifest.approvedPermissions ?? []) as string[];
  const allowed = input.kind === "edit" ? pre.baseApproved : ([...RUNTIME_PERMISSIONS] as string[]);
  for (const p of approved) {
    if (!allowed.includes(p)) {
      await withTenant(pool, claims, async (client) => {
        await client.query(
          `INSERT INTO artifact_ai_proposals (workspace_id, idempotency_key, request_hash, artifact_id, version_id, kind, status, error_class, ai_run_id, thread_id) VALUES ($1, $2, $3, NULL, NULL, $4, 'failed', 'permission_expansion', $5, $6)`,
          [claims.workspaceId, input.idempotencyKey, keyHash, input.kind, builder.reservationId || null, input.threadId ?? null],
        );
        if (input.threadId) await appendArtifactActivity(client, claims.workspaceId, input.threadId, "artifact-failed");
      });
      return { ok: false, errorClass: "permission_expansion", errorMessage: "Model requested permissions outside the approved grant.", usage };
    }
  }

  // Persisted proposal in one tenant transaction with freshness rechecks.
  // Nothing here activates: the new version stays inactive until host publish.
  const persisted = await withTenant(pool, claims, async (client) => {
    const policyNow = await livePolicyVersion(client, claims.workspaceId);
    const revisionNow = await liveDataRevision(client, claims.workspaceId);
    if (policyNow !== pre.policyVersion || revisionNow !== pre.dataRevision) {
      const e = new Error("STALE_CONTEXT");
      throw e;
    }
    let artifactId: string;
    if (input.kind === "create") {
      const created = await createArtifactDraft(client, claims, checkName(input.name), input.description, { aiRunId: builder.reservationId });
      artifactId = created.artifactId;
    } else {
      artifactId = input.artifactId;
      const stillThere = await client.query("SELECT manifest FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3", [
        claims.workspaceId,
        input.artifactId,
        input.baseVersionId,
      ]);
      if ((stillThere.rowCount ?? 0) === 0) throw new TenantDenied();
    }
    const manifest = { ...(parsed.value.manifest as Record<string, unknown>), createdByAIRun: builder.reservationId };
    const submitted = await submitArtifactBuild(
      client,
      claims,
      artifactId,
      { html: parsed.value.html, css: parsed.value.css, js: parsed.value.js },
      manifest as import("./commands/artifacts.ts").ArtifactManifest,
      { aiRunId: builder.reservationId },
    );
    const { validateArtifactSource } = await import("./artifact-validate.ts");
    const check = validateArtifactSource({ html: parsed.value.html, css: parsed.value.css, js: parsed.value.js }, manifest);
    if (!check.ok) throw new Error("VALIDATION_DRIFT:" + check.errorClass);
    await settleArtifactVersion(client, claims, artifactId, submitted.versionId, { ok: true });
    await client.query(
      `INSERT INTO artifact_ai_proposals (workspace_id, idempotency_key, request_hash, artifact_id, version_id, kind, status, ai_run_id, thread_id) VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8)`,
      [claims.workspaceId, input.idempotencyKey, keyHash, artifactId, submitted.versionId, input.kind, builder.reservationId, input.threadId ?? null],
    );
    if (input.threadId) {
      await client.query("UPDATE chat_threads SET artifact_id = $1 WHERE workspace_id = $2 AND id = $3", [artifactId, claims.workspaceId, input.threadId]);
      await appendArtifactActivity(client, claims.workspaceId, input.threadId, "artifact-proposed");
    }
    return { artifactId, versionId: submitted.versionId };
  }).catch((err) => {
    if (err instanceof Error && err.message === "STALE_CONTEXT") return { stale: true as const };
    throw err;
  });
  if ("stale" in persisted) {
    return { ok: false, errorClass: "stale", errorMessage: "Base, policy or data changed during generation; active version unchanged.", usage };
  }
  if (Date.now() - startedAt > ARTIFACT_BUILDER_CONFIG.wallClockMin * 60 * 1000) {
    return { ok: false, errorClass: "wall_clock", errorMessage: "Generation exceeded its wall-clock budget.", usage };
  }
  return { ok: true, artifactId: persisted.artifactId, versionId: persisted.versionId, usage };
}

async function appendArtifactActivity(client: PoolClient, workspaceId: string, threadId: string, kind: "artifact-proposed" | "artifact-failed"): Promise<void> {
  const thread = await client.query("SELECT id FROM chat_threads WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, threadId]);
  if ((thread.rowCount ?? 0) === 0) throw new TenantDenied();
  const next = await client.query("SELECT COALESCE(MAX(seq), 0)::bigint + 1 AS n FROM chat_activity WHERE workspace_id = $1 AND thread_id = $2", [workspaceId, threadId]);
  await client.query("INSERT INTO chat_activity (workspace_id, thread_id, seq, kind, turn_id, attempt_id) VALUES ($1, $2, $3, $4, NULL, NULL)", [
    workspaceId,
    threadId,
    (next.rows[0] as { n: string }).n,
    kind,
  ]);
}

/** Link an artifact to a normal chat thread (context link, trusted-host write). */
export async function linkArtifactToThread(pool: Pool, claims: TenantClaims, threadId: string, artifactId: string): Promise<void> {
  if (!isUuid(threadId) || !isUuid(artifactId)) throw new TenantInvalid();
  await withTenant(pool, claims, async (client) => {
    const art = await client.query("SELECT id FROM artifacts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, artifactId]);
    if ((art.rowCount ?? 0) === 0) throw new TenantDenied();
    const updated = await client.query("UPDATE chat_threads SET artifact_id = $1 WHERE workspace_id = $2 AND id = $3", [artifactId, claims.workspaceId, threadId]);
    if ((updated.rowCount ?? 0) === 0) throw new TenantDenied();
  });
}

// --- Chat-tool entry points (model proposes; server validates + persists) ---

export async function artifactCreateDraftTool(
  pool: Pool,
  ctx: ToolContext,
  actorId: string,
  args: unknown,
): Promise<{ artifactId: string; versionId: string }> {
  if (!isUuid(actorId)) throw new TenantDenied();
  await revalidateContext(pool, ctx);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolError("invalid_args");
  const a = args as Record<string, unknown>;
  const name = typeof a["name"] === "string" ? a["name"] : "";
  const description = typeof a["description"] === "string" ? a["description"] : undefined;
  const idempotencyKey = typeof a["idempotencyKey"] === "string" ? a["idempotencyKey"] : "";
  if (!name || name.length > 200 || !isUuid(idempotencyKey)) throw new ToolError("invalid_args");
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) throw new ToolError("invalid_args");
  const checked = validateArtifactAiOutput({ html: a["html"], css: a["css"], js: a["js"], manifest: a["manifest"] });
  if (!checked.ok) throw new ToolError("invalid_args");
  const approved = (checked.value.manifest.approvedPermissions ?? []) as string[];
  for (const p of approved) {
    if (!(RUNTIME_PERMISSIONS as readonly string[]).includes(p)) throw new ToolError("denied");
  }
  return withTenant(pool, ctx.claims, async (client) => {
    const existing = await client.query("SELECT artifact_id, version_id, status FROM artifact_ai_proposals WHERE workspace_id = $1 AND idempotency_key = $2", [
      ctx.claims.workspaceId,
      idempotencyKey,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as { artifact_id: string | null; version_id: string | null; status: string };
      if (row.status === "proposed" && row.artifact_id && row.version_id) return { artifactId: row.artifact_id, versionId: row.version_id };
      throw new ToolError("invalid_args");
    }
    const created = await createArtifactDraft(client, ctx.claims, name, description);
    const manifest = { ...checked.value.manifest, createdByAIRun: ctx.runId };
    const submitted = await submitArtifactBuild(client, ctx.claims, created.artifactId, { html: checked.value.html, css: checked.value.css, js: checked.value.js }, manifest as import("./commands/artifacts.ts").ArtifactManifest);
    await settleArtifactVersion(client, ctx.claims, created.artifactId, submitted.versionId, { ok: true });
    await client.query(
      `INSERT INTO artifact_ai_proposals (workspace_id, idempotency_key, request_hash, artifact_id, version_id, kind, status, ai_run_id, thread_id) VALUES ($1, $2, $3, $4, $5, 'create', 'proposed', $6, NULL)`,
      [ctx.claims.workspaceId, idempotencyKey, requestHash({ kind: "create", name, html: checked.value.html, css: checked.value.css, js: checked.value.js, manifest: checked.value.manifest }), created.artifactId, submitted.versionId, ctx.runId],
    );
    return { artifactId: created.artifactId, versionId: submitted.versionId };
  });
}

export async function artifactProposeEditTool(
  pool: Pool,
  ctx: ToolContext,
  actorId: string,
  args: unknown,
): Promise<{ artifactId: string; versionId: string }> {
  if (!isUuid(actorId)) throw new TenantDenied();
  await revalidateContext(pool, ctx);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolError("invalid_args");
  const a = args as Record<string, unknown>;
  const artifactId = typeof a["artifactId"] === "string" ? a["artifactId"] : "";
  const baseVersionId = typeof a["baseVersionId"] === "string" ? a["baseVersionId"] : "";
  const idempotencyKey = typeof a["idempotencyKey"] === "string" ? a["idempotencyKey"] : "";
  const policyVersion = typeof a["policyVersion"] === "string" ? a["policyVersion"] : "";
  if (!isUuid(artifactId) || !isUuid(baseVersionId) || !isUuid(idempotencyKey)) throw new ToolError("invalid_args");
  if (policyVersion !== ctx.policyVersion) throw new ToolError("stale");
  const checked = validateArtifactAiOutput({ html: a["html"], css: a["css"], js: a["js"], manifest: a["manifest"] });
  if (!checked.ok) throw new ToolError("invalid_args");
  return withTenant(pool, ctx.claims, async (client) => {
    const base = await client.query("SELECT manifest FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3", [
      ctx.claims.workspaceId,
      artifactId,
      baseVersionId,
    ]);
    if ((base.rowCount ?? 0) === 0) throw new ToolError("denied");
    const baseApproved = ((base.rows[0] as { manifest: { approvedPermissions?: unknown } }).manifest.approvedPermissions ?? []) as string[];
    for (const p of (checked.value.manifest.approvedPermissions ?? []) as string[]) {
      if (!baseApproved.includes(p)) throw new ToolError("denied");
    }
    const existing = await client.query("SELECT artifact_id, version_id, status FROM artifact_ai_proposals WHERE workspace_id = $1 AND idempotency_key = $2", [
      ctx.claims.workspaceId,
      idempotencyKey,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as { artifact_id: string | null; version_id: string | null; status: string };
      if (row.status === "proposed" && row.artifact_id && row.version_id) return { artifactId: row.artifact_id, versionId: row.version_id };
      throw new ToolError("invalid_args");
    }
    const manifest = { ...checked.value.manifest, createdByAIRun: ctx.runId };
    const submitted = await submitArtifactBuild(client, ctx.claims, artifactId, { html: checked.value.html, css: checked.value.css, js: checked.value.js }, manifest as import("./commands/artifacts.ts").ArtifactManifest);
    await settleArtifactVersion(client, ctx.claims, artifactId, submitted.versionId, { ok: true });
    await client.query(
      `INSERT INTO artifact_ai_proposals (workspace_id, idempotency_key, request_hash, artifact_id, version_id, kind, status, ai_run_id, thread_id) VALUES ($1, $2, $3, $4, $5, 'edit', 'proposed', $6, NULL)`,
      [ctx.claims.workspaceId, idempotencyKey, requestHash({ kind: "edit", artifactId, baseVersionId, html: checked.value.html, css: checked.value.css, js: checked.value.js, manifest: checked.value.manifest }), artifactId, submitted.versionId, ctx.runId],
    );
    return { artifactId, versionId: submitted.versionId };
  });
}
