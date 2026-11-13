"use client";

import { useEffect, useState, useTransition } from "react";
import { appUpdate, type AppUpdateState } from "./app-update-actions";

const button = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";

function describe(state: AppUpdateState) {
  switch (state.state) {
    case "checking": return "Checking for updates…";
    case "current": return `You have the latest version.`;
    case "available": return state.installs
      ? `Moneo ${state.latest} is available. Updating downloads it, restarts Moneo and keeps all your data.`
      : `Moneo ${state.latest} is available. Download it from GitHub and install it over this one; your data stays.`;
    case "downloading": return `Downloading Moneo ${state.latest}… ${state.percent ?? 0}%`;
    case "installing": return `Installing Moneo ${state.latest}. Moneo closes and opens again by itself in a moment.`;
    case "error": return state.error;
    default: return null;
  }
}

/** Moneo Desktop only: check GitHub releases for a newer version and install it. */
export function AppUpdate({ initial }: { initial: AppUpdateState }) {
  const [state, setState] = useState(initial);
  const [pending, start] = useTransition();
  const run = (action: "check" | "install") => start(async () => setState(await appUpdate(action, state)));
  const working = state.state === "downloading" || state.state === "installing";
  // Follow the download. Once it installs, Moneo restarts and opens a new window by itself.
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(async () => setState(await appUpdate("status", state).catch(() => state)), 1_000);
    return () => clearTimeout(timer);
  }, [working, state]);
  const text = describe(state);
  return <section id="updates" aria-labelledby="updates-title" className="scroll-mt-20 rounded-xl border border-border bg-card p-6">
    <h2 id="updates-title" className="text-sm font-medium">App updates</h2>
    <p className="mt-1 text-sm text-muted-foreground">This is Moneo {state.current}. Moneo checks for a new version only when you ask, and your data stays on this computer when it updates.</p>
    {text && <p role={state.state === "error" ? "alert" : "status"} className={`mt-3 text-sm ${state.state === "error" ? "text-danger" : ""}`}>{text}</p>}
    {state.message && <p role="alert" className="mt-3 text-sm text-danger">{state.message}</p>}
    {state.state === "downloading" && <progress className="mt-3 h-2 w-full max-w-sm accent-primary" max={100} value={state.percent ?? 0} aria-label="Download progress" />}
    <div className="mt-3 flex flex-wrap gap-2">
      {state.state === "available" && <button type="button" disabled={pending} className={primary} onClick={() => run("install")}>
        {state.installs ? `Update to ${state.latest}` : `Download ${state.latest}`}
      </button>}
      {!working && <button type="button" disabled={pending || state.state === "checking"} className={button} onClick={() => run("check")}>
        {pending || state.state === "checking" ? "Checking…" : "Check for updates"}
      </button>}
    </div>
  </section>;
}
