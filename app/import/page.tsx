"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import type { ImportMapping, SourceRow } from "@/lib/csv";
import { formatMoney } from "@/lib/finance/format";

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
type Inspection = { headers: string[]; sample: SourceRow[]; mapping: ImportMapping | null; preview: Preview | null; aiError?: string; previewError?: string; warnings?: string[] };
type ImportStatus = { id: string; filename: string; status: string; run_version: number; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; classification_review_rows?: number; rejected_rows: number; error: string | null; created_at: string };
type HistoryUpdate = Partial<ImportStatus> & Pick<ImportStatus, "id" | "status" | "run_version">;
type UndoPreview = { import_id: string; filename: string; status: string; deletable_transactions: number; deletable_balances: number; blockers: string[]; safe: boolean };

function formatMinor(value: string, currency: string) {
  const amount = BigInt(value);
  return `${amount >= 0n ? "+" : ""}${formatMoney(amount, currency)}`;
}

const subscribeToHydration = () => () => {};

function SourceRowReview({ row, mapping, onDecision }: { row: { rowNumber: number; sourceRow: SourceRow }; mapping: ImportMapping;
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
  return <article className="space-y-3 rounded-lg border border-border p-3 text-sm">
    <h3 className="font-medium">Review source row {row.rowNumber}</h3>
    <details><summary>Original source evidence</summary><pre className="whitespace-pre-wrap">{JSON.stringify(row.sourceRow, null, 2)}</pre></details>
    {parserReview && <p role="alert">The source has a different number of cells than its headers. Review every mapped cell against the original evidence before using a correction.</p>}
    <div className="grid gap-2 sm:grid-cols-2">{Object.keys(row.sourceRow).filter(column => !column.startsWith("__moneo_csv_")).map(column => <label key={column} className="grid gap-1">{column}<input aria-label={`Source row ${row.rowNumber} ${column}`} className="rounded border border-border bg-card p-2" value={values[column]} onChange={event => setValues({ ...values, [column]: event.target.value })} /></label>)}</div>
    <button type="button" className="rounded border border-border px-3 py-2" disabled={!Object.keys(correction).length} onClick={() => onDecision({ rowNumber: row.rowNumber, action: "correct", values: correction })}>Use correction for row {row.rowNumber}</button>
    <label className="grid gap-1">Exclusion reason for row {row.rowNumber}<input className="rounded border border-border bg-card p-2" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
    <button type="button" className="rounded border border-border px-3 py-2" disabled={!reason.trim()} onClick={() => onDecision({ rowNumber: row.rowNumber, action: "exclude", reason })}>Exclude row {row.rowNumber}</button>
    <p className="text-muted-foreground">Preview the updated interpretation before continuing. Corrections and exclusions retain the original source evidence.</p>
  </article>;
}

export default function ImportPage() {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [files, setFiles] = useState<File[]>([]);
  const [index, setIndex] = useState(0);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState("");
  const [rowsReviewed, setRowsReviewed] = useState(false);
  const [history, setHistory] = useState<ImportStatus[]>([]);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [preview, setPreview] = useState<UndoPreview | null>(null);
  const controlRequests = useRef(new Map<string, string>());
  const inspectionRequest = useRef<AbortController | null>(null);
  const historyRequest = useRef(0);
  const historyApplied = useRef(new Map<string, number>());
  const file = files[index];

  useEffect(() => () => inspectionRequest.current?.abort(), []);

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
      setError((current) => current === "Import history is unavailable. Try again." ? "" : current);
    } catch { setError("Import history is unavailable. Try again."); }
  }

  useEffect(() => {
    const requestOrder = ++historyRequest.current;
    fetch("/api/imports", { cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(async (response) => {
      if (!response.ok) throw new Error("History unavailable");
      mergeHistory(await response.json(), requestOrder);
    }).catch(() => setError("Import history is unavailable. Try again."));
  }, []);
  useEffect(() => {
    if (!history.some((item) => item.status === "queued" || item.status === "running")) return;
    const timer = setInterval(async () => {
      const requestOrder = ++historyRequest.current;
      try {
      const active = history.filter((item) => item.status === "queued" || item.status === "running");
      const updates = await Promise.all(active.map(async (item) => {
        const response = await fetch(`/api/imports/${item.id}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("History unavailable");
        return await response.json() as ImportStatus;
      }));
      mergeHistory(updates, requestOrder);
      } catch { setError("Import history is unavailable. Try again."); }
    }, 3000);
    return () => clearInterval(timer);
  }, [history]);

  async function inspect(target: File, corrected?: ImportMapping) {
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
      const response = await fetch("/api/imports/inspect", { method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
      const result = await response.json();
      if (inspectionRequest.current !== controller) return;
      if (!response.ok) throw new Error(result.error ?? "Inspection failed");
      setInspection(result);
      const column = (name: string) => result.headers.find((header: string) => header.toLowerCase() === name);
      setMapping(result.mapping ?? {
        accountName: target.name.replace(/\.(csv|xlsx)$/i, ""),
        currencyCode: "EUR",
        dateColumn: column("completed date") ?? column("date") ?? column("started date") ?? "",
        descriptionColumn: column("description") ?? "",
        amountColumn: column("amount"),
        dateFormat: "iso",
        amountSign: "signed",
      });
      setEditing(!result.mapping || !result.preview || result.mapping.amountSign === "outflow-positive");
    } catch (cause) {
      if (inspectionRequest.current !== controller) return;
      setError(cause instanceof Error ? cause.message : "Inspection failed");
    } finally {
      if (inspectionRequest.current === controller) { inspectionRequest.current = null; setBusy(false); setInterpreting(false); }
    }
  }

  function cancelInspection() {
    inspectionRequest.current?.abort();
    inspectionRequest.current = null;
    setFiles([]); setInspection(null); setMapping(null); setBusy(false); setInterpreting(false); setError("");
  }

  async function confirm() {
    if (!file || !mapping) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      const response = await fetch("/api/imports/confirm", { method: "POST", body: form, signal: AbortSignal.timeout(45_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Import failed");
      await loadHistory();
      setInspection(null);
      setMapping(null);
      if (index + 1 < files.length) {
        setIndex(index + 1);
        await inspect(files[index + 1]);
      } else {
        setFiles([]);
        setIndex(0);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function resetRowDecision(rowNumber: number) {
    setMapping(current => current && ({ ...current, rowDecisions: (current.rowDecisions ?? []).filter(row => row.rowNumber !== rowNumber) }));
    setEditing(true); setRowsReviewed(false);
  }

  async function control(item: ImportStatus, action: "cancel" | "resume") {
    setBusy(true);
    setError("");
    try {
      const key = `${item.id}:${item.run_version}:${action}`;
      if (!controlRequests.current.has(key)) controlRequests.current.set(key, crypto.randomUUID());
      const response = await fetch(`/api/imports/${item.id}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId: controlRequests.current.get(key) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Retry failed");
      mergeHistory([{ id: item.id, status: result.status, run_version: result.runVersion, total_rows: result.totalRows, error: null }], ++historyRequest.current);
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }

  async function showUndo(id: string) {
    setBusy(true);
    setError("");
    setUndoId(id);
    setPreview(null);
    try {
      const response = await fetch(`/api/imports/${id}/undo`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Undo preview failed");
      setPreview(result as UndoPreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Undo preview failed");
      setUndoId(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmUndo() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Undo failed");
    } finally {
      setBusy(false);
    }
  }

  const chooseColumn = (label: string, key: keyof ImportMapping, optional = false) => (
    <label className="grid gap-1 text-sm" key={key}>
      {label}
      <select className="rounded-lg border border-border bg-card px-3 py-2" value={String(mapping?.[key] ?? "")}
        onChange={(event) => setMapping((current) => current && ({ ...current, [key]: event.target.value || undefined,
          ...(["accountColumn", "productColumn", "currencyColumn"].includes(key) ? { accountRoutes: undefined } : {}) }))}>
        {optional && <option value="">None</option>}
        {!optional && <option value="">Select column</option>}
        {inspection?.headers.map((header) => <option key={header} value={header}>{header}</option>)}
      </select>
    </label>
  );

  const visibleHistory = history.filter((item) => item.status !== "undone");

  return <main className="mx-auto max-w-5xl space-y-6 px-5 py-8 lg:px-8">
    <div><p className="text-xs font-semibold uppercase tracking-widest text-brand">Money / Import</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Import financial data</h1><p className="mt-2 text-sm text-muted-foreground">Choose CSV or XLSX statements. We&apos;ll propose an interpretation for you to review before importing.</p></div>
    <label className="block rounded-xl border border-dashed border-blue-300 bg-card p-8 text-center shadow-sm hover:bg-muted/40"><span className="block text-base font-semibold">Choose statements to import</span><span className="mt-1 block text-sm text-muted-foreground">CSV or XLSX files · You can select more than one</span><input className="mt-5 w-full max-w-xs text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-4 file:py-2 file:font-medium file:text-white" type="file" accept=".csv,.xlsx" multiple disabled={!hydrated || busy} aria-label="Financial statement files"
      onChange={(event) => {
        const selected = Array.from(event.target.files ?? []);
        setFiles(selected);
        setIndex(0);
        setInspection(null);
        if (selected[0]) void inspect(selected[0]);
      }} /></label>
    <section className="space-y-3" aria-label="Import history">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">Import history</h2>
      {error === "Import history is unavailable. Try again." && <button type="button" className="text-sm underline" onClick={() => void loadHistory()}>Reload history</button>}
      {!visibleHistory.length && error !== "Import history is unavailable. Try again." && <p>No imports yet.</p>}
      {visibleHistory.map((item) => <article key={item.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{item.filename}</strong><span role="status" className="rounded-lg bg-muted px-2.5 py-1 text-xs font-medium capitalize text-brand">{item.status}</span></div>
        <p className="text-sm">{item.new_rows} new · {item.matched_rows} matched · {item.review_rows} for review · {item.rejected_rows} rejected · {item.total_rows} total</p>
        {item.error && <p className="text-sm text-red-700">{item.error}</p>}
        <Link className="text-sm underline" href={`/import/${item.id}/review`}>Review rows and source coverage{item.classification_review_rows ? ` · ${item.classification_review_rows} financial classifications` : ""}</Link>
        {["queued", "running"].includes(item.status) && <button className="ml-3 text-sm underline" type="button" disabled={busy} onClick={() => void control(item, "cancel")}>Stop import</button>}
        {["failed", "canceled"].includes(item.status) && <button className="ml-3 text-sm underline" type="button" disabled={busy} onClick={() => void control(item, "resume")}>{item.status === "canceled" ? "Resume import" : "Retry"}</button>}
        {item.status === "canceled" && <p className="mt-2 text-xs text-muted-foreground">Stopped. Already imported rows and their sources remain saved; resume continues the same file without duplicating them.</p>}
        {item.status === "completed" && <button className="ml-3 text-sm underline" type="button" disabled={busy} onClick={() => void showUndo(item.id)}>Undo import</button>}
        {undoId === item.id && preview && <div className="mt-3 space-y-2 rounded bg-muted p-3 text-sm">
          <p><strong>Undo impact:</strong> remove {preview.deletable_transactions} transactions and {preview.deletable_balances} balance snapshots. This import will disappear from history. Source file and matched links are kept.</p>
          {preview.blockers.length > 0
            ? <ul className="list-disc pl-5">{preview.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            : <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-lg bg-brand px-3 py-2 text-white hover:opacity-90" disabled={busy} onClick={() => void confirmUndo()}>Confirm undo {preview.deletable_transactions} transactions</button>
                <button type="button" className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted" disabled={busy} onClick={() => { setUndoId(null); setPreview(null); }}>Keep import</button>
              </div>}
        </div>}
      </article>)}
    </section>
    {busy && <p role="status">Working…{interpreting && <button type="button" className="ml-3 underline" onClick={cancelInspection}>Cancel interpretation</button>}</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {file && inspection && <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{file.name} ({index + 1} of {files.length})</h2>
      {inspection.aiError && <p>Automatic interpretation unavailable. Choose the columns below.</p>}
      {inspection.previewError && <p role="alert">{inspection.previewError}</p>}
      {mapping && <label className="grid gap-1 text-sm">Source numeric convention
        <select className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.numericConvention ?? ""} onChange={event => { setMapping({ ...mapping, numericConvention: event.target.value as ImportMapping["numericConvention"] || undefined }); setEditing(true); }}>
          <option value="">Select the statement&apos;s number format</option>
          <option value="decimal-dot">Decimal dot, comma grouping: 1,234.567</option>
          <option value="decimal-comma">Decimal comma, dot grouping: 1.234,567</option>
        </select>
        <span className="text-muted-foreground">Check the original amounts, fees and balances, then preview this convention before continuing.</span>
      </label>}
      {editing && <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_td]:px-3 [&_td]:py-3"><thead><tr>{inspection.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>
        {inspection.sample.slice(0, 3).map((row, i) => <tr className="border-t border-border" key={i}>{inspection.headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>)}
      </tbody></table></div>}
      {inspection.preview && <>
        {inspection.preview.acceptedRows != null && <p>{inspection.preview.acceptedRows} accepted · {inspection.preview.correctedRows ?? 0} corrected · {inspection.preview.excludedRows?.length ?? 0} excluded · {inspection.preview.unresolvedRows?.length ?? 0} unresolved</p>}
        {!!inspection.preview.unresolvedRows?.length && <div role="alert" className="space-y-2 rounded-lg border border-amber-300 p-3 text-sm">
          <p>{inspection.preview.acceptedRows} of {inspection.preview.totalRows} source rows are valid. Resolve the remaining observations before importing; the original source stays unchanged.</p>
          <ul>{inspection.preview.unresolvedRows.map(row => <li key={row.rowNumber}>{row.message}</li>)}</ul>
        </div>}
        {inspection.preview.unresolvedRows?.map(row => <SourceRowReview key={row.rowNumber} row={row} mapping={mapping!} onDecision={decision => {
          setMapping(current => current && ({ ...current, rowDecisions: [...(current.rowDecisions ?? []).filter(item => item.rowNumber !== decision.rowNumber), decision] }));
          setEditing(true); setRowsReviewed(false);
        }} />)}
        {mapping?.rowDecisions?.filter(row => row.action === "correct").map(row => <details key={row.rowNumber} className="rounded-lg border border-border p-3 text-sm"><summary>Corrected source row {row.rowNumber}</summary>
          <dl>{Object.entries(row.values).map(([column, value]) => <div key={column}><dt className="font-medium">{column}</dt><dd>{value}</dd></div>)}</dl>
          <button type="button" className="underline" onClick={() => resetRowDecision(row.rowNumber)}>Reset review for row {row.rowNumber}</button>
        </details>)}
        {inspection.preview.excludedRows?.map(row => <details key={row.rowNumber} className="rounded-lg border border-border p-3 text-sm"><summary>Excluded source row {row.rowNumber}: {row.reason}</summary><pre className="whitespace-pre-wrap">{JSON.stringify(row.sourceRow, null, 2)}</pre>
          <button type="button" className="underline" onClick={() => resetRowDecision(row.rowNumber)}>Reset review for row {row.rowNumber}</button>
        </details>)}
        {!!mapping?.rowDecisions?.length && <label className="flex gap-2 text-sm"><input type="checkbox" checked={rowsReviewed} onChange={event => setRowsReviewed(event.target.checked)} />I reviewed the corrections and exclusions against the original source.</label>}
        {inspection.preview.timestampReviewRequired && mapping && <div className="space-y-2 rounded-lg border border-amber-300 p-3 text-sm">
          <p>Source timestamps have no offset. The proposed timezone needs your confirmation; incorrect clock interpretation changes dates and balance order.</p>
          <label className="grid gap-1">Source timestamp timezone<input className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.timestampTimezone ?? ""} onChange={event => { setMapping({ ...mapping, timestampTimezone: event.target.value, timestampTimezoneConfirmed: false }); setEditing(true); }} /></label>
          <label className="flex gap-2"><input type="checkbox" checked={mapping.timestampTimezoneConfirmed ?? false} onChange={event => setMapping({ ...mapping, timestampTimezoneConfirmed: event.target.checked })} />I confirmed this timezone matches the statement&apos;s source clock.</label>
        </div>}
        {!!inspection.preview.classificationReviewRows && <p className="text-sm text-amber-700 dark:text-amber-300">{inspection.preview.classificationReviewRows} rows need financial classification. Their booked amounts will be preserved; income and spending remain partial until reviewed.</p>}
        {inspection.preview.accounts?.map(account => <p key={`${account.accountName}:${account.currencyCode}`}><strong>{account.accountName}</strong> · {account.currencyCode} · {account.rows} rows</p>)}
        {inspection.warnings?.map(warning => <p key={warning} className="text-sm text-amber-700 dark:text-amber-300">{warning}</p>)}
        <p><strong>Account:</strong> {inspection.preview.accountName} · <strong>Currency:</strong> {inspection.preview.currencyCode}</p>
        <p className="text-sm text-muted-foreground">Check the currency and incoming/outgoing amounts below. {mapping?.amountSign === "outflow-positive" ? "Positive source amounts are treated as outgoing; review this sign convention before continuing." : "Positive source amounts are treated as incoming."}</p>
        <p><strong>{inspection.preview.totalRows} rows</strong> · {inspection.preview.dateRange.from ? `${inspection.preview.dateRange.from} to ${inspection.preview.dateRange.to}` : "No accepted posting dates"}{inspection.preview.pendingRows != null && inspection.preview.pendingRows > 0 ? ` · ${inspection.preview.pendingRows} pending (excluded from posted spending)` : ""}</p>
        <p className="text-sm text-muted-foreground">Descriptions stay exactly as in the file. Merchants/categories below come only from explicit columns when present. Pending rows stay pending and never count as posted spending.</p>
        <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_td]:px-3 [&_td]:py-3"><thead><tr><th>Date</th><th>Description</th><th>Incoming / outgoing</th><th>Status</th><th>Merchant</th><th>Category</th></tr></thead><tbody>
          {inspection.preview.examples.map((row, i) => <tr key={i} className="border-t"><td>{row.postedOn}</td><td>{row.description}</td><td>{formatMinor(row.amountMinor, row.currencyCode)}</td><td>{row.status ?? "posted"}</td><td>{row.merchant ?? "—"}</td><td>{row.category ?? "Uncategorized"}</td></tr>)}
        </tbody></table></div>
      </>}
      {editing && mapping && <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Account name<input className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.accountName} onChange={(e) => setMapping({ ...mapping, accountName: e.target.value })} /></label>
        <label className="grid gap-1 text-sm">Currency code<input className="rounded-lg border border-border bg-card px-3 py-2" maxLength={3} value={mapping.currencyCode} onChange={(e) => setMapping({ ...mapping, currencyCode: e.target.value.toUpperCase() })} /></label>
        {chooseColumn("Date", "dateColumn")}{chooseColumn("Description", "descriptionColumn")}
        {chooseColumn("Amount", "amountColumn", true)}
        {chooseColumn("Debit", "debitColumn", true)}{chooseColumn("Credit", "creditColumn", true)}
        {chooseColumn("Currency", "currencyColumn", true)}{chooseColumn("Balance", "balanceColumn", true)}
        {chooseColumn("Source account", "accountColumn", true)}{chooseColumn("Product", "productColumn", true)}
        {chooseColumn("Source financial type", "typeColumn", true)}{chooseColumn("Source fee evidence", "feeColumn", true)}
        {mapping.accountRoutes?.map((route, routeIndex) => <label className="grid gap-1 text-sm" key={routeIndex}>Account for {[route.accountValue, route.productValue, route.currencyCode].filter(Boolean).join(" / ")}<input className="rounded-lg border border-border bg-card px-3 py-2" value={route.accountName} onChange={event => setMapping({ ...mapping, accountRoutes: mapping.accountRoutes?.map((item, i) => i === routeIndex ? { ...item, accountName: event.target.value } : item) })} /></label>)}
        {chooseColumn("Merchant", "merchantColumn", true)}{chooseColumn("Category", "categoryColumn", true)}{chooseColumn("External ID", "externalIdColumn", true)}{chooseColumn("Status (posted/pending/completed)", "statusColumn", true)}
        <label className="grid gap-1 text-sm">Date format<select className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as ImportMapping["dateFormat"] })}><option value="iso">YYYY-MM-DD</option><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label>
        <label className="grid gap-1 text-sm">Amount signs<select className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.amountSign} onChange={(e) => setMapping({ ...mapping, amountSign: e.target.value as ImportMapping["amountSign"] })}><option value="signed">Positive is incoming</option><option value="outflow-positive">Positive is outgoing</option></select></label>
        <div className="sm:col-span-2"><button type="button" className="rounded-lg bg-brand px-4 py-2 text-white hover:opacity-90" disabled={busy} onClick={() => void inspect(file, mapping)}>Preview correction</button></div>
      </div>}
      <div className="flex gap-3">
        {inspection.preview && !editing && <button type="button" className="rounded-lg bg-brand px-4 py-2 text-white hover:opacity-90" disabled={busy || !!inspection.preview.unresolvedRows?.length || (!!mapping?.rowDecisions?.length && !rowsReviewed) || !mapping?.numericConvention || (!!inspection.preview.timestampReviewRequired && !mapping?.timestampTimezoneConfirmed)} onClick={() => void confirm()}>Continue</button>}
        {inspection.preview && !editing && <button type="button" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted" onClick={() => setEditing(true)}>Correct</button>}
        <button type="button" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted" onClick={() => { setFiles([]); setInspection(null); setMapping(null); }}>Cancel</button>
      </div>
    </section>}
  </main>;
}
