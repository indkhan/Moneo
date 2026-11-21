"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export type CategoryOption = { id: string; name: string };

export function matchCategories(options: CategoryOption[], text: string) {
  const query = text.trim().toLowerCase();
  if (!query) return options;
  const starts = options.filter(option => option.name.toLowerCase().startsWith(query));
  return [...starts, ...options.filter(option => !starts.includes(option) && option.name.toLowerCase().includes(query))];
}

export function resolveCategory(options: CategoryOption[], text: string, allowCreate = false): { id: string } | { name: string } | null {
  const typed = text.trim();
  const match = options.find(option => option.name.toLowerCase() === typed.toLowerCase());
  if (match) return { id: match.id };
  return allowCreate && typed ? { name: typed } : null;
}

const LIST_MAX_HEIGHT = 224;
const LIST_GAP = 4;

export function listPlacement(input: { top: number; bottom: number; left: number; width: number }, viewportHeight: number): CSSProperties {
  const below = viewportHeight - input.bottom - LIST_GAP * 2;
  const above = input.top - LIST_GAP * 2;
  const opensBelow = below >= Math.min(LIST_MAX_HEIGHT, above) || below >= above;
  const space = opensBelow ? below : above;
  return {
    position: "fixed", left: input.left, width: input.width, maxHeight: Math.max(0, Math.min(LIST_MAX_HEIGHT, space)),
    ...(opensBelow ? { top: input.bottom + LIST_GAP } : { bottom: viewportHeight - input.top + LIST_GAP }),
  };
}

export function CategoryCombobox({ label, options, value, onChange, allowCreate = false, placeholder, disabled, className = "" }: {
  label: string; options: CategoryOption[]; value: string; onChange: (text: string) => void;
  allowCreate?: boolean; placeholder?: string; disabled?: boolean; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const typed = value.trim();
  const exact = options.some(option => option.name.toLowerCase() === typed.toLowerCase());
  const matches = exact ? options : matchCategories(options, value);
  const create = allowCreate && typed && !exact ? typed.slice(0, 100) : "";
  const shown = open ? [...matches.map(option => ({ key: option.id, text: option.name, label: option.name })), ...(create ? [{ key: "+new", text: create, label: `Create “${create}”` }] : [])] : [];
  useEffect(() => { if (active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, id]);
  const listOpen = shown.length > 0;
  useLayoutEffect(() => {
    if (!listOpen) return;
    const place = () => { if (inputRef.current) setPlacement(listPlacement(inputRef.current.getBoundingClientRect(), window.innerHeight)); };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [listOpen]);
  const choose = (text: string) => { onChange(text); setOpen(false); setActive(-1); };
  return <span className={`relative block min-w-0 ${className}`}>
    <input ref={inputRef} role="combobox" aria-label={label} aria-expanded={shown.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      autoComplete="off" value={value} maxLength={100} placeholder={placeholder} disabled={disabled} suppressHydrationWarning
      className="min-h-9 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
      onChange={event => { onChange(event.target.value); setOpen(true); setActive(-1); }}
      onFocus={event => { event.target.select(); setOpen(true); }}
      onBlur={() => { setOpen(false); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          const step = event.key === "ArrowDown" ? 1 : -1;
          if (shown.length) setActive(current => Math.max(0, Math.min(shown.length - 1, current + step)));
        }
        if (event.key === "Enter" && shown[active]) { event.preventDefault(); choose(shown[active].text); }
      }} />
    <ul id={`${id}-list`} role="listbox" aria-label={label} hidden={!shown.length} style={placement} className="z-30 min-w-48 overflow-auto rounded-lg border border-border bg-card py-1 text-sm text-foreground shadow-lg">
      {shown.map((option, index) => <li key={option.key} id={`${id}-${index}`} role="option" aria-selected={index === active}
        className={`cursor-pointer px-3 py-2 hover:bg-muted ${index === active ? "bg-muted" : ""} ${option.key === "+new" ? "font-medium text-brand" : ""}`}
        onMouseDown={event => { event.preventDefault(); choose(option.text); }}>{option.label}</li>)}
    </ul>
  </span>;
}
