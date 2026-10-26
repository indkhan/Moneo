"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CornerDownLeft, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type Command = { id: string; label: string; group: string; keywords?: string; hint?: string; run: () => void };

// Every word must appear in the label, group or keywords; order of results is the order given.
export function filterCommands(commands: Command[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const haystack = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground">{children}</kbd>;
}

/** Native modal dialog: focus trap, Escape and backdrop come from the platform. */
export function Modal({ open, onClose, label, className, children }: { open: boolean; onClose: () => void; label: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} aria-label={label} onClose={onClose} onClick={event => { if (event.target === ref.current) onClose(); }}
    className={cn("m-0 max-h-none max-w-none bg-transparent p-0 text-foreground backdrop:bg-black/40 open:flex", className)}>
    {open && children}
  </dialog>;
}

export function CommandPalette({ open, onClose, commands, onAsk }: { open: boolean; onClose: () => void; commands: Command[]; onAsk?: (question: string) => void }) {
  return <Modal open={open} onClose={onClose} label="Command palette" className="inset-0 size-full items-start justify-center px-4 pt-[12vh]">
    <PaletteBody commands={commands} onClose={onClose} onAsk={onAsk} />
  </Modal>;
}

// Mounted only while open, so the query and selection reset each time.
function PaletteBody({ commands, onClose, onAsk }: { commands: Command[]; onClose: () => void; onAsk?: (question: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const question = query.trim();
  // Whatever is typed can always be sent to the assistant, so it is the last row.
  const asking: Command[] = onAsk && question ? [{ id: "ask-moneo", label: `Ask Moneo “${question}”`, group: "Ask Moneo", run: () => onAsk(question) }] : [];
  const results = [...filterCommands(commands, query), ...asking];
  const selected = Math.min(active, Math.max(results.length - 1, 0));
  const run = (command: Command | undefined) => { if (!command) return; onClose(); command.run(); };

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((selected + step + results.length) % Math.max(results.length, 1));
    } else if (event.key === "Enter") { event.preventDefault(); run(results[selected]); }
  }

  useEffect(() => { document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [listId, selected]);

  return <div className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
    <div className="flex items-center gap-2 border-b border-border px-4">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input autoFocus value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}
        role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${selected}` : undefined} aria-label="Search commands"
        placeholder="Jump to a page, account or action…" className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      <button type="button" onClick={onClose} aria-label="Close command palette" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
    </div>
    <ul id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-2">
      {results.map((command, index) => <li key={command.id} role="presentation">
        {(index === 0 || results[index - 1].group !== command.group) && <p role="presentation" className="px-2 pb-1 pt-3 eyebrow">{command.group}</p>}
        <div id={`${listId}-${index}`} role="option" aria-selected={index === selected} onMouseMove={() => setActive(index)} onClick={() => run(command)}
          className={cn("flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm", index === selected && "bg-accent text-accent-foreground")}>
          <span className="truncate">{command.label}</span>
          {index === selected ? <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : command.hint && <span className="shrink-0 text-xs text-muted-foreground">{command.hint}</span>}
        </div>
      </li>)}
      {!results.length && <li className="px-3 py-8 text-center text-sm text-muted-foreground">No matches for “{query}”</li>}
    </ul>
  </div>;
}

export function ShortcutHelp({ open, onClose, shortcuts }: { open: boolean; onClose: () => void; shortcuts: { keys: string[]; label: string }[] }) {
  return <Modal open={open} onClose={onClose} label="Keyboard shortcuts" className="inset-0 size-full items-center justify-center px-4">
    <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Keyboard shortcuts</h2>
        <button type="button" autoFocus onClick={onClose} aria-label="Close keyboard shortcuts" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button></div>
      <dl className="divide-y divide-border text-sm">{shortcuts.map(({ keys, label }) => <div key={label} className="flex items-center justify-between gap-4 py-2">
        <dt className="text-muted-foreground">{label}</dt><dd className="flex shrink-0 gap-1">{keys.map(key => <Kbd key={key}>{key}</Kbd>)}</dd>
      </div>)}</dl>
    </div>
  </Modal>;
}
