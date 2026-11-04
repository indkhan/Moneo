"use client";

import { useState } from "react";
import { associateOccurrence } from "./actions";
import { ActionForm } from "./forms";

type Schedule = { value: string; label: string; accountId: string | null; currency: string; amountMinor: string; dates: string[] };
type Transaction = { value: string; label: string; accountId: string; currency: string; amountMinor: string };
const inputClass = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm";

/** Pick a schedule first; only transactions it could match are offered, and the form says what stays due before saving. */
export function OccurrenceForm({ schedules, transactions }: { schedules: Schedule[]; transactions: Transaction[] }) {
  const [scheduleValue, setScheduleValue] = useState("");
  const [transactionValue, setTransactionValue] = useState("");
  const [date, setDate] = useState("");
  const [fulfillment, setFulfillment] = useState("full");
  const schedule = schedules.find(row => row.value === scheduleValue);
  const options = schedule ? transactions.filter(row => row.currency === schedule.currency && (!schedule.accountId || row.accountId === schedule.accountId) && row.amountMinor.startsWith("-") === schedule.amountMinor.startsWith("-")) : transactions;
  const transaction = options.find(row => row.value === transactionValue);
  return <ActionForm action={associateOccurrence} className="grid gap-3 rounded-xl border border-border bg-card p-4 md:grid-cols-2">
    <label className="grid gap-1 text-sm">Schedule<select name="assumption" required className={inputClass} value={scheduleValue} onChange={event => { setScheduleValue(event.target.value); setTransactionValue(""); }}><option value="" disabled>Select a schedule</option>{schedules.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select></label>
    <div className="grid gap-1 text-sm"><label className="grid gap-1">Scheduled occurrence date<input name="scheduledOn" type="date" required className={inputClass} value={date} onChange={event => setDate(event.target.value)} /></label>
      {schedule?.dates.length ? <div className="flex flex-wrap gap-1">{schedule.dates.map(option => <button key={option} type="button" aria-pressed={date === option} onClick={() => setDate(option)} className={`min-h-8 rounded-full border border-border px-2 font-mono text-xs hover:bg-muted ${date === option ? "bg-muted" : ""}`}>{option}</button>)}</div> : null}</div>
    <label className="grid gap-1 text-sm">Transaction<select name="transaction" required className={inputClass} value={transactionValue} onChange={event => setTransactionValue(event.target.value)}><option value="" disabled>Select exact transaction</option>{options.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select>
      {schedule ? <span className="text-xs text-muted-foreground">Showing {options.length} from the schedule’s {schedule.accountId ? "account" : "currency"}, in {schedule.currency}.</span> : null}</label>
    <label className="grid gap-1 text-sm">Payment<select name="fulfillment" className={inputClass} value={fulfillment} onChange={event => setFulfillment(event.target.value)}><option value="full">Paid in full</option><option value="partial">Part of it, the rest is still due</option></select></label>
    {transaction && schedule ? <p role="status" className="text-sm md:col-span-2">{fulfillment === "full" ? "The forecast stops expecting this date." : "The forecast subtracts this payment and any earlier matches from the amount due on this date."}</p> : null}
    <button type="submit" className="min-h-10 w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{fulfillment === "full" ? "Mark fully paid" : "Record partial payment"}</button>
  </ActionForm>;
}
