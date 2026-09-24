// E08-S01c-L local retention enforcement (architecture ##455-456).
// Enforced locally (no provider needed): original upload bytes ~30 days
// after validated import (explicit retain/unresolved holds), export bundles
// 24 hours, tombstones never purged (45-day floor exported for S02).
// AI metadata, queue records, security audit and backups are cataloged as
// deployment-gated with no enforced period and no fake claim (S01c-D).
//
// Cross-workspace sweeping reads the ID-only expiry indexes (UUIDs +
// instants, no RLS — same rationale as job_dispatch_index) and expires each
// package/import inside a workspace-scoped sweep context bound to the index
// row. Tombstones have no index and no sweep path: no sweep may delete them.

import type { Pool, PoolClient } from "pg";
import { isUuid } from "./ids.ts";
import { TenantDenied } from "./tenancy.ts";
import { s3Delete, s3DeleteExport, type S3Config } from "./s3.ts";
import { DELETION_BATCH_ROWS } from "./deletion.ts";

export const TOMBSTONE_RETENTION_DAYS = 45;
export const UPLOAD_BYTES_RETENTION_DAYS = 30;
export const EXPORT_BUNDLE_RETENTION_HOURS = 24;

export type RetentionClass = {
  class: string;
  retention: string;
  basis: string;
  mechanism: string;
  enforced: boolean;
};

/** Machine-readable catalog: code, privacy text and cleanup agree on it. */
export const RETENTION_CATALOG: RetentionClass[] = [
  { class: "canonical finance data", retention: "while the workspace is active", basis: "contract", mechanism: "workspace/identity deletion purges on request", enforced: true },
  { class: "raw source observations", retention: "while the source history is active", basis: "contract", mechanism: "kept with the import; never purged by retention sweeps", enforced: true },
  { class: "original uploaded bytes", retention: `about ${UPLOAD_BYTES_RETENTION_DAYS} days after validated import`, basis: "data minimisation", mechanism: "sweepRetention deletes bytes + source_objects rows past expiry; explicit retain and unresolved-import holds", enforced: true },
  { class: "temporary export bundle", retention: `${EXPORT_BUNDLE_RETENTION_HOURS} hours`, basis: "data minimisation", mechanism: "sweepRetention plus lazy/member expiry; one-use download", enforced: true },
  { class: "AI conversations", retention: "until the user deletes them or the account is deleted", basis: "consent/erasure", mechanism: "identity deletion purges the departed member's threads", enforced: true },
  { class: "deletion tombstones", retention: `at least ${TOMBSTONE_RETENTION_DAYS} days; never restored into tenant use`, basis: "legal obligation (proof of erasure; restore guard)", mechanism: "no sweep path deletes tombstones; S02 replays them after restore", enforced: true },
  { class: "AI operational metadata", retention: "set after operational/legal review", basis: "pending", mechanism: "none enforced locally", enforced: false },
  { class: "queue execution records", retention: "set after operational/legal review", basis: "pending", mechanism: "bounded BullMQ retention only; no PG purge locally", enforced: false },
  { class: "security audit events", retention: "set after operational/legal review", basis: "pending", mechanism: "none enforced locally", enforced: false },
  { class: "backups", retention: "set after hosting selection and privacy sign-off", basis: "pending", mechanism: "none enforced locally", enforced: false },
];

export type SweepCounts = { purgedUploads: number; heldUploads: number; expiredExports: number; skippedExports: number; failed: number };

async function withRetentionSweep<T>(pool: Pool, table: "export_expiry_index" | "import_expiry_index", workspaceId: string, keyId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(workspaceId) || !isUuid(keyId)) throw new TenantDenied();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
    // Fence: the index row must still exist (prevents double-sweep races
    // and bounds this context to discovered, due work only).
    const keyCol = table === "export_expiry_index" ? "package_id" : "import_id";
    const fence = await client.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1 AND ${keyCol} = $2`, [workspaceId, keyId]);
    if ((fence.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      throw new TenantDenied();
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { /* preserve the original error */ }
    throw err;
  } finally {
    client.release();
  }
}

async function deleteImportBytes(client: PoolClient, s3: S3Config, workspaceId: string, importId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const keys = await client.query("SELECT object_key FROM source_objects WHERE workspace_id = $1 AND import_id = $2 LIMIT $3", [workspaceId, importId, DELETION_BATCH_ROWS]);
    if ((keys.rowCount ?? 0) === 0) return total;
    for (const row of keys.rows as Array<{ object_key: string }>) {
      await s3Delete(s3, row.object_key);
    }
    await client.query("DELETE FROM source_objects WHERE workspace_id = $1 AND import_id = $2 AND object_key = ANY ($3)", [
      workspaceId,
      importId,
      (keys.rows as Array<{ object_key: string }>).map((r) => r.object_key),
    ]);
    total += keys.rowCount ?? 0;
  }
}

/**
 * Sweep due retention work across workspaces: eligible import bytes and
 * expired export bundles. Retain-held, unresolved and non-READY rows are
 * skipped (held), never purged. Failed object deletes are counted and
 * retried on the next sweep, never marked complete. Tombstones are not
 * indexed and cannot be reached here.
 */
export async function sweepRetention(pool: Pool, s3: S3Config | null, limit = 100): Promise<SweepCounts> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("sweep limit out of range");
  const counts: SweepCounts = { purgedUploads: 0, heldUploads: 0, expiredExports: 0, skippedExports: 0, failed: 0 };
  if (!s3) {
    // Without object storage no bytes can be removed: count everything due
    // as failed so the gap stays visible instead of silently passing.
    const dueImports = await pool.query("SELECT count(*)::int AS n FROM import_expiry_index WHERE expires_at <= now()");
    const dueExports = await pool.query("SELECT count(*)::int AS n FROM export_expiry_index WHERE expires_at <= now()");
    counts.failed = (dueImports.rows[0] as { n: number }).n + (dueExports.rows[0] as { n: number }).n;
    return counts;
  }

  const dueImports = await pool.query("SELECT workspace_id, import_id FROM import_expiry_index WHERE expires_at <= now() ORDER BY expires_at LIMIT $1", [limit]);
  for (const row of dueImports.rows as Array<{ workspace_id: string; import_id: string }>) {
    try {
      const purged = await withRetentionSweep(pool, "import_expiry_index", row.workspace_id, row.import_id, async (client) => {
        const imp = await client.query("SELECT status, retain_original, expires_at FROM imports WHERE workspace_id = $1 AND id = $2", [row.workspace_id, row.import_id]);
        if ((imp.rowCount ?? 0) === 0) {
          await client.query("DELETE FROM import_expiry_index WHERE workspace_id = $1 AND import_id = $2", [row.workspace_id, row.import_id]);
          return false;
        }
        const meta = imp.rows[0] as { status: string; retain_original: boolean; expires_at: Date | null };
        // Eligible: terminal validated/rejected bytes past expiry without an
        // explicit hold. Anything else (in-flight, unmarked, retained, or no
        // longer due) holds.
        if (meta.retain_original || (meta.status !== "STAGED" && meta.status !== "REJECTED")) {
          return false;
        }
        if (meta.expires_at === null || new Date(meta.expires_at).getTime() > Date.now()) {
          return false;
        }
        await deleteImportBytes(client, s3, row.workspace_id, row.import_id);
        await client.query("DELETE FROM import_expiry_index WHERE workspace_id = $1 AND import_id = $2", [row.workspace_id, row.import_id]);
        return true;
      });
      if (purged) counts.purgedUploads += 1;
      else counts.heldUploads += 1;
    } catch {
      counts.failed += 1;
    }
  }

  const dueExports = await pool.query("SELECT workspace_id, package_id FROM export_expiry_index WHERE expires_at <= now() ORDER BY expires_at LIMIT $1", [limit]);
  for (const row of dueExports.rows as Array<{ workspace_id: string; package_id: string }>) {
    try {
      const expired = await withRetentionSweep(pool, "export_expiry_index", row.workspace_id, row.package_id, async (client) => {
        const pkg = await client.query("SELECT status, object_key, expires_at FROM export_packages WHERE workspace_id = $1 AND id = $2", [row.workspace_id, row.package_id]);
        if ((pkg.rowCount ?? 0) === 0) {
          await client.query("DELETE FROM export_expiry_index WHERE workspace_id = $1 AND package_id = $2", [row.workspace_id, row.package_id]);
          return false;
        }
        const meta = pkg.rows[0] as { status: string; object_key: string | null; expires_at: Date };
        if (meta.status === "BUILDING") return false;
        if (meta.status !== "READY") {
          // Terminal without index cleanup (failed/cancelled paths clear it
          // themselves; this converges stragglers).
          await client.query("DELETE FROM export_expiry_index WHERE workspace_id = $1 AND package_id = $2", [row.workspace_id, row.package_id]);
          return false;
        }
        // Recheck expiry inside the fence: discovery-to-sweep moves must not
        // purge early.
        if (new Date(meta.expires_at).getTime() > Date.now()) return false;
        if (meta.object_key) await s3DeleteExport(s3, meta.object_key);
        const done = await client.query(
          "UPDATE export_packages SET status = 'EXPIRED', object_key = NULL, data_key = NULL, manifest = NULL, section_counts = NULL, completed_at = coalesce(completed_at, now()) WHERE workspace_id = $1 AND id = $2 AND status = 'READY'",
          [row.workspace_id, row.package_id],
        );
        if ((done.rowCount ?? 0) === 1) {
          await client.query("DELETE FROM export_expiry_index WHERE workspace_id = $1 AND package_id = $2", [row.workspace_id, row.package_id]);
          return true;
        }
        return false;
      });
      if (expired) counts.expiredExports += 1;
      else counts.skippedExports += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

/** Render the catalog as the Settings privacy section (enforced values + gated names, never invented periods). */
export function renderRetentionCatalogHtml(): string {
  const rows = RETENTION_CATALOG.map(
    (entry) =>
      `<tr><td>${escapeCatalogCell(entry.class)}</td><td>${escapeCatalogCell(entry.enforced ? entry.retention : `${entry.retention} — set after hosting selection`)}</td><td>${escapeCatalogCell(entry.mechanism)}</td></tr>`,
  ).join("");
  return `<table><thead><tr><th scope="col">Data</th><th scope="col">Retention</th><th scope="col">How</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeCatalogCell(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
