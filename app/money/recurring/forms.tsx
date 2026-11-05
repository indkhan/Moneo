"use client";

import { useActionState, useEffect, useState } from "react";
import { Modal } from "@/components/command-palette";
import { cadenceWords, recurringCadences } from "@/lib/finance/cadences";
import type { ActionState } from "./actions";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
const inputClass = "min-h-10 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

function Hidden({ values }: { values: Record<string, string> }) {
  return <>{Object.entries(values).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}</>;
}

/** A plain form whose failure is shown next to it instead of crashing the page. */
export function ActionForm({ action, hidden = {}, className, children }: { action: Action; hidden?: Record<string, string>; className?: string; children: React.ReactNode }) {
  const [state, submit, pending] = useActionState<ActionState, FormData>(action, {});
  return <form action={submit} className={className}>
    <Hidden values={hidden} />
    <fieldset disabled={pending} className="contents">{children}</fieldset>
    {pending && <p role="status" className="basis-full text-xs text-muted-foreground">Saving…</p>}
    {state.error && <p role="alert" className="basis-full text-xs text-danger">{state.error}</p>}
  </form>;
}

export type ScheduleDefaults = { name: string; amount: string; direction: "out" | "in"; cadence: string; startsOn: string; category: string; currencyCode?: string };

/** Opens a dialog to confirm, edit or add a recurring payment: how much, which way, how often, the next date and a category. */
export function ScheduleDialog({ title, trigger, triggerLabel, triggerClassName, action, remove, hidden = {}, defaults, accounts, categories, submitLabel, onDone }: {
  title: string; trigger: React.ReactNode; triggerLabel?: string; triggerClassName?: string; action: Action; remove?: Action; hidden?: Record<string, string>; defaults: ScheduleDefaults;
  accounts?: { id: string; name: string; currencyCode: string }[]; categories: string[]; submitLabel: string; onDone?: () => void;
}) {
  // When it was opened; a submission that succeeds after that closes it. The action refreshes the page.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [state, submit, pending] = useActionState<ActionState, FormData>(action, {});
  const [removed, removeSubmit, removing] = useActionState<ActionState, FormData>(remove ?? (async () => ({})), {});
  const [values, setValues] = useState(defaults);
  // Tell the owner once a save went through, e.g. so a card can show it is done.
  useEffect(() => { if (state.done) onDone?.(); }, [state.done]); // eslint-disable-line react-hooks/exhaustive-deps
  const [accountId, setAccountId] = useState(accounts?.[0]?.id ?? "");
  const open = openedAt !== null && Math.max(state.done ?? 0, removed.done ?? 0) < openedAt;
  const close = () => setOpenedAt(null);
  const currencyCode = accounts ? accounts.find(account => account.id === accountId)?.currencyCode ?? "" : defaults.currencyCode ?? "";
  const set = (key: keyof ScheduleDefaults) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues(current => ({ ...current, [key]: event.target.value }));
  const summary = values.amount && values.startsOn ? `${cadenceWords[values.cadence] ?? ""}: ${values.amount} ${currencyCode} ${values.direction === "out" ? "going out" : "coming in"}, next on ${values.startsOn}` : "";
  const listId = `categories-${title.replace(/\W/g, "")}`;
  return <>
    <button type="button" aria-label={triggerLabel} className={triggerClassName} onClick={() => { setValues(defaults); setConfirmingRemove(false); setOpenedAt(Date.now()); }}>{trigger}</button>
    <Modal open={open} onClose={close} label={title} className="inset-0 size-full items-center justify-center px-4">
      <form action={submit} className="grid max-h-[calc(100dvh-2rem)] w-full max-w-md gap-3 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl">
        <Hidden values={{ ...hidden, shownStartsOn: defaults.startsOn, ...(currencyCode ? { currencyCode } : {}) }} />
        <h2 className="text-base font-semibold">{title}</h2>
        {summary && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{summary}</p>}
        <label className="grid gap-1 text-sm">Name<input name="name" required maxLength={120} value={values.name} onChange={set("name")} className={inputClass} /></label>
        {accounts && <label className="grid gap-1 text-sm">Account<select name="accountId" required value={accountId} onChange={event => setAccountId(event.target.value)} className={inputClass}>
          {accounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currencyCode})</option>)}</select></label>}
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-sm">Direction<select name="direction" value={values.direction} onChange={set("direction")} className={inputClass}>
            <option value="out">Going out</option><option value="in">Coming in</option></select></label>
          <label className="grid gap-1 text-sm">Amount{currencyCode && ` (${currencyCode})`}<input name="amount" required inputMode="decimal" pattern="\d+([.,]\d+)?" value={values.amount} onChange={set("amount")} className={inputClass} /></label>
          <label className="grid gap-1 text-sm">How often<select name="scheduleCadence" value={values.cadence} onChange={set("cadence")} className={inputClass}>
            {recurringCadences.map(cadence => <option key={cadence} value={cadence}>{cadenceWords[cadence]}</option>)}</select></label>
          <label className="grid gap-1 text-sm">Next date<input name="startsOn" type="date" required value={values.startsOn} onChange={set("startsOn")} className={inputClass} /></label>
        </div>
        <label className="grid gap-1 text-sm">Category<input name="category" list={listId} maxLength={100} placeholder="e.g. Job, Rent, Subscriptions" value={values.category} onChange={set("category")} className={inputClass} /></label>
        <datalist id={listId}>{categories.map(name => <option key={name} value={name} />)}</datalist>
        {(state.error || removed.error) && <p role="alert" className="text-sm text-danger">{state.error ?? removed.error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={pending || removing} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Saving…" : submitLabel}</button>
          <button type="button" onClick={close} className="min-h-10 rounded-lg border border-border px-4 text-sm hover:bg-muted">Cancel</button>
          {remove && !confirmingRemove && <button type="button" onClick={() => setConfirmingRemove(true)} className="ml-auto min-h-10 rounded-lg border border-danger/40 px-4 text-sm font-medium text-danger hover:bg-danger-soft">Remove from recurring</button>}
        </div>
        {remove && confirmingRemove && <div role="group" aria-label="Confirm removal" className="space-y-2 rounded-lg border border-border p-3 text-sm"><p>This stops {values.name}’s future forecast dates. Past transactions and marked payments stay.</p><button formAction={removeSubmit} formNoValidate disabled={pending || removing} className="min-h-10 rounded-lg bg-danger px-4 text-sm font-medium text-background disabled:opacity-50">{removing ? "Removing…" : `Yes, remove ${values.name}`}</button></div>}
      </form>
    </Modal>
  </>;
}
