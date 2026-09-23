// E07-S03 pin and arrange persistent artifacts on the one Home dashboard.
// Journaled CAS commands over one workspace layout row (optimistic BIGINT
// version; versions cross JSON strictly as decimal strings) plus pinned
// artifact refs. Every mutation is idempotent via command_operations, writes
// an audit row, and bumps workspace_data_revision. Any member change sets
// user_edited so analysis personalization must never overwrite saved order.
// Pins reference artifact_id only: opening a tile always resolves the
// CURRENT active version with fresh SDK grants (E05 contracts own grant
// freshness); tiles never execute stale code.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { bumpRevision, claimAndExecute, insertAudit, TxError, type TxOutcome } from "./transactions.ts";

export const HOME_LAYOUT_PIN_COMMAND = "home-layout.pin";
export const HOME_LAYOUT_UNPIN_COMMAND = "home-layout.unpin";
export const HOME_LAYOUT_MOVE_COMMAND = "home-layout.move";
export const HOME_LAYOUT_RESIZE_COMMAND = "home-layout.resize";

export const HOME_LAYOUT_MAX_TILES = 12;
export const HOME_LAYOUT_SIZES = ["small", "wide", "large"] as const;
export type HomeLayoutSize = (typeof HOME_LAYOUT_SIZES)[number];

export type HomeTileView = {
  artifactId: string;
  position: number;
  size: HomeLayoutSize;
};

export type HomeLayoutView = {
  workspaceId: string;
  version: string;
  userEdited: boolean;
  tiles: HomeTileView[];
};

export type HomeTileResolution = {
  artifactId: string;
  position: number;
  size: HomeLayoutSize;
  status: "available" | "unavailable";
  reason?: "deleted" | "archived" | "not_ready";
  name?: string;
  activeVersionId?: string;
};

function checkUuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw new TenantInvalid();
  return value;
}

function checkVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new TenantInvalid();
  return value.replace(/^0+(?=[0-9])/, "");
}

function checkSize(value: unknown): HomeLayoutSize {
  if (value !== "small" && value !== "wide" && value !== "large") throw new TenantInvalid();
  return value;
}

function checkPosition(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new TenantInvalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 1000) throw new TenantInvalid();
  return n;
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TenantInvalid();
  }
}

export type PinInput = {
  workspaceId: string;
  artifactId: string;
  size: HomeLayoutSize;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validatePinInput(value: unknown): PinInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "artifactId", "size", "expectedVersion", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    artifactId: checkUuid(v.artifactId),
    size: v.size === undefined ? "small" : checkSize(v.size),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type UnpinInput = {
  workspaceId: string;
  artifactId: string;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateUnpinInput(value: unknown): UnpinInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "artifactId", "expectedVersion", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    artifactId: checkUuid(v.artifactId),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type MoveInput = {
  workspaceId: string;
  artifactId: string;
  toPosition: number;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateMoveInput(value: unknown): MoveInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "artifactId", "toPosition", "expectedVersion", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    artifactId: checkUuid(v.artifactId),
    toPosition: checkPosition(v.toPosition),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type ResizeInput = {
  workspaceId: string;
  artifactId: string;
  size: HomeLayoutSize;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateResizeInput(value: unknown): ResizeInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "artifactId", "size", "expectedVersion", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    artifactId: checkUuid(v.artifactId),
    size: checkSize(v.size),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

function hashOf(obj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

/** Lock the workspace layout row, creating it at version 1 on first use. */
async function lockLayout(client: PoolClient, workspaceId: string): Promise<{ version: bigint; userEdited: boolean }> {
  const found = await client.query("SELECT version, user_edited FROM home_layouts WHERE workspace_id = $1 FOR UPDATE", [workspaceId]);
  if ((found.rowCount ?? 0) > 0) {
    const row = found.rows[0] as { version: string; user_edited: boolean };
    return { version: BigInt(String(row.version)), userEdited: row.user_edited };
  }
  try {
    await client.query("INSERT INTO home_layouts (workspace_id, version, user_edited) VALUES ($1, 1, false)", [workspaceId]);
    return { version: 1n, userEdited: false };
  } catch (err) {
    // A concurrent first pin won the insert: converge on its row.
    if ((err as { code?: string }).code !== "23505") throw err;
    const retry = await client.query("SELECT version, user_edited FROM home_layouts WHERE workspace_id = $1 FOR UPDATE", [workspaceId]);
    const row = retry.rows[0] as { version: string; user_edited: boolean };
    return { version: BigInt(String(row.version)), userEdited: row.user_edited };
  }
}

function checkExpected(current: bigint, expected: string): void {
  if (current !== BigInt(expected)) throw new TxError("version_mismatch", current.toString(10));
}

async function readTiles(client: PoolClient, workspaceId: string): Promise<HomeTileView[]> {
  const rows = await client.query("SELECT artifact_id, position, size FROM home_layout_tiles WHERE workspace_id = $1 ORDER BY position", [workspaceId]);
  return (rows.rows as { artifact_id: string; position: number; size: HomeLayoutSize }[]).map((r) => ({
    artifactId: r.artifact_id,
    position: Number(r.position),
    size: r.size,
  }));
}

async function commitLayout(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  action: string,
  before: unknown,
  tiles: HomeTileView[],
  operationId: string,
): Promise<HomeLayoutView> {
  await client.query("UPDATE home_layouts SET version = version + 1, user_edited = true, updated_at = now() WHERE workspace_id = $1", [claims.workspaceId]);
  const after = await client.query("SELECT version FROM home_layouts WHERE workspace_id = $1", [claims.workspaceId]);
  const view: HomeLayoutView = {
    workspaceId: claims.workspaceId,
    version: String((after.rows[0] as { version: string }).version),
    userEdited: true,
    tiles,
  };
  await insertAudit(client, claims, actorId, "home_layout", claims.workspaceId, action, before, view, operationId);
  await bumpRevision(client, claims.workspaceId);
  return view;
}

/** Pin target must be owned, non-archived, and carry a ready active version. */
async function requirePinnable(client: PoolClient, workspaceId: string, artifactId: string): Promise<void> {
  const art = await client.query("SELECT active_version_id, archived_at FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, artifactId]);
  if ((art.rowCount ?? 0) === 0) throw new TxError("not_found");
  const row = art.rows[0] as { active_version_id: string | null; archived_at: string | null };
  // Uniform 404: archived reads exactly like missing (no lifecycle oracle).
  if (row.archived_at !== null) throw new TxError("not_found");
  if (!row.active_version_id) throw new TxError("unsupported_operation", undefined, { reason: "version_not_ready" });
  const ver = await client.query("SELECT status FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3", [
    workspaceId,
    artifactId,
    row.active_version_id,
  ]);
  if ((ver.rowCount ?? 0) === 0 || (ver.rows[0] as { status: string }).status !== "ready") {
    throw new TxError("unsupported_operation", undefined, { reason: "version_not_ready" });
  }
}

export async function pinTileTx(client: PoolClient, claims: TenantClaims, actorId: string, input: PinInput): Promise<TxOutcome<HomeLayoutView>> {
  return claimAndExecute(client, claims, actorId, HOME_LAYOUT_PIN_COMMAND, input.idempotencyKey, hashOf({ ...input, command: HOME_LAYOUT_PIN_COMMAND }), async (client, operationId) => {
    const layout = await lockLayout(client, claims.workspaceId);
    checkExpected(layout.version, input.expectedVersion);
    const existing = await client.query("SELECT 1 FROM home_layout_tiles WHERE workspace_id = $1 AND artifact_id = $2", [claims.workspaceId, input.artifactId]);
    if ((existing.rowCount ?? 0) > 0) throw new TxError("unsupported_operation", layout.version.toString(10), { reason: "already_pinned" });
    const count = await client.query("SELECT count(*)::int AS n FROM home_layout_tiles WHERE workspace_id = $1", [claims.workspaceId]);
    if (((count.rows[0] as { n: number }).n) >= HOME_LAYOUT_MAX_TILES) {
      throw new TxError("limit_exceeded", layout.version.toString(10), { maxTiles: HOME_LAYOUT_MAX_TILES });
    }
    // Owned + non-archived + ready, else uniform 404 / not-ready 409.
    await requirePinnable(client, claims.workspaceId, input.artifactId);
    const tiles = await readTiles(client, claims.workspaceId);
    const before: HomeLayoutView = { workspaceId: claims.workspaceId, version: layout.version.toString(10), userEdited: layout.userEdited, tiles };
    await client.query("INSERT INTO home_layout_tiles (workspace_id, artifact_id, position, size) VALUES ($1, $2, $3, $4)", [
      claims.workspaceId,
      input.artifactId,
      tiles.length,
      input.size,
    ]);
    const next = [...tiles, { artifactId: input.artifactId, position: tiles.length, size: input.size }];
    const view = await commitLayout(client, claims, actorId, "pin", before, next, operationId);
    return { view, operationId };
  });
}

export async function unpinTileTx(client: PoolClient, claims: TenantClaims, actorId: string, input: UnpinInput): Promise<TxOutcome<HomeLayoutView>> {
  return claimAndExecute(client, claims, actorId, HOME_LAYOUT_UNPIN_COMMAND, input.idempotencyKey, hashOf({ ...input, command: HOME_LAYOUT_UNPIN_COMMAND }), async (client, operationId) => {
    const layout = await lockLayout(client, claims.workspaceId);
    checkExpected(layout.version, input.expectedVersion);
    const tiles = await readTiles(client, claims.workspaceId);
    if (!tiles.some((t) => t.artifactId === input.artifactId)) throw new TxError("not_found");
    const before: HomeLayoutView = { workspaceId: claims.workspaceId, version: layout.version.toString(10), userEdited: layout.userEdited, tiles };
    await client.query("DELETE FROM home_layout_tiles WHERE workspace_id = $1 AND artifact_id = $2", [claims.workspaceId, input.artifactId]);
    const rest = tiles.filter((t) => t.artifactId !== input.artifactId);
    for (let i = 0; i < rest.length; i++) {
      await client.query("UPDATE home_layout_tiles SET position = $3 WHERE workspace_id = $1 AND artifact_id = $2", [claims.workspaceId, rest[i]!.artifactId, i]);
      rest[i]!.position = i;
    }
    const view = await commitLayout(client, claims, actorId, "unpin", before, rest, operationId);
    return { view, operationId };
  });
}

export async function moveTileTx(client: PoolClient, claims: TenantClaims, actorId: string, input: MoveInput): Promise<TxOutcome<HomeLayoutView>> {
  return claimAndExecute(client, claims, actorId, HOME_LAYOUT_MOVE_COMMAND, input.idempotencyKey, hashOf({ ...input, command: HOME_LAYOUT_MOVE_COMMAND }), async (client, operationId) => {
    const layout = await lockLayout(client, claims.workspaceId);
    checkExpected(layout.version, input.expectedVersion);
    const tiles = await readTiles(client, claims.workspaceId);
    const from = tiles.findIndex((t) => t.artifactId === input.artifactId);
    if (from < 0) throw new TxError("not_found");
    const before: HomeLayoutView = { workspaceId: claims.workspaceId, version: layout.version.toString(10), userEdited: layout.userEdited, tiles };
    const [moving] = tiles.splice(from, 1);
    const to = Math.min(input.toPosition, tiles.length);
    tiles.splice(to, 0, moving!);
    for (let i = 0; i < tiles.length; i++) {
      await client.query("UPDATE home_layout_tiles SET position = $3 WHERE workspace_id = $1 AND artifact_id = $2", [claims.workspaceId, tiles[i]!.artifactId, i]);
      tiles[i]!.position = i;
    }
    const view = await commitLayout(client, claims, actorId, "move", before, tiles, operationId);
    return { view, operationId };
  });
}

export async function resizeTileTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ResizeInput): Promise<TxOutcome<HomeLayoutView>> {
  return claimAndExecute(client, claims, actorId, HOME_LAYOUT_RESIZE_COMMAND, input.idempotencyKey, hashOf({ ...input, command: HOME_LAYOUT_RESIZE_COMMAND }), async (client, operationId) => {
    const layout = await lockLayout(client, claims.workspaceId);
    checkExpected(layout.version, input.expectedVersion);
    const tiles = await readTiles(client, claims.workspaceId);
    const tile = tiles.find((t) => t.artifactId === input.artifactId);
    if (!tile) throw new TxError("not_found");
    const before: HomeLayoutView = { workspaceId: claims.workspaceId, version: layout.version.toString(10), userEdited: layout.userEdited, tiles: tiles.map((t) => ({ ...t })) };
    await client.query("UPDATE home_layout_tiles SET size = $3 WHERE workspace_id = $1 AND artifact_id = $2", [claims.workspaceId, input.artifactId, input.size]);
    tile.size = input.size;
    const view = await commitLayout(client, claims, actorId, "resize", before, tiles, operationId);
    return { view, operationId };
  });
}

function toTxError(outcome: { ok: false; code: TxError["code"]; currentVersion?: string; detail?: unknown }): TxError {
  return new TxError(outcome.code, outcome.currentVersion, outcome.detail);
}

export type HomeLayoutResult = { view: HomeLayoutView; operationId: string; replayed: boolean };

async function runCommand<T>(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
  validate: (value: unknown) => T & { workspaceId: string; idempotencyKey: string },
  tx: (client: PoolClient, claims: TenantClaims, actorId: string, input: T) => Promise<TxOutcome<HomeLayoutView>>,
): Promise<HomeLayoutResult> {
  const input = validate(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => tx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function pinTile(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<HomeLayoutResult> {
  return runCommand(pool, claims, actorId, raw, validatePinInput, pinTileTx);
}

export async function unpinTile(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<HomeLayoutResult> {
  return runCommand(pool, claims, actorId, raw, validateUnpinInput, unpinTileTx);
}

export async function moveTile(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<HomeLayoutResult> {
  return runCommand(pool, claims, actorId, raw, validateMoveInput, moveTileTx);
}

export async function resizeTile(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<HomeLayoutResult> {
  return runCommand(pool, claims, actorId, raw, validateResizeInput, resizeTileTx);
}

/** Read-only layout load. A missing row is version "1" with no tiles: the
 *  Home renders its deterministic default order and nothing is written, so
 *  analysis personalization can never overwrite a saved order — and a saved
 *  order (userEdited) is never replaced by a default. */
export async function readHomeLayout(pool: Pool, claims: TenantClaims): Promise<HomeLayoutView> {
  return withTenant(pool, claims, async (client) => {
    const layout = await client.query("SELECT version, user_edited FROM home_layouts WHERE workspace_id = $1", [claims.workspaceId]);
    if ((layout.rowCount ?? 0) === 0) {
      return { workspaceId: claims.workspaceId, version: "1", userEdited: false, tiles: [] };
    }
    const row = layout.rows[0] as { version: string; user_edited: boolean };
    return {
      workspaceId: claims.workspaceId,
      version: String(row.version),
      userEdited: row.user_edited,
      tiles: await readTiles(client, claims.workspaceId),
    };
  });
}

/** Artifacts the member may pin: owned, non-archived, ready active version, not already pinned. */
export async function listPinnableArtifacts(pool: Pool, claims: TenantClaims): Promise<{ artifactId: string; name: string }[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      `SELECT a.id, a.name FROM artifacts a
        JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.id = a.active_version_id AND v.status = 'ready'
        LEFT JOIN home_layout_tiles t ON t.workspace_id = a.workspace_id AND t.artifact_id = a.id
        WHERE a.workspace_id = $1 AND a.archived_at IS NULL AND t.artifact_id IS NULL
        ORDER BY a.created_at DESC LIMIT 100`,
      [claims.workspaceId],
    );
    return (rows.rows as { id: string; name: string }[]).map((r) => ({ artifactId: r.id, name: r.name }));
  });
}

export type PinnedArtifactDefault = { artifactId: string; name: string; activeVersionId: string };

/** Deterministic default order when the member never customized the Home:
 *  ready, non-archived artifacts, newest first, capped at the tile limit. */
export async function defaultPinnedOrder(pool: Pool, claims: TenantClaims): Promise<PinnedArtifactDefault[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      `SELECT a.id, a.name, a.active_version_id FROM artifacts a
        JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.id = a.active_version_id AND v.status = 'ready'
        WHERE a.workspace_id = $1 AND a.archived_at IS NULL
        ORDER BY a.created_at DESC LIMIT ${HOME_LAYOUT_MAX_TILES}`,
      [claims.workspaceId],
    );
    return (rows.rows as { id: string; name: string; active_version_id: string }[]).map((r) => ({
      artifactId: r.id,
      name: r.name,
      activeVersionId: r.active_version_id,
    }));
  });
}

/** Resolve saved pins for rendering. Deleted/archived/not-ready artifacts
 *  resolve as removable unavailable tiles; nothing is executed here and no
 *  source, state, or cross-tenant row is read. Grant/policy freshness is
 *  enforced when the tile is opened (fresh grant, current basis) and on
 *  every SDK call per the E05 contracts. */
export async function resolveHomeTiles(pool: Pool, claims: TenantClaims): Promise<{ layout: HomeLayoutView; tiles: HomeTileResolution[] }> {
  const layout = await readHomeLayout(pool, claims);
  if (layout.tiles.length === 0) return { layout, tiles: [] };
  const resolved = await withTenant(pool, claims, async (client) => {
    const out: HomeTileResolution[] = [];
    for (const tile of layout.tiles) {
      const art = await client.query("SELECT name, active_version_id, archived_at FROM artifacts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, tile.artifactId]);
      if ((art.rowCount ?? 0) === 0) {
        out.push({ artifactId: tile.artifactId, position: tile.position, size: tile.size, status: "unavailable", reason: "deleted" });
        continue;
      }
      const row = art.rows[0] as { name: string; active_version_id: string | null; archived_at: string | null };
      if (row.archived_at !== null) {
        out.push({ artifactId: tile.artifactId, position: tile.position, size: tile.size, status: "unavailable", reason: "archived", name: row.name });
        continue;
      }
      if (!row.active_version_id) {
        out.push({ artifactId: tile.artifactId, position: tile.position, size: tile.size, status: "unavailable", reason: "not_ready", name: row.name });
        continue;
      }
      const ver = await client.query("SELECT status FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3", [
        claims.workspaceId,
        tile.artifactId,
        row.active_version_id,
      ]);
      if ((ver.rowCount ?? 0) === 0 || (ver.rows[0] as { status: string }).status !== "ready") {
        out.push({ artifactId: tile.artifactId, position: tile.position, size: tile.size, status: "unavailable", reason: "not_ready", name: row.name });
        continue;
      }
      out.push({ artifactId: tile.artifactId, position: tile.position, size: tile.size, status: "available", name: row.name, activeVersionId: row.active_version_id });
    }
    return out;
  });
  return { layout, tiles: resolved };
}

export { uuidv7 };
