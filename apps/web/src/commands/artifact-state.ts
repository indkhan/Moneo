import { randomUUID, UUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenant, type TenantClaims } from "../tenancy.ts";

export type ArtifactStatePatch = {
    op: "replace" | "add" | "remove";
    path: string;
    value?: unknown;
};

export type MigrationOperation = {
    type: "rename" | "remove" | "set-default";
    path: string;
    newPath?: string;
    default?: unknown;
};

function validateStateSize(state: unknown): void {
    const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
    if (bytes > 64 * 1024) throw new Error("state_too_large");
}

function validateStateSchema(state: unknown, maxKeys = 100, maxDepth = 8): void {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
        throw new Error("state_must_be_object");
    }
    let keyCount = 0;
    function walk(obj: unknown, depth: number): void {
        if (depth > maxDepth) throw new Error("state_depth_exceeded");
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
            const keys = Object.keys(obj);
            keyCount += keys.length;
            if (keyCount > maxKeys) throw new Error("state_key_limit_exceeded");
            for (const key of keys) walk((obj as Record<string, unknown>)[key], depth + 1);
        } else if (Array.isArray(obj)) {
            for (const item of obj) walk(item, depth + 1);
        }
    }
    walk(state, 0);
}

function applyPatch(state: Record<string, unknown>, patch: ArtifactStatePatch): Record<string, unknown> {
    const result = { ...state };
    const pathParts = patch.path.split(".").filter(Boolean);
    if (pathParts.length === 0) throw new Error("invalid_path");

    let current: Record<string, unknown> = result;
    for (let i = 0; i < pathParts.length - 1; i++) {
        const part = pathParts[i];
        if (!(part in current) || typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) {
            if (patch.op === "add") {
                current[part] = {};
            } else {
                throw new Error("path_not_found");
            }
        }
        current = { ...(current[part] as Record<string, unknown>) };
        result[pathParts[i]] = current;
    }

    const lastPart = pathParts[pathParts.length - 1];
    switch (patch.op) {
        case "replace":
            if (!(lastPart in current)) throw new Error("path_not_found");
            current[lastPart] = patch.value;
            break;
        case "add":
            if (lastPart in current) throw new Error("path_exists");
            current[lastPart] = patch.value;
            break;
        case "remove":
            if (!(lastPart in current)) throw new Error("path_not_found");
            delete current[lastPart];
            break;
        default:
            throw new Error("invalid_op");
    }
    return result;
}

function applyMigration(state: Record<string, unknown>, ops: MigrationOperation[]): Record<string, unknown> {
    let result = { ...state };
    for (const op of ops) {
        if (op.type === "rename") {
            const value = getValueAtPath(result, op.path);
            if (value === undefined) throw new Error("migration_path_not_found");
            result = setValueAtPath(result, op.newPath!, value);
            result = deletePath(result, op.path);
        } else if (op.type === "remove") {
            result = deletePath(result, op.path);
        } else if (op.type === "set-default") {
            if (getValueAtPath(result, op.path) === undefined) {
                result = setValueAtPath(result, op.path, op.default);
            }
        }
    }
    return result;
}

function getValueAtPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".").filter(Boolean);
    let current: unknown = obj;
    for (const part of parts) {
        if (typeof current !== "object" || current === null) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
    const parts = path.split(".").filter(Boolean);
    if (parts.length === 0) return { ...obj, [path]: value } as any;
    const result = { ...obj };
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        current[part] = { ...(current[part] as Record<string, unknown> || {}) };
        current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
    return result;
}

function deletePath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
    const parts = path.split(".").filter(Boolean);
    if (parts.length === 0) return obj;
    const result = { ...obj };
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof current[parts[i]] !== "object" || current[parts[i]] === null) return obj;
        current = { ...(current[parts[i]] as Record<string, unknown>) };
        result[parts[i]] = current;
    }
    delete current[parts[parts.length - 1]];
    return result;
}

type StateRow = {
    state: Record<string, unknown>;
    schema_version: number;
    version_id: string;
    updated_at: string;
};

type SnapshotRow = {
    id: string;
    state: Record<string, unknown>;
    schema_version: number;
    version_id: string;
    created_at: string;
};

export async function getArtifactState(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
): Promise<{ state: Record<string, unknown>; schemaVersion: number; versionId: string; updatedAt: string } | null> {
    const result = await client.query(
        `SELECT state, schema_version, version_id, updated_at FROM artifact_state WHERE workspace_id = $1 AND artifact_id = $2`,
        [claims.workspaceId, artifactId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as StateRow;
    return {
        state: row.state,
        schemaVersion: row.schema_version,
        versionId: row.version_id,
        updatedAt: row.updated_at,
    };
}

export async function patchArtifactState(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    patches: ArtifactStatePatch[],
    expectedVersion: number,
): Promise<{ state: Record<string, unknown>; schemaVersion: number }> {
    // E05 adversarial fix: the first-insert path previously stored a fresh
    // randomUUID() as version_id, which always violates the FK to
    // artifact_versions — and a foreign artifactId surfaced as a 500. Resolve
    // the artifact first (404 when foreign/missing) and anchor new state to
    // the active version (falling back to the latest version when nothing is
    // active yet; 409 when the artifact has no versions at all).
    const owner = await client.query(`SELECT active_version_id FROM artifacts WHERE workspace_id = $1 AND id = $2`, [
        claims.workspaceId,
        artifactId,
    ]);
    if ((owner.rowCount ?? 0) === 0) throw new Error("ARTIFACT_NOT_FOUND");
    let anchorVersionId = (owner.rows[0] as { active_version_id: string | null }).active_version_id;
    if (!anchorVersionId) {
        const latest = await client.query(
            `SELECT id FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY created_at DESC LIMIT 1`,
            [claims.workspaceId, artifactId],
        );
        if ((latest.rowCount ?? 0) === 0) throw new Error("NO_VERSION_STATE");
        anchorVersionId = (latest.rows[0] as { id: string }).id;
    }
    const result = await client.query(
        `SELECT state, schema_version FROM artifact_state WHERE workspace_id = $1 AND artifact_id = $2 FOR UPDATE`,
        [claims.workspaceId, artifactId],
    );
    let state: Record<string, unknown> = {};
    let schemaVersion = 1;
    if ((result.rowCount ?? 0) > 0) {
        const row = result.rows[0] as StateRow;
        if (row.schema_version !== expectedVersion) {
            throw new Error("VERSION_MISMATCH");
        }
        state = { ...row.state };
        schemaVersion = row.schema_version;
    }

    for (const patch of patches) {
        state = applyPatch(state, patch);
    }
    validateStateSize(state);
    validateStateSchema(state);

    // E05 adversarial fix: updates previously rewrote the same schema_version,
    // so concurrent patches never conflicted despite the expected-version
    // contract (S04: two tabs, one winner). Every committed patch bumps.
    if ((result.rowCount ?? 0) > 0) {
        const nextVersion = schemaVersion + 1;
        await client.query(
            `UPDATE artifact_state SET state = $1, schema_version = $2, updated_at = now() WHERE workspace_id = $3 AND artifact_id = $4`,
            [JSON.stringify(state), nextVersion, claims.workspaceId, artifactId],
        );
        return { state, schemaVersion: nextVersion };
    // E05 adversarial fix round 2 (B3): concurrent first-inserts both see
    // rowCount 0 and collide on PK (workspace_id, artifact_id). Converge the
    // loser to a typed version conflict instead of a raw 23505 500.
    } else {
        try {
            await client.query(
                `INSERT INTO artifact_state (workspace_id, artifact_id, version_id, schema_version, state) VALUES ($1, $2, $3, $4, $5)`,
                [claims.workspaceId, artifactId, anchorVersionId, schemaVersion, JSON.stringify(state)],
            );
        } catch (err) {
            if (err instanceof Error && (err as { code?: string }).code === "23505") throw new Error("VERSION_MISMATCH");
            // Anchor deleted between the existence check and the insert
            // (artifact or version dropped concurrently): fail closed as
            // missing rather than escaping as a raw 23503 500.
            if (err instanceof Error && (err as { code?: string }).code === "23503") throw new Error("ARTIFACT_NOT_FOUND");
            throw err;
        }
    }
    return { state, schemaVersion };
}

export async function getArtifactStateSnapshot(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    snapshotId?: string,
): Promise<{ id: string; state: Record<string, unknown>; schemaVersion: number; versionId: string; createdAt: string } | null> {
    let query = `SELECT id, state, schema_version, version_id, created_at FROM artifact_state_snapshots WHERE workspace_id = $1 AND artifact_id = $2`;
    const params: (string | UUID)[] = [claims.workspaceId, artifactId];
    if (snapshotId) {
        query += ` AND id = $3`;
        params.push(snapshotId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1`;
    const result = await client.query(query, params);
    if ((result.rowCount ?? 0) === 0) return null;
    const row = result.rows[0] as SnapshotRow;
    return { id: row.id, state: row.state, schemaVersion: row.schema_version, versionId: row.version_id, createdAt: row.created_at };
}

export async function createStateSnapshot(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    versionId: string,
    schemaVersion: number,
    state: Record<string, unknown>,
): Promise<{ id: string }> {
    // E05 adversarial fix: snapshots bypassed the 64 KiB / keys / depth caps
    // enforced on patch/migrate, so oversized state could enter via
    // snapshot→revert. Validate on the way in.
    validateStateSize(state);
    validateStateSchema(state);
    const id = randomUUID();
    await client.query(
        `INSERT INTO artifact_state_snapshots (workspace_id, id, artifact_id, version_id, schema_version, state) VALUES ($1, $2, $3, $4, $5, $6)`,
        [claims.workspaceId, id, artifactId, versionId, schemaVersion, JSON.stringify(state)],
    );
    return { id };
}

type MigrationRow = {
    id: string;
    from_version_id: string;
    to_version_id: string;
    operations: MigrationOperation[];
    status: string;
    error: string | null;
    created_at: string;
    applied_at: string | null;
};

export async function applyStateMigration(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    fromVersionId: string,
    toVersionId: string,
    operations: MigrationOperation[],
): Promise<{ success: boolean; state?: Record<string, unknown>; error?: string }> {
    const migrationId = randomUUID();
    await client.query(
        `INSERT INTO artifact_state_migrations (workspace_id, id, artifact_id, from_version_id, to_version_id, operations, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [claims.workspaceId, migrationId, artifactId, fromVersionId, toVersionId, JSON.stringify(operations)],
    );

    const stateResult = await client.query(
        `SELECT state, schema_version FROM artifact_state WHERE workspace_id = $1 AND artifact_id = $2 FOR UPDATE`,
        [claims.workspaceId, artifactId],
    );
    if ((stateResult.rowCount ?? 0) === 0) {
        await client.query(`UPDATE artifact_state_migrations SET status = 'failed', error = 'state_not_found', applied_at = now() WHERE workspace_id = $1 AND id = $2`, [claims.workspaceId, migrationId]);
        return { success: false, error: "state_not_found" };
    }

    try {
        let state = { ...(stateResult.rows[0] as StateRow).state };
        state = applyMigration(state, operations);
        validateStateSize(state);
        validateStateSchema(state);

        await client.query(
            `UPDATE artifact_state SET state = $1, version_id = $2, updated_at = now() WHERE workspace_id = $3 AND artifact_id = $4`,
            [JSON.stringify(state), toVersionId, claims.workspaceId, artifactId],
        );

        await client.query(
            `UPDATE artifact_state_migrations SET status = 'applied', applied_at = now() WHERE workspace_id = $1 AND id = $2`,
            [claims.workspaceId, migrationId],
        );

        return { success: true, state };
    } catch (error) {
        await client.query(
            `UPDATE artifact_state_migrations SET status = 'failed', error = $1, applied_at = now() WHERE workspace_id = $2 AND id = $3`,
            [error instanceof Error ? error.message : "migration_failed", claims.workspaceId, migrationId],
        );
        return { success: false, error: error instanceof Error ? error.message : "migration_failed" };
    }
}

export async function revertArtifactState(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    targetSnapshotId: string,
): Promise<{ success: boolean; state?: Record<string, unknown>; error?: string }> {
    const snapshot = await getArtifactStateSnapshot(client, claims, artifactId, targetSnapshotId);
    if (!snapshot) return { success: false, error: "snapshot_not_found" };

    const stateResult = await client.query(
        `SELECT version_id FROM artifact_state WHERE workspace_id = $1 AND artifact_id = $2 FOR UPDATE`,
        [claims.workspaceId, artifactId],
    );
    if ((stateResult.rowCount ?? 0) === 0) return { success: false, error: "state_not_found" };

    // E05 adversarial fix: revert previously restored any snapshot's state
    // while keeping the current version_id, so old code could run against
    // arbitrary newer state (and vice versa). The snapshot must belong to the
    // currently active version — code revert goes through version activation,
    // and the pair stays coherent. The version_id is carried from the
    // snapshot so the row never straddles two versions.
    const owner = await client.query(`SELECT active_version_id FROM artifacts WHERE workspace_id = $1 AND id = $2`, [
        claims.workspaceId,
        artifactId,
    ]);
    if ((owner.rowCount ?? 0) === 0) return { success: false, error: "artifact_not_found" };
    const activeVersionId = (owner.rows[0] as { active_version_id: string | null }).active_version_id;
    if (snapshot.versionId !== activeVersionId) {
        return { success: false, error: "incompatible_snapshot" };
    }

    await client.query(
        `UPDATE artifact_state SET state = $1, schema_version = $2, version_id = $3, updated_at = now() WHERE workspace_id = $4 AND artifact_id = $5`,
        [JSON.stringify(snapshot.state), snapshot.schemaVersion, snapshot.versionId, claims.workspaceId, artifactId],
    );

    return { success: true, state: snapshot.state };
}