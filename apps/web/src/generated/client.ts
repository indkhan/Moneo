/**
 * GENERATED — do not edit by hand.
 * Source: apps/web/openapi/openapi.json (info.version=v1)
 * contractSha: f059a6add0b20c36344e196a596ecf3047b2e9e6f2cbbddcede805fa4a16e8f8
 * Regenerate: pnpm --filter @moneo/web gen:client
 * Every browser DTO comes from here; later API issues extend the contract first.
 */

export type ProblemCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RATE_LIMITED"
  | "JOB_REQUIRED"
  | "UNKNOWN_OUTCOME"
  | "INVARIANT_VIOLATION"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ProblemCode;
  retryable: boolean;
  correlationId: string;
  errors?: { field: string; message: string }[];
  instance?: string;
}

/** Integer minor units as a decimal string — never a JSON number. */
export type MoneyString = string;
/** Optimistic-concurrency version as a decimal string. */
export type VersionString = string;

export interface CommandMetadata {
  idempotencyKey: string;
  expectedVersion?: VersionString;
}

export interface CommandRequest {
  metadata: CommandMetadata;
  input: Record<string, unknown>;
}

export interface CommandResult {
  operationId: string;
  replayed: boolean;
  result: Record<string, unknown>;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobStatus {
  id: string;
  type: string;
  status: JobState;
  progressStage: string | null;
  progressPercent: number | null;
  attempts: number;
  maxAttempts: number;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSubmit {
  type: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}

export interface JobPage {
  items: JobStatus[];
  nextCursor: string | null;
}

export type AccountType =
  | "CHECKING"
  | "SAVINGS"
  | "CASH"
  | "CREDIT"
  | "INVESTMENT"
  | "WALLET"
  | "OTHER";

export interface AccountBalance {
  /** Decimal-string minor units; null means unknown, never zero. */
  currentAmountMinor: string | null;
  availableAmountMinor: string | null;
  currencyCode: string;
  observedAt: string;
  source: string;
}

export interface Account {
  id: string;
  name: string;
  institutionName: string | null;
  accountType: AccountType;
  currencyCode: string;
  isSpendable: boolean;
  includeInNetWorth: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Latest known snapshot; null means the balance is unknown, never zero. */
  balance: AccountBalance | null;
}

export interface AccountList {
  items: Account[];
}

export type TransactionStatus = "PENDING" | "POSTED" | "VOIDED";
export type TransactionDirection = "credit" | "debit";

export interface Transaction {
  id: string;
  accountId: string;
  status: TransactionStatus;
  direction: TransactionDirection;
  /** Non-negative integer minor units as a decimal string — never a JSON number. */
  amountMinor: string;
  currencyCode: string;
  effectiveDate: string;
  description: string;
  note: string | null;
  excludedFromAnalytics: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionPage {
  items: Transaction[];
  nextCursor: string | null;
}

export type TransactionSort = "newest" | "oldest";

export interface TransactionSearchParams {
  cursor?: string;
  limit?: number;
  accountIds?: string;
  dateFrom?: string;
  dateTo?: string;
  directions?: string;
  amountMin?: string;
  amountMax?: string;
  q?: string;
  sort?: TransactionSort;
}

export interface UploadInitiate {
  fileName: string;
  contentLength: number;
}

export interface UploadInitiated {
  importId: string;
  /** Internal quarantine key — never a public URL. */
  objectKey: string;
  mime: string;
  maxBytes: number;
}

export interface UploadComplete {
  importId: string;
  objectKey: string;
  fileName: string;
  expectedSha256?: string;
}

export interface UploadCompleted {
  workspaceId: string;
  importId: string;
  objectKey: string;
  fileName: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface ImportBytesResult {
  importId: string;
  objectKey: string;
  bytes: number;
  sha256: string;
}

export interface ImportPreviewRow {
  rowNumber: number;
  cells: string[];
}

export interface ImportPreviewDuplicate {
  isRepeat: true;
  message: string;
}

export interface ImportPreview {
  importId: string;
  dataSourceId: string;
  duplicate: ImportPreviewDuplicate | null;
  fileName: string;
  kind: "csv" | "xlsx";
  delimiter: string | null;
  headers: string[];
  preview: ImportPreviewRow[];
  totalRows: number;
  parseErrors: { rowNumber: number; message: string }[];
  mapping: Record<string, number | null>;
  confidence: Record<string, string>;
  unmapped: number[];
  suggestedAccount: string;
}

export const CONTRACT_SHA = "f059a6add0b20c36344e196a596ecf3047b2e9e6f2cbbddcede805fa4a16e8f8";

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;
  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }
}

export type FetchFn = typeof fetch;

async function request<T>(fetchFn: FetchFn, baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetchFn(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : null;
  if (!response.ok) {
    if (body && typeof body === "object" && "code" in body && "status" in body) {
      throw new ApiError(body as ProblemDetails);
    }
    throw new ApiError({
      type: "https://moneo.app/problems/internal-error",
      title: "Internal server error",
      status: response.status,
      detail: `Request failed with status ${response.status}`,
      code: "INTERNAL_ERROR",
      retryable: true,
      correlationId: "client",
    });
  }
  return body as T;
}

const query = (params: object): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/** Typed browser client for /api/v1. Pass a custom fetch in tests. */
export function createClient(options: { baseUrl?: string; fetchFn?: FetchFn } = {}) {
  const baseUrl = options.baseUrl ?? "/api/v1";
  const fetchFn = options.fetchFn ?? fetch;
  return {
    getHealth: (): Promise<{ status: string; service: string }> =>
      request(fetchFn, baseUrl, "/health"),
    listJobs: (params: { cursor?: string; limit?: number } = {}): Promise<JobPage> =>
      request(fetchFn, baseUrl, `/jobs${query(params)}`),
    submitJob: (body: JobSubmit): Promise<JobStatus> =>
      request(fetchFn, baseUrl, "/jobs", { method: "POST", body: JSON.stringify(body) }),
    getJob: (id: string): Promise<JobStatus> =>
      request(fetchFn, baseUrl, `/jobs/${encodeURIComponent(id)}`),
    retryJob: (id: string): Promise<JobStatus> =>
      request(fetchFn, baseUrl, `/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
    stopJob: (id: string): Promise<JobStatus> =>
      request(fetchFn, baseUrl, `/jobs/${encodeURIComponent(id)}/stop`, { method: "POST" }),
    executeCommand: (commandName: string, body: CommandRequest): Promise<CommandResult> =>
      request(fetchFn, baseUrl, `/commands/${encodeURIComponent(commandName)}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    initiateUpload: (body: UploadInitiate): Promise<UploadInitiated> =>
      request(fetchFn, baseUrl, "/imports/initiate", { method: "POST", body: JSON.stringify(body) }),
    completeUpload: (body: UploadComplete): Promise<UploadCompleted> =>
      request(fetchFn, baseUrl, "/imports/complete", { method: "POST", body: JSON.stringify(body) }),
    putImportBytes: (importId: string, fileName: string, bytes: Uint8Array): Promise<ImportBytesResult> =>
      request(
        fetchFn,
        baseUrl,
        `/imports/bytes?importId=${encodeURIComponent(importId)}&fileName=${encodeURIComponent(fileName)}`,
        // Uint8Array is a valid fetch body; the cast bridges DOM lib versions.
        { method: "POST", body: bytes as unknown as BodyInit, headers: { "content-type": "application/octet-stream" } },
      ),
    previewImport: (body: { importId: string; fileName: string; previewRows?: number }): Promise<ImportPreview> =>
      request(fetchFn, baseUrl, "/imports/preview", { method: "POST", body: JSON.stringify(body) }),
    listAccounts: (params: { includeArchived?: boolean } = {}): Promise<AccountList> =>
      request(fetchFn, baseUrl, `/accounts${query(params)}`),
    getAccount: (id: string): Promise<Account> =>
      request(fetchFn, baseUrl, `/accounts/${encodeURIComponent(id)}`),
    searchTransactions: (params: TransactionSearchParams = {}): Promise<TransactionPage> =>
      request(fetchFn, baseUrl, `/transactions/search${query(params)}`),
  };
}

export type MoneoClient = ReturnType<typeof createClient>;
