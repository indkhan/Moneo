"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ImportMapping, SourceRow } from "@/lib/csv";

type Preview = {
  accountName: string;
  currencyCode: string;
  totalRows: number;
  pendingRows?: number;
  postedRows?: number;
  dateRange: { from: string; to: string };
  examples: { postedOn: string; description: string; amountMinor: string; currencyCode: string; status?: string; merchant?: string; category?: string }[];
};
type Inspection = { headers: string[]; sample: SourceRow[]; mapping: ImportMapping | null; preview: Preview | null; aiError?: string };
type ImportStatus = { id: string; filename: string; status: string; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; rejected_rows: number; error: string | null; created_at: string };
type UndoPreview = { import_id: string; filename: string; status: string; deletable_transactions: number; deletable_balances: number; blockers: string[]; safe: boolean };

function formatMinor(value: string, currency: string) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "−" : "+"}${currency} ${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export default function ImportPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [index, setIndex] = useState(0);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<ImportStatus[]>([]);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [preview, setPreview] = useState<UndoPreview | null>(null);
  const file = files[index];

  async function loadHistory() {
    const response = await fetch("/api/imports", { cache: "no-store" });
    if (response.ok) setHistory(await response.json());
  }

  useEffect(() => {
    fetch("/api/imports", { cache: "no-store" }).then(async (response) => {
      if (response.ok) setHistory(await response.json());
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!history.some((item) => item.status === "queued" || item.status === "running")) return;
    const timer = setInterval(async () => {
      const active = history.filter((item) => item.status === "queued" || item.status === "running");
      const updates = await Promise.all(active.map(async (item) => {
        const response = await fetch(`/api/imports/${item.id}`, { cache: "no-store" });
        return response.ok ? await response.json() as ImportStatus : item;
      }));
      setHistory((current) => current.map((item) => updates.find((update) => update.id === item.id) ?? item));
    }, 3000);
    return () => clearInterval(timer);
  }, [history]);

  async function inspect(target: File, corrected?: ImportMapping) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", target);
      if (corrected) form.set("mapping", JSON.stringify(corrected));
      const response = await fetch("/api/imports/inspect", { method: "POST", body: form });
      const result = await response.json();
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
      setEditing(!result.mapping || result.mapping.amountSign === "outflow-positive");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Inspection failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!file || !mapping) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      const response = await fetch("/api/imports/confirm", { method: "POST", body: form });
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

  async function retry(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${id}/retry`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Retry failed");
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
        onChange={(event) => setMapping((current) => current && ({ ...current, [key]: event.target.value || undefined }))}>
        {optional && <option value="">None</option>}
        {!optional && <option value="">Select column</option>}
        {inspection?.headers.map((header) => <option key={header} value={header}>{header}</option>)}
      </select>
    </label>
  );

  return <main className="mx-auto max-w-5xl space-y-6 px-5 py-8 lg:px-8">
    <div><p className="text-xs font-semibold uppercase tracking-widest text-brand">Money / Import</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Import financial data</h1><p className="mt-2 text-sm text-muted-foreground">Choose CSV or XLSX statements. We&apos;ll propose an interpretation for you to review before importing.</p></div>
    <label className="block rounded-xl border border-dashed border-blue-300 bg-card p-8 text-center shadow-sm hover:bg-muted/40"><span className="block text-base font-semibold">Choose statements to import</span><span className="mt-1 block text-sm text-muted-foreground">CSV or XLSX files · You can select more than one</span><input className="mt-5 w-full max-w-xs text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-4 file:py-2 file:font-medium file:text-white" type="file" accept=".csv,.xlsx" multiple disabled={busy} aria-label="Financial statement files"
      onChange={(event) => {
        const selected = Array.from(event.target.files ?? []);
        setFiles(selected);
        setIndex(0);
        setInspection(null);
        if (selected[0]) void inspect(selected[0]);
      }} /></label>
    <section className="space-y-3" aria-label="Import history">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">Import history</h2>
      {!history.length && <p>No imports yet.</p>}
      {history.map((item) => <article key={item.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{item.filename}</strong><span role="status" className="rounded-lg bg-muted px-2.5 py-1 text-xs font-medium capitalize text-brand">{item.status}</span></div>
        <p className="text-sm">{item.new_rows} new · {item.matched_rows} matched · {item.review_rows} for review · {item.rejected_rows} rejected · {item.total_rows} total</p>
        {item.error && <p className="text-sm text-red-700">{item.error}</p>}
        {item.review_rows > 0 && <Link className="text-sm underline" href={`/import/${item.id}/review`}>Review rows</Link>}
        {item.status === "failed" && <button className="ml-3 text-sm underline" type="button" disabled={busy} onClick={() => void retry(item.id)}>Retry</button>}
        {item.status === "completed" && <button className="ml-3 text-sm underline" type="button" disabled={busy} onClick={() => void showUndo(item.id)}>Undo import</button>}
        {undoId === item.id && preview && <div className="mt-3 space-y-2 rounded bg-muted p-3 text-sm">
          <p><strong>Undo impact:</strong> remove {preview.deletable_transactions} transactions and {preview.deletable_balances} balance snapshots. Source file, import history and matched links are kept.</p>
          {preview.blockers.length > 0
            ? <ul className="list-disc pl-5">{preview.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            : <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-lg bg-brand px-3 py-2 text-white hover:opacity-90" disabled={busy} onClick={() => void confirmUndo()}>Confirm undo {preview.deletable_transactions} transactions</button>
                <button type="button" className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted" disabled={busy} onClick={() => { setUndoId(null); setPreview(null); }}>Keep import</button>
              </div>}
        </div>}
      </article>)}
    </section>
    {busy && <p role="status">Working…</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {file && inspection && <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{file.name} ({index + 1} of {files.length})</h2>
      {inspection.aiError && <p>Automatic interpretation unavailable. Choose the columns below.</p>}
      {editing && <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_td]:px-3 [&_td]:py-3"><thead><tr>{inspection.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>
        {inspection.sample.slice(0, 3).map((row, i) => <tr className="border-t border-border" key={i}>{inspection.headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>)}
      </tbody></table></div>}
      {inspection.preview && <>
        <p><strong>Account:</strong> {inspection.preview.accountName} · <strong>Currency:</strong> {inspection.preview.currencyCode}</p>
        <p className="text-sm text-muted-foreground">Check the currency and incoming/outgoing amounts below. {mapping?.amountSign === "outflow-positive" ? "Positive source amounts are treated as outgoing; review this sign convention before continuing." : "Positive source amounts are treated as incoming."}</p>
        <p><strong>{inspection.preview.totalRows} rows</strong> · {inspection.preview.dateRange.from} to {inspection.preview.dateRange.to}{inspection.preview.pendingRows != null && inspection.preview.pendingRows > 0 ? ` · ${inspection.preview.pendingRows} pending (excluded from posted spending)` : ""}</p>
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
        {chooseColumn("Merchant", "merchantColumn", true)}{chooseColumn("Category", "categoryColumn", true)}{chooseColumn("External ID", "externalIdColumn", true)}{chooseColumn("Status (posted/pending only)", "statusColumn", true)}
        <label className="grid gap-1 text-sm">Date format<select className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as ImportMapping["dateFormat"] })}><option value="iso">YYYY-MM-DD</option><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label>
        <label className="grid gap-1 text-sm">Amount signs<select className="rounded-lg border border-border bg-card px-3 py-2" value={mapping.amountSign} onChange={(e) => setMapping({ ...mapping, amountSign: e.target.value as ImportMapping["amountSign"] })}><option value="signed">Positive is incoming</option><option value="outflow-positive">Positive is outgoing</option></select></label>
        <div className="sm:col-span-2"><button type="button" className="rounded-lg bg-brand px-4 py-2 text-white hover:opacity-90" disabled={busy} onClick={() => void inspect(file, mapping)}>Preview correction</button></div>
      </div>}
      <div className="flex gap-3">
        {inspection.preview && !editing && <button type="button" className="rounded-lg bg-brand px-4 py-2 text-white hover:opacity-90" disabled={busy} onClick={() => void confirm()}>Continue</button>}
        {inspection.preview && !editing && <button type="button" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted" onClick={() => setEditing(true)}>Correct</button>}
        <button type="button" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted" onClick={() => { setFiles([]); setInspection(null); setMapping(null); }}>Cancel</button>
      </div>
    </section>}
  </main>;
}
