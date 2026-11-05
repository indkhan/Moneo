"use client";

import { useEffect, useId, useState } from "react";
import { supportedCurrencies } from "@/lib/finance/fx";

const COMMON = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "INR", "CNY"];
const field = "min-h-10 w-full rounded-[10px] border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";

export type CurrencyOption = { code: string; name: string; label: string };

/** Every currency the server accepts, the usual ones first, named in the viewer's language. */
export function currencyOptions(locale = "en"): CurrencyOption[] {
  const names = new Intl.DisplayNames([locale], { type: "currency" });
  const codes = [...COMMON, ...supportedCurrencies().filter(code => !COMMON.includes(code))];
  return codes.map(code => { const name = names.of(code) ?? code; return { code, name, label: name === code ? code : `${code} · ${name}` }; });
}

/** Finds by code or by any part of the name; codes that start with the text come first. */
export function matchCurrencies(options: CurrencyOption[], text: string) {
  const query = text.trim().toLowerCase();
  if (!query) return options;
  const byCode = options.filter(option => option.code.toLowerCase().startsWith(query));
  return [...byCode, ...options.filter(option => !byCode.includes(option) && option.label.toLowerCase().includes(query))];
}

/** The code a form submits for what is typed: a chosen option's code, or the text itself so the server can refuse it. */
export function currencyCode(options: CurrencyOption[], text: string) {
  return options.find(option => option.label === text)?.code ?? text.trim().toUpperCase();
}

/** A searchable currency picker that shows code and name and submits the three-letter code under `name`. */
export function CurrencySelect({ name, label, defaultValue = "", locale, onChange, className = "" }: {
  name: string; label: string; defaultValue?: string; locale?: string; onChange?: (code: string) => void; className?: string;
}) {
  const id = useId();
  const [options] = useState(() => currencyOptions(locale));
  const known = (code: string) => options.find(option => option.code === code);
  const [text, setText] = useState(known(defaultValue)?.label ?? defaultValue);
  // Undo elsewhere can change the saved currency while this stays mounted; never submit the stale one.
  const [saved, setSaved] = useState(defaultValue);
  if (defaultValue !== saved) { setSaved(defaultValue); setText(known(defaultValue)?.label ?? defaultValue); }
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const code = currencyCode(options, text);
  // A chosen option lists everything again, so changing your mind does not start with clearing the field.
  const shown = open ? (options.some(option => option.label === text) ? options : matchCurrencies(options, text)) : [];
  useEffect(() => { if (active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, id]);
  const type = (next: string) => { setText(next); setOpen(true); setActive(-1); onChange?.(currencyCode(options, next)); };
  const choose = (option: CurrencyOption) => { setText(option.label); setOpen(false); setActive(-1); onChange?.(option.code); };
  return <span className={`relative block w-56 max-w-full ${className}`}>
    <input type="hidden" name={name} value={code} />
    <input role="combobox" aria-label={label} aria-expanded={shown.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      autoComplete="off" required value={text} className={field} suppressHydrationWarning
      onChange={event => type(event.target.value)}
      onFocus={event => { event.target.select(); setOpen(true); }}
      onBlur={() => { const match = known(code); if (match) setText(match.label); setOpen(false); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          const step = event.key === "ArrowDown" ? 1 : -1;
          if (shown.length) setActive(current => Math.max(0, Math.min(shown.length - 1, current + step)));
        }
        if (event.key === "Enter" && shown[active]) { event.preventDefault(); choose(shown[active]); }
      }} />
    <ul id={`${id}-list`} role="listbox" aria-label={label} hidden={!shown.length} className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-[10px] border border-border bg-card py-1 text-sm text-foreground shadow-lg">
      {shown.map((option, index) => <li key={option.code} id={`${id}-${index}`} role="option" aria-selected={index === active}
        className={`cursor-pointer px-3 py-2 hover:bg-muted ${index === active ? "bg-muted" : ""}`}
        onMouseDown={event => { event.preventDefault(); choose(option); }}>{option.label}</li>)}
    </ul>
    {!open && text.trim() && !known(code) && <span role="alert" className="mt-1 block text-xs text-danger">Not a supported currency. Search by name or code and choose from the list.</span>}
  </span>;
}
