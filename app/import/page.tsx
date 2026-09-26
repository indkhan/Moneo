"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ImportMapping, SourceRow } from "@/lib/csv";

type Preview = {
  accountName: string;
  currencyCode: string;
  totalRows: number;
  dateRange: { from: string; to: string };
  examples: { postedOn: string; description: string; amountMinor: string; currencyCode: string }[];
};
type Inspection = { headers: string[]; sample: SourceRow[]; mapping: ImportMapping | null; preview: Preview | null; aiError?: string };
type ImportStatus = { id: string; filename: string; status: string; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; error: string | null; created_at: string };

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
  const file = files[index];

  async function loadHistory() {
    const response = await fetch("/api/imports", { cache: "no-store" });
    if (response.ok) setHistory(await response.json());
  }

  useEffect(() => { void loadHistory(); }, []);
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
      setMapping(result.mapping ?? {
        accountName: target.name.replace(/\.(csv|xlsx)$/i, ""),
        currencyCode: "EUR",
        dateColumn: result.headers[0] ?? "",
        descriptionColumn: result.headers[1] ?? "",
        amountColumn: result.headers[2] ?? "",
        dateFormat: "iso",
        amountSign: "signed",
      });
      setEditing(!result.mapping);
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

  const chooseColumn = (label: string, key: keyof ImportMapping, optional = false) => (
    <label className="grid gap-1 text-sm" key={key}>
      {label}
      <select className="rounded border p-2" value={String(mapping?.[key] ?? "")}
        onChange={(event) => setMapping((current) => current && ({ ...current, [key]: event.target.value || undefined }))}>
        {optional && <option value="">None</option>}
        {!optional && <option value="">Select column</option>}
        {inspection?.headers.map((header) => <option key={header} value={header}>{header}</option>)}
      </select>
    </label>
  );

  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <h1 className="text-3xl font-semibold">Import financial data</h1>
    <p>Choose CSV or XLSX statements. We&apos;ll propose an interpretation for you to review before importing.</p>
    <input type="file" accept=".csv,.xlsx" multiple disabled={busy} aria-label="Financial statement files"
      onChange={(event) => {
        const selected = Array.from(event.target.files ?? []);
        setFiles(selected);
        setIndex(0);
        setInspection(null);
        if (selected[0]) void inspect(selected[0]);
      }} />
    <section className="space-y-3" aria-label="Import history">
      <h2 className="text-xl font-semibold">Import history</h2>
      {!history.length && <p>No imports yet.</p>}
      {history.map((item) => <article key={item.id} className="rounded border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{item.filename}</strong><span role="status">{item.status}</span></div>
        <p className="text-sm">{item.new_rows} new · {item.matched_rows} matched · {item.review_rows} for review · {item.total_rows} total</p>
        {item.error && <p className="text-sm text-red-700">{item.error}</p>}
        {item.review_rows > 0 && <Link className="text-sm underline" href={`/import/${item.id}/review`}>Review rows</Link>}
        {item.status === "failed" && <button className="ml-3 text-sm underline" type="button" disabled={busy} onClick={() => void retry(item.id)}>Retry</button>}
      </article>)}
    </section>
    {busy && <p role="status">Working…</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {file && inspection && <section className="space-y-4 rounded border p-4">
      <h2 className="text-xl font-semibold">{file.name} ({index + 1} of {files.length})</h2>
      {inspection.aiError && <p>Automatic interpretation unavailable. Choose the columns below.</p>}
      {editing && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{inspection.headers.map((header) => <th className="pr-4" key={header}>{header}</th>)}</tr></thead><tbody>
        {inspection.sample.slice(0, 3).map((row, i) => <tr className="border-t" key={i}>{inspection.headers.map((header) => <td className="pr-4" key={header}>{row[header]}</td>)}</tr>)}
      </tbody></table></div>}
      {inspection.preview && <>
        <p><strong>Account:</strong> {inspection.preview.accountName} · <strong>Currency:</strong> {inspection.preview.currencyCode}</p>
        <p><strong>{inspection.preview.totalRows} rows</strong> · {inspection.preview.dateRange.from} to {inspection.preview.dateRange.to}</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Date</th><th>Description</th><th>Incoming / outgoing</th></tr></thead><tbody>
          {inspection.preview.examples.map((row, i) => <tr key={i} className="border-t"><td>{row.postedOn}</td><td>{row.description}</td><td>{formatMinor(row.amountMinor, row.currencyCode)}</td></tr>)}
        </tbody></table></div>
      </>}
      {editing && mapping && <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Account name<input className="rounded border p-2" value={mapping.accountName} onChange={(e) => setMapping({ ...mapping, accountName: e.target.value })} /></label>
        <label className="grid gap-1 text-sm">Currency code<input className="rounded border p-2" maxLength={3} value={mapping.currencyCode} onChange={(e) => setMapping({ ...mapping, currencyCode: e.target.value.toUpperCase() })} /></label>
        {chooseColumn("Date", "dateColumn")}{chooseColumn("Description", "descriptionColumn")}
        {chooseColumn("Amount", "amountColumn", true)}
        {chooseColumn("Debit", "debitColumn", true)}{chooseColumn("Credit", "creditColumn", true)}
        {chooseColumn("Currency", "currencyColumn", true)}{chooseColumn("Balance", "balanceColumn", true)}
        {chooseColumn("Merchant", "merchantColumn", true)}{chooseColumn("External ID", "externalIdColumn", true)}
        <label className="grid gap-1 text-sm">Date format<select className="rounded border p-2" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as ImportMapping["dateFormat"] })}><option value="iso">YYYY-MM-DD</option><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label>
        <label className="grid gap-1 text-sm">Amount signs<select className="rounded border p-2" value={mapping.amountSign} onChange={(e) => setMapping({ ...mapping, amountSign: e.target.value as ImportMapping["amountSign"] })}><option value="signed">Positive is incoming</option><option value="outflow-positive">Positive is outgoing</option></select></label>
        <div className="sm:col-span-2"><button type="button" className="rounded bg-black px-4 py-2 text-white" disabled={busy} onClick={() => void inspect(file, mapping)}>Preview correction</button></div>
      </div>}
      <div className="flex gap-3">
        {inspection.preview && !editing && <button type="button" className="rounded bg-black px-4 py-2 text-white" disabled={busy} onClick={() => void confirm()}>Continue</button>}
        {inspection.preview && !editing && <button type="button" className="rounded border px-4 py-2" onClick={() => setEditing(true)}>Correct</button>}
        <button type="button" className="rounded border px-4 py-2" onClick={() => { setFiles([]); setInspection(null); setMapping(null); }}>Cancel</button>
      </div>
    </section>}
  </main>;
}
