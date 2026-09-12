"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { createClient, type MoneoClient } from "../generated/client";
import {
  applyAccountName,
  applyBack,
  applyFailure,
  applyJobPoll,
  applyJobSubmitted,
  applyMappingChange,
  applyPreview,
  applyUploadComplete,
  confirmMapping,
  confirmPreview,
  initialWizardState,
  resumeWizardProgress,
  serializeWizardProgress,
  WIZARD_STORAGE_KEY,
  type ImportWizardState,
  type WizardMapping,
} from "../lib/import-wizard";
import { ImportWizard } from "./ImportWizard";

/**
 * Issue 3.7 — wizard host: fetch + storage wiring.
 *
 * Intentionally thin: every decision lives in `lib/import-wizard` (tested
 * there). This component chains the generated client
 * (initiate → bytes → complete → preview → submit → poll), persists the
 * resumable slice to localStorage on every step change, and restores it on
 * mount so a closed browser resumes processing by polling the stored job.
 * Effects and FileReader I/O are the only untested lines by construction.
 */

async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function loadSaved(): ImportWizardState {
  try {
    const raw = window.localStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) {
      return initialWizardState();
    }
    return resumeWizardProgress(JSON.parse(raw) as unknown) ?? initialWizardState();
  } catch {
    return initialWizardState();
  }
}

export function ImportWizardHost({ client }: { client?: MoneoClient }) {
  const api = React.useMemo(() => client ?? createClient(), [client]);
  const [state, setState] = useState<ImportWizardState>(loadSaved);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      const saved = serializeWizardProgress(state);
      if (saved) {
        window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(saved));
      } else if (state.step === "upload") {
        window.localStorage.removeItem(WIZARD_STORAGE_KEY);
      }
    } catch {
      // Private-mode storage failures must never break the wizard itself.
    }
  }, [state]);

  // Resume polling when reopening mid-processing. The derived id keeps the
  // effect stable across poll responses (same id → no resubscribe).
  const activeJobId = state.step === "processing" ? state.job?.jobId : undefined;
  useEffect(() => {
    if (activeJobId === undefined) {
      return;
    }
    const jobId = activeJobId;
    let cancelled = false;
    const tick = (): void => {
      api
        .getJob(jobId)
        .then((job) => {
          if (cancelled) {
            return;
          }
          setState((current) =>
            applyJobPoll(current, {
              jobId,
              status: job.status,
              progressStage: job.progressStage,
              progressPercent: job.progressPercent,
              errorMessage:
                job.error && typeof job.error["message"] === "string" ? job.error["message"] : null,
            }),
          );
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState((current) =>
              applyFailure(current, error instanceof Error ? error.message : "Job poll failed."),
            );
          }
        });
    };
    const timer = window.setInterval(tick, 2000);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, activeJobId]);

  const onFileSelected = useCallback(
    (file: File) => {
      const run = async (): Promise<void> => {
        try {
          const bytes = await readFileBytes(file);
          const initiated = await api.initiateUpload({
            fileName: file.name,
            contentLength: bytes.length,
          });
          await api.putImportBytes(initiated.importId, initiated.objectKey, bytes);
          const completed = await api.completeUpload({
            importId: initiated.importId,
            objectKey: initiated.objectKey,
            fileName: file.name,
          });
          const preview = await api.previewImport({
            importId: initiated.importId,
            fileName: file.name,
          });
          setState((current) =>
            applyPreview(
              applyUploadComplete(current, {
                importId: completed.importId,
                fileName: completed.fileName,
                objectKey: completed.objectKey,
                bytes: completed.bytes,
                sha256: completed.sha256,
              }),
              {
                headers: preview.headers,
                preview: preview.preview,
                totalRows: preview.totalRows,
                parseErrors: preview.parseErrors,
                suggestedAccount: preview.suggestedAccount,
                dataSourceId: preview.dataSourceId,
              },
              preview.mapping as WizardMapping,
            ),
          );
        } catch (error) {
          setState((current) =>
            applyFailure(current, error instanceof Error ? error.message : "Upload failed."),
          );
        }
      };
      void run();
    },
    [api],
  );

  const onSubmit = useCallback(() => {
    const current = stateRef.current;
    if (!current.file || !current.mapping || !current.preview) {
      setState((next) => applyFailure(next, "The import is not ready to submit yet."));
      return;
    }
    const payload = {
      importId: current.file.importId,
      dataSourceId: current.preview.dataSourceId,
      objectKey: current.file.objectKey,
      fileName: current.file.fileName,
      mapping: current.mapping,
      accountName: current.accountName,
    };
    void api
      .submitJob({ type: "import.process", dedupeKey: current.file.importId, payload })
      .then((job) => {
        setState((next) => applyJobSubmitted(next, job.id));
      })
      .catch((error: unknown) => {
        setState((next) =>
          applyFailure(next, error instanceof Error ? error.message : "Submit failed."),
        );
      });
  }, [api]);

  return (
    <ImportWizard
      state={state}
      onFileSelected={onFileSelected}
      onContinue={() => {
        setState((current) =>
          current.step === "preview" ? confirmPreview(current) : confirmMapping(current),
        );
      }}
      onBack={() => {
        setState((current) => applyBack(current));
      }}
      onMappingChange={(field, column) => {
        setState((current) => applyMappingChange(current, field, column));
      }}
      onAccountNameChange={(name) => {
        setState((current) => applyAccountName(current, name));
      }}
      onSubmit={onSubmit}
      onReset={() => {
        try {
          window.localStorage.removeItem(WIZARD_STORAGE_KEY);
        } catch {
          // Ignore private-mode failures (see above).
        }
        setState(initialWizardState());
      }}
    />
  );
}
