// E00-S03 deterministic minimal .xlsx fixture writer (test-only).
//
// Builds the smallest workbooks the proof admits: one worksheet at
// xl/worksheets/sheet1.xml, optional shared strings, optional hostile parts
// (formula cells, external links). Values are written literally; formulas are
// stored as inert `<f>` markup for the parser to surface, never evaluated.

import { strToU8, zipSync } from "fflate";

export type FixtureCell =
  | { kind: "text"; value: string }
  | { kind: "number"; value: string }
  | { kind: "formula"; expression: string; cached: string };

export type FixtureSheet = {
  name: string;
  header: string[];
  rows: FixtureCell[][];
};

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function colName(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellXml(ref: string, cell: FixtureCell, shared: Map<string, number>): string {
  if (cell.kind === "formula") {
    return `<c r="${ref}"><f>${esc(cell.expression)}</f><v>${esc(cell.cached)}</v></c>`;
  }
  if (cell.kind === "number") {
    return `<c r="${ref}"><v>${esc(cell.value)}</v></c>`;
  }
  let idx = shared.get(cell.value);
  if (idx === undefined) {
    idx = shared.size;
    shared.set(cell.value, idx);
  }
  return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

export function buildXlsx(sheet: FixtureSheet, opts?: { externalLink?: boolean }): Uint8Array {
  const shared = new Map<string, number>();
  const allRows: string[] = [];
  const headerCells = sheet.header
    .map((h, c) => cellXml(`${colName(c)}1`, { kind: "text", value: h }, shared))
    .join("");
  allRows.push(`<row r="1">${headerCells}</row>`);
  sheet.rows.forEach((row, r) => {
    const cells = row.map((cell, c) => cellXml(`${colName(c)}${r + 2}`, cell, shared)).join("");
    allRows.push(`<row r="${r + 2}">${cells}</row>`);
  });

  const sharedXml =
    `<sst xmlns="${NS}" count="${shared.size}" uniqueCount="${shared.size}">` +
    [...shared.keys()].map((s) => `<si><t>${esc(s)}</t></si>`).join("") +
    `</sst>`;

  const externalRef = opts?.externalLink
    ? `<externalReferences><externalReference r:id="rId9"/></externalReferences>`
    : "";
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${esc(sheet.name)}" sheetId="1" r:id="rId1"/></sheets>` +
    externalRef +
    `</workbook>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
        (opts?.externalLink
          ? `<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/>`
          : "") +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
        (opts?.externalLink
          ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>`
          : "") +
        `</Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<worksheet xmlns="${NS}"><sheetData>${allRows.join("")}</sheetData></worksheet>`,
    ),
    "xl/sharedStrings.xml": strToU8(sharedXml),
  };
  if (opts?.externalLink) {
    files["xl/externalLinks/externalLink1.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<externalLink xmlns="${NS}"><externalBook><sheetData><row><cell r="A1"><v>1</v></cell></row></sheetData></externalBook></externalLink>`,
    );
  }
  return zipSync(files, { level: 6 });
}
