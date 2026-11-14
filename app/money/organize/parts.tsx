import Link from "next/link";
import type { ReactNode } from "react";
import { SafeForm } from "@/components/safe-form";
import type { SafeState } from "@/lib/safe-action";

export const card = "rounded-xl border border-border bg-card p-4 sm:p-5";
export const field = "min-h-9 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-sm text-foreground sm:w-auto sm:max-w-56";
export const primary = "min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
export const quiet = "min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50";
const chip = (active: boolean) => `inline-flex h-11 items-center rounded-full border px-3.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai lg:h-9 ${active ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"}`;

export function Chips({ label, items }: { label: string; items: { href: string; text: string; active: boolean; count?: number }[] }) {
  return <nav aria-label={label} className="flex flex-wrap gap-1.5">
    {items.map(item => <Link key={item.href} href={item.href} aria-current={item.active ? "page" : undefined} className={chip(item.active)}>
      {item.text}{!!item.count && <span className="ml-2 tabular-nums">{item.count}</span>}</Link>)}
  </nav>;
}

type Option = { id: string; name: string };
/** A plain select of existing categories or merchants; an empty choice means none. */
export function Pick({ name, label, options, empty, value }: { name: string; label: string; options: Option[]; empty: string; value?: string | null }) {
  return <select name={name} aria-label={label} defaultValue={value ?? ""} className={field}>
    <option value="">{empty}</option>
    {options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
  </select>;
}

/** One button in its own form, so any row can carry several actions. */
export function Action({ action, fields, label, name, tone = "quiet" }: { action: (state: SafeState, form: FormData) => Promise<SafeState>; fields: [string, string][]; label: string; name: string; tone?: "quiet" | "primary" }) {
  return <SafeForm action={action} className="inline-flex flex-wrap items-center gap-2">
    {fields.map(([key, value], index) => <input key={`${key}${index}`} type="hidden" name={key} value={value} />)}
    <button aria-label={name} className={tone === "primary" ? primary : quiet}>{label}</button>
  </SafeForm>;
}

export const Notice = ({ children }: { children: ReactNode }) => <p role="status" className="rounded-lg bg-muted p-3 text-sm">{children}</p>;
export const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{children}</p>;
