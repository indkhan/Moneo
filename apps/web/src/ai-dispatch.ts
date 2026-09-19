// E04-S01 shared model-dispatch boundary (product §§4, 29-30; architecture
// §§124-138, 175-190, 416-489; existing ai_policies, exclusions, permits,
// durable jobs and OpenRouter mapping transport). Every authorized dispatch
// is admitted only after tenant policy, route, concurrency and money/token
// budgets are atomically reserved in ONE transaction; completion reconciles
// measured usage, holds unknown usage as PENDING (never zero), and releases
// only documented terminal classes. Production never falls back to a
// training-permitted route: without production qualification the call fails
// closed. One retry only before any provider output, 30 s per attempt, a
// configured output-token ceiling and 64 KiB request cap. Idempotent replay
// converges without double charge or double dispatch. Observability carries
// IDs, route class, token counts, reserved/reconciled cost, latency and error
// class only — never prompts, outputs, keys or finance payloads.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { formatDecimalBigint, parseDecimalBigint } from "./money.ts";

export const DISPATCH_REQUEST_MAX_BYTES = 64 * 1024;
export const DISPATCH_TIMEOUT_MS = 30_000;
export const DISPATCH_RESERVATION_TTL_MIN = 30;
export const DISPATCH_MAX_OUTPUT_TOKENS = 4000;
export const DISPATCH_MAX_ATTEMPTS = 2;

// Synthetic cost baseline: minor (cent) units per 1k tokens, rounded up.
// Keeps the €10 default budget meaningful in tests without inventing a
// provider price list; production rates arrive with route qualification.
export const DISPATCH_COST_PER_MILLE_INPUT_MINOR = 1n;
export const DISPATCH_COST_PER_MILLE_OUTPUT_MINOR = 4n;

export const DEFAULT_MONEY_BUDGET_MINOR = "1000"; // €10.00 synthetic
export const DEFAULT_TOKEN_BUDGET = 40000;
export const DEFAULT_CONCURRENCY_LIMIT = 5;

export type DispatchRoute = "development" | "production";
export type ReservationStatus = "RESERVED" | "RECONCILED" | "PENDING" | "RELEASED" | "CANCELLED";
export type UsageStatus = "RECONCILED" | "PENDING" | "RELEASED";

export type DispatchErrorCode =
  | "budget_money"
  | "budget_tokens"
  | "budget_concurrency"
  | "idempotency_reuse"
  | "permit_invalid"
  | "permit_stale"
  | "permit_expired"
  | "route_forbidden"
  | "request_too_large";

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  constructor(code: DispatchErrorCode) {
    super(code);
    this.code = code;
  }
}

export type DispatchReservation = {
  workspaceId: string;
  id: string;
  idempotencyKey: string;
  permitId: string | null;
  policyVersion: string;
  route: DispatchRoute;
  purpose: string;
  status: ReservationStatus;
  reservedCostMinor: string;
  inputEstimate: number;
  outputCeiling: number;
  attempt: number;
};

export type DispatchUsage = {
  status: UsageStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  reconciledCostMinor: string | null;
  errorClass: string | null;
  model: string;
};

export type DispatchState = { reservation: DispatchReservation; usage: DispatchUsage | null };

/** Provider interaction. bodyText null means the attempt produced no output
 * (timeout/transport failure/empty body): only such attempts may be retried,
 * and only once. usage null means the provider reported no usable token
 * counts: the run stays PENDING with the full reservation held. */
export type DispatchAttempt = {
  httpStatus: number | null;
  bodyText: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string;
};

export type DispatchTransport = (
  req: { route: DispatchRoute; model: string; requestText: string; maxOutputTokens: number },
  signal: AbortSignal,
) => Promise<DispatchAttempt>;

function checkPurpose(purpose: unknown): string {
  if (typeof purpose !== "string" || purpose.length < 1 || purpose.length > 120) throw new TenantInvalid();
  return purpose;
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 200) throw new TenantInvalid();
  return key;
}

function requestBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function hashRequest(route: DispatchRoute, purpose: string, requestText: string, outputCeiling: number, model: string): string {
  return createHash("sha256").update(JSON.stringify({ route, purpose, requestText, outputCeiling, model })).digest("hex");
}

/** Ceiling cost for a token quantity at the synthetic rate (round up). */
export function costForTokens(tokens: number, perMille: bigint): bigint {
  return ((BigInt(tokens) + 999n) / 1000n) * perMille;
}

export function reservedCostFor(inputEstimate: number, outputCeiling: number): bigint {
  return costForTokens(inputEstimate, DISPATCH_COST_PER_MILLE_INPUT_MINOR) + costForTokens(outputCeiling, DISPATCH_COST_PER_MILLE_OUTPUT_MINOR);
}

/** Production route qualification: explicit and separate from any model
 * name. Without it the production route fails closed — it never falls back
 * to the training-permitted development route. */
export function productionQualified(): boolean {
  return process.env["AI_PRODUCTION_QUALIFIED"] === "1";
}

export function routeModel(route: DispatchRoute): string {
  if (route === "production") return process.env["DISPATCH_PROD_MODEL"] ?? "muse-spark-1.3";
  return process.env["DISPATCH_DEV_MODEL"] ?? "dispatch-double";
}

async function currentPolicyVersion(client: PoolClient, workspaceId: string): Promise<bigint> {
  const rows = await client.query("SELECT policy_version AS v FROM ai_policies WHERE workspace_id = $1", [workspaceId]);
  if ((rows.rowCount ?? 0) === 0) return 1n;
  return BigInt((rows.rows[0] as { v: string }).v);
}

type BudgetRow = { money: bigint; tokens: number; concurrency: number };

async function lockedBudget(client: PoolClient, workspaceId: string): Promise<BudgetRow> {
  await client.query(
    "INSERT INTO ai_dispatch_budgets (workspace_id, money_budget_minor, token_budget, concurrency_limit) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id) DO NOTHING",
    [workspaceId, DEFAULT_MONEY_BUDGET_MINOR, DEFAULT_TOKEN_BUDGET, DEFAULT_CONCURRENCY_LIMIT],
  );
  const rows = await client.query(
    "SELECT money_budget_minor AS m, token_budget AS t, concurrency_limit AS c FROM ai_dispatch_budgets WHERE workspace_id = $1 FOR UPDATE",
    [workspaceId],
  );
  const row = rows.rows[0] as { m: string; t: number; c: number };
  return { money: BigInt(row.m), tokens: row.t, concurrency: row.c };
}

type HeldTotals = { money: bigint; tokens: number; slots: number };

async function heldTotals(client: PoolClient, workspaceId: string): Promise<HeldTotals> {
  // Active (RESERVED/PENDING) holds the full reservation; reconciled history
  // counts at measured cost. RELEASED/CANCELLED hold nothing.
  const active = await client.query(
    "SELECT reserved_cost_minor AS cost, input_estimate AS ie, output_ceiling AS oc FROM ai_dispatch_reservations WHERE workspace_id = $1 AND status IN ('RESERVED', 'PENDING')",
    [workspaceId],
  );
  const done = await client.query(
    "SELECT reconciled_cost_minor AS cost, input_tokens AS ie, output_tokens AS oc FROM ai_dispatch_usage WHERE workspace_id = $1 AND status = 'RECONCILED'",
    [workspaceId],
  );
  let money = 0n;
  let tokens = 0;
  let slots = 0;
  for (const r of active.rows as { cost: string; ie: number; oc: number }[]) {
    money += BigInt(r.cost);
    tokens += r.ie + r.oc;
    slots += 1;
  }
  for (const r of done.rows as { cost: string | null; ie: number | null; oc: number | null }[]) {
    if (r.cost !== null) money += BigInt(r.cost);
    tokens += (r.ie ?? 0) + (r.oc ?? 0);
  }
  return { money, tokens, slots };
}

function rowToReservation(row: {
  workspace_id: string;
  id: string;
  idempotency_key: string;
  permit_id: string | null;
  policy_version: string;
  route: string;
  purpose: string;
  status: string;
  reserved_cost_minor: string;
  input_estimate: number;
  output_ceiling: number;
  attempt: number;
  request_hash: string;
}): DispatchReservation {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    permitId: row.permit_id,
    policyVersion: String(row.policy_version),
    route: row.route as DispatchRoute,
    purpose: row.purpose,
    status: row.status as ReservationStatus,
    reservedCostMinor: String(row.reserved_cost_minor),
    inputEstimate: row.input_estimate,
    outputCeiling: row.output_ceiling,
    attempt: row.attempt,
  };
}

async function readUsage(client: PoolClient, workspaceId: string, reservationId: string): Promise<DispatchUsage | null> {
  const found = await client.query(
    "SELECT status, input_tokens AS ie, output_tokens AS oc, reconciled_cost_minor AS cost, error_class AS ec, model FROM ai_dispatch_usage WHERE workspace_id = $1 AND reservation_id = $2",
    [workspaceId, reservationId],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  const r = found.rows[0] as { status: string; ie: number | null; oc: number | null; cost: string | null; ec: string | null; model: string };
  return {
    status: r.status as UsageStatus,
    inputTokens: r.ie,
    outputTokens: r.oc,
    reconciledCostMinor: r.cost === null ? null : String(r.cost),
    errorClass: r.ec,
    model: r.model,
  };
}

export type ReserveOptions = {
  idempotencyKey: string;
  permitId: string;
  route: DispatchRoute;
  purpose: string;
  requestText: string;
  inputEstimate: number;
  outputCeiling: number;
};

/**
 * Atomically admit one dispatch: tenant policy + permit CAS (fenced by the
 * current policy version) + route + concurrency/money/token budgets in a
 * single transaction. Same key + same bytes replays the existing
 * reservation; same key + different bytes conflicts. Rejected calls never
 * reach the transport (no transport runs inside this function at all).
 */
export async function reserveDispatch(pool: Pool, claims: TenantClaims, opts: ReserveOptions): Promise<DispatchReservation> {
  const key = checkKey(opts.idempotencyKey);
  const purpose = checkPurpose(opts.purpose);
  if (!isUuid(opts.permitId)) throw new TenantInvalid();
  if (opts.route !== "development" && opts.route !== "production") throw new TenantInvalid();
  if (!Number.isInteger(opts.inputEstimate) || opts.inputEstimate < 0 || opts.inputEstimate > 1_000_000) throw new TenantInvalid();
  if (!Number.isInteger(opts.outputCeiling) || opts.outputCeiling < 1 || opts.outputCeiling > DISPATCH_MAX_OUTPUT_TOKENS) throw new TenantInvalid();
  if (typeof opts.requestText !== "string" || requestBytes(opts.requestText) > DISPATCH_REQUEST_MAX_BYTES) throw new DispatchError("request_too_large");
  if (opts.route === "production" && !productionQualified()) throw new DispatchError("route_forbidden");
  const model = routeModel(opts.route);
  const hash = hashRequest(opts.route, purpose, opts.requestText, opts.outputCeiling, model);
  const reserved = reservedCostFor(opts.inputEstimate, opts.outputCeiling);

  return withTenant(pool, claims, async (client) => {
    // Idempotent claim first: a genuine replay converges before any budget
    // or permit state is touched, so replay can never double-charge.
    const prior = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND idempotency_key = $2", [
      claims.workspaceId,
      key,
    ]);
    if ((prior.rowCount ?? 0) > 0) {
      const existing = prior.rows[0] as Parameters<typeof rowToReservation>[0];
      if (existing.request_hash !== hash) throw new DispatchError("idempotency_reuse");
      return rowToReservation(existing);
    }
    const budget = await lockedBudget(client, claims.workspaceId);
    // Consume the permit inside the same transaction: the CAS to DISPATCHED
    // is fenced by the live policy version, so an exclusion committed
    // before this statement fails the dispatch closed.
    const permit = await client.query("SELECT status, policy_version AS v, expires_at AS e FROM ai_dispatch_permits WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      opts.permitId,
    ]);
    if ((permit.rowCount ?? 0) === 0) throw new DispatchError("permit_invalid");
    const p = permit.rows[0] as { status: string; v: string; e: string };
    if (p.status === "INVALIDATED") throw new DispatchError("permit_invalid");
    if (p.status !== "QUEUED") throw new DispatchError("permit_invalid");
    if (new Date(p.e).getTime() <= Date.now()) throw new DispatchError("permit_expired");
    const live = await currentPolicyVersion(client, claims.workspaceId);
    if (BigInt(p.v) !== live) throw new DispatchError("permit_stale");
    const held = await heldTotals(client, claims.workspaceId);
    if (held.slots >= budget.concurrency) throw new DispatchError("budget_concurrency");
    if (held.money + reserved > budget.money) throw new DispatchError("budget_money");
    if (held.tokens + opts.inputEstimate + opts.outputCeiling > budget.tokens) throw new DispatchError("budget_tokens");
    await client.query("UPDATE ai_dispatch_permits SET status = 'DISPATCHED' WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, opts.permitId]);
    const id = uuidv7();
    const inserted = await client.query(
      "INSERT INTO ai_dispatch_reservations (workspace_id, id, idempotency_key, permit_id, policy_version, route, purpose, status, reserved_cost_minor, input_estimate, output_ceiling, request_hash, attempt, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED', $8, $9, $10, $11, 1, now() + ($12 || ' minutes')::interval) RETURNING *",
      [claims.workspaceId, id, key, opts.permitId, live.toString(10), opts.route, purpose, reserved.toString(10), opts.inputEstimate, opts.outputCeiling, hash, String(DISPATCH_RESERVATION_TTL_MIN)],
    );
    return rowToReservation(inserted.rows[0] as Parameters<typeof rowToReservation>[0]);
  });
}

function validTokenCount(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Terminal provider classes release the reservation; everything else that
 * survives the single safe retry stays PENDING (ambiguous work remains
 * charged/reserved pending reconciliation). Documented release classes:
 * auth, credits, forbidden, invalid-request, unavailable-model, revoked
 * (policy revocation before dispatch), cancelled-before-dispatch. */
function terminalClass(httpStatus: number | null): string {
  if (httpStatus === 401) return "auth";
  if (httpStatus === 402) return "credits";
  if (httpStatus === 403) return "forbidden";
  if (httpStatus === 400) return "invalid-request";
  if (httpStatus === 404) return "unavailable-model";
  return "transport";
}

function retryableStatus(httpStatus: number | null): boolean {
  if (httpStatus === null) return true;
  if (httpStatus === 408 || httpStatus === 429) return true;
  if (httpStatus >= 500) return true;
  return false;
}

async function settleReservation(
  client: PoolClient,
  workspaceId: string,
  reservationId: string,
  status: ReservationStatus,
  attempt: number,
  usage: { usageStatus: UsageStatus; inputTokens: number | null; outputTokens: number | null; cost: bigint | null; errorClass: string | null; model: string },
): Promise<void> {
  await client.query("UPDATE ai_dispatch_reservations SET status = $1, attempt = $2 WHERE workspace_id = $3 AND id = $4", [
    status,
    attempt,
    workspaceId,
    reservationId,
  ]);
  await client.query(
    "INSERT INTO ai_dispatch_usage (workspace_id, id, reservation_id, status, input_tokens, output_tokens, reconciled_cost_minor, error_class, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workspace_id, reservation_id) DO NOTHING",
    [workspaceId, uuidv7(), reservationId, usage.usageStatus, usage.inputTokens, usage.outputTokens, usage.cost === null ? null : usage.cost.toString(10), usage.errorClass, usage.model],
  );
}

/**
 * Execute a RESERVED dispatch: revalidate the policy version (revocation
 * after reserve but before dispatch fails closed with no transport call),
 * run at most two attempts (the second only when the first produced no
 * provider output), then reconcile. Terminal reservations replay their
 * recorded state without touching the transport again.
 */
export async function executeReserved(
  pool: Pool,
  claims: TenantClaims,
  reservationId: string,
  transport: DispatchTransport,
  requestText: string,
): Promise<DispatchState> {
  if (!isUuid(reservationId)) throw new TenantInvalid();
  if (typeof requestText !== "string" || requestBytes(requestText) > DISPATCH_REQUEST_MAX_BYTES) throw new DispatchError("request_too_large");

  const current = await withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
    if ((found.rowCount ?? 0) === 0) throw new TenantDenied();
    const reservation = rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]);
    const usage = await readUsage(client, claims.workspaceId, reservationId);
    return { reservation, usage };
  });
  if (current.reservation.status !== "RESERVED") {
    // Idempotent replay of a settled or cancelled dispatch: recorded state
    // only, never a second transport call or second usage row.
    return current;
  }
  const model = routeModel(current.reservation.route);

  // Revocation recheck before any provider I/O: a policy change after
  // reserve fails closed and releases the untouched reservation.
  const live = await withTenant(pool, claims, async (client) => currentPolicyVersion(client, claims.workspaceId));
  if (live.toString(10) !== current.reservation.policyVersion) {
    return withTenant(pool, claims, async (client) => {
      const locked = await client.query("SELECT status FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
        claims.workspaceId,
        reservationId,
      ]);
      if ((locked.rows[0] as { status: string }).status !== "RESERVED") {
        const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
        return { reservation: rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]), usage: await readUsage(client, claims.workspaceId, reservationId) };
      }
      await settleReservation(client, claims.workspaceId, reservationId, "RELEASED", 1, {
        usageStatus: "RELEASED",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        errorClass: "revoked",
        model,
      });
      const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
      return { reservation: rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]), usage: await readUsage(client, claims.workspaceId, reservationId) };
    });
  }

  let attemptResult: DispatchAttempt | { transportError: number | null };
  let attempts = 0;
  const runAttempt = async (): Promise<DispatchAttempt | { transportError: number | null }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
      return await transport({ route: current.reservation.route, model, requestText, maxOutputTokens: current.reservation.outputCeiling }, controller.signal);
    } catch {
      return { transportError: null };
    } finally {
      clearTimeout(timer);
    }
  };
  attempts += 1;
  attemptResult = await runAttempt();
  // Normalize aborts/hangs to a retryable no-output attempt.
  if ("transportError" in attemptResult) attemptResult = { httpStatus: attemptResult.transportError, bodyText: null, inputTokens: null, outputTokens: null, model };
  if (attemptResult.bodyText === null && retryableStatus(attemptResult.httpStatus) && attempts < DISPATCH_MAX_ATTEMPTS) {
    // One retry only, and only because no provider output exists yet. A
    // policy change between attempts fails closed without dispatching.
    const liveBeforeRetry = await withTenant(pool, claims, async (client) => currentPolicyVersion(client, claims.workspaceId));
    if (liveBeforeRetry.toString(10) !== current.reservation.policyVersion) {
      return withTenant(pool, claims, async (client) => {
        await settleReservation(client, claims.workspaceId, reservationId, "RELEASED", attempts, {
          usageStatus: "RELEASED",
          inputTokens: null,
          outputTokens: null,
          cost: null,
          errorClass: "revoked",
          model,
        });
        const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
        return { reservation: rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]), usage: await readUsage(client, claims.workspaceId, reservationId) };
      });
    }
    attempts += 1;
    attemptResult = await runAttempt();
    if ("transportError" in attemptResult) attemptResult = { httpStatus: attemptResult.transportError, bodyText: null, inputTokens: null, outputTokens: null, model };
  }
  const final = attemptResult as DispatchAttempt;

  return withTenant(pool, claims, async (client) => {
    const locked = await client.query("SELECT status FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      reservationId,
    ]);
    if ((locked.rowCount ?? 0) === 0) throw new TenantDenied();
    if ((locked.rows[0] as { status: string }).status !== "RESERVED") {
      const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
      return { reservation: rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]), usage: await readUsage(client, claims.workspaceId, reservationId) };
    }
    if (final.httpStatus !== null && final.httpStatus >= 200 && final.httpStatus < 300 && final.bodyText !== null) {
      if (validTokenCount(final.inputTokens) && validTokenCount(final.outputTokens)) {
        const cost = costForTokens(final.inputTokens, DISPATCH_COST_PER_MILLE_INPUT_MINOR) + costForTokens(final.outputTokens, DISPATCH_COST_PER_MILLE_OUTPUT_MINOR);
        await settleReservation(client, claims.workspaceId, reservationId, "RECONCILED", attempts, {
          usageStatus: "RECONCILED",
          inputTokens: final.inputTokens,
          outputTokens: final.outputTokens,
          cost,
          errorClass: null,
          model: final.model || model,
        });
      } else {
        // Missing or invalid provider usage stays PENDING with the full
        // reservation held — unknown is not zero.
        await settleReservation(client, claims.workspaceId, reservationId, "PENDING", attempts, {
          usageStatus: "PENDING",
          inputTokens: validTokenCount(final.inputTokens) ? final.inputTokens : null,
          outputTokens: validTokenCount(final.outputTokens) ? final.outputTokens : null,
          cost: null,
          errorClass: "unknown-usage",
          model: final.model || model,
        });
      }
    } else if (final.bodyText === null && retryableStatus(final.httpStatus)) {
      // Retryable failure with no output after the one safe retry (or a
      // second no-output attempt): ambiguous dispatch remains
      // charged/reserved pending reconciliation.
      await settleReservation(client, claims.workspaceId, reservationId, "PENDING", attempts, {
        usageStatus: "PENDING",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        errorClass: terminalClass(final.httpStatus),
        model: final.model || model,
      });
    } else {
      // Terminal failure (auth/credits/forbidden/invalid/unavailable, or
      // output accompanied by failure): release under the documented class.
      await settleReservation(client, claims.workspaceId, reservationId, "RELEASED", attempts, {
        usageStatus: "RELEASED",
        inputTokens: validTokenCount(final.inputTokens) ? final.inputTokens : null,
        outputTokens: validTokenCount(final.outputTokens) ? final.outputTokens : null,
        cost: null,
        errorClass: terminalClass(final.httpStatus),
        model: final.model || model,
      });
    }
    const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
    return { reservation: rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]), usage: await readUsage(client, claims.workspaceId, reservationId) };
  });
}

/** Convenience: reserve then execute. The durable job owns retry across
 * these phases; ambiguous dispatch stays PENDING (reserved) for later
 * reconciliation rather than being retried blindly. */
export async function dispatchModelCall(
  pool: Pool,
  claims: TenantClaims,
  opts: ReserveOptions,
  transport: DispatchTransport,
): Promise<DispatchState> {
  const reservation = await reserveDispatch(pool, claims, opts);
  return executeReserved(pool, claims, reservation.id, transport, opts.requestText);
}

/**
 * Cancel a dispatch. Cancellation before dispatch prevents any later
 * transport call and frees the untouched budget; already-accepted provider
 * work (RECONCILED/PENDING usage) is retained, never rewritten. Idempotent.
 */
export async function cancelDispatch(pool: Pool, claims: TenantClaims, reservationId: string): Promise<DispatchState> {
  if (!isUuid(reservationId)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      reservationId,
    ]);
    if ((found.rowCount ?? 0) === 0) throw new TenantDenied();
    const reservation = rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]);
    if (reservation.status === "RESERVED") {
      await settleReservation(client, claims.workspaceId, reservationId, "CANCELLED", reservation.attempt, {
        usageStatus: "RELEASED",
        inputTokens: null,
        outputTokens: null,
        cost: null,
        errorClass: "cancelled",
        model: routeModel(reservation.route),
      });
      const next = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
      return { reservation: rowToReservation(next.rows[0] as Parameters<typeof rowToReservation>[0]), usage: await readUsage(client, claims.workspaceId, reservationId) };
    }
    return { reservation, usage: await readUsage(client, claims.workspaceId, reservationId) };
  });
}

/** Read a dispatch and its usage (decimal-string costs). Uniform denial for
 * foreign or nonexistent ids; unscoped reads return no rows via RLS. */
export async function readDispatch(pool: Pool, claims: TenantClaims, reservationId: string): Promise<DispatchState> {
  if (!isUuid(reservationId)) throw new TenantDenied();
  return withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT * FROM ai_dispatch_reservations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, reservationId]);
    if ((found.rowCount ?? 0) === 0) throw new TenantDenied();
    const reservation = rowToReservation(found.rows[0] as Parameters<typeof rowToReservation>[0]);
    return { reservation, usage: await readUsage(client, claims.workspaceId, reservationId) };
  });
}

export type BudgetView = { moneyBudgetMinor: string; tokenBudget: number; concurrencyLimit: number };

/** Set workspace dispatch budgets (tests and the future settings story use
 * this; production values arrive with route qualification). Money crosses
 * the boundary as a decimal string; no floats anywhere. */
export async function setDispatchBudget(pool: Pool, claims: TenantClaims, budget: { moneyMinor: string; tokens: number; concurrency: number }): Promise<BudgetView> {
  let money: bigint;
  try {
    money = parseDecimalBigint(budget.moneyMinor);
  } catch {
    throw new TenantInvalid();
  }
  if (!Number.isInteger(budget.tokens) || budget.tokens < 0) throw new TenantInvalid();
  if (!Number.isInteger(budget.concurrency) || budget.concurrency < 1 || budget.concurrency > 32) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    await client.query(
      "INSERT INTO ai_dispatch_budgets (workspace_id, money_budget_minor, token_budget, concurrency_limit, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (workspace_id) DO UPDATE SET money_budget_minor = EXCLUDED.money_budget_minor, token_budget = EXCLUDED.token_budget, concurrency_limit = EXCLUDED.concurrency_limit, updated_at = now()",
      [claims.workspaceId, money.toString(10), budget.tokens, budget.concurrency],
    );
    return { moneyBudgetMinor: formatDecimalBigint(money), tokenBudget: budget.tokens, concurrencyLimit: budget.concurrency };
  });
}

export function dispatchErrorBody(err: DispatchError): { status: number; body: unknown } {
  switch (err.code) {
    case "budget_money":
    case "budget_tokens":
    case "budget_concurrency":
      return { status: 429, body: { error: "budget_exceeded", reason: err.code } };
    case "idempotency_reuse":
      return { status: 409, body: { error: "idempotency_reuse" } };
    case "permit_invalid":
    case "permit_stale":
    case "permit_expired":
      return { status: 409, body: { error: err.code } };
    case "route_forbidden":
      return { status: 409, body: { error: "route_forbidden" } };
    case "request_too_large":
      return { status: 400, body: { error: "invalid_request" } };
  }
}
