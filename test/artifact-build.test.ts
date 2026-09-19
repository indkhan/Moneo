import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { createArtifactDraft, submitArtifactBuild, getArtifactVersion, listArtifactVersions, activateArtifactVersion, getArtifact, listArtifacts } from "../apps/web/src/commands/artifacts.ts";
import { withTenant } from "../apps/web/src/tenancy.ts";
import { ensureTestPool, ensureTestMigrationPool } from "./helpers/test-db.ts";

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const TEST_USER_ID = "00000000-0000-0000-0000-000000000002";

let pool: Pool;
let migrationPool: Pool;

beforeAll(async () => {
    pool = await ensureTestPool("test:artifact-build", "moneo_e05_artifact_build", [
        "artifact_build_attempts",
        "artifact_versions",
        "artifacts",
    ]);
    // Create test workspace using migration pool (superuser, bypasses RLS)
    migrationPool = await ensureTestMigrationPool("test:artifact-build", "moneo_e05_artifact_build");
    await migrationPool.query(
        `INSERT INTO users (id, auth_subject) VALUES ($1, 'test-user') ON CONFLICT DO NOTHING`,
        [TEST_USER_ID],
    );
    await migrationPool.query(
        `INSERT INTO workspaces (id, name, base_currency_code, timezone) VALUES ($1, 'Test Workspace', 'EUR', 'UTC') ON CONFLICT DO NOTHING`,
        [TEST_WORKSPACE_ID],
    );
    await migrationPool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
        [TEST_WORKSPACE_ID, TEST_USER_ID],
    );
});

afterAll(async () => {
    await pool.end();
    await migrationPool.end();
});

beforeEach(async () => {
    // Use migration pool for cleanup (bypasses RLS)
    await migrationPool.query("DELETE FROM artifact_build_attempts");
    await migrationPool.query("DELETE FROM artifact_versions");
    await migrationPool.query("DELETE FROM artifacts");
});

const sampleSource = {
    html: `<section><h1>Test Chart</h1><div data-slot="chart"></div></section>`,
    css: `section{font:16px system-ui;padding:1rem}`,
    js: `artifact.ui.render({ type: "chart", rows: [] });`,
};

const sampleManifest = {
    artifactSdkVersion: "1",
    runtimeVersion: "1",
    sourceSchemaVersion: "1",
    stateSchemaVersion: "1",
    requestedPermissions: ["analytics.spending_by_category"],
    approvedPermissions: ["analytics.spending_by_category"],
    entrypoints: { full: "main", compact: "compact" },
    resourceBudget: { maxMessagesPerSecond: 100, maxMessageBytes: 1048576 },
    sourceHash: "dummysourcehash",
    buildHash: "dummybuildhash",
};

describe("artifact build commands", () => {
    it("creates an artifact draft", async () => {
        const result = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });
        expect(result.artifactId).toBeDefined();
        expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("submits a build for an artifact draft", async () => {
        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const build = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        expect(build.versionId).toBeDefined();
        expect(build.versionId).toMatch(/^[0-9a-f-]{36}$/);

        const version = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return getArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build.versionId);
        });
        expect(version).not.toBeNull();
        expect(version!.status).toBe("building");
        expect(version!.manifest).toEqual(sampleManifest);
    });

    it("lists artifact versions", async () => {
        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });
        await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        const versions = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return listArtifactVersions(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId);
        });
        expect(versions.length).toBe(2);
        expect(versions[0].status).toBe("building");
        expect(versions[1].status).toBe("building");
    });

    it("activates a ready version", async () => {
        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const build = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        // Manually set version to ready for activation test using migration pool
        await migrationPool.query(
            `UPDATE artifact_versions SET status = 'ready', settled_at = now() WHERE workspace_id = $1 AND id = $2`,
            [TEST_WORKSPACE_ID, build.versionId],
        );

        const result = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return activateArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build.versionId);
        });
        expect(result.activated).toBe(true);
        expect(result.activeVersionId).toBe(build.versionId);

        const artifact = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return getArtifact(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId);
        });
        expect(artifact!.activeVersionId).toBe(build.versionId);
    });

    it("rejects activation of non-ready version", async () => {
        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const build = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        await expect(
            withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
                return activateArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build.versionId);
            }),
        ).rejects.toThrow("VERSION_NOT_READY");
    });

    it("rejects activation with stale expected active version", async () => {
        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const build1 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });
        await migrationPool.query(
            `UPDATE artifact_versions SET status = 'ready', settled_at = now() WHERE workspace_id = $1 AND id = $2`,
            [TEST_WORKSPACE_ID, build1.versionId],
        );
        await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return activateArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build1.versionId);
        });

        const build2 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });
        const build3 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });
        await migrationPool.query(
            `UPDATE artifact_versions SET status = 'ready', settled_at = now() WHERE workspace_id = $1 AND id = $2`,
            [TEST_WORKSPACE_ID, build2.versionId],
        );
        await migrationPool.query(
            `UPDATE artifact_versions SET status = 'ready', settled_at = now() WHERE workspace_id = $1 AND id = $2`,
            [TEST_WORKSPACE_ID, build3.versionId],
        );
        // Activate build2 first
        await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return activateArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build2.versionId);
        });

        // Now try to activate build3 with stale expected version (build1, but active is now build2)
        await expect(
            withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
                return activateArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build3.versionId, build1.versionId);
            }),
        ).rejects.toThrow("VERSION_MISMATCH");
    });

    it("lists artifacts", async () => {
        await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Artifact 1", "First");
        });
        await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Artifact 2", "Second");
        });

        const artifacts = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return listArtifacts(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID });
        });
        expect(artifacts.length).toBe(2);
        expect(artifacts[0].name).toBe("Artifact 2"); // newest first
        expect(artifacts[1].name).toBe("Artifact 1");
    });

    it("returns null for foreign artifact access", async () => {
        const foreignWorkspaceId = "00000000-0000-0000-0000-000000000003";
        const foreignUserId = "00000000-0000-0000-0000-000000000004";
        // Create foreign workspace using migration pool
        await migrationPool.query(
            `INSERT INTO users (id, auth_subject) VALUES ($1, 'test-user-foreign') ON CONFLICT DO NOTHING`,
            [foreignUserId],
        );
        await migrationPool.query(
            `INSERT INTO workspaces (id, name, base_currency_code, timezone) VALUES ($1, 'Foreign Workspace', 'EUR', 'UTC') ON CONFLICT DO NOTHING`,
            [foreignWorkspaceId],
        );
        await migrationPool.query(
            `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
            [foreignWorkspaceId, foreignUserId],
        );

        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const artifact = await withTenant(pool, { workspaceId: foreignWorkspaceId, userId: foreignUserId }, async (client) => {
            return getArtifact(client, { workspaceId: foreignWorkspaceId, userId: foreignUserId }, draft.artifactId);
        });
        expect(artifact).toBeNull();
    });

    it("returns null for foreign version access", async () => {
        const foreignWorkspaceId = "00000000-0000-0000-0000-000000000003";
        const foreignUserId = "00000000-0000-0000-0000-000000000004";
        // Create foreign workspace using migration pool
        await migrationPool.query(
            `INSERT INTO users (id, auth_subject) VALUES ($1, 'test-user-foreign') ON CONFLICT DO NOTHING`,
            [foreignUserId],
        );
        await migrationPool.query(
            `INSERT INTO workspaces (id, name, base_currency_code, timezone) VALUES ($1, 'Foreign Workspace', 'EUR', 'UTC') ON CONFLICT DO NOTHING`,
            [foreignWorkspaceId],
        );
        await migrationPool.query(
            `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
            [foreignWorkspaceId, foreignUserId],
        );

        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const build = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        const version = await withTenant(pool, { workspaceId: foreignWorkspaceId, userId: foreignUserId }, async (client) => {
            return getArtifactVersion(client, { workspaceId: foreignWorkspaceId, userId: foreignUserId }, draft.artifactId, build.versionId);
        });
        expect(version).toBeNull();
    });

    it("produces identical source/build hashes for same input", async () => {
        const draft = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return createArtifactDraft(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, "Test Artifact", "A test artifact");
        });

        const build1 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        const build2 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return submitArtifactBuild(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, sampleSource, sampleManifest);
        });

        const version1 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return getArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build1.versionId);
        });
        const version2 = await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, async (client) => {
            return getArtifactVersion(client, { workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID }, draft.artifactId, build2.versionId);
        });

        expect(version1!.sourceHash).toBe(version2!.sourceHash);
        expect(version1!.buildHash).toBe(version2!.buildHash);
    });
});