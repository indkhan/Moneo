"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Connection = {
  id: string; aspsp_name: string; aspsp_country: string; status: "active" | "expired" | "error";
  valid_until: string | null; last_synced_at: string | null; last_error: string | null;
  accounts: { provider_account_uid: string; account_name: string; currency_code: string; last_booked_on: string | null }[];
};
type Bank = { name: string; country: string };

const COUNTRIES = ["DE", "AT", "BE", "ES", "FI", "FR", "IE", "IT", "LT", "NL", "PT"];
const RESULTS: Record<string, string> = {
  connected: "Bank connected. The first sync is running and appears in import history.",
  error: "The bank connection was cancelled or failed. Try again.",
  invalid: "That bank link expired or was already used. Start the connection again.",
};
const day = 86_400_000;

// Reconnect banner from 7 days before consent ends (issue #82).
export function consentState(connection: Pick<Connection, "status" | "valid_until">, now = Date.now()): "expired" | "expiring" | null {
  if (connection.status === "expired" || (connection.valid_until && Date.parse(connection.valid_until) <= now)) return "expired";
  if (connection.valid_until && Date.parse(connection.valid_until) - now < 7 * day) return "expiring";
  return null;
}

async function fetchConnections(): Promise<{ configured: boolean; connections: Connection[] }> {
  const response = await fetch("/api/bank/connections", { cache: "no-store" });
  if (!response.ok) throw new Error("Connected banks are unavailable");
  return response.json();
}

const date = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

export function ConnectedBanks() {
  const [data, setData] = useState<{ configured: boolean; connections: Connection[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [country, setCountry] = useState("DE");
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [bank, setBank] = useState("");

  const load = useCallback(() => fetchConnections().then(setData, () => setError("Connected banks are unavailable.")), []);
  useEffect(() => {
    let live = true;
    fetchConnections().then(loaded => {
      if (!live) return;
      setData(loaded);
      const result = new URLSearchParams(window.location.search).get("bank");
      if (result && RESULTS[result]) setMessage(RESULTS[result]);
    }, () => { if (live) setError("Connected banks are unavailable."); });
    return () => { live = false; };
  }, []);

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
    }
    setBusy(null);
  }
  const connect = (aspspName: string, aspspCountry: string) => act(`connect:${aspspName}`, () => fetch("/api/bank/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aspspName, country: aspspCountry }) }));
  async function loadBanks() {
    setBusy("banks"); setError(null); setBanks(null); setBank("");
    const response = await fetch(`/api/bank/aspsps?country=${country}`);
    const body = await response.json().catch(() => ({}));
    if (response.ok) setBanks(body.banks); else setError(body.error ?? "Banks could not be loaded");
    setBusy(null);
  }

  return <section aria-labelledby="connected-banks" className="scroll-mt-20 space-y-4 rounded-xl border border-border bg-card p-6">
    <div>
      <h2 id="connected-banks" className="text-base font-semibold">Connected banks</h2>
      <p className="mt-1 text-sm text-muted-foreground">Sync booked transactions and balances through Enable Banking. Each sync is an ordinary import you can review and undo.</p>
    </div>
    {message && <p role="status" className="text-sm text-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : <>
      {data.connections.length > 0 && <ul className="space-y-3">{data.connections.map(connection => {
        const consent = consentState(connection);
        return <li key={connection.id} className="space-y-3 rounded-lg border border-border p-4">
          {consent && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
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
                onClick={() => void act(`sync:${connection.id}`, () => fetch(`/api/bank/connections/${connection.id}/sync`, { method: "POST" }), "Sync started. New rows appear in import history.")}>
                {busy === `sync:${connection.id}` ? "Starting…" : "Sync now"}</Button>
              <Button size="sm" variant="ghost" disabled={!!busy}
                onClick={() => { if (window.confirm(`Disconnect ${connection.aspsp_name}? Imported transactions stay; undo imports separately.`))
                  void act(`delete:${connection.id}`, () => fetch(`/api/bank/connections/${connection.id}`, { method: "DELETE" }), "Bank disconnected."); }}>
                {busy === `delete:${connection.id}` ? "Disconnecting…" : "Disconnect"}</Button>
            </div>
          </div>
          {connection.last_error && <p className="text-sm text-amber-700 dark:text-amber-300">{connection.last_error}</p>}
          <ul className="divide-y divide-border text-sm">{connection.accounts.map(account => <li key={account.provider_account_uid} className="flex justify-between gap-3 py-1.5">
            <span className="truncate">{account.account_name}</span>
            <span className="shrink-0 text-muted-foreground">{account.currency_code} · {account.last_booked_on ? `through ${account.last_booked_on}` : "not synced yet"}</span>
          </li>)}</ul>
        </li>;
      })}</ul>}
      {data.configured ? <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-sm font-medium">Country
          <select value={country} onChange={event => { setCountry(event.target.value); setBanks(null); }} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal">
            {COUNTRIES.map(code => <option key={code}>{code}</option>)}</select></label>
        {banks ? <>
          <label className="grid min-w-56 flex-1 gap-1.5 text-sm font-medium">Bank
            <select value={bank} onChange={event => setBank(event.target.value)} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal">
              <option value="">Choose your bank</option>{banks.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
          <Button className="min-h-10" disabled={!bank || !!busy} onClick={() => void connect(bank, country)}>{busy?.startsWith("connect:") ? "Opening bank…" : "Connect bank"}</Button>
        </> : <Button variant="outline" className="min-h-10" disabled={!!busy} onClick={() => void loadBanks()}>{busy === "banks" ? "Loading banks…" : "Choose a bank"}</Button>}
      </div> : <p className="text-sm text-muted-foreground">Bank sync is not configured on this deployment. See the README for Enable Banking setup.</p>}
    </>}
  </section>;
}
