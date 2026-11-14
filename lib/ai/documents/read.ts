import { columnLetters, locationLabel, parseLocation, sheetPrefix, type DocumentLocation } from "@/lib/ai/citations";
import type { DocumentUnit, ExtractedDocument } from "./extract";

// Documents as the model reads them: a header naming the file, its id and how to cite it, then the text with
// a location on every page, slide, paragraph or row. Long documents are cut at a unit boundary with a note
// naming the next range for document_read.

const KIND_NAMES = { pdf: "PDF", docx: "Word document", pptx: "PowerPoint deck", xlsx: "Excel workbook", csv: "CSV table" } as const;
type RowUnit = Extract<DocumentUnit, { kind: "row" }>;

const escapeCell = (value: string) => value.replace(/\|/g, "\\|");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function sheetRange(document: ExtractedDocument, sheet: number) {
  const rows = document.units.filter((unit): unit is RowUnit => unit.kind === "row" && unit.sheet === sheet);
  const columns = document.sheets?.[sheet]?.columns ?? 0;
  return rows.length && columns ? `A${rows[0].n}:${columnLetters(columns)}${rows.at(-1)!.n}` : "empty";
}

function overview(document: ExtractedDocument, name: string, id: string) {
  const count = document.kind === "pdf" ? plural(document.pages ?? document.units.length, "page")
    : document.kind === "pptx" ? plural(document.units.length, "slide")
    : document.kind === "docx" ? plural(document.units.length, "paragraph")
    : document.kind === "csv" ? `${plural(document.units.length, "row")} (${sheetRange(document, 0)})`
    : `${plural(document.sheets?.length ?? 0, "sheet")}: ${(document.sheets ?? []).map((sheet, index) => `"${sheet.name}" (${sheetRange(document, index)})`).join(", ")}`;
  const cite = { pdf: "p.N", pptx: "slide.N", docx: "para.N", xlsx: "Sheet!B12", csv: "B12" }[document.kind];
  return `[Document "${name}" (id ${id}), ${KIND_NAMES[document.kind]}, ${count}. Read as text on the owner's computer. Cite it as {{cite ${id} ${cite}}}.]`;
}

/** A row's cells from `from` to `to` (1-based). */
const rowLine = (unit: RowUnit, from = 1, to = unit.cells.length) => `${unit.n} | ${unit.cells.slice(from - 1, to).map(escapeCell).join(" | ")}`;
function sheetHeader(document: ExtractedDocument, sheet: number, from = 1, to = document.sheets?.[sheet]?.columns ?? 1) {
  const name = document.sheets?.[sheet]?.name;
  const columns = Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => columnLetters(from + index)).join(" | ");
  return `=== ${name ? `Sheet "${name}"` : "Table"} (${sheetRange(document, sheet)}) ===\nrow | ${columns}`;
}

function unitText(document: ExtractedDocument, unit: DocumentUnit, imagePages: Set<number>) {
  if (unit.kind === "page") {
    const scanned = document.scannedPages?.includes(unit.n);
    const note = imagePages.has(unit.n) ? "[No text layer: this page is attached as an image after the text.]" : "[No text layer: this page is a scan that was not sent as an image.]";
    return `--- Page ${unit.n} ---\n${scanned ? `${unit.text ? `${unit.text}\n` : ""}${note}` : unit.text}`;
  }
  if (unit.kind === "slide") return `--- Slide ${unit.n} ---\n${unit.text || "[No text on this slide.]"}`;
  if (unit.kind === "para") return unit.heading ? `${"#".repeat(Math.min(unit.heading, 6))} ${unit.text} [¶${unit.n}]` : `[¶${unit.n}] ${unit.text}`;
  return rowLine(unit);
}

function unitLabel(document: ExtractedDocument, unit: DocumentUnit) {
  if (unit.kind === "row") return `${sheetPrefix(document.sheets?.[unit.sheet]?.name)}A${unit.n}`;
  return locationLabel({ kind: unit.kind, from: unit.n, to: unit.n });
}

/** The next stretch after `unit`, written so document_read accepts it. */
function nextRange(document: ExtractedDocument, unit: DocumentUnit) {
  if (unit.kind === "row") {
    const columns = columnLetters(document.sheets?.[unit.sheet]?.columns || 1);
    return `${sheetPrefix(document.sheets?.[unit.sheet]?.name)}A${unit.n}:${columns}${unit.n + 299}`;
  }
  const step = unit.kind === "para" ? 199 : 9;
  return `${unit.kind === "page" ? "p" : unit.kind}.${unit.n}-${unit.n + step}`;
}

/** Units as text within `budget` characters, with sheet headers where a sheet starts and a note where it is cut. */
function renderUnits(document: ExtractedDocument, units: DocumentUnit[], id: string, budget: number, imagePages = new Set<number>(), columns?: [number, number]) {
  const lines: string[] = [];
  let used = 0, sheet = -1;
  for (const [index, unit] of units.entries()) {
    let text = unit.kind === "row" && columns ? rowLine(unit, ...columns) : unitText(document, unit, imagePages);
    if (unit.kind === "row" && unit.sheet !== sheet) { sheet = unit.sheet; text = `${sheetHeader(document, sheet, ...(columns ?? []))}\n${text}`; }
    if (used + text.length > budget && index > 0) {
      const last = units.at(-1)!;
      lines.push(`[Cut here to keep this short: shown up to ${unitLabel(document, units[index - 1])} of ${unitLabel(document, last)}. Read on with document_read, id "${id}", location "${nextRange(document, unit)}".]`);
      break;
    }
    lines.push(text); used += text.length + 1;
  }
  return lines.join(document.kind === "pdf" || document.kind === "pptx" ? "\n\n" : "\n");
}

/** A newly attached document as the model first reads it. */
export function documentForModel(document: ExtractedDocument, name: string, id: string, budget: number, imagePages = new Set<number>()) {
  const body = document.units.length ? renderUnits(document, document.units, id, budget, imagePages) : "[No text could be read from this file.]";
  return `${overview(document, name, id)}\n${body}`;
}

function selectUnits(document: ExtractedDocument, location: DocumentLocation): { units: DocumentUnit[]; columns?: [number, number] } | string {
  if (location.kind === "cells") {
    if (document.kind !== "xlsx" && document.kind !== "csv") return "Cell locations only work for spreadsheets and CSV files.";
    const sheet = location.sheet === undefined ? 0 : (document.sheets ?? []).findIndex(item => item.name.toLowerCase() === location.sheet!.toLowerCase());
    if (sheet < 0) return `There is no sheet "${location.sheet}". Sheets: ${(document.sheets ?? []).map(item => `"${item.name}"`).join(", ")}.`;
    const units = document.units.filter(unit => unit.kind === "row" && unit.sheet === sheet && unit.n >= location.fromRow && unit.n <= location.toRow);
    return { units, columns: [location.fromColumn, location.toColumn] };
  }
  const expected = { page: "pdf", slide: "pptx", para: "docx" }[location.kind];
  if (document.kind !== expected) return `This file is a ${KIND_NAMES[document.kind]}; use ${document.kind === "pdf" ? "p.N" : document.kind === "pptx" ? "slide.N" : document.kind === "docx" ? "para.N" : "cell ranges such as A1:F200"}.`;
  return { units: document.units.filter(unit => unit.kind === location.kind && unit.n >= location.from && unit.n <= location.to) };
}

/** Places where `query` appears, each with its location and a little text around it. */
function search(document: ExtractedDocument, query: string, limit = 40) {
  const needle = query.toLowerCase();
  const found: string[] = [];
  for (const unit of document.units) {
    if (found.length >= limit) break;
    if (unit.kind === "row") {
      unit.cells.forEach((cell, index) => { if (found.length < limit && cell.toLowerCase().includes(needle)) found.push(`${sheetPrefix(document.sheets?.[unit.sheet]?.name)}${columnLetters(index + 1)}${unit.n}: ${rowLine(unit)}`); });
      continue;
    }
    const text = unit.text.replace(/\s+/g, " ");
    for (let at = text.toLowerCase().indexOf(needle); at >= 0 && found.length < limit; at = text.toLowerCase().indexOf(needle, at + needle.length))
      found.push(`${unitLabel(document, unit)}: …${text.slice(Math.max(0, at - 150), at + needle.length + 150)}…`);
  }
  return found;
}

/** What document_read returns: a location range, the places a text appears, or the start of the document. */
export function readDocument(document: ExtractedDocument, input: { name: string; id: string; location?: string; search?: string }, budget = 30_000) {
  const head = overview(document, input.name, input.id);
  if (input.search) {
    const found = search(document, input.search);
    return `${head}\n${found.length ? `"${input.search}" appears at:\n${found.join("\n")}` : `"${input.search}" does not appear in the text. Try a shorter or different word.`}`;
  }
  if (!input.location) return documentForModel(document, input.name, input.id, budget);
  const location = parseLocation(input.location);
  if (!location) return `${head}\nThe location "${input.location}" is not valid. Use p.3 or p.3-5 for PDF pages, slide.2 for slides, para.10-40 for Word paragraphs, or Sheet1!A1:F200 (or A1:F200) for cells.`;
  const selected = selectUnits(document, location);
  if (typeof selected === "string") return `${head}\n${selected}`;
  if (!selected.units.length) return `${head}\nNothing is at ${locationLabel(location)}.`;
  return `${head}\n${renderUnits(document, selected.units, input.id, budget, new Set(), selected.columns)}`;
}

/** What the in-app viewer shows for a citation: the cited slide, paragraphs or cells with a little around them. */
export type CitedSection =
  | { kind: "text"; blocks: { label: string; text: string; heading?: number; target: boolean }[] }
  | { kind: "table"; sheet: string; columns: string[]; rows: { n: number; cells: string[]; target: boolean[] }[] }
  | { kind: "empty"; message: string };

const CONTEXT_PARAGRAPHS = 4, CONTEXT_ROWS = 6, MAX_ROWS = 60, MAX_COLUMNS = 26;

export function citedSection(document: ExtractedDocument, locationText: string): CitedSection {
  const location = parseLocation(locationText);
  if (!location) return { kind: "empty", message: "This citation does not point to a place in the file." };
  if (location.kind === "cells") {
    const selected = selectUnits(document, location);
    if (typeof selected === "string") return { kind: "empty", message: selected };
    const sheet = location.sheet === undefined ? 0 : document.sheets!.findIndex(item => item.name.toLowerCase() === location.sheet!.toLowerCase());
    const total = document.sheets?.[sheet]?.columns ?? 0;
    const first = Math.max(1, Math.min(location.fromColumn, total - MAX_COLUMNS + 1)), last = Math.min(Math.max(total, location.toColumn), first + MAX_COLUMNS - 1);
    const rows = document.units.filter((unit): unit is RowUnit => unit.kind === "row" && unit.sheet === sheet
      && unit.n >= location.fromRow - CONTEXT_ROWS && unit.n <= Math.min(location.toRow, location.fromRow + MAX_ROWS) + CONTEXT_ROWS);
    return { kind: "table", sheet: document.sheets?.[sheet]?.name ?? "", columns: Array.from({ length: last - first + 1 }, (_, index) => columnLetters(first + index)),
      rows: rows.map(row => {
        const cells = Array.from({ length: last - first + 1 }, (_, index) => row.cells[first + index - 1] ?? "");
        const inRows = row.n >= location.fromRow && row.n <= location.toRow;
        return { n: row.n, cells, target: cells.map((_, index) => inRows && first + index >= location.fromColumn && first + index <= location.toColumn) };
      }) };
  }
  const selected = selectUnits(document, location);
  if (typeof selected === "string") return { kind: "empty", message: selected };
  const around = location.kind === "para" ? CONTEXT_PARAGRAPHS : 0;
  const units = document.units.filter(unit => unit.kind === location.kind && unit.n >= location.from - around && unit.n <= location.to + around);
  if (!units.length) return { kind: "empty", message: `Nothing is at ${locationLabel(location)}.` };
  return { kind: "text", blocks: units.map(unit => ({ label: unitLabel(document, unit), text: unit.kind === "row" ? "" : unit.text,
    ...(unit.kind === "para" && unit.heading ? { heading: unit.heading } : {}), target: unit.kind !== "row" && unit.n >= location.from && unit.n <= location.to })) };
}
