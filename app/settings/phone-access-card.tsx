"use client";

import { useActionState } from "react";
import { turnOff, turnOn, type PhoneAccessState } from "./phone-access-actions";

const button = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
const external = "underline hover:text-foreground";

function NextStep({ state }: { state: PhoneAccessState }) {
  if (state.state === "not_installed") return <p className="mt-3 text-sm">Install <a className={external} href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> on this computer and sign in, then press Check again. It is free and connects only your own devices.</p>;
  if (state.state === "signed_out") return <p className="mt-3 text-sm">{state.link
    ? <><a className={external} href={state.link} target="_blank" rel="noreferrer">Sign in to Tailscale</a>, then press Check again.</>
    : "Open Tailscale on this computer and sign in, then press Check again."}</p>;
  if (state.state === "needs_approval" && state.link) return <p className="mt-3 text-sm"><a className={external} href={state.link} target="_blank" rel="noreferrer">Allow secure addresses in Tailscale</a>, then press Check again.</p>;
  if (state.state === "busy") return <p role="alert" className="mt-3 text-sm text-warning">Another app is already using this computer&apos;s Tailscale address. Moneo will not replace it; turn that off first, then press Check again.</p>;
  return null;
}

/** Optional: reach this Moneo from the owner's own phone and tablet through Tailscale. */
export function PhoneAccessCard({ initial }: { initial: PhoneAccessState }) {
  const [state, change, pending] = useActionState<PhoneAccessState>(async previous => previous.state === "on" ? turnOff(previous) : turnOn(previous), initial);
  return <section aria-labelledby="phone-access" className="rounded-xl border border-border bg-card p-6">
    <h2 id="phone-access" className="text-sm font-medium">Phone and tablet <span className="font-normal text-muted-foreground">· optional</span></h2>
    {state.state === "on" ? <>
      <p role="status" className="mt-1 text-sm text-muted-foreground">On. Only devices signed in to your Tailscale account can open Moneo, and they use it without a password. They share this computer&apos;s data and connections, so it needs to be on and awake.</p>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- generated on the server for this address */}
        <img alt={`Scan code for ${state.url}`} src={`data:image/svg+xml;utf8,${encodeURIComponent(state.qr)}`} className="size-36 shrink-0 rounded-lg bg-white p-2" />
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>On your phone or tablet, install <a className={external} href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> and sign in with the same account.</li>
          <li>Scan this code or open <a className="break-all underline hover:text-foreground" href={state.url}>{state.url}</a>.</li>
          <li>Choose Add to Home Screen to keep Moneo there as an app.</li>
        </ol>
      </div>
    </> : <>
      <p className="mt-1 text-sm text-muted-foreground">Use Moneo from your phone or tablet while this computer is on. Nothing changes unless you turn this on.</p>
      <NextStep state={state} />
    </>}
    {state.error && <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p>}
    <form action={change} className="mt-3">
      <button disabled={pending} className={button} onClick={event => {
        if (state.state === "on" && !window.confirm("Turn off phone and tablet access? Those devices lose Moneo until you turn it on again.")) event.preventDefault();
      }}>{pending ? "Checking…" : state.state === "on" ? "Turn off" : state.state === "off" ? "Turn on" : "Check again"}</button>
    </form>
  </section>;
}
