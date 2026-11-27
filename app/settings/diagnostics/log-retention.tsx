"use client";

import { startTransition, useActionState, useState } from "react";
import { LOG_RETENTIONS, LOG_RETENTION_LABELS, type LogRetention } from "@/lib/logs/options";
import { setLogRetentionSafely } from "./log-actions";

export function LogRetentionSetting({ value }: { value: LogRetention }) {
  const [chosen, setChosen] = useState(value);
  const [state, submit, pending] = useActionState(setLogRetentionSafely, {});
  return <form className="mt-4 flex flex-wrap items-center gap-3 text-sm">
    <label htmlFor="log-retention" className="font-medium">Keep logs for</label>
    <select id="log-retention" name="log_retention" value={chosen} disabled={pending} className="min-h-10 rounded-lg border border-border bg-background px-3"
      onChange={event => {
        const next = event.target.value as LogRetention;
        setChosen(next);
        const form = new FormData();
        form.set("log_retention", next);
        startTransition(() => submit(form));
      }}>
      {LOG_RETENTIONS.map(option => <option key={option} value={option}>{LOG_RETENTION_LABELS[option]}</option>)}
    </select>
    <span className="text-muted-foreground">Older entries and their audio are deleted each day.</span>
    {state.error && <p role="alert" className="w-full text-danger">{state.error}</p>}
  </form>;
}
