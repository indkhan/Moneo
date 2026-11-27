"use client";

import { createContext, startTransition, use, useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useDelay } from "@/lib/use-timeout";
import { serialSave } from "@/lib/serial-save";
import { saveSettings, type SaveSettingsState } from "./actions";

type Status = { section: string; state: "saving" | "saved" | "failed"; error?: string; field?: string };
type Autosave = { register: (form: HTMLFormElement | null) => void; changed: (section: string, delayMs: number) => void; status: Status | null; invalid: (name: string) => object };

const TYPING_DELAY_MS = 700;
const AutosaveContext = createContext<Autosave | null>(null);
const typed = (target: EventTarget) => target instanceof HTMLInputElement && ["text", "time", "number", "search", ""].includes(target.type);

function collect(forms: Set<HTMLFormElement>) {
  const data = new FormData();
  for (const form of forms) for (const [key, value] of new FormData(form)) data.append(key, value);
  return data;
}

function focusField(forms: Set<HTMLFormElement>, name: string) {
  for (const form of forms) {
    const named = form.elements.namedItem(name);
    const field = named instanceof HTMLInputElement && named.type === "hidden" ? named.nextElementSibling : named;
    if (!(field instanceof HTMLElement)) continue;
    field.closest("details")?.setAttribute("open", "");
    field.focus();
    return;
  }
}

export function SettingsAutosave({ children }: { children: React.ReactNode }) {
  const forms = useRef(new Set<HTMLFormElement>());
  const section = useRef("");
  const [status, setStatus] = useState<Status | null>(null);
  const [after] = useDelay();
  const saver = useRef<(() => Promise<void>) | null>(null);
  const request = useCallback(() => (saver.current ??= serialSave(() => ({ data: collect(forms.current), section: section.current }), async ({ data, section }) => {
    const result: SaveSettingsState = await saveSettings({}, data).catch(() => ({ error: "Preferences could not be saved. Check that Moneo is running, then try again." }));
    startTransition(() => setStatus(result.error ? { section, state: "failed", error: result.error, field: result.field } : { section, state: "saved" }));
  }))(), []);
  useEffect(() => { if (status?.field) focusField(forms.current, status.field); }, [status]);
  const register = useCallback((form: HTMLFormElement | null) => { if (form) forms.current.add(form); }, []);
  const changed = useCallback((name: string, delayMs: number) => {
    section.current = name;
    setStatus({ section: name, state: "saving" });
    after(() => void request(), delayMs);
  }, [after, request]);
  const invalid = useCallback((name: string) => status?.state === "failed" && status.field === name ? { "aria-invalid": true, "aria-describedby": "settings-error" } : {}, [status]);
  return <AutosaveContext value={{ register, changed, status, invalid }}>{children}</AutosaveContext>;
}

export function useSettingsSection(section: string) {
  const autosave = use(AutosaveContext);
  if (!autosave) throw new Error("useSettingsSection needs SettingsAutosave");
  const { register, changed, invalid, status } = autosave;
  return {
    form: { ref: register, onChange: (event: React.FormEvent<HTMLFormElement>) => changed(section, typed(event.target) ? TYPING_DELAY_MS : 0), onSubmit: (event: React.FormEvent) => event.preventDefault() },
    changed: (delayMs = 0) => changed(section, delayMs),
    invalid,
    status: status?.section === section ? status : null,
  };
}

export function SaveStatus({ status }: { status: Status | null }) {
  if (!status) return null;
  if (status.state === "saving") return <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"><Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />Saving…</span>;
  if (status.state === "saved") return <span role="status" className="inline-flex items-center gap-1 text-xs font-normal text-success"><Check className="size-3" aria-hidden="true" />Saved</span>;
  return <span className="text-xs font-normal text-danger">Not saved</span>;
}

export function SaveError({ status }: { status: Status | null }) {
  return status?.state === "failed" ? <p id="settings-error" role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">{status.error}</p> : null;
}
