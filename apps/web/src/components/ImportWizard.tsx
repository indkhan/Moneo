"use client";

import * as React from "react";
import {
  canProceed,
  WIZARD_STEP_LABELS,
  WIZARD_STEPS,
  wizardStepIndex,
  wizardSummary,
  type ImportWizardState,
  type WizardMapping,
} from "../lib/import-wizard";
import { MatchReviewPanel } from "./MatchReviewPanel";

/**
 * Issue 3.7 — financial statement import wizard.
 *
 * Presentational six-step flow (upload → preview → mapping → account →
 * processing → summary). All decisions live in `lib/import-wizard`; this
 * component only renders state and forwards intent through callbacks, so
 * data fetching and storage plug in without touching this file. Tested via
 * static markup: every step, the stepper, gating, and accessibility roles.
 */

const MAPPING_FIELDS: { field: keyof WizardMapping; label: string }[] = [
  { field: "date", label: "Date" },
  { field: "description", label: "Description" },
  { field: "amount", label: "Amount" },
  { field: "fee", label: "Fee" },
  { field: "credit", label: "Credit (or pair with debit)" },
  { field: "debit", label: "Debit (or pair with credit)" },
  { field: "currency", label: "Currency" },
  { field: "direction", label: "Direction" },
  { field: "account", label: "Account" },
];

function previewExtension(fileName: string | undefined): string {
  const ext = fileName?.split(".").pop()?.trim().toUpperCase() ?? "";
  return ext === "" ? "FILE" : ext.slice(0, 5);
}

function isNumericPreviewColumn(header: string): boolean {
  return /amount|fee|balance|credit|debit|price|total|sum/i.test(header);
}

function isSignedPreviewColumn(header: string): boolean {
  return /amount|balance|credit|debit/i.test(header);
}

function isDescriptionPreviewColumn(header: string): boolean {
  return /descrip|narrative|detail|memo|reference|payee/i.test(header);
}

function isStatePreviewColumn(header: string): boolean {
  return /^(state|status)$/i.test(header.trim());
}

function isTypePreviewColumn(header: string): boolean {
  return /^(type|kind|transaction\s?type)$/i.test(header.trim());
}

function previewAmountColor(header: string, cell: string): string | undefined {
  if (!isSignedPreviewColumn(header)) {
    return undefined;
  }
  const value = Number(cell.replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(value) || value === 0) {
    return undefined;
  }
  return value < 0 ? "#f0883e" : "#3fb950";
}

function previewStateStyle(cell: string): { background: string; color: string } {
  const normalized = cell.trim().toUpperCase();
  if (normalized === "COMPLETED" || normalized === "SUCCESS" || normalized === "SETTLED") {
    return { background: "rgb(63 185 80 / 0.14)", color: "#7ee787" };
  }
  if (normalized === "PENDING" || normalized === "PROCESSING" || normalized === "AUTHORISED") {
    return { background: "rgb(210 153 34 / 0.16)", color: "#e3b341" };
  }
  if (
    normalized === "FAILED" ||
    normalized === "DECLINED" ||
    normalized === "CANCELLED" ||
    normalized === "CANCELED" ||
    normalized === "REJECTED"
  ) {
    return { background: "rgb(248 81 73 / 0.14)", color: "#ff7b72" };
  }
  return { background: "rgb(154 167 184 / 0.14)", color: "#c4cdd8" };
}

export interface ImportWizardCallbacks {
  onFileSelected: (file: File) => void;
  onContinue: () => void;
  onBack: () => void;
  onMappingChange: (field: keyof WizardMapping, column: number | null) => void;
  onAccountNameChange: (name: string) => void;
  onSubmit: () => void;
  onReset: () => void;
}

export function ImportWizard({
  state,
  ...callbacks
}: {
  state: ImportWizardState;
} & ImportWizardCallbacks) {
  const summary = wizardSummary(state);
  const forward = canProceed(state);
  const current = wizardStepIndex(state.step);

  return (
    <section aria-labelledby="import-wizard-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="import-wizard-heading" style={{ margin: 0, fontSize: 24 }}>
        Import statement
      </h1>

      <ol
        aria-label="Import progress"
        style={{
          display: "flex",
          gap: 8,
          listStyle: "none",
          margin: 0,
          padding: 0,
          flexWrap: "wrap",
        }}
      >
        {WIZARD_STEPS.map((step, index) => (
          <li
            key={step}
            aria-current={step === state.step ? "step" : undefined}
            style={{
              fontSize: 13,
              fontWeight: step === state.step ? 700 : 400,
              opacity: index <= current ? 1 : 0.55,
            }}
          >
            {`${index + 1}. ${WIZARD_STEP_LABELS[step]}`}
          </li>
        ))}
      </ol>

      {state.error ? (
        <p role="alert" style={{ color: "#f85149", margin: 0 }}>
          {state.error}
        </p>
      ) : null}

      {state.step === "upload" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label htmlFor="import-file">Statement file (.csv or .xlsx, up to 10 MiB)</label>
          <input
            id="import-file"
            type="file"
            accept=".csv,.xlsx"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                callbacks.onFileSelected(file);
              }
            }}
          />
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
            Files stay private: uploads go to quarantined storage with no public URL.
          </p>
        </div>
      ) : null}

      {state.step === "preview" && state.preview ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div
            style={{
              display: "grid",
              gap: 6,
              border: "1px solid var(--moneo-border)",
              borderRadius: 12,
              padding: "12px 14px",
              background: "var(--moneo-surface)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "var(--moneo-accent)",
                  background: "rgb(79 140 255 / 0.12)",
                  border: "1px solid rgb(79 140 255 / 0.35)",
                  borderRadius: 6,
                  padding: "2px 8px",
                }}
              >
                {previewExtension(state.file?.fileName)}
              </span>
              <h2
                title={state.file?.fileName}
                className="import-preview-title"
                style={{ margin: 0, fontSize: 16, fontWeight: 650 }}
              >
                {state.file?.fileName ?? "Statement preview"}
              </h2>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--moneo-muted)" }}>
              {`${state.preview.totalRows} data rows · Showing the first ${state.preview.preview.length} · ${state.preview.headers.length} columns`}
            </p>
          </div>
          {state.preview.duplicate ? (
            <p
              role="status"
              style={{
                margin: 0,
                fontSize: 13,
                border: "1px solid rgb(210 153 34 / 0.45)",
                background: "rgb(210 153 34 / 0.1)",
                borderRadius: 10,
                padding: "10px 12px",
              }}
            >
              {`Already imported: ${state.preview.duplicate.message}`}
            </p>
          ) : null}
          <div className="import-preview-scroll" role="region" aria-label="Statement rows" tabIndex={0}>
            <table>
              <caption>First rows of the statement file</caption>
              <thead>
                <tr>
                  <th scope="col" aria-label="Row number" title="Source row number">
                    #
                  </th>
                  {state.preview.headers.map((header, index) => (
                    <th
                      key={`${header}-${index}`}
                      scope="col"
                      title={header}
                      style={
                        isNumericPreviewColumn(header) ? { textAlign: "right" } : undefined
                      }
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.preview.preview.map((row) => (
                  <tr key={row.rowNumber}>
                    <td style={{ color: "var(--moneo-muted)", fontSize: 12 }}>{row.rowNumber}</td>
                    {row.cells.map((cell, index) => {
                      const header = state.preview?.headers[index] ?? "";
                      const numeric = isNumericPreviewColumn(header);
                      const description = isDescriptionPreviewColumn(header);
                      const stateColumn = isStatePreviewColumn(header);
                      const typeColumn = isTypePreviewColumn(header);
                      const blank = cell.trim() === "";
                      if (stateColumn && !blank) {
                        const badge = previewStateStyle(cell);
                        return (
                          <td key={index}>
                            <span
                              style={{
                                display: "inline-block",
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: "0.04em",
                                background: badge.background,
                                color: badge.color,
                                borderRadius: 999,
                                padding: "2px 10px",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {cell}
                            </span>
                          </td>
                        );
                      }
                      if (typeColumn && !blank) {
                        return (
                          <td key={index}>
                            <span
                              style={{
                                display: "inline-block",
                                fontSize: 12,
                                fontWeight: 600,
                                color: "var(--moneo-text)",
                                background: "rgb(154 167 184 / 0.12)",
                                border: "1px solid rgb(154 167 184 / 0.25)",
                                borderRadius: 999,
                                padding: "1px 10px",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {cell}
                            </span>
                          </td>
                        );
                      }
                      return (
                        <td
                          key={index}
                          title={cell}
                          style={{
                            textAlign: numeric ? "right" : "left",
                            whiteSpace: description ? "normal" : "nowrap",
                            minWidth: description ? 200 : undefined,
                            maxWidth: description ? 300 : undefined,
                            color: blank
                              ? "var(--moneo-muted)"
                              : (previewAmountColor(header, cell) ?? undefined),
                            fontWeight:
                              previewAmountColor(header, cell) !== undefined ? 600 : undefined,
                          }}
                        >
                          {blank ? "—" : cell}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.preview.parseErrors.length > 0 ? (
            <div
              role="alert"
              style={{
                border: "1px solid rgb(248 81 73 / 0.45)",
                background: "rgb(248 81 73 / 0.08)",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 13,
              }}
            >
              <p style={{ margin: "0 0 4px", fontWeight: 650 }}>
                {`${state.preview.parseErrors.length} malformed rows will be skipped:`}
              </p>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {state.preview.parseErrors.slice(0, 5).map((error) => (
                  <li key={error.rowNumber}>{`Row ${error.rowNumber}: ${error.message}`}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={callbacks.onBack}
              style={{
                border: "1px solid var(--moneo-border)",
                background: "transparent",
                color: "var(--moneo-text)",
                borderRadius: 8,
                padding: "8px 14px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Back
            </button>
            <button
              type="button"
              onClick={callbacks.onContinue}
              disabled={!forward}
              style={{
                border: "none",
                background: "var(--moneo-accent)",
                color: "#fff",
                borderRadius: 8,
                padding: "8px 16px",
                fontWeight: 700,
                cursor: forward ? "pointer" : "not-allowed",
                opacity: forward ? 1 : 0.5,
              }}
            >
              Continue to mapping
            </button>
          </div>
        </div>
      ) : null}

      {state.step === "mapping" && state.preview && state.mapping ? (
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Map columns</h2>
          <p style={{ margin: 0, fontSize: 13 }}>
            Map a single amount column or a credit/debit pair — never both.
          </p>
          {MAPPING_FIELDS.map(({ field, label }) => (
            <label key={field} style={{ display: "grid", gap: 4, fontSize: 14 }}>
              {label}
              <select
                aria-label={`Column for ${label}`}
                value={state.mapping?.[field] ?? ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  callbacks.onMappingChange(field, raw === "" ? null : Number(raw));
                }}
              >
                <option value="">—</option>
                {state.preview?.headers.map((header, index) => (
                  <option key={`${header}-${index}`} value={index}>
                    {`${index + 1}. ${header}`}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={callbacks.onBack}>
              Back
            </button>
            <button type="button" onClick={callbacks.onContinue} disabled={!forward}>
              Continue to account
            </button>
          </div>
        </div>
      ) : null}

      {state.step === "account" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Name the source account</h2>
          <label htmlFor="import-account" style={{ display: "grid", gap: 4, fontSize: 14 }}>
            Account label
            <input
              id="import-account"
              type="text"
              value={state.accountName}
              placeholder={state.preview?.suggestedAccount ?? "Imported account"}
              onChange={(event) => {
                callbacks.onAccountNameChange(event.target.value);
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={callbacks.onBack}>
              Back
            </button>
            <button type="button" onClick={callbacks.onSubmit} disabled={!forward}>
              Start import
            </button>
          </div>
        </div>
      ) : null}

      {state.step === "processing" ? (
        <div role="status" aria-label="Import processing" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Processing {summary.fileName}</h2>
          <p style={{ margin: 0 }}>
            {state.job?.progressStage
              ? `${state.job.progressStage} · ${state.job.progressPercent ?? 0}%`
              : "Queued — the worker picks the import up shortly."}
          </p>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
            You can safely close this browser: processing continues in the background and this page
            resumes where it left off.
          </p>
        </div>
      ) : null}

      {state.step === "summary" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            Import{" "}
            {summary.status === "succeeded" && summary.skippedRows > 0
              ? "completed with errors"
              : summary.status}
          </h2>
          {summary.errorMessage ? (
            <p role="alert" style={{ color: "#f85149", margin: 0 }}>
              {summary.errorMessage}
            </p>
          ) : null}
          <dl style={{ display: "grid", gap: 4, margin: 0 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <dt>File</dt>
              <dd style={{ margin: 0 }}>{summary.fileName}</dd>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <dt>Rows parsed</dt>
              <dd style={{ margin: 0 }}>{summary.totalRows}</dd>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <dt>Imported rows</dt>
              <dd style={{ margin: 0 }}>{summary.importedRows}</dd>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <dt>Skipped rows</dt>
              <dd style={{ margin: 0 }}>{summary.skippedRows}</dd>
            </div>
            {summary.duplicateRows > 0 ? (
              <div style={{ display: "flex", gap: 8 }}>
                <dt>Duplicate rows</dt>
                <dd style={{ margin: 0 }}>{summary.duplicateRows}</dd>
              </div>
            ) : null}
            {summary.reviewRows > 0 ? (
              <div style={{ display: "flex", gap: 8 }}>
                <dt>Rows needing review</dt>
                <dd style={{ margin: 0 }}>{summary.reviewRows}</dd>
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              <dt>Account</dt>
              <dd style={{ margin: 0 }}>{summary.accountName}</dd>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <dt>Mapped</dt>
              <dd style={{ margin: 0 }}>{summary.mappedFields.join(", ") || "—"}</dd>
            </div>
          </dl>
          <div style={{ display: "flex", gap: 8 }}>
            {summary.status === "failed" ? (
              <button type="button" onClick={callbacks.onBack}>
                Back to account
              </button>
            ) : null}
            <button type="button" onClick={callbacks.onReset}>
              Start a new import
            </button>
          </div>
          {state.file?.importId ? <MatchReviewPanel importId={state.file.importId} /> : null}
        </div>
      ) : null}
    </section>
  );
}
