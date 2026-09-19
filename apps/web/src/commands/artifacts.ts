import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant, type TenantClaims } from "../tenancy.ts";

export type ArtifactManifest = {
    artifactSdkVersion: string;
    runtimeVersion: string;
    sourceSchemaVersion: string;
    stateSchemaVersion: string;
    requestedPermissions: string[];
    approvedPermissions: string[];
    entrypoints: { full: string; compact: string };
    resourceBudget: Record<string, number>;
    sourceHash: string;
    buildHash: string;
    createdByAIRun?: string;
    createdByUser?: string;
};

function sha256Hex(data: string): string {
    const hash = createHash("sha256");
    hash.update(data);
    return hash.digest("hex");
}

function sha256Bytes(data: string): Buffer {
    const hash = createHash("sha256");
    hash.update(data);
    return hash.digest();
}

function hashSource(html: string, css: string, js: string): Buffer {
    const combined = `html:${html}\ncss:${css}\njs:${js}`;
    return sha256Bytes(combined);
}

function hashBuild(manifest: ArtifactManifest, sourceHash: Buffer): Buffer {
    const combined = `${JSON.stringify(manifest)}\n${sourceHash.toString("hex")}`;
    return sha256Bytes(combined);
}

export async function createArtifactDraft(
    client: PoolClient,
    claims: TenantClaims,
    name: string,
    description?: string,
): Promise<{ artifactId: string }> {
    const artifactId = randomUUID();
    await client.query(
        `INSERT INTO artifacts (workspace_id, id, name, description) VALUES ($1, $2, $3, $4)`,
        [claims.workspaceId, artifactId, name, description ?? null],
    );
    return { artifactId };
}

export async function submitArtifactBuild(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    source: { html: string; css: string; js: string },
    manifest: ArtifactManifest,
): Promise<{ versionId: string }> {
    const sourceHash = hashSource(source.html, source.css, source.js);
    const buildHash = hashBuild(manifest, sourceHash);

    const versionId = randomUUID();
    await client.query(
        `INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'building')`,
        [claims.workspaceId, versionId, artifactId, JSON.stringify(manifest), sourceHash, buildHash],
    );

    return { versionId };
}

export async function getArtifactVersion(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    versionId: string,
): Promise<{
    versionId: string;
    artifactId: string;
    manifest: ArtifactManifest;
    sourceHash: string;
    buildHash: string;
    status: string;
    errorClass?: string;
    errorMessage?: string;
    createdAt: string;
    settledAt?: string;
} | null> {
    const result = await client.query(
        `SELECT id, artifact_id, manifest, source_hash, build_hash, status, error_class, error_message, created_at, settled_at
         FROM artifact_versions
         WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3`,
        [claims.workspaceId, artifactId, versionId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
        versionId: row.id,
        artifactId: row.artifact_id,
        manifest: row.manifest,
        sourceHash: Buffer.from(row.source_hash).toString("hex"),
        buildHash: Buffer.from(row.build_hash).toString("hex"),
        status: row.status,
        errorClass: row.error_class ?? undefined,
        errorMessage: row.error_message ?? undefined,
        createdAt: row.created_at,
        settledAt: row.settled_at ?? undefined,
    };
}

export async function listArtifactVersions(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
): Promise<Array<{
    versionId: string;
    status: string;
    createdAt: string;
    settledAt?: string;
}>> {
    const result = await client.query(
        `SELECT id, status, created_at, settled_at
         FROM artifact_versions
         WHERE workspace_id = $1 AND artifact_id = $2
         ORDER BY created_at DESC`,
        [claims.workspaceId, artifactId],
    );
    return result.rows.map((row: { id: string; status: string; created_at: string; settled_at: string | null }) => ({
        versionId: row.id,
        status: row.status,
        createdAt: row.created_at,
        settledAt: row.settled_at ?? undefined,
    }));
}

export async function activateArtifactVersion(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
    versionId: string,
    expectedActiveVersionId?: string,
): Promise<{ activated: boolean; activeVersionId: string }> {
    const artifactResult = await client.query(
        `SELECT active_version_id FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [claims.workspaceId, artifactId],
    );
    if (artifactResult.rowCount === 0) {
        throw new Error("ARTIFACT_NOT_FOUND");
    }
    const currentActive = artifactResult.rows[0].active_version_id;

    if (expectedActiveVersionId && currentActive !== expectedActiveVersionId) {
        throw new Error("VERSION_MISMATCH");
    }

    const versionResult = await client.query(
        `SELECT status FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND id = $3`,
        [claims.workspaceId, artifactId, versionId],
    );
    if (versionResult.rowCount === 0) {
        throw new Error("VERSION_NOT_FOUND");
    }
    if (versionResult.rows[0].status !== "ready") {
        throw new Error("VERSION_NOT_READY");
    }

    await client.query(
        `UPDATE artifacts SET active_version_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
        [claims.workspaceId, artifactId, versionId],
    );

    return { activated: true, activeVersionId: versionId };
}

export async function getArtifact(
    client: PoolClient,
    claims: TenantClaims,
    artifactId: string,
): Promise<{
    artifactId: string;
    name: string;
    description?: string;
    activeVersionId?: string;
    createdAt: string;
    updatedAt: string;
} | null> {
    const result = await client.query(
        `SELECT id, name, description, active_version_id, created_at, updated_at
         FROM artifacts WHERE workspace_id = $1 AND id = $2`,
        [claims.workspaceId, artifactId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
        artifactId: row.id,
        name: row.name,
        description: row.description ?? undefined,
        activeVersionId: row.active_version_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export async function listArtifacts(
    client: PoolClient,
    claims: TenantClaims,
): Promise<Array<{
    artifactId: string;
    name: string;
    description?: string;
    activeVersionId?: string;
    createdAt: string;
    updatedAt: string;
}>> {
    const result = await client.query(
        `SELECT id, name, description, active_version_id, created_at, updated_at
         FROM artifacts WHERE workspace_id = $1 AND archived_at IS NULL
         ORDER BY created_at DESC LIMIT 100`,
        [claims.workspaceId],
    );
    return result.rows.map((row: { id: string; name: string; description: string | null; active_version_id: string | null; created_at: string; updated_at: string }) => ({
        artifactId: row.id,
        name: row.name,
        description: row.description ?? undefined,
        activeVersionId: row.active_version_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}