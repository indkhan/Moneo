"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import type { ImportMapping, SourceRow, WorkbookScope } from "@/lib/import/csv";
import { WorkbookScopeReview, type WorkbookSheet } from "./workbook-scope";
import { formatMoney } from "@/lib/finance/format";
import { ConnectedBanks } from "@/components/connected-banks";
import { PhoneCollapse } from "@/components/phone-collapse";

type Preview = {
  accountName: string;
  currencyCode: string;
  accounts?: { accountName: string; currencyCode: string; rows: number }[];
  totalRows: number;
  acceptedRows?: number;
  correctedRows?: number;
  excludedRows?: { rowNumber: number; reason: string; sourceRow: SourceRow }[];
  unresolvedRows?: { rowNumber: number; message: string; sourceRow: SourceRow }[];
  pendingRows?: number;
  postedRows?: number;
  classificationReviewRows?: number;
  timestampReviewRequired?: boolean;
  dateRange: { from?: string; to?: string };
  examples: { postedOn: string; description: string; amountMinor: string; currencyCode: string; status?: string; merchant?: string; category?: string }[];
};
type Inspection = { workbook?: {inventory: WorkbookSheet[]}; workbookScope?: WorkbookScope; needsWorkbookSelection?: boolean; headers: string[]; sample: SourceRow[]; mapping: ImportMapping | null; preview: Preview | null;
  format?: string | null; interpretation?: "known" | "proposed" | "reviewed" | "manual"; suggestedAccountName?: string; aiError?: string; previewError?: string; warnings?: string[] };
type ImportStatus = { id: string; filename: string; status: string; run_version: number; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; classification_review_rows?: number; rejected_rows: number; error: string | null; created_at: string };
type HistoryUpdate = Partial<ImportStatus> & Pick<ImportStatus, "id" | "status" | "run_version">;
type UndoPreview = { import_id: string; filename: string; status: string; deletable_transactions: number; deletable_balances: number; blockers: string[]; safe: boolean };

const HISTORY_UNAVAILABLE = "Import history is unavailable. Try again.";
const STEPS = ["Drop files", "Check mapping", "Review flagged rows", "Confirm", "Progress & summary"];
const input = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal";
const primary = "min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const secondary = "min-h-10 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
const active = (status: string) => status === "queued" || status === "running";
const MORE_COLUMNS: [string, keyof ImportMapping][] = [
  ["Currency", "currencyColumn"], ["Balance", "balanceColumn"], ["Account name or number", "accountColumn"], ["Product", "productColumn"],
  ["Transaction type", "typeColumn"], ["Fee", "feeColumn"], ["Merchant", "merchantColumn"], ["Category", "categoryColumn"],
  ["Transaction ID", "externalIdColumn"], ["Status", "statusColumn"],
];

function formatMinor(value: string, currency: string) {
  const amount = BigInt(value);
  return `${amount >= 0n ? "+" : ""}${formatMoney(amount, currency)}`;
}

const subscribeToHydration = () => () => {};

function SourceFields({ row }: { row: SourceRow }) {
  return <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">{Object.entries(row).filter(([column]) => !column.startsWith("__moneo_csv_")).map(([column, value]) =>
    <div key={column} className="contents"><dt className="font-medium text-muted-foreground">{column}</dt><dd className="break-all">{value || "—"}</dd></div>)}</dl>;
}

function SourceRowReview({ row, nextRow, mapping, onDecision }: { row: { rowNumber: number; message: string; sourceRow: SourceRow }; nextRow?: number; mapping: ImportMapping;
  onDecision: (decision: NonNullable<ImportMapping["rowDecisions"]>[number]) => void }) {
  const previous = mapping.rowDecisions?.find(item => item.rowNumber === row.rowNumber);
  const [values, setValues] = useState<SourceRow>({ ...row.sourceRow, ...(previous?.action === "correct" ? previous.values : {}) });
  const [reason, setReason] = useState("");
  const changes = Object.fromEntries(Object.entries(values).filter(([column, value]) => value !== row.sourceRow[column]));
  const parserReview = Boolean(row.sourceRow.__moneo_csv_issue);
  const mappedColumns = Object.entries(mapping).filter(([key, value]) => key.endsWith("Column") && typeof value === "string").map(([, value]) => value as string);
  for (const name of ["type", "fee"]) {
    const column = Object.keys(row.sourceRow).find(key => key.trim().toLowerCase() === name);
    if (column) mappedColumns.push(column);
  }
  const correction = parserReview ? { ...changes, ...Object.fromEntries(mappedColumns.map(column => [column, values[column] ?? ""])) } : changes;
  return <article id={`flagged-row-${row.rowNumber}`} tabIndex={-1} className="scroll-mt-20 space-y-4 rounded-lg border border-warning/40 bg-card p-4 text-sm outline-none">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-medium">Source row {row.rowNumber}</h3><p className="text-muted-foreground">{row.message.replace(/^Row \d+: /, "")}</p></div>
      {nextRow != null && <a className="underline" href={`#flagged-row-${nextRow}`}>Next flagged row</a>}</div>
    {parserReview && <p>This row has a different number of cells than the headers. Check each cell against the original row before correcting it.</p>}
    <div className="grid gap-3 sm:grid-cols-3">{Object.keys(row.sourceRow).filter(column => !column.startsWith("__moneo_csv_")).map(column => <label key={column} className="grid gap-1 font-medium">{column}<input aria-label={`Source row ${row.rowNumber} ${column}`} className={input} value={values[column]} onChange={event => setValues({ ...values, [column]: event.target.value })} /></label>)}</div>
    <div className="flex flex-wrap items-end gap-3">
      <button type="button" className={secondary} disabled={!Object.keys(correction).length} onClick={() => onDecision({ rowNumber: row.rowNumber, action: "correct", values: correction })}>Use correction for row {row.rowNumber}</button>
      <span className="pb-2.5 text-muted-foreground">or</span>
      <label className="grid min-w-56 flex-1 gap-1 font-medium">Exclusion reason for row {row.rowNumber}<input className={input} maxLength={500} placeholder="e.g. statement footer" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button type="button" className={secondary} disabled={!reason.trim()} onClick={() => onDecision({ rowNumber: row.rowNumber, action: "exclude", reason })}>Exclude row {row.rowNumber}</button>
    </div>
    <details><summary className="cursor-pointer text-muted-foreground">Original row</summary><div className="mt-2 rounded-lg bg-muted p-3"><SourceFields row={row.sourceRow} /></div></details>
  </article>;
}

function dayLabel(iso: string) {
  const date = new Date(iso), today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export default function ImportPage() {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [files, setFiles] = useState<File[]>([]);
  const [index, setIndex] = useState(0);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  // `stale`: the shown preview no longer matches the mapping; `editorOpen`: the column editor is visible.
  const [stale, setStale] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // The user changed the mapping, row decisions or workbook tables, so discarding them needs a warning.
  const [edited, setEdited] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState(false);
  const [moreColumnsOpen, setMoreColumnsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState("");
  const [rowsReviewed, setRowsReviewed] = useState(false);
  const [history, setHistory] = useState<ImportStatus[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "loaded" | "failed">("loading");
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [preview, setPreview] = useState<UndoPreview | null>(null);
  const controlRequests = useRef(new Map<string, string>());
  const inspectionRequest = useRef<AbortController | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const historyRequest = useRef(0);
  const historyApplied = useRef(new Map<string, number>());
  const file = files[index];

  useEffect(() => () => inspectionRequest.current?.abort(), []);
  // The review appears far below the upload, so keyboard and screen-reader users are taken to it.
  useEffect(() => { if (inspection) reviewHeading.current?.focus(); }, [inspection]);
  useEffect(() => {
    if (!edited) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);

  // Merge rules keep a delayed or reordered status response from regressing a newer state.
  function mergeHistory(updates: HistoryUpdate[], requestOrder: number) {
    setHistory((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const update of updates) {
        const previous = byId.get(update.id);
        const sameRun = previous && update.run_version === previous.run_version;
        const stage = (status: string) => ["pending", "queued", "running"].indexOf(status);
        const previousStage = previous ? stage(previous.status) : -1;
        const nextStage = stage(update.status);
        const regresses = previous && (previousStage < 0
          ? update.status !== previous.status && !(previous.status === "completed" && update.status === "undone")
          : nextStage >= 0 && nextStage < previousStage);
        if (previous && (update.run_version < previous.run_version || (sameRun &&
          (regresses || (update.status === previous.status && requestOrder < (historyApplied.current.get(update.id) ?? 0)))))) continue;
        if (!previous && !update.filename) continue;
        byId.set(update.id, { ...previous, ...update } as ImportStatus);
        historyApplied.current.set(update.id, Math.max(requestOrder, historyApplied.current.get(update.id) ?? 0));
      }
      return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30);
    });
  }

  async function loadHistory() {
    const requestOrder = ++historyRequest.current;
    try {
      const response = await fetch("/api/imports", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("History unavailable");
      mergeHistory(await response.json(), requestOrder);
      setHistoryState("loaded");
    } catch { setHistoryState("failed"); }
  }

  useEffect(() => {
    const requestOrder = ++historyRequest.current;
    fetch("/api/imports", { cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(async (response) => {
      if (!response.ok) throw new Error("History unavailable");
      mergeHistory(await response.json(), requestOrder);
      setHistoryState("loaded");
    }).catch(() => setHistoryState("failed"));
  }, []);
  // ponytail: one small status read per active import every 3 s, paused in hidden tabs; batch ids if many run at once.
  useEffect(() => {
    if (!history.some((item) => active(item.status))) return;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      const requestOrder = ++historyRequest.current;
      try {
        const updates = await Promise.all(history.filter((item) => active(item.status)).map(async (item) => {
          const response = await fetch(`/api/imports/${item.id}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error("History unavailable");
          return await response.json() as ImportStatus;
        }));
        mergeHistory(updates, requestOrder);
      } catch { setHistoryState("failed"); }
    }, 3000);
    return () => clearInterval(timer);
  }, [history]);

  async function inspect(target: File, corrected?: ImportMapping, workbookScope?: WorkbookScope) {
    setRowsReviewed(false);
    inspectionRequest.current?.abort();
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setInterpreting(true);
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", target);
      if (corrected) form.set("mapping", JSON.stringify(corrected));
      if (workbookScope) form.set("workbookScope", JSON.stringify(workbookScope));
      const response = await fetch("/api/imports/inspect", { method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
      const result = await response.json() as Inspection & { error?: string };
      if (inspectionRequest.current !== controller) return;
      if (!response.ok) throw new Error(result.error ?? "Inspection failed");
      setInspection(result);
      if (result.needsWorkbookSelection) { setMapping(null); setEditorOpen(false); setStale(false); return; }
      const column = (name: string) => result.headers.find((header: string) => header.toLowerCase() === name);
      const nextMapping: ImportMapping = result.mapping ?? {
        accountName: result.suggestedAccountName ?? target.name.replace(/\.(csv|xlsx)$/i, ""),
        currencyCode: "EUR",
        dateColumn: column("completed date") ?? column("date") ?? column("started date") ?? "",
        descriptionColumn: column("description") ?? "",
        amountColumn: column("amount"),
        dateFormat: "iso",
        amountSign: "signed",
        ...(result.workbookScope ? {workbookScope: result.workbookScope} : {}),
      };
      setMapping(nextMapping);
      setSplitAmounts(!nextMapping.amountColumn && !!(nextMapping.debitColumn || nextMapping.creditColumn));
      // A column set by a proposal must stay visible, so its section starts open.
      setMoreColumnsOpen(MORE_COLUMNS.some(([, key]) => nextMapping[key]));
      // A proposed reversed sign is easy to miss, so it opens the editor; a reviewed one is the user's choice.
      const needsEditor = !result.mapping || !result.preview || (!corrected && result.mapping.amountSign === "outflow-positive");
      setEditorOpen(needsEditor);
      setStale(needsEditor);
    } catch (cause) {
      if (inspectionRequest.current !== controller) return;
      setError(cause instanceof Error ? cause.message : "Inspection failed");
    } finally {
      if (inspectionRequest.current === controller) { inspectionRequest.current = null; setBusy(false); setInterpreting(false); }
    }
  }

  const discardConfirmed = () => !edited || window.confirm("Discard your changes to this statement?");

  function skipFile() {
    if (!discardConfirmed()) return;
    setEdited(false); setInspection(null); setMapping(null); setIndex(index + 1);
    void inspect(files[index + 1]);
  }

  function clearFiles() {
    inspectionRequest.current?.abort();
    inspectionRequest.current = null;
    setEdited(false); setFiles([]); setIndex(0); setInspection(null); setMapping(null); setEditorOpen(false); setStale(false); setBusy(false); setInterpreting(false); setError("");
  }

  // Runs one user action with the shared busy flag and surfaces its error.
  async function run(fallback: string, action: () => Promise<void>, onError?: () => void) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : fallback); onError?.(); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!file || !mapping) return;
    await run("Import failed", async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      const response = await fetch("/api/imports/confirm", { method: "POST", body: form, signal: AbortSignal.timeout(45_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Import failed");
      if (result.importId) setConfirmedIds(ids => [result.importId, ...ids.filter(id => id !== result.importId)]);
      await loadHistory();
      setEdited(false);
      setInspection(null);
      setMapping(null);
      if (index + 1 < files.length) {
        setIndex(index + 1);
        await inspect(files[index + 1]);
      } else {
        setFiles([]);
        setIndex(0);
      }
    });
  }

  // Replaces (or with no decision, clears) the review of one source row.
  function setRowDecision(rowNumber: number, decision?: NonNullable<ImportMapping["rowDecisions"]>[number]) {
    setMapping(current => current && ({ ...current, rowDecisions: [...(current.rowDecisions ?? []).filter(item => item.rowNumber !== rowNumber), ...(decision ? [decision] : [])] }));
    setStale(true); setRowsReviewed(false); setEdited(true);
  }

  function edit(change: Partial<ImportMapping>) {
    setMapping(current => current && ({ ...current, ...change }));
    setStale(true); setEdited(true);
  }

  async function control(item: ImportStatus, action: "cancel" | "resume") {
    await run("Retry failed", async () => {
      const key = `${item.id}:${item.run_version}:${action}`;
      if (!controlRequests.current.has(key)) controlRequests.current.set(key, crypto.randomUUID());
      const response = await fetch(`/api/imports/${item.id}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId: controlRequests.current.get(key) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Retry failed");
      mergeHistory([{ id: item.id, status: result.status, run_version: result.runVersion, total_rows: result.totalRows, error: null }], ++historyRequest.current);
      await loadHistory();
    });
  }

  async function showUndo(id: string) {
    setUndoId(id);
    setPreview(null);
    await run("Undo preview failed", async () => {
      const response = await fetch(`/api/imports/${id}/undo`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Undo preview failed");
      setPreview(result as UndoPreview);
    }, () => setUndoId(null));
  }

  async function confirmUndo() {
    if (!preview) return;
    await run("Undo failed", async () => {
      const response = await fetch(`/api/imports/${preview.import_id}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, expectedTransactions: preview.deletable_transactions, expectedBalances: preview.deletable_balances }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Undo failed");
      const item = history.find((item) => item.id === preview.import_id);
      if (item) mergeHistory([{ id: item.id, status: "undone", run_version: item.run_version }], ++historyRequest.current);
      setUndoId(null);
      setPreview(null);
      await loadHistory();
    });
  }

  const chooseColumn = (label: string, key: keyof ImportMapping, optional = false) => (
    <label className="grid gap-1 text-sm" key={key}>
      {label}
      <select className={input} value={String(mapping?.[key] ?? "")}
        onChange={(event) => edit({ [key]: event.target.value || undefined,
          ...(["accountColumn", "productColumn", "currencyColumn"].includes(key) ? { accountRoutes: undefined } : {}) })}>
        <option value="">{optional ? "None" : "Select column"}</option>
        {inspection?.headers.map((header) => <option key={header} value={header}>{header}</option>)}
      </select>
    </label>
  );

  const result = inspection?.preview;
  const sourceAmountColumn = mapping?.amountColumn ?? mapping?.debitColumn;
  const sourceAmount = sourceAmountColumn && inspection?.sample.map(row => row[sourceAmountColumn]).find(Boolean);
  const unresolved = result?.unresolvedRows ?? [];
  const decisions = mapping?.rowDecisions ?? [];
  const namesMissing = !!mapping && (mapping.accountRoutes?.length ? mapping.accountRoutes.some(route => !route.accountName.trim()) : !mapping.accountName.trim());
  const mappingReady = !!result && !stale && !!mapping?.numericConvention && (!result.timestampReviewRequired || !!mapping.timestampTimezoneConfirmed) && !namesMissing;
  const flaggedReady = !unresolved.length && (!decisions.length || rowsReviewed);
  const step = !file || !inspection ? (confirmedIds.length ? 4 : 0) : !mappingReady ? 1 : !flaggedReady ? 2 : 3;
  const visibleHistory = history.filter((item) => item.status !== "undone");
  const days = visibleHistory.reduce((groups, item) => {
    const label = dayLabel(item.created_at);
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(item);
    return groups;
  }, new Map<string, ImportStatus[]>());
  const extension = file?.name.toLowerCase().endsWith(".xlsx") ? "Excel workbook" : "CSV";

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <header className="space-y-5">
      <div><p className="eyebrow">Money · Import</p><h1 className="mt-2 page-title">Import financial data</h1><p className="mt-2 text-sm text-muted-foreground">Drop CSV or XLSX statements. Only rows that need a decision are shown. Afterwards you can review each import and undo it if nothing depends on it.</p></div>
      {file && <PhoneCollapse label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}><ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Import steps">{STEPS.map((label, i) =>
        <li key={label} aria-current={i === step ? "step" : undefined} className={`flex items-center gap-2 ${i === step ? "font-medium text-foreground" : i < step ? "text-foreground" : "text-muted-foreground"}`}>
          <span className={`grid size-6 place-items-center rounded-full text-xs ${i === step ? "bg-brand text-white" : i < step ? "bg-muted text-brand" : "border border-border"}`}>{i < step ? "✓" : i + 1}</span>{label}
        </li>)}</ol></PhoneCollapse>}
    </header>

    <label className={`relative block rounded-xl border border-dashed border-border bg-card text-center transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-brand ${file ? "p-5" : "p-10"}`}>
      <span className="block text-base font-semibold">{file ? "Drop more statements to replace this selection" : "Drop statements here, or click to choose"}</span>
      <span className="mt-1 block text-sm text-muted-foreground">CSV or XLSX, up to 10 MB each. Several files are imported one after another.</span>
      {/* The native input covers the zone so dropping files works without a drag-and-drop library. */}
      <input className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed" type="file" accept=".csv,.xlsx" multiple disabled={!hydrated || busy} aria-label="Financial statement files"
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []);
          if (!selected.length || !discardConfirmed()) { event.target.value = ""; return; }
          setEdited(false);
          setFiles(selected);
          setIndex(0);
          setInspection(null);
          if (selected[0]) void inspect(selected[0]);
          event.target.value = "";
        }} />
    </label>
    {!file && <p className="text-sm text-muted-foreground">Or <a className="underline" href="#connected-banks">connect a bank</a> to sync automatically.</p>}

    {busy && <p role="status" className="text-sm text-muted-foreground">{interpreting ? `Reading ${file?.name ?? "statement"}…` : "Working…"}{interpreting && <button type="button" className="ml-3 underline" onClick={clearFiles}>Cancel interpretation</button>}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}

    {file && inspection && <section className="space-y-6 rounded-xl border border-border bg-card p-4 sm:p-6" aria-label="Statement review">
      <div className="space-y-1">
        <p role="status" className="sr-only">{result ? `Statement ready to review. ${unresolved.length ? `${unresolved.length} flagged rows need a decision.` : "No flagged rows."}` : "Statement read. Choose its columns."}</p>
        <h2 ref={reviewHeading} tabIndex={-1} className="truncate text-sm font-medium text-foreground outline-none" title={`${file.name} (${index + 1} of ${files.length})`}>{file.name} <span className="font-normal text-muted-foreground">({index + 1} of {files.length})</span></h2>
        {files.length > 1 && <p className="text-sm text-muted-foreground">Next: {files.slice(index + 1).map(item => item.name).join(", ") || "none"}</p>}
        <p className="text-sm text-muted-foreground">{inspection.format ? `Recognized ${inspection.format} statement` : inspection.interpretation === "proposed" ? "Columns proposed automatically. Check the preview." : inspection.interpretation === "reviewed" ? "Your reviewed mapping" : "Unrecognized layout"} · {extension}</p>
      </div>
      {inspection.workbook && <WorkbookScopeReview key={`${index}:${file.name}:${file.lastModified}:${file.size}`} inventory={inspection.workbook.inventory} initialScope={inspection.workbookScope} busy={busy}
        onEdit={() => { setEdited(true); setMapping(null); setEditorOpen(false); setStale(false); setRowsReviewed(false); setInspection(previous => previous ? {...previous,preview:null} : null); }}
        onPreview={scope => void inspect(file, undefined, scope)} />}
      {inspection.aiError && <p className="text-sm text-muted-foreground">Automatic interpretation unavailable. Choose the columns below.</p>}
      {inspection.previewError && <p role="alert" className="text-sm text-danger">{inspection.previewError}</p>}

      {result && <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">Into</span>
          <strong className="font-semibold">{mapping?.accountRoutes?.length ? `${mapping.accountRoutes.length} accounts` : mapping?.accountName ?? result.accountName}</strong>
          <span className="text-muted-foreground">·</span><span className="text-muted-foreground">{result.currencyCode}</span>
          <span className="text-muted-foreground">·</span><span className="text-muted-foreground">{result.totalRows} rows</span>
          {result.dateRange.from && <span className="text-muted-foreground">· {result.dateRange.from} → {result.dateRange.to}</span>}
        </div>
        <p className="text-sm text-muted-foreground">
          {mapping?.debitColumn ? "Separate money out and money in columns" : mapping?.amountSign === "outflow-positive" ? "Positive amounts = outgoing" : "Positive amounts = incoming"}
          {result.pendingRows ? ` · ${result.pendingRows} pending` : ""}
          {result.classificationReviewRows ? ` · ${result.classificationReviewRows} need category review after import` : ""}
        </p>
      </div>}

      {mapping && <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="grid gap-3"><legend className="mb-2 text-sm font-medium">Accounts</legend>
          {mapping.accountRoutes?.length
            ? mapping.accountRoutes.map((route, routeIndex) => <label className="grid gap-1 text-sm" key={routeIndex}>Account for {[route.accountValue, route.productValue, route.currencyCode].filter(Boolean).join(" / ")}<input className={input} maxLength={100} value={route.accountName} onChange={event => setMapping({ ...mapping, accountRoutes: mapping.accountRoutes?.map((item, i) => i === routeIndex ? { ...item, accountName: event.target.value } : item) })} /></label>)
            : <label className="grid gap-1.5 text-sm font-medium">Account name<input className={input} maxLength={100} value={mapping.accountName} onChange={(e) => setMapping({ ...mapping, accountName: e.target.value })} /></label>}
          <p className="text-xs text-muted-foreground">Proposed from the bank and account. Rename before continuing; existing accounts with the same name and currency are reused.</p>
        </fieldset>
        <div className="grid content-start gap-3">
          <label className="grid gap-1.5 text-sm font-medium">Number format in your file
            <select className={input} value={mapping.numericConvention ?? ""} onChange={event => edit({ numericConvention: event.target.value as ImportMapping["numericConvention"] || undefined })}>
              <option value="">Select number format</option>
              <option value="decimal-dot">1,234.56</option>
              <option value="decimal-comma">1.234,56</option>
            </select>
          </label>
          {sourceAmount && <p className="text-xs text-muted-foreground">An amount from your file: <span className="font-mono">{sourceAmount}</span>. Compare it with the preview below.</p>}
          {result?.timestampReviewRequired && <div className="space-y-2 rounded-lg border border-warning/40 p-3 text-sm">
            <p>The file has times without a timezone. A wrong one can move entries near midnight to another day and change balance order.</p>
            <label className="grid gap-1.5 font-medium">Timezone used by the statement<input className={input} list="import-timezones" placeholder="e.g. Europe/Berlin" value={mapping.timestampTimezone ?? ""} onChange={event => edit({ timestampTimezone: event.target.value, timestampTimezoneConfirmed: false })} /></label>
            <datalist id="import-timezones">{Intl.supportedValuesOf("timeZone").map(zone => <option key={zone} value={zone} />)}</datalist>
            <label className="flex gap-2"><input type="checkbox" checked={mapping.timestampTimezoneConfirmed ?? false} onChange={event => setMapping({ ...mapping, timestampTimezoneConfirmed: event.target.checked })} />This timezone matches the statement.</label>
          </div>}
        </div>
      </div>}

      {result && <section className="space-y-3" aria-label="Flagged rows">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">{unresolved.length ? `${unresolved.length} flagged ${unresolved.length === 1 ? "row needs" : "rows need"} a decision` : "No flagged rows"}</h3>
          {result.acceptedRows != null && <p className="text-sm text-muted-foreground">{result.acceptedRows} accepted · {result.correctedRows ?? 0} corrected · {result.excludedRows?.length ?? 0} excluded · {unresolved.length} unresolved</p>}
        </div>
        {!!unresolved.length && <p role="alert" className="text-sm text-muted-foreground">Correct each row or exclude it with a reason. The original row is always kept.</p>}
        {unresolved.map((row, rowIndex) => <SourceRowReview key={row.rowNumber} row={row} nextRow={unresolved[rowIndex + 1]?.rowNumber} mapping={mapping!} onDecision={decision => setRowDecision(decision.rowNumber, decision)} />)}
        {decisions.filter(row => row.action === "correct").map(row => <details key={row.rowNumber} className="rounded-lg border border-border p-4 text-sm"><summary className="cursor-pointer">Corrected source row {row.rowNumber}</summary>
          <div className="mt-3"><SourceFields row={row.values} /></div>
          <button type="button" className="mt-3 underline" onClick={() => setRowDecision(row.rowNumber)}>Reset review for row {row.rowNumber}</button>
        </details>)}
        {result.excludedRows?.map(row => <details key={row.rowNumber} className="rounded-lg border border-border p-4 text-sm"><summary className="cursor-pointer">Excluded source row {row.rowNumber}: {row.reason}</summary>
          <div className="mt-3 rounded-lg bg-muted p-3"><SourceFields row={row.sourceRow} /></div>
          <button type="button" className="mt-3 underline" onClick={() => setRowDecision(row.rowNumber)}>Reset review for row {row.rowNumber}</button>
        </details>)}
        {!!decisions.length && <label className="flex gap-2 text-sm"><input type="checkbox" checked={rowsReviewed} onChange={event => setRowsReviewed(event.target.checked)} />I checked the corrections and exclusions against the original file.</label>}
      </section>}

      {inspection.warnings?.map(warning => <p key={warning} className="text-sm text-warning">{warning}</p>)}

      {result && <div className="space-y-2">
        <h3 className="text-sm font-semibold">Mapping preview</h3>
        {/* One table restyled as stacked rows on phones, so every value stays readable without sideways scrolling. */}
        <div className="rounded-lg border border-border bg-card md:overflow-x-auto"><table className="w-full text-left text-sm max-md:block md:table-fixed [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-sm [&_th]:font-medium [&_th]:text-muted-foreground md:[&_td]:px-3 md:[&_td]:py-2.5 md:[&_td]:align-top"><colgroup className="max-md:hidden"><col className="w-24" /><col /><col className="w-28" /><col className="w-20" /><col className="w-28" /><col className="w-28" /></colgroup><thead className="max-md:hidden"><tr><th>Date</th><th>Description</th><th className="text-right">Amount</th><th>Status</th><th>Merchant</th><th>Category</th></tr></thead><tbody className="max-md:block">
          {result.examples.slice(0, 10).map((row, i) => <tr key={i} className="border-border max-md:grid max-md:grid-cols-[1fr_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:p-3 [&:not(:first-child)]:border-t md:border-t">
            <td className="whitespace-nowrap tabular-nums text-muted-foreground max-md:text-xs">{row.postedOn}</td>
            <td className="break-words max-md:order-first max-md:col-span-2 max-md:font-medium md:max-w-0"><span title={row.description} className="md:line-clamp-2">{row.description}</span></td>
            <td className={`whitespace-nowrap text-right tabular-nums font-medium ${BigInt(row.amountMinor) < 0n ? "text-foreground" : "text-success"}`}>{formatMinor(row.amountMinor, row.currencyCode)}</td>
            <td className="max-md:col-span-2"><span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{row.status ?? "posted"}</span></td>
            <td className="break-words max-md:col-span-2 max-md:text-xs max-md:text-muted-foreground md:truncate" title={row.merchant ?? ""}><span className="md:hidden">Merchant: </span>{row.merchant ?? "—"}</td>
            <td className="break-words max-md:col-span-2 max-md:text-xs max-md:text-muted-foreground md:truncate" title={row.category ?? ""}><span className="md:hidden">Category: </span>{row.category ?? "Uncategorized"}</td>
          </tr>)}
        </tbody></table></div>
        <p className="text-xs text-muted-foreground">First {Math.min(result.examples.length, 10)} interpreted entries. Signs, dates and amounts should match your statement.</p>
      </div>}

      {editorOpen && mapping && <div className="space-y-4 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Columns</h3>
        <p className="text-xs text-muted-foreground md:hidden">Your file's first rows. Swipe sideways to see every column.</p>
        <div tabIndex={0} role="region" aria-label="First rows of your file" className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm [&_td]:max-w-64 [&_td]:truncate [&_td]:px-3 [&_td]:py-2 [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-sm [&_th]:font-medium [&_th]:text-muted-foreground"><thead><tr>{inspection.headers.map((header) => <th key={header} title={header}>{header}</th>)}</tr></thead><tbody>
          {inspection.sample.slice(0, 3).map((row, i) => <tr className="border-t border-border" key={i}>{inspection.headers.map((header) => <td key={header} title={row[header]}>{row[header]}</td>)}</tr>)}
        </tbody></table></div>
        <div className="grid gap-3 sm:grid-cols-3">
          {chooseColumn("Date", "dateColumn")}
          <label className="grid gap-1.5 text-sm">Date format<select className={input} value={mapping.dateFormat} onChange={(e) => edit({ dateFormat: e.target.value as ImportMapping["dateFormat"] })}><option value="iso">YYYY-MM-DD</option><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label>
          {chooseColumn("Description", "descriptionColumn")}
        </div>
        <fieldset className="space-y-3"><legend className="text-sm font-medium">How does your file show amounts?</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex min-h-10 items-center gap-2"><input type="radio" name="amount-layout" checked={!splitAmounts} onChange={() => { setSplitAmounts(false); edit({ debitColumn: undefined, creditColumn: undefined }); }} />One column, like -12.50 or 12.50</label>
            <label className="flex min-h-10 items-center gap-2"><input type="radio" name="amount-layout" checked={splitAmounts} onChange={() => { setSplitAmounts(true); edit({ amountColumn: undefined }); }} />Two columns, money out and money in</label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {splitAmounts ? <>{chooseColumn("Money out", "debitColumn")}{chooseColumn("Money in", "creditColumn")}</> : <>
              {chooseColumn("Amount", "amountColumn")}
              <label className="grid gap-1.5 text-sm">Amount signs<select className={input} value={mapping.amountSign} onChange={(e) => edit({ amountSign: e.target.value as ImportMapping["amountSign"] })}><option value="signed">Positive is incoming (a purchase is -12.50)</option><option value="outflow-positive">Positive is outgoing (a purchase is 12.50)</option></select></label>
            </>}
            <label className="grid gap-1.5 text-sm">Currency code<input className={input} maxLength={3} value={mapping.currencyCode} onChange={(e) => edit({ currencyCode: e.target.value.toUpperCase() })} /></label>
          </div>
        </fieldset>
        <details open={moreColumnsOpen} onToggle={event => setMoreColumnsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm font-medium">More columns (optional)</summary>
          <p className="mt-2 text-sm text-muted-foreground">Choose these only if your file has them. Currency is for files with several currencies, and Account and Product split one file across accounts. Transaction type holds words like Transfer or Refund. Fee is a separate charge on the row. Transaction ID is the bank reference, which helps spot duplicates.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">{MORE_COLUMNS.map(([label, key]) => chooseColumn(label, key, true))}</div>
        </details>
      </div>}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        {result && !stale && <p className="w-full text-sm text-muted-foreground">This is the last step before anything is saved. Start import adds up to {result.acceptedRows ?? result.totalRows} rows to {mapping?.accountRoutes?.length ? `${mapping.accountRoutes.length} accounts` : mapping?.accountName || result.accountName}{result.excludedRows?.length ? ` and leaves out ${result.excludedRows.length}` : ""}. Rows you already imported are skipped, and rows that may overlap are held for your review. It runs in the background, so you can leave this page.</p>}
        {result && !stale && <button type="button" className={primary} disabled={busy || !mappingReady || !flaggedReady} onClick={() => void confirm()}>Start import</button>}
        {mapping && (editorOpen || stale) && <button type="button" className={stale ? primary : secondary} disabled={busy} onClick={() => void inspect(file, mapping)}>Preview correction</button>}
        {result && !editorOpen && <button type="button" className={secondary} onClick={() => setEditorOpen(true)}>Correct</button>}
        {index + 1 < files.length && <button type="button" className={secondary} disabled={busy} onClick={skipFile}>Skip this file</button>}
        <button type="button" className={secondary} onClick={() => { if (discardConfirmed()) clearFiles(); }}>{files.length > 1 ? "Cancel all files" : "Cancel"}</button>
        {result && !stale && !mappingReady && <p className="text-sm text-muted-foreground">{!mapping?.numericConvention ? "Choose the number format to continue." : namesMissing ? "Name every account to continue." : "Confirm the timezone to continue."}</p>}
      </div>
    </section>}

    <ConnectedBanks />

    <section className="space-y-4" aria-label="Import history">
      <h2 className="text-sm font-medium text-foreground">Import history</h2>
      {historyState === "failed" && <div className="space-y-1"><p role="alert" className="text-sm text-danger">{HISTORY_UNAVAILABLE}</p><button type="button" className="text-sm underline" onClick={() => void loadHistory()}>Reload history</button></div>}
      {historyState === "loading" && <p role="status" className="text-sm text-muted-foreground">Loading imports…</p>}
      {historyState === "loaded" && !visibleHistory.length && <p className="text-sm text-muted-foreground">No imports yet.</p>}
      {visibleHistory.length > 0 && <p className="text-sm text-muted-foreground">{history.length >= 30 ? "Your 30 most recent imports. " : ""}Already imported rows were in Moneo before and are not added twice. Left out rows stay on record but are not in your totals.</p>}
      {[...days].map(([label, items]) => <div key={label} className="space-y-3">
        <h3 className="eyebrow">{label}</h3>
        <ol className="space-y-3 border-l border-border pl-5">{items.map((item) => {
          const processed = item.new_rows + item.matched_rows + item.review_rows + item.rejected_rows;
          const recent = confirmedIds.includes(item.id);
          return <li key={item.id} className="relative">
            <span aria-hidden className={`absolute -left-[26px] top-6 size-2.5 rounded-full ring-4 ring-background ${item.status === "failed" ? "bg-danger" : active(item.status) ? "bg-warning" : item.status === "canceled" ? "bg-muted-foreground" : "bg-brand"}`} />
            <article className={`space-y-3 rounded-xl border bg-card p-5 ${recent ? "border-brand" : "border-border"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="truncate">{item.filename}</strong>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">{new Date(item.created_at).toLocaleTimeString(undefined, { timeStyle: "short" })}<span role="status" className="rounded-lg bg-muted px-2.5 py-1 font-medium capitalize text-brand">{item.status}</span></span></div>
              {active(item.status) && <div className="space-y-1"><progress className="h-2 w-full overflow-hidden rounded-full accent-brand" aria-label={`Progress for ${item.filename}`} max={Math.max(item.total_rows, 1)} value={Math.min(processed, item.total_rows)} />
                <p className="text-xs text-muted-foreground">{item.status === "queued" ? "Waiting to start" : `${Math.min(processed, item.total_rows)} of ${item.total_rows} processed`}. You can leave this page; the import keeps running.</p></div>}
              <p className="text-sm text-muted-foreground">{item.new_rows} new · {item.matched_rows} already imported · {item.review_rows} to review · {item.rejected_rows} left out · {item.total_rows} total{item.classification_review_rows ? `. ${item.classification_review_rows} new rows need a transaction type.` : ""}</p>
              {recent && item.status === "completed" && <p className="text-sm">{item.review_rows || item.classification_review_rows ? "Imported. A few rows need your decision before totals are complete." : "Imported. Nothing needs review. If anything looks wrong, Undo import shows what it would remove."}</p>}
              {item.error && <p className="text-sm text-danger">{item.error}</p>}
              {item.status === "canceled" && <p className="text-sm text-muted-foreground">Stopped. Rows already imported are kept, and resuming will not duplicate them.</p>}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"><Link className="underline" href={`/import/${item.id}/review`}>Review rows and source coverage{item.classification_review_rows ? ` · ${item.classification_review_rows} need a type` : ""}</Link>
                <Link className="underline" href={`/money/organization?import=${item.id}`}>Organize imported spending</Link>
                {item.status === "completed" && <Link className="font-medium text-brand underline" href={`/ai/agents?import=${item.id}`}>Watch the agent team</Link>}
                {active(item.status) && <button className="underline" type="button" disabled={busy} onClick={() => void control(item, "cancel")}>Stop import</button>}
                {["failed", "canceled"].includes(item.status) && <button className="underline" type="button" disabled={busy} onClick={() => void control(item, "resume")}>{item.status === "canceled" ? "Resume import" : "Retry"}</button>}
                {item.status === "completed" && <button className="ml-auto text-danger underline" type="button" disabled={busy} onClick={() => void showUndo(item.id)}>Undo import</button>}</div>
              {undoId === item.id && preview && <div className="space-y-3 rounded-lg bg-muted p-4 text-sm">
                <p><strong>Undo impact:</strong> remove {preview.deletable_transactions} transactions and {preview.deletable_balances} balance snapshots. This import will disappear from history. The source file and matched links are kept.</p>
                {preview.blockers.length > 0
                  ? <ul className="list-disc pl-5">{preview.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  : <div className="flex flex-wrap gap-2">
                      <button type="button" className={primary} disabled={busy} onClick={() => void confirmUndo()}>Confirm undo {preview.deletable_transactions} transactions</button>
                      <button type="button" className={secondary} disabled={busy} onClick={() => { setUndoId(null); setPreview(null); }}>Keep import</button>
                    </div>}
              </div>}
            </article>
          </li>;
        })}</ol>
      </div>)}
    </section>
  </main>;
}
