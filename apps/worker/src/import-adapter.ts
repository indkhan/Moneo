import { and, eq } from "drizzle-orm";
import { decideRowForImport } from "@moneo/finance";
import { createDrizzleMatchStore } from "@moneo/db/import-matching";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import type { Db } from "@moneo/db/client";
import {
  dataSources,
  imports,
  sourceAccounts,
  sourceTransactionObservations,
  sourceTransactions,
} from "@moneo/db/schema";
import type { ObjectStore } from "@moneo/shared/uploads";
import {
  parseImportInput,
  runImportWorkflow,
  type CanonicalizeHook,
  type ImportJobInput,
  type ImportStore,
} from "./import-workflow.js";
import type { HandlerContext, JobHandler } from "./job-lifecycle.js";

export function createDrizzleImportStore(
  objects: ObjectStore,
  input: ImportJobInput,
): ImportStore & { ensureImport(): Promise<void> } {
  const inWorkspace = <T>(fn: (db: Db) => Promise<T>) =>
    withWorkspaceTransaction(input.workspaceId, fn);
  return {
    getObject: (key) => objects.get(key),
    async ensureImport() {
      await inWorkspace(async (db) => {
        await db
          .insert(dataSources)
          .values({
            id: input.dataSourceId,
            workspaceId: input.workspaceId,
            type: input.fileName.toLowerCase().endsWith(".xlsx") ? "xlsx_file" : "csv_file",
            name: input.accountName || input.fileName,
          })
          .onConflictDoNothing();
        await db
          .insert(imports)
          .values({
            id: input.importId,
            workspaceId: input.workspaceId,
            dataSourceId: input.dataSourceId,
            idempotencyKey: input.importId,
            fileName: input.fileName,
            objectStorageKey: input.objectKey,
          })
          .onConflictDoNothing();
      });
    },
    setImportStage: (importId, stage, patch = {}) =>
      inWorkspace(async (db) => {
        await db
          .update(imports)
          .set({
            status: "running",
            startedAt: new Date(),
            metadata: { stage, progressPercent: patch.progressPercent },
            ...(patch.rowCount !== undefined ? { rowCount: patch.rowCount } : {}),
          })
          .where(and(eq(imports.workspaceId, input.workspaceId), eq(imports.id, importId)));
      }),
    failImport: (importId, message) =>
      inWorkspace(async (db) => {
        await db
          .update(imports)
          .set({ status: "failed", metadata: { error: message } })
          .where(and(eq(imports.workspaceId, input.workspaceId), eq(imports.id, importId)));
      }),
    cancelImport: (importId) =>
      inWorkspace(async (db) => {
        await db
          .update(imports)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(and(eq(imports.workspaceId, input.workspaceId), eq(imports.id, importId)));
      }),
    completeImport: (importId, summary) =>
      inWorkspace(async (db) => {
        await db
          .update(imports)
          .set({
            status: "succeeded",
            completedAt: new Date(),
            rowCount: summary.rowCount,
            newCount: summary.newCount,
            duplicateCount: summary.duplicateCount,
            reviewCount: summary.reviewCount,
            errorCount: summary.errorCount,
            metadata: { stage: "IMPORT_SUMMARY", progressPercent: 100 },
          })
          .where(and(eq(imports.workspaceId, input.workspaceId), eq(imports.id, importId)));
      }),
    upsertSourceAccount: (row) =>
      inWorkspace(async (db) => {
        const inserted = await db
          .insert(sourceAccounts)
          .values({
            workspaceId: row.workspaceId,
            dataSourceId: row.dataSourceId,
            stableSourceKey: row.stableKey,
            displayName: row.displayName,
          })
          .onConflictDoNothing()
          .returning({ id: sourceAccounts.id });
        if (inserted[0]) return { id: inserted[0].id, created: true };
        const existing = await db
          .select({ id: sourceAccounts.id })
          .from(sourceAccounts)
          .where(
            and(
              eq(sourceAccounts.dataSourceId, row.dataSourceId),
              eq(sourceAccounts.stableSourceKey, row.stableKey),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new Error("Source account upsert returned no row.");
        return { id: existing[0].id, created: false };
      }),
    upsertSourceTransaction: (row) =>
      inWorkspace(async (db) => {
        const inserted = await db
          .insert(sourceTransactions)
          .values({
            workspaceId: row.workspaceId,
            dataSourceId: row.dataSourceId,
            sourceAccountId: row.sourceAccountId,
            stableSourceKey: row.stableKey,
          })
          .onConflictDoNothing()
          .returning({ id: sourceTransactions.id });
        if (inserted[0]) return { id: inserted[0].id, created: true };
        const existing = await db
          .select({ id: sourceTransactions.id })
          .from(sourceTransactions)
          .where(
            and(
              eq(sourceTransactions.dataSourceId, row.dataSourceId),
              eq(sourceTransactions.stableSourceKey, row.stableKey),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new Error("Source transaction upsert returned no row.");
        return { id: existing[0].id, created: false };
      }),
    recordObservation: (row) =>
      inWorkspace(async (db) => {
        const inserted = await db
          .insert(sourceTransactionObservations)
          .values({
            workspaceId: row.workspaceId,
            sourceTransactionId: row.sourceTransactionId,
            importId: row.importId,
            rowNumber: row.rowNumber,
            rawHash: row.rawHash,
            rawPayload: row.rawPayload,
          })
          .onConflictDoNothing()
          .returning({ id: sourceTransactionObservations.id });
        if (inserted[0])
          await db
            .update(sourceTransactions)
            .set({ latestObservationId: inserted[0].id, lastSeenAt: new Date() })
            .where(eq(sourceTransactions.id, row.sourceTransactionId));
        return { recorded: inserted.length > 0 };
      }),
  };
}

export function createDrizzleCanonicalizeHook(input: ImportJobInput): CanonicalizeHook {
  return {
    canonicalize: (row) =>
      withWorkspaceTransaction(input.workspaceId, (db) =>
        decideRowForImport(createDrizzleMatchStore(db), row),
      ),
  };
}

export function createImportHandlerWithStore(
  storeFor: (input: ImportJobInput) => ImportStore & { ensureImport(): Promise<void> },
  hookFor: (input: ImportJobInput) => CanonicalizeHook | undefined = () => undefined,
): JobHandler {
  return async (payload: Record<string, unknown>, context: HandlerContext) => {
    const input = parseImportInput({ ...payload, workspaceId: context.workspaceId });
    const store = storeFor(input);
    await store.ensureImport();
    try {
      return {
        ...(await runImportWorkflow(store, input, context, { canonicalize: hookFor(input) })),
      };
    } catch (error) {
      await store.failImport(
        input.importId,
        error instanceof Error ? error.message : "Import failed",
      );
      throw error;
    }
  };
}

export function createProductionImportHandler(objects: ObjectStore): JobHandler {
  return createImportHandlerWithStore(
    (input) => createDrizzleImportStore(objects, input),
    createDrizzleCanonicalizeHook,
  );
}
