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
  { field: "credit", label: "Credit (or pair with debit)" },
  { field: "debit", label: "Debit (or pair with credit)" },
  { field: "currency", label: "Currency" },
  { field: "direction", label: "Direction" },
  { field: "account", label: "Account" },
];

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
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Preview of {state.file?.fileName}</h2>
          {state.preview.duplicate ? (
            <p role="status" style={{ margin: 0 }}>
              {`Already imported: ${state.preview.duplicate.message}`}
            </p>
          ) : null}
          <p style={{ margin: 0, fontSize: 13 }}>
            {`${state.preview.totalRows} data rows. Showing the first ${state.preview.preview.length}.`}
          </p>
          <table>
            <caption>First rows of the statement file</caption>
            <thead>
              <tr>
                {state.preview.headers.map((header, index) => (
                  <th key={`${header}-${index}`} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.preview.preview.map((row) => (
                <tr key={row.rowNumber}>
                  {row.cells.map((cell, index) => (
                    <td key={index}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {state.preview.parseErrors.length > 0 ? (
            <div role="alert">
              <p style={{ margin: "0 0 4px" }}>
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
            <button type="button" onClick={callbacks.onBack}>
              Back
            </button>
            <button type="button" onClick={callbacks.onContinue} disabled={!forward}>
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
          <h2 style={{ margin: 0, fontSize: 18 }}>Import {summary.status}</h2>
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
              <dt>Skipped rows</dt>
              <dd style={{ margin: 0 }}>{summary.parseErrors}</dd>
            </div>
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
