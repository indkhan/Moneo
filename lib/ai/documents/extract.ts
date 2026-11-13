import ExcelJS from "exceljs";
import JSZip from "jszip";
import Papa from "papaparse";
import { createIsomorphicCanvasFactory, extractText, getDocumentProxy } from "unpdf";
import type { AttachmentType } from "@/lib/ai/chat-attachments";

// Every document becomes text on this computer, the same way for every AI source, split into units that
// carry their location: PDF pages, PPTX slides, DOCX paragraphs and spreadsheet rows. Answers cite these
// locations and document_read pages through them.

export type DocumentKind = "pdf" | "docx" | "pptx" | "xlsx" | "csv";
export type DocumentUnit =
  | { kind: "page"; n: number; text: string }
  | { kind: "slide"; n: number; text: string }
  /** A DOCX paragraph or table row; headings carry their level. */
  | { kind: "para"; n: number; text: string; heading?: number }
  /** A spreadsheet row; `sheet` indexes `sheets`, cells start at column A. */
  | { kind: "row"; sheet: number; n: number; cells: string[] };
export type ExtractedDocument = { kind: DocumentKind; units: DocumentUnit[]; sheets?: { name: string; columns: number }[]; pages?: number; scannedPages?: number[] };

export const DOCUMENT_KINDS: Partial<Record<AttachmentType, DocumentKind>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv", "text/tab-separated-values": "csv",
};

/** A PDF page with less text than this has no real text layer (a scan, or a photo saved as PDF). */
const MIN_PAGE_CHARS = 10;
const MAX_CELL_CHARS = 300;

export async function extractDocument(bytes: Uint8Array, type: AttachmentType): Promise<ExtractedDocument> {
  switch (DOCUMENT_KINDS[type]) {
    case "pdf": return extractPdf(bytes);
    case "docx": return extractDocx(bytes);
    case "pptx": return extractPptx(bytes);
    case "xlsx": return extractXlsx(bytes);
    case "csv": return extractCsv(bytes, type === "text/tab-separated-values" ? "\t" : undefined);
    default: throw new Error(`${type} is not a document`);
  }
}

// ---- PDF ----

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  // pdf.js may take ownership of the buffer, so it gets a copy.
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
  const units = text.map((page, index) => ({ kind: "page" as const, n: index + 1, text: page.trim() }));
  return { kind: "pdf", units, pages: units.length, scannedPages: units.filter(unit => unit.text.replace(/\s/g, "").length < MIN_PAGE_CHARS).map(unit => unit.n) };
}

/** PDF pages drawn as JPEG images on this computer, for pages that have no text to read. */
export async function renderPdfPages(bytes: Uint8Array, pages: number[], width = 1400): Promise<{ page: number; image: Uint8Array }[]> {
  const CanvasFactory = await createIsomorphicCanvasFactory(() => import("@napi-rs/canvas"));
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { CanvasFactory } as never);
  const factory = new CanvasFactory();
  const images: { page: number; image: Uint8Array }[] = [];
  try {
    for (const number of pages) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: Math.min(3, width / page.getViewport({ scale: 1 }).width) });
      const drawing = factory.create(viewport.width, viewport.height);
      try {
        // Scans are usually printed on white; a transparent page would turn black as JPEG.
        const context = drawing.context as unknown as CanvasRenderingContext2D;
        context.fillStyle = "#fff"; context.fillRect(0, 0, viewport.width, viewport.height);
        await page.render({ canvas: drawing.canvas as never, canvasContext: context, viewport } as never).promise;
        images.push({ page: number, image: new Uint8Array(await (drawing.canvas as unknown as { encode(format: "jpeg", quality: number): Promise<Uint8Array> }).encode("jpeg", 80)) });
      } finally { factory.destroy(drawing); }
    }
  } finally { await pdf.loadingTask.destroy(); }
  return images;
}

// ---- Office XML ----

type Token = { tag: string; close: boolean; empty: boolean; attrs: string } | { text: string };
const TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;

function* xmlTokens(xml: string): Generator<Token> {
  for (const match of xml.matchAll(TOKEN)) {
    if (match[2]) yield { tag: match[2], close: match[1] === "/", empty: match[4] === "/", attrs: match[3] };
    else if (match[5] !== undefined) yield { text: match[5] };
    else if (match[6] !== undefined) yield { text: decodeEntities(match[6]) };
  }
}
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const decodeEntities = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) =>
  entity[0] === "#" ? String.fromCodePoint(Number.parseInt(entity.slice(entity[1] === "x" || entity[1] === "X" ? 2 : 1), entity[1] === "x" || entity[1] === "X" ? 16 : 10)) : ENTITIES[entity] ?? whole);
const attribute = (attrs: string, name: string) => { const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs); return match ? decodeEntities(match[1]) : undefined; };
const clean = (text: string) => text.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();

async function zipText(zip: JSZip, path: string) {
  const file = zip.file(path);
  if (!file) throw new Error(`The file is missing ${path}`);
  return file.async("string");
}

/** Heading levels by DOCX style id: built-in "heading n" and "Title" styles, or any style with an outline level. */
function headingStyles(stylesXml: string | undefined) {
  const levels = new Map<string, number>();
  for (const match of (stylesXml ?? "").matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attribute(match[1], "w:styleId");
    if (!id) continue;
    const name = /<w:name w:val="([^"]*)"/.exec(match[2])?.[1]?.toLowerCase() ?? "";
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(match[2])?.[1];
    const level = name === "title" ? 1 : /^heading (\d)$/.exec(name)?.[1] ?? (outline !== undefined ? Number(outline) + 1 : undefined);
    if (level !== undefined) levels.set(id, Number(level));
  }
  return levels;
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const zip = await JSZip.loadAsync(bytes);
  const levels = headingStyles(await zip.file("word/styles.xml")?.async("string"));
  const units: DocumentUnit[] = [];
  const push = (text: string, heading?: number) => { const value = clean(text); if (value) units.push({ kind: "para", n: units.length + 1, text: value, ...(heading ? { heading } : {}) }); };
  let paragraph = "", level: number | undefined, inText = false, tableDepth = 0, cell = "", row: string[] = [];
  for (const token of xmlTokens(await zipText(zip, "word/document.xml"))) {
    if ("text" in token) { if (inText) { if (tableDepth) cell += token.text; else paragraph += token.text; } continue; }
    const { tag, close, empty, attrs } = token;
    if (tag === "w:t") inText = !close && !empty;
    else if ((tag === "w:tab" || tag === "w:br" || tag === "w:cr") && !close) { if (tableDepth) cell += " "; else paragraph += tag === "w:tab" ? "\t" : "\n"; }
    else if (tag === "w:pStyle" && !tableDepth) level = levels.get(attribute(attrs, "w:val") ?? "");
    else if (tag === "w:outlineLvl" && !tableDepth) { const value = attribute(attrs, "w:val"); if (value && Number(value) < 9) level = Number(value) + 1; }
    else if (tag === "w:p" && !close && !empty) { if (tableDepth) { if (cell) cell += " "; } else { paragraph = ""; level = undefined; } }
    else if (tag === "w:p" && close && !tableDepth) push(paragraph, level);
    else if (tag === "w:tbl") tableDepth += close ? -1 : 1;
    else if (tag === "w:tc" && close && tableDepth === 1) { row.push(clean(cell).replace(/\n/g, " ")); cell = ""; }
    else if (tag === "w:tr" && !close && tableDepth === 1) row = [];
    else if (tag === "w:tr" && close && tableDepth === 1 && row.some(Boolean)) push(`| ${row.join(" | ")} |`);
  }
  return { kind: "docx", units };
}

/** Paths in .rels files are relative to the folder of the part that owns them. */
function resolvePart(from: string, target: string) {
  const parts = from.split("/").slice(0, -1);
  for (const piece of target.split("/")) { if (piece === "..") parts.pop(); else if (piece !== ".") parts.push(piece); }
  return parts.join("/").replace(/^\//, "");
}
async function relationships(zip: JSZip, part: string) {
  const relsPath = `${part.split("/").slice(0, -1).join("/")}/_rels/${part.split("/").at(-1)}.rels`;
  const xml = await zip.file(relsPath)?.async("string") ?? "";
  return [...xml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(match => ({ id: attribute(match[1], "Id") ?? "", type: attribute(match[1], "Type") ?? "", target: resolvePart(part, attribute(match[1], "Target") ?? "") }));
}

/** A slide or notes page's text, one line per paragraph; slide-number fields are left out. */
function drawingText(xml: string) {
  let text = "", inText = false, field = 0;
  for (const token of xmlTokens(xml)) {
    if ("text" in token) { if (inText && !field) text += token.text; continue; }
    if (token.tag === "a:t") inText = !token.close && !token.empty;
    else if (token.tag === "a:fld" && !token.empty) field += token.close ? -1 : 1;
    else if (token.tag === "a:br" && !token.close) text += "\n";
    else if (token.tag === "a:p" && token.close) text += "\n";
  }
  return clean(text).replace(/\n{2,}/g, "\n");
}

async function extractPptx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const zip = await JSZip.loadAsync(bytes);
  const presentation = await zipText(zip, "ppt/presentation.xml");
  const rels = await relationships(zip, "ppt/presentation.xml");
  const order = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)].map(match => attribute(match[1], "r:id"));
  const slides = order.map(id => rels.find(rel => rel.id === id)?.target).filter((path): path is string => !!path && !!zip.file(path));
  const units: DocumentUnit[] = await Promise.all(slides.map(async (path, index) => {
    const notesPath = (await relationships(zip, path)).find(rel => rel.type.endsWith("/notesSlide"))?.target;
    const notes = notesPath && zip.file(notesPath) ? drawingText(await zipText(zip, notesPath)) : "";
    const text = drawingText(await zipText(zip, path));
    return { kind: "slide" as const, n: index + 1, text: [text, notes && `Speaker notes: ${notes}`].filter(Boolean).join("\n") };
  }));
  return { kind: "pptx", units };
}

// ---- Spreadsheets ----

const cellString = (text: string) => text.replace(/\s*\r?\n\s*/g, " ").trim().slice(0, MAX_CELL_CHARS);

function excelValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().replace(/T00:00:00\.000Z$/, "").replace(/\.000Z$/, "Z");
  if (typeof value !== "object") return String(value);
  if ("richText" in value) return value.richText.map(part => part.text).join("");
  if ("error" in value) return String(value.error);
  if ("formula" in value || "sharedFormula" in value) return value.result === undefined ? "" : excelValue(value.result as ExcelJS.CellValue);
  if ("text" in value) return typeof value.text === "string" ? value.text : excelValue(value.text as ExcelJS.CellValue);
  return "";
}

async function extractXlsx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  const units: DocumentUnit[] = [], sheets: { name: string; columns: number }[] = [];
  for (const worksheet of workbook.worksheets) {
    const sheet = sheets.length;
    let columns = 0;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, column) => { cells[column - 1] = cellString(excelValue(cell.value)); });
      const filled = Array.from(cells, value => value ?? "");
      while (filled.length && !filled.at(-1)) filled.pop();
      if (!filled.length) return;
      columns = Math.max(columns, filled.length);
      units.push({ kind: "row", sheet, n: rowNumber, cells: filled });
    });
    sheets.push({ name: worksheet.name, columns });
  }
  return { kind: "xlsx", units, sheets };
}

/** Bank exports are often Windows-1252 rather than UTF-8. */
function decodeText(bytes: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}

function extractCsv(bytes: Uint8Array, delimiter?: string): ExtractedDocument {
  const parsed = Papa.parse<string[]>(decodeText(bytes), { skipEmptyLines: false, ...(delimiter ? { delimiter } : {}) });
  const units: DocumentUnit[] = [];
  let columns = 0;
  parsed.data.forEach((row, index) => {
    const cells = row.map(cellString);
    while (cells.length && !cells.at(-1)) cells.pop();
    if (!cells.length) return;
    columns = Math.max(columns, cells.length);
    units.push({ kind: "row", sheet: 0, n: index + 1, cells });
  });
  return { kind: "csv", units, sheets: [{ name: "", columns }] };
}
