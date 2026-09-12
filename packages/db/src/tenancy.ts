import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { getPool, type Db } from "./client.js";
import * as schema from "./schema.js";
import { assertUuid } from "./uuid.js";

/**
 * Epoch 1 tenancy contract (Issue 1.2).
 *
 * - The runtime pool connects as the `moneo_app` role (NOBYPASSRLS, see
 *   migration `0002_workspace_rls`). The migration/owner role from
 *   `DATABASE_MIGRATION_URL` is reserved for `pnpm db:migrate` and ops.
 * - Every tenant-domain query MUST run inside `withWorkspaceTransaction`,
 *   which opens a transaction and sets transaction-local
 *   `app.current_workspace`. `SET LOCAL` keeps the context scoped to the
 *   transaction, so a pooled connection can never leak one workspace's
 *   context into the next checkout.
 * - PostgreSQL `SET` accepts no bind parameters, so the id is strictly
 *   validated by `assertUuid` before interpolation. Anything that is not a
 *   canonical UUID throws before a connection is even checked out.
 */
export const TENANT_SETTING = "app.current_workspace";

/** Minimal query surface `withWorkspaceTransaction` needs from a connection. */
export interface TenantConnection {
  query(text: string, params?: unknown[]): Promise<unknown>;
  release(): void;
}

export interface WorkspaceTransactionDeps<Tx> {
  /** Defaults to a pooled `pg` client. Tests inject a PGlite-backed fake. */
  checkout?: () => Promise<TenantConnection>;
  /** Defaults to a drizzle client over the `pg` connection. */
  wrap?: (conn: TenantConnection) => Tx;
}

async function defaultCheckout(): Promise<TenantConnection> {
  const client: PoolClient = await getPool().connect();
  return {
    query: (text: string, params?: unknown[]) => client.query(text, params as never[] | undefined),
    release: () => {
      client.release();
    },
  };
}

function defaultWrap(conn: TenantConnection): Db {
  return drizzle(conn as unknown as PoolClient, { schema });
}

/**
 * Run `fn` in a transaction pinned to one workspace. Commits on success,
 * rolls back and rethrows on failure, and always releases the connection.
 */
export async function withWorkspaceTransaction<T, Tx = Db>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
  deps: WorkspaceTransactionDeps<Tx> = {},
): Promise<T> {
  const id = assertUuid(workspaceId, "workspaceId");
  const conn = await (deps.checkout ?? defaultCheckout)();
  const wrap = (deps.wrap ?? defaultWrap) as (conn: TenantConnection) => Tx;
  try {
    await conn.query("BEGIN");
    // No placeholders allowed in SET: `id` was regex-validated above, so
    // interpolation cannot smuggle in extra statements.
    await conn.query(`SET LOCAL ${TENANT_SETTING} = '${id}'`);
    const result = await fn(wrap(conn));
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await conn.query("ROLLBACK");
    } catch {
      // The connection is already broken; release it and surface the real error.
    }
    throw error;
  } finally {
    conn.release();
  }
}
