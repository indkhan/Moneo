"use client";

import { Check, Circle, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { BankCredentialsForm, type BankCredentials } from "@/components/bank-credentials";

type SyncImport = { id: string; status: string; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; rejected_rows: number };
type Connection = {
  id: string; aspsp_name: string; aspsp_country: string; status: "active" | "expired" | "error";
  valid_until: string | null; last_synced_at: string | null; sync_started_at: string | null; last_error: string | null;
  accounts: { provider_account_uid: string; account_name: string; currency_code: string; last_booked_on: string | null }[];
  sync: { running: boolean; imports: SyncImport[] };
};
type Bank = { name: string; country: string };

// Countries Enable Banking serves (its changelog lists banks in each). A country without banks just shows an empty list.
const COUNTRIES = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IS", "IT", "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK"];
const countryName = (code: string) => { try { return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code; } catch { return code; } };
const RESULTS: Record<string, string> = {
  connected: "Bank connected. The first sync is running and appears in import history.",
  error: "The bank connection was cancelled or failed. Try again.",
  invalid: "That bank link expired or was already used. Start the connection again.",
};
const day = 86_400_000;
// A clicked sync counts as running until the workflow picks it up and stamps sync_started_at.
const REQUEST_GRACE_MS = 60_000;

// Reconnect banner from 7 days before consent ends (issue #82).
export function consentState(connection: Pick<Connection, "status" | "valid_until">, now = Date.now()): "expired" | "expiring" | null {
  if (connection.status === "expired" || (connection.valid_until && Date.parse(connection.valid_until) <= now)) return "expired";
  if (connection.valid_until && Date.parse(connection.valid_until) - now < 7 * day) return "expiring";
  return null;
}

type StepState = "done" | "active" | "pending";
const processedRows = (item: SyncImport) => item.new_rows + item.matched_rows + item.review_rows + item.rejected_rows;

// The three phases a sync goes through, derived from server state so it survives navigation.
export function syncSteps(connection: Pick<Connection, "aspsp_name" | "sync">) {
  const imports = connection.sync.imports;
  const total = imports.reduce((sum, item) => sum + item.total_rows, 0);
  const processed = imports.reduce((sum, item) => sum + Math.min(processedRows(item), item.total_rows), 0);
  const importing = imports.some(item => item.status === "queued" || item.status === "running");
  const fetched = imports.length > 0;
  const state = (done: boolean, active: boolean): StepState => done ? "done" : active ? "active" : "pending";
  return {
    total, processed, importing,
    steps: [
      { label: fetched ? `Fetched ${total} transactions from ${connection.aspsp_name}` : `Asking ${connection.aspsp_name} for transactions and balance`, state: state(fetched, !fetched) },
      { label: total ? `Importing ${processed} of ${total} rows` : "Import rows", state: state(fetched && !importing, importing) },
      { label: "Updating balance and finishing up", state: state(false, fetched && !importing) },
    ],
  };
}

const elapsed = (from: string | null, now: number) => {
  const seconds = from ? Math.max(0, Math.round((now - Date.parse(from)) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function SyncProgress({ connection, now }: { connection: Pick<Connection, "aspsp_name" | "sync" | "sync_started_at">; now: number }) {
  const { steps, total, processed, importing } = syncSteps(connection);
  return <div className="space-y-3 rounded-lg border border-brand/40 bg-muted/40 p-3" role="status" aria-live="polite">
    <div className="flex items-center justify-between gap-2 text-sm font-medium">
      <span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin text-brand" aria-hidden="true" />Syncing {connection.aspsp_name}</span>
      <span className="text-xs font-normal tabular-nums text-muted-foreground">{elapsed(connection.sync_started_at, now)}</span>
    </div>
    <ol className="space-y-1.5 text-sm">{steps.map(step => <li key={step.label} className={`flex items-center gap-2 ${step.state === "pending" ? "text-muted-foreground" : ""}`}>
      {step.state === "done" ? <Check className="size-4 shrink-0 text-brand" aria-label="Done" /> : step.state === "active" ? <LoaderCircle className="size-4 shrink-0 animate-spin" aria-label="In progress" /> : <Circle className="size-4 shrink-0" aria-label="Waiting" />}
      {step.label}</li>)}</ol>
    {importing && <progress className="h-2 w-full overflow-hidden rounded-full accent-brand" aria-label="Rows imported" max={Math.max(total, 1)} value={processed} />}
    <p className="text-xs text-muted-foreground">You can leave this page; the sync keeps running and this updates when you come back.</p>
  </div>;
}

export function syncSummary(connection: Pick<Connection, "sync" | "sync_started_at" | "last_synced_at">) {
  const imports = connection.sync.imports;
  if (!connection.sync_started_at || !connection.last_synced_at || Date.parse(connection.last_synced_at) < Date.parse(connection.sync_started_at)) return null;
  if (!imports.length) return { text: "Last sync found no new transactions.", href: null };
  const sum = (key: "new_rows" | "matched_rows" | "review_rows") => imports.reduce((total, item) => total + item[key], 0);
  const review = sum("review_rows");
  return { text: `Last sync: ${sum("new_rows")} new · ${sum("matched_rows")} already imported${review ? ` · ${review} need review` : ""}.`, href: `/import/${imports[imports.length - 1].id}/review` };
}

type ConnectionsData = { configured: boolean; credentials: BankCredentials; redirectUrl: string; connections: Connection[] };
async function fetchConnections(): Promise<ConnectionsData> {
  const response = await fetch("/api/bank/connections", { cache: "no-store" });
  if (!response.ok) throw new Error("Connected banks are unavailable");
  return response.json();
}

const date = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

export function ConnectedBanks() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [country, setCountry] = useState("DE");
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [bank, setBank] = useState("");
  const [requested, setRequested] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => fetchConnections().then(setData, () => setError("Connected banks are unavailable.")), []);
  useEffect(() => {
    let live = true;
    fetchConnections().then(loaded => {
      if (!live) return;
      setData(loaded);
      // Start the bank picker on this computer's country (en-GB → GB isn't served, so it stays on DE).
      const region = navigator.language.split("-")[1]?.toUpperCase();
      if (region && COUNTRIES.includes(region)) setCountry(region);
      const result = new URLSearchParams(window.location.search).get("bank");
      if (result && RESULTS[result]) setMessage(RESULTS[result]);
      if (result === "connected" && loaded.connections[0]) setRequested({ [loaded.connections[0].id]: Date.now() });
    }, () => { if (live) setError("Connected banks are unavailable."); });
    return () => { live = false; };
  }, []);

  const running = (connection: Connection) => connection.sync.running || (now - (requested[connection.id] ?? 0) < REQUEST_GRACE_MS
    && (!connection.last_synced_at || Date.parse(connection.last_synced_at) < requested[connection.id]));
  const anyRunning = !!data?.connections.some(running);
  // ponytail: one connections read every 2 s while a sync runs, paused in hidden tabs.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!document.hidden) void fetchConnections().then(setData, () => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  async function act(key: string, run: () => Promise<Response>, done?: string) {
    setBusy(key); setError(null); setMessage(null);
    try {
      const response = await run();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Something went wrong");
      if (body.url) { window.location.assign(body.url); return; }
      if (done) setMessage(done);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong");
      setBusy(null);
      return false;
    }
    setBusy(null);
    return true;
  }
  const connect = (aspspName: string, aspspCountry: string) => act(`connect:${aspspName}`, () => fetch("/api/bank/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aspspName, country: aspspCountry }) }));
  async function loadBanks() {
    setBusy("banks"); setError(null); setBanks(null); setBank("");
    try {
      const response = await fetch(`/api/bank/aspsps?country=${country}`);
      const body = await response.json().catch(() => ({}));
      if (response.ok) { setBanks(body.banks); if (!body.banks.length) setError(`Enable Banking has no banks for ${countryName(country)}. You can still import statements from your bank.`); } else setError(body.error ?? "Banks could not be loaded");
    } catch { setError("Banks could not be loaded. Check your connection and try again."); }
    finally { setBusy(null); }
  }

  return <section aria-labelledby="connected-banks" className="scroll-mt-20 space-y-4 rounded-xl border border-border bg-card p-6">
    <div>
      <h2 id="connected-banks" className="text-sm font-medium">Connected banks</h2>
      <p className="mt-1 text-sm text-muted-foreground">Sync booked transactions and balances through Enable Banking. Each sync is an ordinary import you can review, and undo if nothing depends on it.</p>
    </div>
    {message && <p role="status" className="text-sm text-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!data ? (error ? <Button variant="outline" className="min-h-10" onClick={() => { setError(null); void load(); }}>Try again</Button> : <p className="text-sm text-muted-foreground">Loading…</p>) : <>
      {data.connections.length > 0 && <ul className="space-y-3">{data.connections.map(connection => {
        const consent = consentState(connection);
        return <li key={connection.id} className="space-y-3 rounded-lg border border-border p-4">
          {consent && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            <span>{consent === "expired" ? "Bank consent has ended. Reconnect to keep syncing." : `Bank consent ends ${date(connection.valid_until)}. Reconnect to keep syncing.`}</span>
            <Button size="sm" disabled={!!busy || !data.configured} onClick={() => void connect(connection.aspsp_name, connection.aspsp_country)}>Reconnect</Button>
          </div>}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-medium">{connection.aspsp_name} <span className="text-xs font-normal text-muted-foreground">{connection.aspsp_country}</span></h3>
              <p className="text-xs text-muted-foreground">Last sync {date(connection.last_synced_at)} · consent until {date(connection.valid_until)}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!!busy || connection.status !== "active" || !data.configured}
                onClick={() => { const at = Date.now(); setNow(at); setRequested(current => ({ ...current, [connection.id]: at }));
                  void act(`sync:${connection.id}`, () => fetch(`/api/bank/connections/${connection.id}/sync`, { method: "POST" }))
                    .then(ok => { if (!ok) setRequested(current => { const next = { ...current }; delete next[connection.id]; return next; }); }); }}>
                {busy === `sync:${connection.id}` ? "Starting…" : running(connection) ? "Syncing…" : "Sync now"}</Button>
              <Button size="sm" variant="ghost" disabled={!!busy}
                onClick={() => { if (window.confirm(`Disconnect ${connection.aspsp_name}? Imported transactions stay; undo imports separately.`))
                  void act(`delete:${connection.id}`, () => fetch(`/api/bank/connections/${connection.id}`, { method: "DELETE" }), "Bank disconnected."); }}>
                {busy === `delete:${connection.id}` ? "Disconnecting…" : "Disconnect"}</Button>
            </div>
          </div>
          {running(connection) ? <SyncProgress connection={connection} now={now} /> : (() => {
            const summary = syncSummary(connection);
            return summary && <p className="text-sm text-muted-foreground">{summary.text}{summary.href && <> <Link href={summary.href} className="text-brand underline-offset-4 hover:underline">Review rows</Link></>}</p>;
          })()}
          {connection.last_error && <p className="text-sm text-warning">{connection.last_error}</p>}
          <ul className="divide-y divide-border text-sm">{connection.accounts.map(account => <li key={account.provider_account_uid} className="flex justify-between gap-3 py-1.5">
            <span className="truncate">{account.account_name}</span>
            <span className="shrink-0 text-muted-foreground">{account.currency_code} · {account.last_booked_on ? `through ${account.last_booked_on}` : "not synced yet"}</span>
          </li>)}</ul>
        </li>;
      })}</ul>}
      {!data.configured || replacing ? <BankCredentialsForm redirectUrl={data.redirectUrl} onCancel={replacing ? () => setReplacing(false) : undefined}
        onSaved={() => { setReplacing(false); setMessage("Enable Banking is set up. Choose your bank to connect it."); void load(); }} /> : <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-sm font-medium">Country
          <select value={country} onChange={event => { setCountry(event.target.value); setBanks(null); }} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal">
            {COUNTRIES.map(code => [code, countryName(code)]).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        {banks ? <>
          <label className="grid min-w-56 flex-1 gap-1.5 text-sm font-medium">Bank
            <select value={bank} onChange={event => setBank(event.target.value)} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal">
              <option value="">Choose your bank</option>{banks.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
          <Button className="min-h-10" disabled={!bank || !!busy} onClick={() => void connect(bank, country)}>{busy?.startsWith("connect:") ? "Opening bank…" : "Connect bank"}</Button>
          <p className="basis-full text-xs text-muted-foreground">Your bank&apos;s login opens in the browser. Some banks ask you to approve twice: once for access and once for history older than 90 days.</p>
        </> : <Button variant="outline" className="min-h-10" disabled={!!busy} onClick={() => void loadBanks()}>{busy === "banks" ? "Loading banks…" : "Choose a bank"}</Button>}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Enable Banking app{data.credentials.hint ? ` ending in ${data.credentials.hint}` : ""}{data.credentials.source === "env" ? ", read from .env or a system environment variable" : ""}</span>
        <button type="button" disabled={!!busy} className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => setReplacing(true)}>Replace</button>
        {data.credentials.source === "app" && <button type="button" disabled={!!busy} className="underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => { if (window.confirm("Remove the Enable Banking App ID and key? Connected banks and imported transactions stay, but syncing stops until you add them again."))
            void act("credentials", () => fetch("/api/bank/credentials", { method: "DELETE" }), "Enable Banking App ID and key removed."); }}>Remove</button>}
      </p></>}
    </>}
  </section>;
}
