"use client";

import { useState } from "react";
import { Button } from "@/components/button";

// From README → Connect your bank: what the Enable Banking application form asks for.
const PRIVACY_URL = "https://indkhan.github.io/Moneo/privacy.html";
const TERMS_URL = "https://indkhan.github.io/Moneo/terms.html";
export type BankCredentials = { source: "app" | "env" | null; hint: string | null };

const field = "min-h-10 w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal";

function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-xs">{value}</code>
    <button type="button" className="text-xs text-brand underline-offset-4 hover:underline"
      onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined)}>{copied ? "Copied" : "Copy"}</button>
  </div>;
}

/** Enable Banking App ID and private key: entered here once, checked with Enable Banking and saved encrypted. */
export function BankCredentialsForm({ redirectUrl, onSaved, onCancel }: { redirectUrl: string; onSaved: () => void; onCancel?: () => void }) {
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/bank/credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId, privateKey }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "The App ID and key could not be saved");
      setPrivateKey("");
      onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The App ID and key could not be saved"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={event => void save(event)} className="space-y-3 rounded-lg border border-border p-4">
    <div className="space-y-1.5 text-sm">
      <p className="font-medium">Set up Enable Banking</p>
      <p className="text-muted-foreground">Moneo reaches your bank through Enable Banking, which is free for personal use. You set it up once, in about 10 minutes.</p>
    </div>
    <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
      <li>Sign up at the <a href="https://enablebanking.com/cp/" target="_blank" rel="noreferrer" className="text-brand underline-offset-4 hover:underline">Enable Banking control panel</a>.</li>
      <li className="space-y-1.5">Add an application in the <b className="font-medium text-foreground">Production</b> environment. Give it any name and copy in these addresses:
        <div className="space-y-1.5">
          <Copyable label="Redirect URL" value={redirectUrl} />
          <Copyable label="Privacy policy URL" value={PRIVACY_URL} />
          <Copyable label="Terms of service URL" value={TERMS_URL} />
        </div></li>
      <li>Let the control panel make the key. Keep the file ending in <code className="rounded bg-muted px-1">.pem</code> that it downloads.</li>
      <li>On the new application, link your own bank accounts (activate by linking accounts). Only linked accounts can sync.</li>
      <li>Paste the application&apos;s App ID below and upload the <code className="rounded bg-muted px-1">.pem</code> file.</li>
    </ol>
    <label className="grid gap-1.5 text-sm font-medium">App ID
      <input value={appId} onChange={event => setAppId(event.target.value)} required autoComplete="off" spellCheck={false} placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" className={field} /></label>
    <label className="grid gap-1.5 text-sm font-medium">Private key
      <textarea value={privateKey} onChange={event => setPrivateKey(event.target.value)} required rows={4} autoComplete="off" spellCheck={false}
        placeholder="-----BEGIN PRIVATE KEY-----" className={`${field} font-mono text-xs`} /></label>
    <label className="grid gap-1.5 text-sm font-medium">Or upload the .pem file
      <input type="file" accept=".pem,application/x-pem-file,text/plain" className="w-full min-w-0 text-sm font-normal file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-border file:bg-card file:px-3 file:text-sm"
        onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(setPrivateKey); }} /></label>
    <p className="text-xs text-muted-foreground">The key is checked with Enable Banking, then stored encrypted on this computer. It is never shown again.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" className="min-h-10" disabled={busy || !appId.trim() || !privateKey.trim()}>{busy ? "Checking…" : "Save and check"}</Button>
      {onCancel && <Button type="button" variant="ghost" className="min-h-10" disabled={busy} onClick={onCancel}>Cancel</Button>}
    </div>
  </form>;
}
