"use client";

import { Check, Circle, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { usePolling } from "@/lib/use-polling";
import { Button } from "@/components/button";
import { BankCredentialsForm, type BankCredentials } from "@/components/bank-credentials";

type SyncImport = { id: string; status: string; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; rejected_rows: number };
type Connection = {
  id: string; aspsp_name: string; aspsp_country: string; status: "active" | "expired" | "error";
  valid_until: string | null; last_synced_at: string | null; sync_started_at: string | null; last_error: string | null;
  accounts: { provider_account_uid: string; account_name: string; currency_code: string; last_booked_on: string | null }[];
  problem: string | null; next_sync_at: string | null;
  sync: { running: boolean; imports: SyncImport[] };
};
type Bank = { name: string; country: string };

const COUNTRIES = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IS", "IT", "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK"];
const countryName = (code: string, locale?: string) => { try { return new Intl.DisplayNames(locale, { type: "region" }).of(code) ?? code; } catch { return code; } };
const RESULTS: Record<string, string> = {
  connected: "Bank connected. The first sync is running; its accounts appear in the bank's card when it finishes.",
  error: "The bank connection was cancelled or failed. Try again.",
  invalid: "That bank link expired or was already used. Start the connection again.",
};
const day = 86_400_000;
const REQUEST_GRACE_MS = 60_000;

export function consentState(connection: Pick<Connection, "status" | "valid_until">, now = Date.now()): "expired" | "expiring" | null {
  if (connection.status === "expired" || (connection.valid_until && Date.parse(connection.valid_until) <= now)) return "expired";
  if (connection.valid_until && Date.parse(connection.valid_until) - now < 7 * day) return "expiring";
  return null;
}

export function canSync(connection: Pick<Connection, "status" | "valid_until">, running: boolean, now = Date.now()) {
  return connection.status === "active" && !running && consentState(connection, now) !== "expired";
}

type StepState = "done" | "active" | "pending";
const processedRows = (item: SyncImport) => item.new_rows + item.matched_rows + item.review_rows + item.rejected_rows;

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
  const sum = (key: "new_rows" | "matched_rows" | "review_rows" | "rejected_rows") => imports.reduce((total, item) => total + item[key], 0);
  const review = sum("review_rows");
  const rejected = sum("rejected_rows");
  const toReview = imports.filter(item => item.review_rows > 0);
  const target = toReview.length > 1 ? null : toReview[0] ?? imports[imports.length - 1];
  return {
    text: `Last sync: ${sum("new_rows")} new · ${sum("matched_rows")} already imported${review ? ` · ${review} need review` : ""}${rejected ? ` · ${rejected} rejected` : ""}.`,
    href: target ? `/import/${target.id}/review` : "/import#import-history",
  };
}


export type ConnectionsData = { configured: boolean; credentials: BankCredentials; redirectUrl: string; connections: Connection[] };
async function fetchConnections(): Promise<ConnectionsData> {
  const response = await fetch("/api/bank/connections", { cache: "no-store" });
  if (!response.ok) throw new Error("Connected banks are unavailable");
  return response.json();
}

const select = "min-h-10 w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal";

async function startConnection(aspspName: string, country: string) {
  const response = await fetch("/api/bank/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aspspName, country }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.url) throw new Error(body.error ?? "The bank login could not be opened");
  window.location.assign(body.url);
}

export function connectionStatus(connection: Pick<Connection, "status" | "valid_until">, now = Date.now()): { label: string; tone: "ok" | "warn" | "bad" } {
  const consent = consentState(connection, now);
  if (consent === "expired") return { label: "Login ended", tone: "bad" };
  if (connection.status === "error") return { label: "Error", tone: "bad" };
  if (consent === "expiring" && connection.valid_until) {
    const days = Math.max(0, Math.ceil((Date.parse(connection.valid_until) - now) / day));
    return { label: days === 0 ? "Login ends today" : `Login ends in ${days} ${days === 1 ? "day" : "days"}`, tone: "warn" };
  }
  return { label: "Active", tone: "ok" };
}

const TONES = { ok: "bg-success-soft text-success", warn: "bg-warning-soft text-warning", bad: "bg-danger/10 text-danger" };

function BankPicker({ onCancel, intro }: { onCancel?: () => void; intro: string }) {
  const [country, setCountry] = useState(() => {
    const region = typeof navigator === "undefined" ? undefined : navigator.language.split("-")[1]?.toUpperCase();
    return region && COUNTRIES.includes(region) ? region : "DE";
  });
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/bank/aspsps?country=${country}`).then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!live) return;
      if (!response.ok) { setError(body.error ?? "Banks could not be loaded"); return; }
      setBanks(body.banks);
      if (!body.banks.length) setError(`Enable Banking has no banks for ${countryName(country)}. You can still import statements from your bank.`);
    }, () => { if (live) setError("Banks could not be loaded. Check your connection and try again."); });
    return () => { live = false; };
  }, [country]);
  const shown = (banks ?? []).filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const open = (name: string) => {
    setOpening(name); setError(null);
    startConnection(name, country).catch(failure => { setOpening(null); setError(failure instanceof Error ? failure.message : "The bank login could not be opened"); });
  };
  return <div className="space-y-3">
    <p className="text-sm font-medium">{intro}</p>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      <label className="grid gap-1.5 text-sm font-medium">Country
        <select value={country} onChange={event => { setCountry(event.target.value); setBanks(null); setError(null); }} className={select}>
          {COUNTRIES.map(code => [code, countryName(code)]).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      <label className="grid gap-1.5 text-sm font-medium">Search
        <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Your bank's name" className={select} /></label>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!banks ? !error && <p className="text-sm text-muted-foreground">Loading banks…</p>
      : banks.length > 0 && <ul aria-label="Banks" className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">{shown.map(item => <li key={item.name}>
        <button type="button" disabled={!!opening} onClick={() => open(item.name)}
          className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-60">
          <span className="truncate">{item.name}</span><span className="shrink-0 text-xs text-brand">{opening === item.name ? "Opening bank…" : "Connect"}</span></button></li>)}
        {!shown.length && <li className="px-3 py-2 text-sm text-muted-foreground">No bank matches “{search}”.</li>}</ul>}
    <p className="text-xs text-muted-foreground">Your bank&apos;s login opens in the browser, then you come back here. Some banks ask you to approve twice: once for access and once for history older than 90 days.</p>
    {onCancel && <Button type="button" variant="ghost" className="min-h-10" disabled={!!opening} onClick={onCancel}>Cancel</Button>}
  </div>;
}

export function ConnectBank({ onCancel }: { onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ configured: boolean; redirectUrl: string; justSaved?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchConnections().then(loaded => { if (live) setSetup(loaded); }, () => { if (live) setError("Connected banks are unavailable."); });
    return () => { live = false; };
  }, []);
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!setup) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!setup.configured) return <div className="space-y-2">
    <p className="eyebrow">Step 1 of 2 · only once</p>
    <BankCredentialsForm redirectUrl={setup.redirectUrl} onCancel={onCancel} onSaved={() => setSetup({ ...setup, configured: true, justSaved: true })} />
  </div>;
  return <div className="space-y-2">
    {setup.justSaved && <p className="eyebrow">Step 2 of 2</p>}
    <BankPicker onCancel={onCancel} intro={setup.justSaved ? "Enable Banking is set up. Choose your bank to connect it." : "Choose your bank"} />
  </div>;
}

export function ConnectedArea({ initial, feeds, scalable, hasScalable, result, connect, locale, timeZone }: {
  initial: ConnectionsData; feeds: Record<string, ReactNode>; scalable: ReactNode; hasScalable: boolean; result?: string; connect?: string; locale: string; timeZone: string;
}) {
  const router = useRouter();
  const date = (value: string | null) => value ? new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone }) : "never";
  const [data, setData] = useState<ConnectionsData>(initial);
  const [connecting, setConnecting] = useState(connect === "bank");
  const [replacing, setReplacing] = useState(false);
  const [message, setMessage] = useState<string | null>(result ? RESULTS[result] ?? null : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [requested, setRequested] = useState<Record<string, number>>({});

  const load = useCallback(() => fetchConnections().then(setData, () => setError("Connected banks are unavailable.")), []);
  useEffect(() => {
    if (result !== "connected") return;
    let live = true;
    fetchConnections().then(loaded => {
      const newest = loaded.connections[0];
      if (!live) return;
      setData(loaded);
      if (newest) { setHighlight(newest.id); setRequested({ [newest.id]: Date.now() }); }
    }, () => { if (live) setError("Connected banks are unavailable."); });
    return () => { live = false; };
  }, [result]);

  const [now, setNow] = useState(() => Date.now());
  const running = (connection: Connection) => connection.sync.running || (now - (requested[connection.id] ?? 0) < REQUEST_GRACE_MS
    && (!connection.last_synced_at || Date.parse(connection.last_synced_at) < requested[connection.id]));
  const syncing = data.connections.some(running);
  usePolling(() => { setNow(Date.now()); return fetchConnections().then(setData, () => undefined); }, 2000, syncing);
  const wasSyncing = useRef(false);
  useEffect(() => { if (wasSyncing.current && !syncing) router.refresh(); wasSyncing.current = syncing; }, [syncing, router]);

  async function act(key: string, run: () => Promise<Response>, done?: string) {
    setBusy(key); setError(null); setMessage(null);
    try {
      const response = await run();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Something went wrong");
      if (body.url) { window.location.assign(body.url); return true; }
      if (done) setMessage(done);
      await load();
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong");
      setBusy(null);
      return false;
    }
    setBusy(null);
    return true;
  }
  const reconnect = (connection: Connection) => act(`connect:${connection.id}`, () => fetch("/api/bank/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aspspName: connection.aspsp_name, country: connection.aspsp_country }) }));
  const sync = (connection: Connection, at: number) => {
    setNow(at); setRequested(current => ({ ...current, [connection.id]: at }));
    void act(`sync:${connection.id}`, () => fetch(`/api/bank/connections/${connection.id}/sync`, { method: "POST" }))
      .then(ok => { if (!ok) setRequested(current => { const next = { ...current }; delete next[connection.id]; return next; }); });
  };
  const connections = data.connections;
  const empty = !connections.length && !hasScalable;

  return <section id="connected" aria-labelledby="connected-title" className="scroll-mt-20 space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 id="connected-title" className="text-base font-semibold">Connected</h2>
        <p className="mt-1 text-sm text-muted-foreground">Banks and brokers that sync on their own. Each card lists the accounts it feeds.</p></div>
      {!connecting && !empty && <Button variant="outline" className="min-h-10" onClick={() => setConnecting(true)}>{connections.length ? "Connect another bank" : "Connect a bank"}</Button>}
    </div>
    {message && <p role="status" className="text-sm text-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {connecting && <div role="group" aria-label="Connect a bank" className="rounded-xl border border-brand/40 bg-card p-5"><ConnectBank onCancel={() => setConnecting(false)} /></div>}
    {empty && !connecting && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-card p-5">
      <p className="max-w-xl text-sm text-muted-foreground">Moneo connects your bank through a free Enable Banking app that you set up once. After that, transactions and balances sync on their own.</p>
      <Button className="min-h-10" onClick={() => setConnecting(true)}>Connect a bank</Button>
    </div>}
    {connections.map(connection => {
      const status = connectionStatus(connection, now);
      const isRunning = running(connection);
      const summary = isRunning ? null : syncSummary(connection);
      return <article key={connection.id} id={`bank-${connection.id}`} aria-label={connection.aspsp_name}
        className={`scroll-mt-20 space-y-3 rounded-xl border bg-card p-5 ${highlight === connection.id ? "border-brand ring-2 ring-brand/30" : "border-border"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="flex flex-wrap items-center gap-2 font-medium">{connection.aspsp_name}
              <span className="text-xs font-normal text-muted-foreground">{countryName(connection.aspsp_country, locale)}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[status.tone]}`}>{status.label}</span></h3>
            <p className="text-xs text-muted-foreground">Last sync {date(connection.last_synced_at)}
              {connection.next_sync_at && status.tone !== "bad" ? ` · next automatic sync around ${date(connection.next_sync_at)}` : ""}
              {connection.valid_until ? ` · login valid until ${date(connection.valid_until)}` : ""}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!!busy || !data.configured || !canSync(connection, isRunning, now)} onClick={() => sync(connection, Date.now())}>
              {busy === `sync:${connection.id}` ? "Starting…" : isRunning ? "Syncing…" : "Sync now"}</Button>
            <Button size="sm" variant={status.tone === "ok" ? "ghost" : "default"} disabled={!!busy || !data.configured} onClick={() => void reconnect(connection)}>
              {busy === `connect:${connection.id}` ? "Opening bank…" : "Reconnect"}</Button>
            <Button size="sm" variant="ghost" disabled={!!busy}
              onClick={() => { if (window.confirm(`Disconnect ${connection.aspsp_name}? Imported transactions stay; undo imports separately.`))
                void act(`delete:${connection.id}`, () => fetch(`/api/bank/connections/${connection.id}`, { method: "DELETE" }), `${connection.aspsp_name} disconnected.`); }}>
              {busy === `delete:${connection.id}` ? "Disconnecting…" : "Disconnect"}</Button>
          </div>
        </div>
        {connection.problem && <div role="alert" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
          <p>{connection.problem}{consentState(connection, now) === "expired" ? " Reconnect to keep syncing." : ""}</p>
          {connection.last_error && <details className="mt-1 text-xs"><summary className="cursor-pointer">What the bank said</summary><p className="mt-1 break-words">{connection.last_error}</p></details>}
        </div>}
        {isRunning ? <SyncProgress connection={connection} now={now} />
          : summary && <p className="text-sm text-muted-foreground">{summary.text}{summary.href && <> <Link href={summary.href} className="text-brand underline-offset-4 hover:underline">Review rows</Link></>}</p>}
        {feeds[connection.id] ?? <ul className="divide-y divide-border text-sm">{connection.accounts.map(account => <li key={account.provider_account_uid} className="flex justify-between gap-3 py-1.5">
          <span className="truncate">{account.account_name}</span>
          <span className="shrink-0 text-muted-foreground">{account.currency_code} · {account.last_booked_on ? `through ${account.last_booked_on}` : "not synced yet"}</span>
        </li>)}</ul>}
      </article>;
    })}
    {scalable}
    {data.credentials.source && (replacing ? <BankCredentialsForm redirectUrl={data.redirectUrl} onCancel={() => setReplacing(false)}
      onSaved={() => { setReplacing(false); setMessage("The new Enable Banking key is saved."); void load(); }} />
      : <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
        <span>Enable Banking app{data.credentials.hint ? ` ending in ${data.credentials.hint}` : ""}{data.credentials.source === "env" ? ", read from .env or a system environment variable" : ""}</span>
        <button type="button" disabled={!!busy} className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => setReplacing(true)}>Replace key</button>
        {data.credentials.source === "app" && <button type="button" disabled={!!busy} className="underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => { if (window.confirm("Remove the Enable Banking App ID and key? Connected banks and imported transactions stay, but syncing stops until you add them again."))
            void act("credentials", () => fetch("/api/bank/credentials", { method: "DELETE" }), "Enable Banking App ID and key removed."); }}>Remove</button>}
      </p>)}
  </section>;
}
