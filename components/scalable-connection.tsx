"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { syncProblems } from "@/lib/sync-problems";

type Connection = { id: string; status: "active" | "expired" | "error"; last_synced_at: string | null; last_error: string | null; created_at: string };
type Data = { configured: boolean; connection: Connection | null };

const RESULTS: Record<string, string> = {
  connected: "Scalable Capital connected.",
  error: "The Scalable login was cancelled or failed. Try again.",
  invalid: "That Scalable link expired or was already used. Connect again.",
};
const date = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
const STATUS = { active: { label: "Active", tone: "bg-success-soft text-success" }, expired: { label: "Login ended", tone: "bg-danger/10 text-danger" }, error: { label: "Error", tone: "bg-danger/10 text-danger" } };

async function fetchStatus(): Promise<Data> {
  const response = await fetch("/api/scalable/connections", { cache: "no-store" });
  if (!response.ok) throw new Error("Scalable status is unavailable");
  return response.json();
}

async function openScalableLogin() {
  const response = await fetch("/api/scalable/connect", { method: "POST" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.url) throw new Error(body.error ?? "The Scalable login could not be opened");
  window.location.assign(body.url);
}

export function ConnectScalable() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="space-y-3 text-sm">
    <p className="font-medium">Connect Scalable Capital</p>
    <p className="text-muted-foreground">See holdings, cash and portfolio value on Accounts and Wealth. First turn on access in Scalable on the web under Profile → Security → Agentic Investing; read-only is enough.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <Button className="min-h-10" disabled={busy} onClick={() => { setBusy(true); setError(null); openScalableLogin().catch(failure => { setBusy(false); setError(failure instanceof Error ? failure.message : "The Scalable login could not be opened"); }); }}>
      {busy ? "Opening Scalable…" : "Connect Scalable Capital"}</Button>
  </div>;
}

const nextSync = (lastSynced: string | null) => lastSynced && new Date(lastSynced).toDateString() === new Date().toDateString() ? "tomorrow" : "within the hour";

export function ScalableCard({ children, setting }: { children: ReactNode; setting: ReactNode }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const load = useCallback(() => fetchStatus().then(setData, () => setError("Scalable status is unavailable.")), []);
  useEffect(() => {
    let live = true;
    fetchStatus().then(loaded => {
      if (!live) return;
      setData(loaded);
      const result = new URLSearchParams(window.location.search).get("scalable");
      if (result && RESULTS[result]) setMessage(RESULTS[result]);
      setHighlight(result === "connected");
    }, () => { if (live) setError("Scalable status is unavailable."); });
    return () => { live = false; };
  }, []);

  async function act(run: () => Promise<Response>, done?: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await run();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Something went wrong");
      if (done) setMessage(done);
      await load();
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Something went wrong"); }
    setBusy(false);
  }
  const connection = data?.connection;
  const status = connection ? STATUS[connection.status] : null;
  const problem = connection ? syncProblems([{ name: "Scalable", status: connection.status, last_error: connection.last_error }])[0] : undefined;

  return <article id="scalable" aria-labelledby="scalable-connection" className={`scroll-mt-20 space-y-4 rounded-xl border bg-card p-5 ${highlight ? "border-brand ring-2 ring-brand/30" : "border-border"}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h3 id="scalable-connection" className="flex flex-wrap items-center gap-2 font-medium">Scalable Capital
          <span className="text-xs font-normal text-muted-foreground">Broker</span>
          {status && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>}</h3>
        {connection && <p className="text-xs text-muted-foreground">Last sync {date(connection.last_synced_at)}{connection.status === "active" ? ` · next automatic sync ${nextSync(connection.last_synced_at)}` : ""}</p>}
      </div>
      {connection && data && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || !data.configured || connection.status !== "active"}
          onClick={() => void act(() => fetch(`/api/scalable/connections/${connection.id}/sync`, { method: "POST" }), "Scalable synced.")}>{busy ? "Working…" : "Sync now"}</Button>
        <Button size="sm" variant={connection.status === "active" ? "ghost" : "default"} disabled={busy || !data.configured}
          onClick={() => { setBusy(true); setError(null); openScalableLogin().catch(failure => { setBusy(false); setError(failure instanceof Error ? failure.message : "The Scalable login could not be opened"); }); }}>Reconnect</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm("Disconnect Scalable Capital? Synced data stays."))
          void act(() => fetch(`/api/scalable/connections/${connection.id}`, { method: "DELETE" }), "Scalable Capital disconnected."); }}>Disconnect</Button>
      </div>}
    </div>
    {message && <p role="status" className="text-sm text-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
    {problem && <div role="alert" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning"><p>{problem}</p>
      {connection?.last_error && <details className="mt-1 text-xs"><summary className="cursor-pointer">What Scalable said</summary><p className="mt-1 break-words">{connection.last_error}</p></details>}</div>}
    {children}
    {setting}
  </article>;
}
