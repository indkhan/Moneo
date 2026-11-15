import { z } from "zod";

export type DocumentLocation =
  | { kind: "page" | "slide" | "para"; from: number; to: number }
  | { kind: "cells"; sheet?: string; fromRow: number; toRow: number; fromColumn: number; toColumn: number };

export const columnNumber = (letters: string) => [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
export function columnLetters(column: number) {
  let letters = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  return letters;
}
export const sheetPrefix = (sheet: string | undefined) => !sheet ? "" : /^[A-Za-z_][\w.]*$/.test(sheet) ? `${sheet}!` : `'${sheet.replace(/'/g, "''")}'!`;

const MAX_INDEX = 1_000_000;
const RANGE = /^(p|page|slide|para|¶)\.?\s?(\d{1,7})(?:\s?[-–]\s?(\d{1,7}))?$/i;
const CELL = /^([A-Z]{1,3})(\d{1,7})$/i;

export function parseLocation(text: string): DocumentLocation | null {
  const value = text.trim();
  const range = RANGE.exec(value);
  if (range) {
    const kind = range[1].toLowerCase();
    const from = Number(range[2]), to = Number(range[3] ?? range[2]);
    if (from < 1 || to < from || to > MAX_INDEX) return null;
    return { kind: kind === "p" || kind === "page" ? "page" : kind === "slide" ? "slide" : "para", from, to };
  }
  const sheetMatch = /^(?:'((?:[^']|'')+)'|([^!'\s]+))!(.+)$/.exec(value);
  const sheet = sheetMatch ? (sheetMatch[1]?.replace(/''/g, "'") ?? sheetMatch[2]) : undefined;
  const cells = (sheetMatch ? sheetMatch[3] : value).split(":");
  if (cells.length > 2) return null;
  const [start, end] = cells.map(cell => CELL.exec(cell));
  if (!start || (cells.length === 2 && !end)) return null;
  const last = end ?? start;
  const fromColumn = columnNumber(start[1]), toColumn = columnNumber(last[1]), fromRow = Number(start[2]), toRow = Number(last[2]);
  if (fromRow < 1 || toRow < fromRow || toColumn < fromColumn || toRow > MAX_INDEX || toColumn > 16_384) return null;
  return { kind: "cells", ...(sheet ? { sheet } : {}), fromRow, toRow, fromColumn, toColumn };
}

export function locationLabel(location: DocumentLocation) {
  if (location.kind === "cells") {
    const start = `${columnLetters(location.fromColumn)}${location.fromRow}`, end = `${columnLetters(location.toColumn)}${location.toRow}`;
    return `${sheetPrefix(location.sheet)}${start}${end === start ? "" : `:${end}`}`;
  }
  const span = location.to === location.from ? `${location.from}` : `${location.from}–${location.to}`;
  return location.kind === "page" ? `p.${span}` : location.kind === "slide" ? `slide ${span}` : `¶${span}`;
}

export const citationSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}$/),
  location: z.string().max(140).optional(),
  quote: z.string().trim().min(1).max(300).optional(),
}).strict();
export type Citation = z.infer<typeof citationSchema> & { parsed?: DocumentLocation };

export const CITATION_PATTERN = /\{\{cite\s+([0-9a-f]{8})(?:\s+('(?:[^'\n]|'')+'![^\s"{}]+|[^\s"{}]+))?(?:\s+"([^"\n{}]{1,300})")?\s*\}\}/gi;

export function parseCitation(match: RegExpMatchArray): Citation | null {
  const parsed = citationSchema.safeParse({ id: match[1].toLowerCase(), location: match[2], quote: match[3] });
  if (!parsed.success) return null;
  const location = parsed.data.location ? parseLocation(parsed.data.location) : null;
  return location ? { ...parsed.data, parsed: location } : { id: parsed.data.id, ...(parsed.data.quote ? { quote: parsed.data.quote } : {}) };
}

export const citations = (text: string) => [...text.matchAll(CITATION_PATTERN)].flatMap(match => parseCitation(match) ?? []);
