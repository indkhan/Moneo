import type { JobStatus } from "../generated/client";

/**
 * Issue 3.7 — financial statement import wizard state.
 *
 * Six steps: upload → preview → mapping → account → processing → summary.
 * Import execution itself is a durable `import.process` job (Issue 3.6), so
 * the browser may close mid-processing: the resumable slice
 * (`{ importId, jobId, fileName, step }`) persists to localStorage, and
 * reopening jumps straight back to processing/summary by polling the stored
 * job id. Everything here is pure and unit-tested; the thin client host
 * (`ImportWizardHost`) only wires fetch + storage to these transitions.
 */

export type ImportWizardStep =
  "upload" | "preview" | "mapping" | "account" | "processing" | "summary";

export const WIZARD_STEPS: readonly ImportWizardStep[] = [
  "upload",
  "preview",
  "mapping",
  "account",
  "processing",
  "summary",
];

export const WIZARD_STEP_LABELS: Record<ImportWizardStep, string> = {
  upload: "Upload",
  preview: "Preview",
  mapping: "Mapping",
  account: "Account",
  processing: "Processing",
  summary: "Summary",
};

export interface WizardFile {
  importId: string;
  fileName: string;
  objectKey: string;
  bytes: number;
  sha256: string;
}

export interface WizardPreviewRow {
  rowNumber: number;
  cells: string[];
}

export interface WizardPreview {
  headers: string[];
  preview: WizardPreviewRow[];
  totalRows: number;
  parseErrors: { rowNumber: number; message: string }[];
  suggestedAccount: string;
  /** Provisional statement source id from the preview response (submit payload). */
  dataSourceId: string;
}

export type WizardMapping = Record<
  "date" | "description" | "amount" | "credit" | "debit" | "currency" | "direction" | "account",
  number | null
>;

export interface WizardJob {
  jobId: string;
  status: JobStatus["status"];
  progressStage: string | null;
  progressPercent: number | null;
  errorMessage: string | null;
}

export interface ImportWizardState {
  step: ImportWizardStep;
  file: WizardFile | null;
  preview: WizardPreview | null;
  mapping: WizardMapping | null;
  accountName: string;
  job: WizardJob | null;
  error: string | null;
}

export function initialWizardState(): ImportWizardState {
  return {
    step: "upload",
    file: null,
    preview: null,
    mapping: null,
    accountName: "",
    job: null,
    error: null,
  };
}

/** Step order for the stepper (upload = 0 … summary = 5). */
export function wizardStepIndex(step: ImportWizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/**
 * Whether the wizard may advance from its current step. Upload needs the
 * completed file, preview needs parsed headers, mapping needs a structurally
 * valid mapping (date + amount shape, chosen columns in range, no clashes),
 * account needs a non-blank label; processing/summary never advance by hand
 * (the job poll moves them).
 */
export function canProceed(state: ImportWizardState): boolean {
  switch (state.step) {
    case "upload":
      return state.file !== null;
    case "preview":
      return state.preview !== null && state.preview.headers.length > 0;
    case "mapping":
      return isMappingComplete(state.preview?.headers ?? [], state.mapping);
    case "account":
      return state.accountName.trim().length > 0;
    case "processing":
    case "summary":
      return false;
  }
}

export function isMappingComplete(headers: string[], mapping: WizardMapping | null): boolean {
  if (mapping === null) {
    return false;
  }
  const cols = Object.values(mapping).filter((c): c is number => c !== null);
  if (cols.some((c) => !Number.isInteger(c) || c < 0 || c >= headers.length)) {
    return false;
  }
  if (new Set(cols).size !== cols.length) {
    return false;
  }
  const hasAmount = mapping.amount !== null;
  const hasSplit = mapping.credit !== null || mapping.debit !== null;
  if (hasAmount && hasSplit) {
    return false;
  }
  if (mapping.date === null) {
    return false;
  }
  if (!hasAmount && (mapping.credit === null || mapping.debit === null)) {
    return false;
  }
  return hasAmount || hasSplit;
}

/** Upload finished (initiate → bytes → complete): enter preview with the file bound. */
export function applyUploadComplete(state: ImportWizardState, file: WizardFile): ImportWizardState {
  return { ...state, step: "preview", file, preview: null, mapping: null, error: null };
}

/** Preview parsed server-side: show headers, rows, and shape errors first. */
export function applyPreview(
  state: ImportWizardState,
  preview: WizardPreview,
  detectedMapping: WizardMapping,
): ImportWizardState {
  return {
    ...state,
    step: "preview",
    preview,
    mapping: { ...detectedMapping },
    accountName: preview.suggestedAccount,
    error: null,
  };
}

/** Preview confirmed: move to column mapping (seeded from auto-detection). */
export function confirmPreview(state: ImportWizardState): ImportWizardState {
  if (state.step !== "preview" || !state.preview) {
    return state;
  }
  return { ...state, step: "mapping", error: null };
}

/** Mapping confirmed: move to the account step when the shape validates. */
export function confirmMapping(state: ImportWizardState): ImportWizardState {
  if (state.step !== "mapping" || !canProceed(state)) {
    return state;
  }
  return { ...state, step: "account", error: null };
}

/** Manual column change inside the mapping step (revalidated by canProceed). */
export function applyMappingChange(
  state: ImportWizardState,
  field: keyof WizardMapping,
  column: number | null,
): ImportWizardState {
  if (state.mapping === null) {
    return state;
  }
  return { ...state, mapping: { ...state.mapping, [field]: column }, error: null };
}

/** Account label edit (the summary falls back to the suggestion when blank). */
export function applyAccountName(state: ImportWizardState, accountName: string): ImportWizardState {
  return { ...state, accountName, error: null };
}

/** Job submitted: leave the browser-closable processing step behind. */
export function applyJobSubmitted(state: ImportWizardState, jobId: string): ImportWizardState {
  return {
    ...state,
    step: "processing",
    job: {
      jobId,
      status: "queued",
      progressStage: null,
      progressPercent: null,
      errorMessage: null,
    },
    error: null,
  };
}

/** One job poll: stay processing while live, land on summary when terminal. */
export function applyJobPoll(state: ImportWizardState, job: WizardJob): ImportWizardState {
  if (state.step !== "processing" && state.step !== "summary") {
    return state;
  }
  const terminal =
    job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
  return { ...state, job, step: terminal ? "summary" : "processing" };
}

export function applyFailure(state: ImportWizardState, error: string): ImportWizardState {
  return { ...state, error };
}

export function applyBack(state: ImportWizardState): ImportWizardState {
  const back: Partial<Record<ImportWizardStep, ImportWizardStep>> = {
    preview: "upload",
    mapping: "preview",
    account: "mapping",
    summary: "account",
  };
  const previous = back[state.step];
  return previous ? { ...state, step: previous, error: null } : state;
}

/** Resumable slice: only processing/summary persist (ids, never bytes). */
export interface SavedWizardProgress {
  version: 1;
  step: "processing" | "summary";
  importId: string;
  fileName: string;
  jobId: string;
}

export const WIZARD_STORAGE_KEY = "moneo.importWizard.v1";

export function serializeWizardProgress(state: ImportWizardState): SavedWizardProgress | null {
  if ((state.step !== "processing" && state.step !== "summary") || !state.file || !state.job) {
    return null;
  }
  return {
    version: 1,
    step: state.step,
    importId: state.file.importId,
    fileName: state.file.fileName,
    jobId: state.job.jobId,
  };
}

/** Restore persisted progress; unknown shapes resume to null (fresh start). */
export function resumeWizardProgress(saved: unknown): ImportWizardState | null {
  if (typeof saved !== "object" || saved === null) {
    return null;
  }
  const record = saved as Record<string, unknown>;
  if (record["version"] !== 1) {
    return null;
  }
  if (record["step"] !== "processing" && record["step"] !== "summary") {
    return null;
  }
  if (
    typeof record["importId"] !== "string" ||
    typeof record["fileName"] !== "string" ||
    typeof record["jobId"] !== "string" ||
    record["importId"] === "" ||
    record["jobId"] === ""
  ) {
    return null;
  }
  return {
    ...initialWizardState(),
    step: record["step"],
    file: {
      importId: record["importId"],
      fileName: record["fileName"],
      objectKey: "",
      bytes: 0,
      sha256: "",
    },
    job: {
      jobId: record["jobId"],
      status: "queued",
      progressStage: null,
      progressPercent: null,
      errorMessage: null,
    },
  };
}

export interface WizardSummary {
  fileName: string;
  totalRows: number;
  parseErrors: number;
  mappedFields: string[];
  accountName: string;
  status: WizardJob["status"] | "not-started";
  progressStage: string | null;
  errorMessage: string | null;
}

/** Everything the summary step renders, derived — never stored — from state. */
export function wizardSummary(state: ImportWizardState): WizardSummary {
  const mappedFields =
    state.mapping === null
      ? []
      : (Object.keys(state.mapping) as (keyof WizardMapping)[]).filter(
          (field) => state.mapping?.[field] !== null,
        );
  return {
    fileName: state.file?.fileName ?? "—",
    totalRows: state.preview?.totalRows ?? 0,
    parseErrors: state.preview?.parseErrors.length ?? 0,
    mappedFields,
    accountName: state.accountName.trim() || state.preview?.suggestedAccount || "—",
    status: state.job?.status ?? "not-started",
    progressStage: state.job?.progressStage ?? null,
    errorMessage: state.job?.errorMessage ?? state.error,
  };
}
