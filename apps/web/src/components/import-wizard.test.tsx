import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyJobSubmitted,
  initialWizardState,
  type ImportWizardState,
  type WizardMapping,
} from "../lib/import-wizard";
import { ImportWizard } from "./ImportWizard";

/**
 * Issue 3.7 — import wizard markup. No browser is needed: every step
 * renders to static HTML and the stepper, gating, and accessibility roles
 * are asserted on the markup. (`createElement` instead of JSX because this
 * repo compiles JSX via Next, not vitest.)
 */

const noop = (): void => {};
const noopFile = (_file: File): void => {};
const noopMapping = (_field: keyof WizardMapping, _column: number | null): void => {};
const noopName = (_name: string): void => {};

function render(state: ImportWizardState): string {
  return renderToStaticMarkup(
    h(ImportWizard, {
      state,
      onFileSelected: noopFile,
      onContinue: noop,
      onBack: noop,
      onMappingChange: noopMapping,
      onAccountNameChange: noopName,
      onSubmit: noop,
      onReset: noop,
    }),
  );
}

function previewed(): ImportWizardState {
  return {
    ...initialWizardState(),
    step: "preview",
    file: {
      importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fileName: "statement.csv",
      objectKey: "quarantine/w/i/statement.csv",
      bytes: 100,
      sha256: "0".repeat(64),
    },
    preview: {
      headers: ["date", "desc", "amount"],
      preview: [{ rowNumber: 2, cells: ["2026-01-01", "coffee", "3.50"] }],
      totalRows: 1,
      parseErrors: [],
      suggestedAccount: "statement",
      dataSourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      duplicate: null,
    },
    mapping: {
      date: 0,
      description: 1,
      amount: 2,
      credit: null,
      debit: null,
      currency: null,
      direction: null,
      account: null,
    },
  };
}

describe("import wizard ui", () => {
  it("renders the stepper with the current step marked", () => {
    const html = render(initialWizardState());
    expect(html).toContain('aria-label="Import progress"');
    expect(html).toContain("1. Upload");
    expect(html).toContain("6. Summary");
    expect(html).toContain('aria-current="step"');
  });

  it("upload step explains privacy and accepts statements", () => {
    const html = render(initialWizardState());
    expect(html).toContain('for="import-file"');
    expect(html).toContain('accept=".csv,.xlsx"');
    expect(html).toContain("no public URL");
  });

  it("preview step shows the table, counts, and continue gating", () => {
    const html = render(previewed());
    expect(html).toContain("<table>");
    expect(html).toContain("<caption>First rows of the statement file</caption>");
    expect(html).toContain("<th");
    expect(html).toContain("1 data rows");
    expect(html).toContain("Continue to mapping");
    // Header-only preview cannot continue.
    const empty = render({ ...previewed(), preview: { ...previewed().preview!, headers: [] } });
    expect(empty).toContain("disabled");
  });

  it("preview step shows the repeat warning as a non-blocking status", () => {
    const state = previewed();
    const html = render({
      ...state,
      preview: {
        ...state.preview!,
        duplicate: { isRepeat: true, message: "This exact file was already imported once." },
      },
    });
    expect(html).toContain('role="status"');
    expect(html).toContain("Already imported: This exact file was already imported once.");
    // Advisory only: Continue stays enabled.
    expect(html).not.toContain("disabled");
  });

  it("preview step announces malformed rows as an alert", () => {
    const state = previewed();
    const html = render({
      ...state,
      preview: {
        ...state.preview!,
        parseErrors: [{ rowNumber: 3, message: "Expected 3 columns, found 1." }],
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Row 3: Expected 3 columns, found 1.");
  });

  it("mapping step lists every field with a labeled column select", () => {
    const html = render({ ...previewed(), step: "mapping" });
    for (const label of [
      "Date",
      "Description",
      "Amount",
      "Credit (or pair with debit)",
      "Debit (or pair with credit)",
      "Currency",
      "Direction",
      "Account",
    ]) {
      expect(html).toContain(`Column for ${label}`);
    }
    expect(html).toContain("Continue to account");
  });

  it("account step binds the label input with the suggestion as placeholder", () => {
    const html = render({ ...previewed(), step: "account", accountName: "" });
    expect(html).toContain('id="import-account"');
    expect(html).toContain('placeholder="statement"');
    expect(html).toContain("Start import");
  });

  it("processing step exposes a live status and the close-safe note", () => {
    const processing = applyJobSubmitted(previewed(), "job-1");
    const html = render(processing);
    expect(html).toContain('aria-label="Import processing"');
    expect(html).toContain('role="status"');
    expect(html).toContain("close this browser");
  });

  it("summary step reports the derived outcome and a restart", () => {
    const processing = applyJobSubmitted(previewed(), "job-1");
    const html = render({ ...processing, step: "summary" });
    expect(html).toContain("Import queued");
    expect(html).toContain("statement.csv");
    expect(html).toContain("Start a new import");
  });

  it("announces failures as alerts", () => {
    const html = render({ ...initialWizardState(), error: "Upload failed." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Upload failed.");
  });
});
