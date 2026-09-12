import { createHash } from "node:crypto";
import {
  parseCsvBytes,
  parseXlsxBytes,
  previewMappedRows,
  validateMapping,
  type ColumnMapping,
} from "@moneo/finance";
import { DomainError } from "@moneo/shared/problem";
import { JobCancelledError, type HandlerContext, type JobHandler } from "./job-lifecycle.js";
import { transientError } from "./retry.js";

/**
 * Issue 3.6 — durable statement import workflow.
 *
 * One BullMQ delivery of an `import.process` job runs these stages in order:
 *
 *   FILE_VALIDATION → PARSE → SOURCE_ACCOUNT_DETECTION →
 *   SOURCE_TRANSACTION_UPSERT → IMPORT_SUMMARY
 *
 * Durability comes from the Epoch 2 lifecycle (`runDurableJob` owns attempts,
 * heartbeats, cancellation, and retry budgets); this file owns the stage
 * order and the idempotency that makes redelivery safe:
 *
 * - one source account per import, upserted by `(dataSourceId, label key)`;
 * - one source transaction per `(importId, rowNumber)`, upserted by a stable
 *   `row:` key, so a retried batch updates instead of duplicating;
 * - one observation per `(importId, rowNumber)` — the Issue 3.1 unique —
 *   recorded once and skipped on replay.
 *
 * Rows are processed in caller-sized batches: cancellation and heartbeats
 * happen between batches, progress is reported per batch, and mapping runs
 * per batch too (so a 50k-row file never materializes 50k typed rows at
 * once). Row-level failures (parser shape errors, mapping data errors)
 * accumulate into `errorCount`; only structural file failures, bad mappings,
 * and cancellation abort the import.
 *
 * Error classes (handled by the Issue 2.7 decider, no new retry code):
 * missing bytes → TRANSIENT (the upload may still be landing); structural
 * parse/mapping problems → DomainError → PERMANENT_INPUT (fail fast, never
 * spin); cancellation → JobCancelledError → PERMANENT_POLICY.
 */

export const IMPORT_JOB_TYPE = "import.process";

export type ImportStage =
  | "FILE_VALIDATION"
  | "PARSE"
  | "SOURCE_ACCOUNT_DETECTION"
  | "SOURCE_TRANSACTION_UPSERT"
  | "IMPORT_SUMMARY";

export const IMPORT_STAGES: readonly ImportStage[] = [
  "FILE_VALIDATION",
  "PARSE",
  "SOURCE_ACCOUNT_DETECTION",
  "SOURCE_TRANSACTION_UPSERT",
  "IMPORT_SUMMARY",
];

export interface ImportJobInput {
  importId: string;
  workspaceId: string;
  dataSourceId: string;
  objectKey: string;
  fileName: string;
  mapping: ColumnMapping;
  defaultCurrency?: string;
  /** Wizard-chosen account label; defaults to the file stem. */
  accountName?: string;
  batchSize?: number;
}

export interface ImportSummary {
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  reviewCount: number;
  errorCount: number;
  sourceAccountId: string;
}

export interface ImportStore {
  getObject(key: string): Promise<Uint8Array | null>;
  setImportStage(
    importId: string,
    stage: ImportStage,
    patch?: { progressPercent?: number; rowCount?: number },
  ): Promise<void>;
  failImport(importId: string, message: string): Promise<void>;
  cancelImport(importId: string): Promise<void>;
  completeImport(importId: string, summary: ImportSummary): Promise<void>;
  upsertSourceAccount(input: {
    workspaceId: string;
    dataSourceId: string;
    stableKey: string;
    displayName: string;
  }): Promise<{ id: string; created: boolean }>;
  upsertSourceTransaction(input: {
    workspaceId: string;
    dataSourceId: string;
    sourceAccountId: string;
    stableKey: string;
  }): Promise<{ id: string; created: boolean }>;
  recordObservation(input: {
    workspaceId: string;
    sourceTransactionId: string;
    importId: string;
    rowNumber: number;
    rawHash: string;
    rawPayload: Record<string, unknown>;
  }): Promise<{ recorded: boolean }>;
}

/** In-memory store: same upsert/once semantics the Drizzle store will keep. */
export function createMemoryImportStore(
  options: { objects?: Record<string, Uint8Array> } = {},
): ImportStore & {
  stages(importId: string): ImportStage[];
  status(importId: string): string;
  summary(importId: string): ImportSummary | undefined;
  transactions(): { id: string; stableKey: string }[];
  observations(): { importId: string; rowNumber: number }[];
  failAtStage?: ImportStage | null;
} {
  const objects = new Map<string, Uint8Array>(Object.entries(options.objects ?? {}));
  const stageLog = new Map<string, ImportStage[]>();
  const statuses = new Map<string, string>();
  const summaries = new Map<string, ImportSummary>();
  const accounts = new Map<string, { id: string }>();
  const transactions = new Map<string, { id: string }>();
  const observations = new Set<string>();
  let ids = 0;
  const nextId = (prefix: string): string => `${prefix}-${(ids += 1)}`;

  const store: ImportStore & {
    stages(importId: string): ImportStage[];
    status(importId: string): string;
    summary(importId: string): ImportSummary | undefined;
    transactions(): { id: string; stableKey: string }[];
    observations(): { importId: string; rowNumber: number }[];
    failAtStage?: ImportStage | null;
  } = {
    failAtStage: null,
    stages: (importId) => stageLog.get(importId) ?? [],
    status: (importId) => statuses.get(importId) ?? "pending",
    summary: (importId) => summaries.get(importId),
    transactions: () =>
      [...transactions.entries()].map(([stableKey, t]) => ({ id: t.id, stableKey })),
    observations: () =>
      [...observations].map((key) => {
        const [importId, row] = key.split(":");
        return { importId: importId as string, rowNumber: Number(row) };
      }),
    getObject: (key) => Promise.resolve(objects.get(key) ?? null),
    setImportStage: (importId, stage) => {
      if (store.failAtStage === stage) {
        return Promise.reject(transientError(`simulated crash at ${stage}`));
      }
      stageLog.set(importId, [...(stageLog.get(importId) ?? []), stage]);
      if (statuses.get(importId) === undefined) {
        statuses.set(importId, "running");
      }
      return Promise.resolve();
    },
    failImport: (importId, _message) => {
      statuses.set(importId, "failed");
      return Promise.resolve();
    },
    cancelImport: (importId) => {
      statuses.set(importId, "cancelled");
      return Promise.resolve();
    },
    completeImport: (importId, summary) => {
      statuses.set(importId, "succeeded");
      summaries.set(importId, summary);
      return Promise.resolve();
    },
    upsertSourceAccount: ({ dataSourceId, stableKey, displayName: _displayName }) => {
      const key = `${dataSourceId}:${stableKey}`;
      const existing = accounts.get(key);
      if (existing) {
        return Promise.resolve({ id: existing.id, created: false });
      }
      const id = nextId("acct");
      accounts.set(key, { id });
      return Promise.resolve({ id, created: true });
    },
    upsertSourceTransaction: ({ dataSourceId, stableKey }) => {
      const key = `${dataSourceId}:${stableKey}`;
      const existing = transactions.get(key);
      if (existing) {
        return Promise.resolve({ id: existing.id, created: false });
      }
      const id = nextId("txn");
      transactions.set(key, { id });
      return Promise.resolve({ id, created: true });
    },
    recordObservation: ({ importId, rowNumber }) => {
      const key = `${importId}:${rowNumber}`;
      if (observations.has(key)) {
        return Promise.resolve({ recorded: false });
      }
      observations.add(key);
      return Promise.resolve({ recorded: true });
    },
  };
  return store;
}

function invalid(message: string): DomainError {
  return new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "payload", message }],
  });
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`Import payload field "${field}" must be a non-empty string.`);
  }
  return value;
}

function asMapping(value: unknown): ColumnMapping {
  if (typeof value !== "object" || value === null) {
    throw invalid('Import payload field "mapping" must be an object.');
  }
  const mapping = value as Record<string, unknown>;
  for (const field of [
    "date",
    "description",
    "amount",
    "credit",
    "debit",
    "currency",
    "direction",
    "account",
  ] as const) {
    const col = mapping[field];
    if (col !== null && col !== undefined && (!Number.isInteger(col) || (col as number) < 0)) {
      throw invalid(`Import mapping field "${field}" must be a column index or null.`);
    }
  }
  return {
    date: (mapping["date"] as number | null) ?? null,
    description: (mapping["description"] as number | null) ?? null,
    amount: (mapping["amount"] as number | null) ?? null,
    credit: (mapping["credit"] as number | null) ?? null,
    debit: (mapping["debit"] as number | null) ?? null,
    currency: (mapping["currency"] as number | null) ?? null,
    direction: (mapping["direction"] as number | null) ?? null,
    account: (mapping["account"] as number | null) ?? null,
  };
}

/** Validate the untyped job payload without adding a zod dependency to the worker. */
export function parseImportInput(payload: Record<string, unknown>): ImportJobInput {
  const batchSize = payload["batchSize"];
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || (batchSize as number) <= 0)) {
    throw invalid('Import payload field "batchSize" must be a positive integer.');
  }
  const defaultCurrency = payload["defaultCurrency"];
  if (defaultCurrency !== undefined && typeof defaultCurrency !== "string") {
    throw invalid('Import payload field "defaultCurrency" must be a string.');
  }
  const accountName = payload["accountName"];
  if (accountName !== undefined && typeof accountName !== "string") {
    throw invalid('Import payload field "accountName" must be a string.');
  }
  return {
    importId: asNonEmptyString(payload["importId"], "importId"),
    workspaceId: asNonEmptyString(payload["workspaceId"], "workspaceId"),
    dataSourceId: asNonEmptyString(payload["dataSourceId"], "dataSourceId"),
    objectKey: asNonEmptyString(payload["objectKey"], "objectKey"),
    fileName: asNonEmptyString(payload["fileName"], "fileName"),
    mapping: asMapping(payload["mapping"]),
    ...(defaultCurrency !== undefined ? { defaultCurrency } : {}),
    ...(accountName !== undefined ? { accountName } : {}),
    ...(batchSize !== undefined ? { batchSize: batchSize as number } : {}),
  };
}

export function rawHashFor(rowNumber: number, cells: string[]): string {
  return createHash("sha256").update(JSON.stringify({ rowNumber, cells }), "utf8").digest("hex");
}

function accountLabelFor(fileName: string, accountName?: string): { label: string; key: string } {
  const label =
    accountName?.trim() ||
    fileName
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]*$/, "")
      .trim() ||
    "Imported account";
  const key = `label:${
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "account"
  }`;
  return { label, key };
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export interface WorkflowContext {
  heartbeat(): Promise<void>;
  isCancelled(): Promise<boolean>;
}

/**
 * Run every stage for one import. Throws JobCancelledError on cancellation
 * (the lifecycle records it as cancelled) and DomainError/ClassifiedError
 * otherwise (the Issue 2.7 decider routes them to retry or fail).
 */
export async function runImportWorkflow(
  store: ImportStore,
  input: ImportJobInput,
  ctx: WorkflowContext,
): Promise<ImportSummary> {
  const batchSize = input.batchSize ?? 500;
  const fail = async (message: string): Promise<never> => {
    await store.failImport(input.importId, message);
    throw invalid(message);
  };

  // — FILE_VALIDATION ————————————————————————————————————————————
  await store.setImportStage(input.importId, "FILE_VALIDATION");
  if (await ctx.isCancelled()) {
    await store.cancelImport(input.importId);
    throw new JobCancelledError();
  }
  const bytes = await store.getObject(input.objectKey);
  if (!bytes) {
    // The bytes may still be landing: TRANSIENT so the job retries bounded.
    await store.setImportStage(input.importId, "FILE_VALIDATION");
    throw transientError(`Quarantined object "${input.objectKey}" is not available yet.`);
  }
  const extension = extensionOf(input.fileName);
  if (extension !== "csv" && extension !== "xlsx") {
    await fail(`File "${input.fileName}" must be a .csv or .xlsx statement.`);
  }

  // — PARSE ——————————————————————————————————————————————————————
  await store.setImportStage(input.importId, "PARSE");
  let parsed: {
    headers: string[];
    rows: { rowNumber: number; cells: string[] }[];
    errors: { rowNumber: number; message: string }[];
  };
  try {
    parsed = extension === "csv" ? parseCsvBytes(bytes) : await parseXlsxBytes(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parse failed.";
    await store.failImport(input.importId, message);
    throw error;
  }
  try {
    validateMapping(parsed.headers, input.mapping);
  } catch (error) {
    await store.failImport(input.importId, (error as Error).message);
    throw error;
  }
  await store.setImportStage(input.importId, "PARSE", { rowCount: parsed.rows.length });

  // — SOURCE_ACCOUNT_DETECTION ———————————————————————————————————
  await store.setImportStage(input.importId, "SOURCE_ACCOUNT_DETECTION");
  const { label, key } = accountLabelFor(input.fileName, input.accountName);
  const account = await store.upsertSourceAccount({
    workspaceId: input.workspaceId,
    dataSourceId: input.dataSourceId,
    stableKey: key,
    displayName: label,
  });

  // — SOURCE_TRANSACTION_UPSERT (batched) —————————————————————————
  await store.setImportStage(input.importId, "SOURCE_TRANSACTION_UPSERT");
  let newCount = 0;
  let duplicateCount = 0;
  let errorCount = parsed.errors.length;
  const totalBatches = Math.max(1, Math.ceil(parsed.rows.length / batchSize));
  for (let batch = 0; batch < totalBatches; batch += 1) {
    if (await ctx.isCancelled()) {
      await store.cancelImport(input.importId);
      throw new JobCancelledError();
    }
    await ctx.heartbeat();
    const slice = parsed.rows.slice(batch * batchSize, batch * batchSize + batchSize);
    const mapped = previewMappedRows({
      headers: parsed.headers,
      rows: slice,
      mapping: input.mapping,
      ...(input.defaultCurrency !== undefined ? { defaultCurrency: input.defaultCurrency } : {}),
      previewRows: slice.length,
    });
    errorCount += mapped.errors.length;
    for (const item of mapped.preview) {
      const stableKey = `row:${input.importId}:${item.rowNumber}`;
      const txn = await store.upsertSourceTransaction({
        workspaceId: input.workspaceId,
        dataSourceId: input.dataSourceId,
        sourceAccountId: account.id,
        stableKey,
      });
      if (txn.created) {
        newCount += 1;
      } else {
        duplicateCount += 1;
      }
      await store.recordObservation({
        workspaceId: input.workspaceId,
        sourceTransactionId: txn.id,
        importId: input.importId,
        rowNumber: item.rowNumber,
        rawHash: rawHashFor(
          item.rowNumber,
          slice.find((r) => r.rowNumber === item.rowNumber)?.cells ?? [],
        ),
        rawPayload: { cells: slice.find((r) => r.rowNumber === item.rowNumber)?.cells ?? [] },
      });
    }
    await store.setImportStage(input.importId, "SOURCE_TRANSACTION_UPSERT", {
      progressPercent: Math.floor(((batch + 1) / totalBatches) * 100),
    });
  }

  // — IMPORT_SUMMARY —————————————————————————————————————————————
  await store.setImportStage(input.importId, "IMPORT_SUMMARY");
  if (await ctx.isCancelled()) {
    await store.cancelImport(input.importId);
    throw new JobCancelledError();
  }
  const summary: ImportSummary = {
    rowCount: parsed.rows.length + parsed.errors.length,
    newCount,
    duplicateCount,
    reviewCount: 0,
    errorCount,
    sourceAccountId: account.id,
  };
  await store.completeImport(input.importId, summary);
  return summary;
}

/** Adapter from untyped BullMQ payloads to the typed workflow. */
export function createImportHandler(store: ImportStore): JobHandler {
  return async (payload: Record<string, unknown>, ctx: HandlerContext) => {
    const input = parseImportInput(payload);
    const summary = await runImportWorkflow(store, input, ctx);
    // Spread into a fresh record: the durable lifecycle stores job results
    // as JSON, and the spread type carries the known summary fields with it.
    return { ...summary };
  };
}

/** Handler map entry for `runDurableJob` (Issue 2.6 lifecycle). */
export function createImportHandlers(store: ImportStore): Map<string, JobHandler> {
  return new Map([[IMPORT_JOB_TYPE, createImportHandler(store)]]);
}
