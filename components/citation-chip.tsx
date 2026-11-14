"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "lucide-react";
import { locationLabel, type Citation } from "@/lib/ai/citations";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import type { CitedSection } from "@/lib/ai/documents/read";

const fileUrl = (file: ChatAttachment) => `/api/chat/attachments?${new URLSearchParams({ path: file.path })}`;

/** The quoted text marked inside `text`, wherever it appears (ignoring case and spacing differences). */
function Highlighted({ text, quote }: { text: string; quote?: string }) {
  const words = quote?.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words?.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("\\s+")})`, "gi"));
  return <>{parts.map((part, index) => index % 2 ? <mark key={index} className="rounded bg-ai-soft px-0.5 text-foreground">{part}</mark> : part)}</>;
}

function SectionView({ section, quote }: { section: CitedSection; quote?: string }) {
  if (section.kind === "empty") return <p className="text-sm text-muted-foreground">{section.message}</p>;
  if (section.kind === "text") return <div className="space-y-3">{section.blocks.map(block => <div key={block.label} data-target={block.target || undefined}
    className={`rounded-lg p-3 text-sm ${block.target ? "border border-ai-border bg-ai-soft/40" : "text-muted-foreground"}`}>
    <p className="mb-1 text-xs font-medium text-muted-foreground">{block.label}</p>
    <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${block.heading ? "font-semibold" : ""}`}>{block.target ? <Highlighted text={block.text} quote={quote} /> : block.text}</p>
  </div>)}</div>;
  return <div className="overflow-x-auto rounded-lg border border-border">
    <table className="min-w-full text-xs tabular-nums">
      <thead className="bg-muted text-muted-foreground"><tr><th className="px-2 py-1 text-right font-medium" scope="col">{section.sheet || "Row"}</th>{section.columns.map(column => <th key={column} scope="col" className="px-2 py-1 text-left font-medium">{column}</th>)}</tr></thead>
      <tbody>{section.rows.map(row => <tr key={row.n} className="border-t border-border">
        <th scope="row" className="bg-muted px-2 py-1 text-right font-medium text-muted-foreground">{row.n}</th>
        {row.cells.map((cell, index) => <td key={index} data-target={row.target[index] || undefined} className={`max-w-64 truncate px-2 py-1 ${row.target[index] ? "bg-ai-soft font-medium outline outline-1 -outline-offset-1 outline-ai-border" : ""}`} title={cell}>{cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

/** The cited part of a Word, PowerPoint or spreadsheet file, as read on the owner's computer, over the chat. */
function DocumentViewer({ file, citation, label, onClose }: { file: ChatAttachment; citation: Citation; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<CitedSection | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/chat/attachments/section?${new URLSearchParams({ path: file.path, location: citation.location ?? "" })}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("Not found"))).then(setSection)
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [file.path, citation.location]);
  useEffect(() => { if (section) dialog.current?.querySelector("[data-target]")?.scrollIntoView({ block: "center" }); }, [section]);
  return <dialog ref={dialog} aria-label={label} onClose={onClose} onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}
    className="m-auto mb-0 max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-background p-5 text-foreground backdrop:bg-black/40 sm:mb-auto sm:rounded-2xl">
    <div className="mb-3 flex items-center gap-2"><h2 className="mr-auto min-w-0 truncate font-display text-lg font-semibold">{label}</h2>
      <a href={fileUrl(file)} target="_blank" rel="noreferrer" className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Open file</a>
      <button type="button" onClick={() => dialog.current?.close()} aria-label="Close" className="rounded-lg p-2 hover:bg-muted"><X className="size-4" aria-hidden="true" /></button></div>
    {citation.quote && <p className="mb-3 text-sm text-muted-foreground">“{citation.quote}”</p>}
    {failed ? <p role="alert" className="text-sm text-danger">This part of the file could not be loaded.</p> : section ? <SectionView section={section} quote={citation.quote} />
      : <p role="status" className="text-sm text-muted-foreground">Loading…</p>}
  </dialog>;
}

/** A small chip after a sentence that names the file and place it came from; tapping opens that place. */
export function CitationChip({ file, citation }: { file: ChatAttachment; citation: Citation }) {
  const [open, setOpen] = useState(false);
  const where = citation.parsed ? locationLabel(citation.parsed) : "";
  const label = where ? `${file.name} · ${where}` : file.name;
  const chip = "mx-0.5 inline-flex max-w-56 items-center gap-1 rounded-full border border-border bg-muted px-2 py-px align-[1px] text-xs font-normal text-muted-foreground no-underline hover:border-muted-foreground/60 hover:text-foreground";
  // A long file name is cut, never the place in it.
  const content = <><FileText className="size-3 shrink-0" aria-hidden="true" /><span className="min-w-0 truncate">{file.name}</span>{where && <span className="shrink-0">· {where}</span>}</>;
  // PDFs and photos open in the browser's own viewer, a PDF at the cited page.
  if (file.type === "application/pdf" || file.type.startsWith("image/") || !citation.parsed) {
    const page = citation.parsed?.kind === "page" ? `#page=${citation.parsed.from}` : "";
    return <a href={`${fileUrl(file)}${page}`} target="_blank" rel="noreferrer" className={chip} aria-label={label} title={citation.quote ? `“${citation.quote}”` : label}>{content}</a>;
  }
  return <><button type="button" onClick={() => setOpen(true)} className={chip} aria-label={label} title={citation.quote ? `“${citation.quote}”` : label}>{content}</button>
    {/* A dialog cannot sit inside the paragraph the chip is in. */}
    {open && createPortal(<DocumentViewer file={file} citation={citation} label={label} onClose={() => setOpen(false)} />, document.body)}</>;
}
