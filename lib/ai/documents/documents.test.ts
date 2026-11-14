import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import { extractDocument, renderPdfPages } from "./extract";
import { attachmentParts } from "./message";
import { citedSection, documentForModel, readDocument } from "./read";
import { sniffType } from "./sniff";

// Tiny documents built here, so the tests carry no real files.
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A PDF with one page per entry; an empty entry is a page without text, drawn as a grey box like a scan. */
function pdf(...pages: string[]) {
  const objects = ["<</Type/Catalog/Pages 2 0 R>>", `<</Type/Pages/Kids[${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}]/Count ${pages.length}>>`];
  for (const [index, text] of pages.entries()) {
    const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : "0.5 g 20 20 260 160 re f";
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${4 + index * 2} 0 R/Resources<</Font<</F1 ${3 + pages.length * 2} 0 R>>>>>>`,
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  }
  objects.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  // pdf.js rebuilds the cross-reference table, so the offsets can be left out.
  return new TextEncoder().encode(`%PDF-1.4\n${objects.map((body, index) => `${index + 1} 0 obj${body}endobj`).join("\n")}\ntrailer<</Root 1 0 R/Size ${objects.length + 1}>>\n%%EOF`);
}

async function zip(files: Record<string, string>) {
  const archive = new JSZip();
  for (const [path, content] of Object.entries(files)) archive.file(path, content);
  return archive.generateAsync({ type: "uint8array" });
}
const contentTypes = (main: string) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/x.xml" ContentType="application/vnd.openxmlformats-officedocument.${main}"/></Types>`;

const docx = () => zip({
  "[Content_Types].xml": contentTypes("wordprocessingml.document.main+xml"),
  "word/styles.xml": `<w:styles><w:style w:type="paragraph" w:styleId="Berschrift1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  "word/document.xml": `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Berschrift1"/></w:pPr><w:r><w:t>Costs</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Rent is </w:t></w:r><w:r><w:t>950 &amp; heating</w:t></w:r><w:del><w:r><w:delText>old</w:delText></w:r></w:del></w:p>
    <w:p></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Power</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>60</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`,
});

const slide = (text: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const pptx = () => zip({
  "[Content_Types].xml": contentTypes("presentationml.presentation.main+xml"),
  // Slide order comes from the presentation, not from file names.
  "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
  "ppt/slides/slide1.xml": slide("Budget plan"),
  "ppt/slides/slide2.xml": slide("Agenda"),
  "ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  "ppt/notesSlides/notesSlide1.xml": `<p:notes><a:p><a:r><a:t>Mention the 200 buffer</a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p></p:notes>`,
});

async function xlsx() {
  const workbook = new ExcelJS.Workbook();
  const budget = workbook.addWorksheet("Budget");
  budget.addRow(["Date", "Item", "Amount"]);
  budget.addRow([new Date(Date.UTC(2026, 9, 1)), "Rent | flat", 950]);
  budget.addRow([new Date(Date.UTC(2026, 9, 2)), "Power", 60]);
  budget.getCell("C4").value = { formula: "SUM(C2:C3)", result: 1010 };
  workbook.addWorksheet("My notes").getCell("B2").value = "Check heating";
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

const text = (value: string) => new TextEncoder().encode(value);

describe("sniffType", () => {
  it("trusts a file's bytes, not its name", async () => {
    expect(await sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "a.pdf")).toBe("image/jpeg");
    expect(await sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "a.png")).toBe("image/png");
    expect(await sniffType(text("RIFF....WEBPVP8 "), "a.webp")).toBe("image/webp");
    expect(await sniffType(text("%PDF-1.7"), "a.docx")).toBe("application/pdf");
    expect(await sniffType(await docx(), "renamed.zip")).toBe(DOCX);
    expect(await sniffType(await pptx(), "deck.pptx")).toBe(PPTX);
    expect(await sniffType(await xlsx(), "budget.xlsx")).toBe(XLSX);
    expect(await sniffType(text("Date;Amount\n2026-10-01;9,50\n"), "export.CSV")).toBe("text/csv");
    expect(await sniffType(text("a\tb\n"), "export.tsv")).toBe("text/tab-separated-values");
  });

  it("refuses other zips, binary files named .csv, and other text", async () => {
    expect(await sniffType(await zip({ "readme.txt": "hi" }), "fake.xlsx")).toBeNull();
    expect(await sniffType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "program.csv")).toBeNull();
    expect(await sniffType(text("<svg/>"), "image.svg")).toBeNull();
    expect(await sniffType(text("a,b"), "notes.txt")).toBeNull();
  });
});

describe("extraction", () => {
  it("reads a PDF page by page and finds pages without a text layer", async () => {
    const document = await extractDocument(pdf("Rent 950 EUR per month", ""), "application/pdf");
    expect(document.scannedPages).toEqual([2]);
    const shown = documentForModel(document, "lease.pdf", "a1b2c3d4", 10_000, new Set([2]));
    expect(shown).toContain("(id a1b2c3d4), PDF, 2 pages");
    expect(shown).toContain("--- Page 1 ---\nRent 950 EUR per month");
    expect(shown).toContain("--- Page 2 ---\n[No text layer: this page is attached as an image");
  });

  it("numbers Word paragraphs, marks headings by style and keeps table rows", async () => {
    const shown = documentForModel(await extractDocument(await docx(), DOCX), "plan.docx", "a1b2c3d4", 10_000);
    expect(shown).toContain("# Costs [¶1]\n[¶2] Rent is 950 & heating\n[¶3] | Item | Amount |\n[¶4] | Power | 60 |");
    expect(shown).not.toContain("old");
  });

  it("reads slides in presentation order with their speaker notes", async () => {
    const shown = documentForModel(await extractDocument(await pptx(), PPTX), "deck.pptx", "a1b2c3d4", 10_000);
    expect(shown).toContain("--- Slide 1 ---\nAgenda\n\n--- Slide 2 ---\nBudget plan\nSpeaker notes: Mention the 200 buffer");
    expect(shown).not.toMatch(/buffer\n?1/);
  });

  it("writes sheets as compact tables with row numbers and column letters", async () => {
    const shown = documentForModel(await extractDocument(await xlsx(), XLSX), "budget.xlsx", "a1b2c3d4", 10_000);
    expect(shown).toContain(`2 sheets: "Budget" (A1:C4), "My notes" (A2:B2)`);
    expect(shown).toContain(`=== Sheet "Budget" (A1:C4) ===\nrow | A | B | C\n1 | Date | Item | Amount\n2 | 2026-10-01 | Rent \\| flat | 950\n3 | 2026-10-02 | Power | 60\n4 |  |  | 1010`);
    expect(shown).toContain(`=== Sheet "My notes" (A2:B2) ===\nrow | A | B\n2 |  | Check heating`);
  });

  it("reads Windows-1252 CSV exports with their own delimiter", async () => {
    const bytes = new Uint8Array([...text("Datum;Empf"), 0xe4, ...text("nger;Betrag\n01.10.2026;M"), 0xfc, ...text("ller;-9,50\n")]);
    const shown = documentForModel(await extractDocument(bytes, "text/csv"), "export.csv", "a1b2c3d4", 10_000);
    expect(shown).toContain("=== Table (A1:C2) ===\nrow | A | B | C\n1 | Datum | Empfänger | Betrag\n2 | 01.10.2026 | Müller | -9,50");
  });
});

describe("long documents", () => {
  const csv = text(["Date,Amount", ...Array.from({ length: 500 }, (_, index) => `2026-01-${String(index % 28 + 1).padStart(2, "0")},${index}`)].join("\n"));

  it("cuts at a row and names the next range, which document_read then returns", async () => {
    const document = await extractDocument(csv, "text/csv");
    const shown = documentForModel(document, "big.csv", "a1b2c3d4", 2_000);
    const next = /location "([^"]+)"/.exec(shown)?.[1];
    expect(shown).toMatch(/\[Cut here to keep this short: shown up to A\d+ of A501\./);
    expect(next).toMatch(/^A\d+:B\d+$/);
    const rest = readDocument(document, { name: "big.csv", id: "a1b2c3d4", location: next });
    expect(rest.split("\n")[2]).toBe("row | A | B");
    expect(rest).toContain(`\n${next!.slice(1, next!.indexOf(":"))} | 2026-`);
  });

  it("finds text with its cell and reads a column range", async () => {
    const document = await extractDocument(await xlsx(), XLSX);
    expect(readDocument(document, { name: "b.xlsx", id: "a1b2c3d4", search: "power" })).toContain("Budget!B3: 3 | 2026-10-02 | Power | 60");
    expect(readDocument(document, { name: "b.xlsx", id: "a1b2c3d4", location: "Budget!B2:C3" })).toContain("row | B | C\n2 | Rent \\| flat | 950\n3 | Power | 60");
    expect(readDocument(document, { name: "b.xlsx", id: "a1b2c3d4", location: "'My notes'!A1:B9" })).toContain("2 |  | Check heating");
    expect(readDocument(document, { name: "b.xlsx", id: "a1b2c3d4", location: "p.2" })).toContain("use cell ranges");
  });

  it("shows a cited cell with the rows around it for the viewer", async () => {
    const section = citedSection(await extractDocument(await xlsx(), XLSX), "Budget!C3");
    expect(section).toMatchObject({ kind: "table", sheet: "Budget", columns: ["A", "B", "C"] });
    expect(section.kind === "table" && section.rows.find(row => row.n === 3)?.target).toEqual([false, false, true]);
  });
});

describe("attachmentParts", () => {
  const file = (name: string, type: ChatAttachment["type"], extension: string): ChatAttachment =>
    ({ path: `00000000-0000-4000-8000-000000000001/a1b2c3d4-0000-4000-8000-00000000000${extension.length}.${extension}`, name, type });
  const storage = (bytes: Uint8Array) => ({ storage: { from: () => ({ download: async () => ({ data: new Blob([bytes as BlobPart]), error: null }) }) } }) as never;

  it("sends scanned PDF pages as images beside the text and says which pages were left out", async () => {
    const render = vi.fn(async (_bytes: Uint8Array, pages: number[]) => pages.map(page => ({ page, image: new Uint8Array([0xff, 0xd8]) })));
    const scans = pdf("Cover letter for the October statement", ...Array.from({ length: 12 }, () => ""));
    const parts = await attachmentParts(storage(scans), [file("scan.pdf", "application/pdf", "pdf")], render);
    expect(render).toHaveBeenCalledWith(expect.any(Uint8Array), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(parts.filter(part => part.type === "file").map(part => part.type === "file" && part.mediaType)).toEqual(Array(10).fill("image/jpeg"));
    expect(parts[0].type === "text" && parts[0].text).toContain("Pages 12-13 have no text layer and were not sent as images");
  });

  it("keeps photos as images and says when a document cannot be opened", async () => {
    const photo = await attachmentParts(storage(new Uint8Array([0xff, 0xd8, 0xff])), [file("receipt.jpg", "image/jpeg", "jpg")]);
    expect(photo.map(part => part.type)).toEqual(["text", "file"]);
    const broken = await attachmentParts(storage(text("not a zip")), [file("broken.docx", DOCX, "docx")]);
    expect(broken).toEqual([{ type: "text", text: expect.stringContaining(`"broken.docx" (id a1b2c3d4) could not be opened`) }]);
  });
});

it("draws a page without text as a JPEG on this computer", async () => {
  const [{ page, image }] = await renderPdfPages(pdf(""), [1], 300);
  expect(page).toBe(1);
  expect([...image.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
});
