import { describe, expect, it } from "vitest";
import {
  applyAccountName,
  applyBack,
  applyFailure,
  applyJobPoll,
  applyJobSubmitted,
  applyMappingChange,
  applyPreview,
  applyUploadComplete,
  canProceed,
  confirmMapping,
  confirmPreview,
  initialWizardState,
  isMappingComplete,
  resumeWizardProgress,
  serializeWizardProgress,
  WIZARD_STEP_LABELS,
  WIZARD_STEPS,
  wizardStepIndex,
  wizardSummary,
  type ImportWizardState,
  type WizardMapping,
} from "./import-wizard";

/**
 * Issue 3.7 — import wizard state machine.
 *
 * Proves, in order: the six steps with labels and order; per-step gating
 * (including the full mapping-shape rule mirrored from the domain);
 * the transition chain upload → preview → mapping → account → processing →
 * summary with payloads carried forward; manual mapping edits; back
 * navigation bounds; job-poll transitions (live stays, terminal lands,
 * foreign steps ignored); failure surfacing; resume serialization
 * (persisted only from processing/summary, ids never bytes, unknown shapes
 * rejected); and the derived summary model.
 */

const MAPPING: WizardMapping = {
  date: 0,
  description: 1,
  amount: 2,
  credit: null,
  debit: null,
  currency: null,
  direction: null,
  account: null,
  fee: null,
};

function uploaded(): ImportWizardState {
  return applyUploadComplete(initialWizardState(), {
    importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    fileName: "statement.csv",
    objectKey: "quarantine/w/i/statement.csv",
    bytes: 100,
    sha256: "0".repeat(64),
  });
}

function previewed(): ImportWizardState {
  return applyPreview(
    uploaded(),
    {
      headers: ["date", "desc", "amount"],
      preview: [{ rowNumber: 2, cells: ["2026-01-01", "x", "1.00"] }],
      totalRows: 1,
      parseErrors: [],
      suggestedAccount: "statement",
      dataSourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      duplicate: null,
    },
    MAPPING,
  );
}

describe("steps", () => {
  it("defines six ordered steps with labels", () => {
    expect(WIZARD_STEPS).toEqual([
      "upload",
      "preview",
      "mapping",
      "account",
      "processing",
      "summary",
    ]);
    expect(WIZARD_STEP_LABELS.upload).toBe("Upload");
    expect(WIZARD_STEP_LABELS.summary).toBe("Summary");
    expect(wizardStepIndex("upload")).toBe(0);
    expect(wizardStepIndex("summary")).toBe(5);
  });
});

describe("gating", () => {
  it("opens on upload with nothing to proceed with", () => {
    expect(initialWizardState().step).toBe("upload");
    expect(canProceed(initialWizardState())).toBe(false);
  });

  it("gates every step on its required payload", () => {
    expect(canProceed(uploaded())).toBe(false); // preview not parsed yet
    const shown = previewed();
    expect(shown.step).toBe("preview");
    expect(canProceed(shown)).toBe(true); // headers present
    const mapped = confirmPreview(shown);
    expect(mapped.step).toBe("mapping");
    expect(canProceed(mapped)).toBe(true);
    expect(canProceed({ ...mapped, step: "account", accountName: "  " })).toBe(false);
    expect(canProceed({ ...mapped, step: "account", accountName: "Cash" })).toBe(true);
    expect(canProceed({ ...mapped, step: "processing" })).toBe(false);
    expect(canProceed({ ...mapped, step: "summary" })).toBe(false);
  });

  it("mirrors the domain mapping-shape rule", () => {
    const headers = ["a", "b", "c"];
    expect(isMappingComplete(headers, null)).toBe(false);
    expect(isMappingComplete(headers, MAPPING)).toBe(true);
    expect(isMappingComplete(headers, { ...MAPPING, date: null })).toBe(false);
    expect(isMappingComplete(headers, { ...MAPPING, amount: null })).toBe(false);
    expect(isMappingComplete(headers, { ...MAPPING, amount: 9 })).toBe(false);
    expect(isMappingComplete(headers, { ...MAPPING, description: 0 })).toBe(false);
    expect(isMappingComplete(headers, { ...MAPPING, credit: 1 })).toBe(false);
    // A credit/debit pair needs its own columns (no clash with description).
    const split = { ...MAPPING, description: 3, amount: null, credit: 1, debit: 2 };
    expect(isMappingComplete(["a", "b", "c", "d"], split)).toBe(true);
    expect(isMappingComplete(["a", "b", "c", "d"], { ...split, debit: null })).toBe(false);
  });
});

describe("transitions", () => {
  it("chains upload → preview → mapping → account → processing → summary", () => {
    let state = uploaded();
    expect(state.step).toBe("preview");
    expect(state.file?.fileName).toBe("statement.csv");
    expect(state.error).toBeNull();

    state = previewed();
    expect(state.step).toBe("preview");
    expect(state.mapping).toEqual(MAPPING);
    expect(state.accountName).toBe("statement");

    state = confirmPreview(state);
    expect(state.step).toBe("mapping");
    state = confirmMapping(state);
    expect(state.step).toBe("account");
    state = applyAccountName(state, "Holiday fund");
    expect(state.accountName).toBe("Holiday fund");

    state = applyJobSubmitted(state, "job-1");
    expect(state.step).toBe("processing");
    expect(state.job?.jobId).toBe("job-1");

    state = applyJobPoll(state, {
      jobId: "job-1",
      status: "running",
      progressStage: "PARSE",
      progressPercent: 40,
      errorMessage: null,
      result: { newCount: 416, duplicateCount: 0, reviewCount: 0, errorCount: 2 },
    });
    expect(state.step).toBe("processing");

    state = applyJobPoll(state, {
      jobId: "job-1",
      status: "succeeded",
      progressStage: "IMPORT_SUMMARY",
      progressPercent: 100,
      errorMessage: null,
      result: { newCount: 416, duplicateCount: 0, reviewCount: 0, errorCount: 2 },
    });
    expect(state.step).toBe("summary");
  });

  it("lands failed and cancelled jobs on summary with their error", () => {
    const processing = applyJobSubmitted(previewed(), "job-9");
    const failed = applyJobPoll(processing, {
      jobId: "job-9",
      status: "failed",
      progressStage: "PARSE",
      progressPercent: null,
      errorMessage: "bad file",
    });
    expect(failed.step).toBe("summary");
    expect(wizardSummary(failed).errorMessage).toBe("bad file");
  });

  it("ignores job polls outside processing/summary", () => {
    const state = previewed();
    const untouched = applyJobPoll(state, {
      jobId: "job-1",
      status: "succeeded",
      progressStage: null,
      progressPercent: null,
      errorMessage: null,
    });
    expect(untouched).toBe(state);
  });

  it("edits manual mapping columns and surfaces failures", () => {
    const state = applyMappingChange(previewed(), "description", null);
    expect(state.mapping?.description).toBeNull();
    expect(canProceed({ ...state, step: "mapping" })).toBe(true);
    const unchanged = applyMappingChange(initialWizardState(), "date", 0);
    expect(unchanged.mapping).toBeNull();
    expect(applyFailure(state, "boom").error).toBe("boom");
  });

  it("walks back within the setup steps only", () => {
    expect(applyBack(previewed()).step).toBe("upload");
    expect(applyBack(confirmPreview(previewed())).step).toBe("preview");
    expect(applyBack({ ...previewed(), step: "account" }).step).toBe("mapping");
    const processing = applyJobSubmitted(previewed(), "job-1");
    expect(applyBack(processing).step).toBe("processing");
    expect(applyBack(initialWizardState()).step).toBe("upload");
  });

  it("confirms only from the right step with valid payloads", () => {
    expect(confirmPreview(uploaded()).step).toBe("preview"); // no preview yet
    expect(confirmMapping(previewed()).step).toBe("preview"); // wrong step
    const broken = applyMappingChange(confirmPreview(previewed()), "date", null);
    expect(confirmMapping(broken).step).toBe("mapping"); // invalid mapping stays
  });
});

describe("resumability", () => {
  it("persists ids (never bytes) from processing/summary only", () => {
    expect(serializeWizardProgress(initialWizardState())).toBeNull();
    expect(serializeWizardProgress(previewed())).toBeNull();
    const processing = applyJobSubmitted(previewed(), "job-1");
    expect(serializeWizardProgress(processing)).toEqual({
      version: 1,
      step: "processing",
      importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fileName: "statement.csv",
      jobId: "job-1",
    });
  });

  it("restores persisted progress and rejects unknown shapes", () => {
    const restored = resumeWizardProgress({
      version: 1,
      step: "processing",
      importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fileName: "statement.csv",
      jobId: "job-1",
    });
    expect(restored?.step).toBe("processing");
    expect(restored?.job?.jobId).toBe("job-1");
    expect(restored?.file?.importId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    for (const bad of [
      null,
      42,
      "processing",
      { version: 2, step: "processing", importId: "a", fileName: "f", jobId: "j" },
      { version: 1, step: "mapping", importId: "a", fileName: "f", jobId: "j" },
      { version: 1, step: "processing", importId: "", fileName: "f", jobId: "j" },
      { version: 1, step: "processing", importId: "a", fileName: "f", jobId: "" },
    ]) {
      expect(resumeWizardProgress(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("summary model", () => {
  it("derives everything the summary step renders", () => {
    const empty = wizardSummary(initialWizardState());
    expect(empty).toMatchObject({
      fileName: "—",
      totalRows: 0,
      status: "not-started",
      accountName: "—",
    });
    const done = wizardSummary(
      applyJobPoll(applyJobSubmitted(previewed(), "job-1"), {
        jobId: "job-1",
        status: "succeeded",
        progressStage: "IMPORT_SUMMARY",
        progressPercent: 100,
        errorMessage: null,
        result: { newCount: 416, duplicateCount: 0, reviewCount: 0, errorCount: 2 },
      }),
    );
    expect(done).toMatchObject({
      fileName: "statement.csv",
      totalRows: 1,
      parseErrors: 0,
      importedRows: 416,
      skippedRows: 2,
      accountName: "statement",
      status: "succeeded",
      progressStage: "IMPORT_SUMMARY",
    });
    expect(done.mappedFields).toEqual(expect.arrayContaining(["date", "amount"]));
  });
});
