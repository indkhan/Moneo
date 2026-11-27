"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { Modal } from "@/components/command-palette";
import type { AppUpdate } from "@/lib/app-update";
import { installAppUpdate } from "@/lib/app-update-actions";

const primary = "min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";
const SOURCE_COMMANDS = "git pull\nnpm ci\nnpm run setup\nnpm run build\nnpm start";

type Desktop = Extract<AppUpdate, { kind: "desktop" }>;

function describe(update: Desktop) {
  switch (update.state) {
    case "available": return update.installs
      ? "Download it now, then restart Moneo to install it. All your data is kept."
      : "Download it from GitHub and install it over this one. All your data is kept.";
    case "downloading": return `Downloading… ${update.percent ?? 0}%`;
    case "downloaded": return "Downloaded. Restart Moneo to install it. All your data is kept.";
    case "installing": return "Installing. Moneo closes and opens again by itself in a moment.";
    case "error": return update.error ?? "The update failed. Try again.";
  }
}

function actionLabel(update: Desktop) {
  switch (update.state) {
    case "available": return update.installs ? `Download ${update.latest}` : "Download from GitHub";
    case "downloaded": return "Restart to install";
    case "error": return "Try again";
    case "downloading":
    case "installing": return null;
  }
}

function DesktopSteps({ update, onUpdate }: { update: Desktop; onUpdate: (update: AppUpdate | null) => void }) {
  const [message, setMessage] = useState<string>();
  const [pending, start] = useTransition();
  const label = actionLabel(update);
  const advance = () => start(async () => {
    const result = await installAppUpdate();
    setMessage(result.message);
    if (result.update !== undefined) onUpdate(result.update);
  });
  return <div className="space-y-3">
    <p role={update.state === "error" ? "alert" : "status"} className={`text-sm ${update.state === "error" ? "text-danger" : ""}`}>{describe(update)}</p>
    {update.state === "downloading" && <progress className="h-2 w-full accent-primary" max={100} value={update.percent ?? 0} aria-label="Download progress" />}
    {message && <p role="alert" className="text-sm text-danger">{message}</p>}
    {label && <button type="button" disabled={pending} className={primary} onClick={advance}>{label}</button>}
  </div>;
}

function SourceSteps() {
  return <div className="space-y-2">
    <p className="text-sm">Stop Moneo, then run these in the Moneo folder. Your data and settings are kept.</p>
    <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[13px] leading-6"><code>{SOURCE_COMMANDS}</code></pre>
    <p className="text-sm text-muted-foreground">If you run it with <code className="font-mono">npm run dev</code>, start that instead of the last two.</p>
  </div>;
}

export function UpdateDialog({ update, onUpdate, onClose }: { update: AppUpdate; onUpdate: (update: AppUpdate | null) => void; onClose: () => void }) {
  return <Modal open onClose={onClose} label="Update Moneo" className="inset-0 size-full items-start justify-center px-4 pt-[12vh]">
    <div className="flex max-h-[76dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Moneo {update.latest} is available</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">You have {update.current}.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" aria-hidden="true" /></button>
      </div>
      <div>
        {update.notes && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-sm text-muted-foreground">{update.notes}</p>}
        <a href={update.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm underline hover:text-foreground">Release notes on GitHub</a>
      </div>
      {update.kind === "desktop" ? <DesktopSteps update={update} onUpdate={onUpdate} /> : <SourceSteps />}
    </div>
  </Modal>;
}
