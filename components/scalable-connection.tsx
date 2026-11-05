"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";

type Connection = { id: string; status: "active" | "expired" | "error"; last_synced_at: string | null; last_error: string | null; created_at: string };
type Data = { configured: boolean; connection: Connection | null };

const RESULTS: Record<string, string> = {
  connected: "Scalable Capital connected.",
  error: "The Scalable login was cancelled or failed. Try again.",
  invalid: "That Scalable link expired or was already used. Connect again.",
};
const date = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

async function fetchStatus(): Promise<Data> {
  const response = await fetch("/api/scalable/connections", { cache: "no-store" });
  if (!response.ok) throw new Error("Scalable status is unavailable");
  return response.json();
}

/** Connect a Scalable Capital broker account through Scalable's official MCP (read-only access is enough). */
export function ScalableConnection() {
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchStatus().then(setData, () => setError("Scalable status is unavailable.")), []);
  useEffect(() => {
    let live = true;
    fetchStatus().then(loaded => {
      if (!live) return;
      setData(loaded);
      const result = new URLSearchParams(window.location.search).get("scalable");
      if (result && RESULTS[result]) setMessage(RESULTS[result]);
    }, () => { if (live) setError("Scalable status is unavailable."); });
    return () => { live = false; };
  }, []);

  async function act(run: () => Promise<Response>, done?: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await run();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Something went wrong");
      if (body.url) { window.location.assign(body.url); return; }
      if (done) setMessage(done);
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Something went wrong"); }
    setBusy(false);
  }
  const connect = () => act(() => fetch("/api/scalable/connect", { method: "POST" }));
  const connection = data?.connection;

  return <section aria-labelledby="scalable-connection" className="space-y-4 rounded-xl border border-border bg-card p-6">
    <div>
      <h2 id="scalable-connection" className="text-sm font-medium">Scalable Capital</h2>
      <p className="mt-1 text-sm text-muted-foreground">Connect your broker account to see holdings, cash and portfolio value. First turn on access in Scalable on the web under Profile → Security → Agentic Investing; read-only is enough.</p>
    </div>
    {message && <p role="status" className="text-sm text-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!data ? (!error && <p className="text-sm text-muted-foreground">Loading…</p>) : connection ? <div className="space-y-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Scalable Capital</h3>
          <p className="text-xs text-muted-foreground">{connection.status === "active" ? "Connected" : "Login ended"} · last sync {date(connection.last_synced_at)}</p>
        </div>
        <div className="flex gap-2">
          {connection.status !== "active" && <Button size="sm" disabled={busy || !data.configured} onClick={() => void connect()}>Connect again</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm("Disconnect Scalable Capital? Synced data stays."))
            void act(() => fetch(`/api/scalable/connections/${connection.id}`, { method: "DELETE" }), "Scalable Capital disconnected."); }}>Disconnect</Button>
        </div>
      </div>
      {connection.last_error && <p className="text-sm text-warning">{connection.last_error}</p>}
    </div> : <Button disabled={busy || !data.configured} onClick={() => void connect()}>{busy ? "Opening Scalable…" : "Connect Scalable Capital"}</Button>}
  </section>;
}
