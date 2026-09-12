import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import { defaultXlsxBounds, parseXlsxBytes } from "./xlsx.js";

/**
 * Issue 3.4 — hardened XLSX parser.
 *
 * A tiny in-test ZIP writer builds real workbooks (stored + deflated parts,
 * shared strings, rels, formulas) plus hostile variants, and the suite
 * proves, in order: clean workbooks parse (shared/inline/numeric/boolean
 * cells, first-sheet selection, rels resolution, sparse gap-fill); formulas
 * are never executed (stale caches returned verbatim, uncached formulas
 * empty, `formulaCells` counted); macro/activeX/executable parts and macro
 * manifests are rejected; zip bombs die on declared sizes, totals, and
 * entry counts; traversal/absolute names, unknown methods, and truncated
 * archives fail closed; external relationships are ignored without any
 * fetch; every bound (bytes/rows/columns/cells/shared-text) holds; column
 * mismatches become row errors with spreadsheet line numbers; and corrupt
 * references fail closed.
 */

// ---------------------------------------------------------------------------
// Minimal ZIP writer (test-only): local headers + central directory + EOCD.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface TestEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** Lie about the uncompressed size in the central directory (bomb sim). */
  centralUncompSize?: number;
  /** Lie about the method in the central directory. */
  centralMethod?: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function makeZip(entries: TestEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const comp = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = encoder.encode(entry.name);
    const header = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc32(entry.data)),
      u32(comp.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    locals.push(header, comp);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(entry.centralMethod ?? method),
        u16(0),
        u16(0),
        u32(crc32(entry.data)),
        u32(comp.length),
        u32(entry.centralUncompSize ?? entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += header.length + comp.length;
  }
  const cd = concat(centrals);
  const localBlock = concat(locals);
  return concat([
    localBlock,
    cd,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(localBlock.length),
    u16(0),
  ]);
}

// ---------------------------------------------------------------------------
// Minimal workbook parts.
// ---------------------------------------------------------------------------

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function contentTypes(extra = ""): Uint8Array {
  return bytesOf(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
      `${extra}</Types>`,
  );
}

function workbookRels(
  targets: Array<{ id: string; target: string; external?: boolean }>,
): Uint8Array {
  const rels = targets
    .map(
      (t) =>
        `<Relationship Id="${t.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${t.target}"${t.external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("");
  return bytesOf(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
}

function workbook(sheets: Array<{ name: string; rid: string }>): Uint8Array {
  const list = sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${s.rid}"/>`)
    .join("");
  return bytesOf(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${list}</sheets></workbook>`,
  );
}

function sharedStrings(strings: string[]): Uint8Array {
  const items = strings.map((s) => `<si><t>${s}</t></si>`).join("");
  return bytesOf(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`,
  );
}

/** Cell helper: c("A1", "s", "0") / c("B2", null, "3.50") / c("C3", null, "7", "1+1"). */
function c(ref: string, type: string | null, value: string | null, formula?: string): string {
  if (value === null && formula === undefined) {
    return `<c r="${ref}"${type ? ` t="${type}"` : ""}/>`;
  }
  return `<c r="${ref}"${type ? ` t="${type}"` : ""}>${formula !== undefined ? `<f>${formula}</f>` : ""}${value !== null ? `<v>${value}</v>` : ""}</c>`;
}

function sheet(rows: Array<{ n: number; cells: string }>): Uint8Array {
  const body = rows.map((r) => `<row r="${r.n}">${r.cells}</row>`).join("");
  return bytesOf(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
  );
}

function cleanWorkbook(options: { sheets?: Uint8Array[]; shared?: string[] } = {}): Uint8Array {
  const sst = sharedStrings(options.shared ?? ["coffee", "tea"]);
  const first =
    options.sheets?.[0] ?? sheet([{ n: 1, cells: c("A1", "s", "0") + c("B1", null, "3.50") }]);
  const entries: TestEntry[] = [
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "xl/workbook.xml", data: workbook([{ name: "Statement", rid: "rId1" }]) },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: workbookRels([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
    },
    { name: "xl/sharedStrings.xml", data: sst },
    { name: "xl/worksheets/sheet1.xml", data: first },
  ];
  (options.sheets ?? []).slice(1).forEach((data, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 2}.xml`, data });
  });
  return makeZip(entries);
}

async function expectValidation(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("VALIDATION_FAILED");
    return error as DomainError;
  }
  throw new Error("Expected a VALIDATION_FAILED DomainError, but parsing succeeded");
}

describe("clean workbooks", () => {
  it("parses shared, numeric, boolean, inline, and error cells", async () => {
    const data = sheet([
      {
        n: 1,
        cells:
          c("A1", "s", "0") +
          c("B1", "s", "1") +
          c("C1", null, "h3") +
          c("D1", null, "h4") +
          c("E1", null, "h5"),
      },
      {
        n: 2,
        cells:
          c("A2", "s", "0") +
          c("B2", null, "3.5") +
          `<c r="C2" t="inlineStr"><is><t>inline note</t></is></c>` +
          c("D2", "b", "1") +
          c("E2", "e", "#DIV/0!"),
      },
    ]);
    const parsed = await parseXlsxBytes(cleanWorkbook({ sheets: [data] }));
    expect(parsed.sheetName).toBe("Statement");
    expect(parsed.headers).toEqual(["coffee", "tea", "h3", "h4", "h5"]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.formulaCells).toBe(0);
    // Boolean TRUE survives; error cells become empty (never a crash).
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["coffee", "3.5", "inline note", "TRUE", ""] },
    ]);
  });

  it("reads deflated and stored parts alike", async () => {
    const entries: TestEntry[] = [
      { name: "[Content_Types].xml", data: contentTypes(), method: 0 },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]), method: 0 },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: workbookRels([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
        method: 0,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: sheet([{ n: 1, cells: c("A1", null, "7") }]),
        method: 0,
      },
    ];
    const parsed = await parseXlsxBytes(makeZip(entries));
    expect(parsed.headers).toEqual(["7"]);
    expect(parsed.rows).toEqual([]);
  });

  it("selects the first sheet in workbook order", async () => {
    const first = sheet([{ n: 1, cells: c("A1", null, "111") }]);
    const second = sheet([{ n: 1, cells: c("A1", null, "222") }]);
    const zip = makeZip([
      {
        name: "[Content_Types].xml",
        data: contentTypes(
          `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        ),
      },
      {
        name: "xl/workbook.xml",
        data: workbook([
          { name: "First", rid: "rId1" },
          { name: "Second", rid: "rId2" },
        ]),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: workbookRels([
          { id: "rId1", target: "worksheets/sheet1.xml" },
          { id: "rId2", target: "worksheets/sheet2.xml" },
        ]),
      },
      { name: "xl/worksheets/sheet1.xml", data: first },
      { name: "xl/worksheets/sheet2.xml", data: second },
    ]);
    const parsed = await parseXlsxBytes(zip);
    expect(parsed.sheetName).toBe("First");
    expect(parsed.headers).toEqual(["111"]);
  });

  it("falls back to sheetN.xml when rels are missing", async () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "NoRels", rid: "rId9" }]) },
      { name: "xl/worksheets/sheet1.xml", data: sheet([{ n: 1, cells: c("A1", null, "5") }]) },
    ]);
    expect((await parseXlsxBytes(zip)).headers).toEqual(["5"]);
  });

  it("gap-fills sparse rows so columns stay aligned", async () => {
    const data = sheet([
      { n: 1, cells: c("A1", null, "1") + c("B1", null, "2") + c("C1", null, "3") },
      { n: 2, cells: c("A2", null, "4") + c("C2", null, "6") },
    ]);
    const parsed = await parseXlsxBytes(cleanWorkbook({ sheets: [data] }));
    expect(parsed.rows).toEqual([{ rowNumber: 2, cells: ["4", "", "6"] }]);
  });
});

describe("formulas are never executed", () => {
  it("returns stale cached values verbatim and counts formula cells", async () => {
    // =1+1 cached as 999: an evaluator would return 2; we return 999.
    const data = sheet([
      { n: 1, cells: c("A1", null, "total") + c("B1", null, "other") },
      { n: 2, cells: c("A2", null, "999", "1+1") + c("B2", null, "x", 'CONCATENATE("a","b")') },
    ]);
    const parsed = await parseXlsxBytes(cleanWorkbook({ sheets: [data] }));
    expect(parsed.rows).toEqual([{ rowNumber: 2, cells: ["999", "x"] }]);
    expect(parsed.formulaCells).toBe(2);
  });

  it("treats uncached formulas as empty cells, not errors", async () => {
    // The row carries a second populated cell so it is not blank-skipped.
    const data = sheet([
      { n: 1, cells: c("A1", null, "v") + c("B1", null, "w") },
      { n: 2, cells: `<c r="A2"><f>NOW()</f></c>` + c("B2", null, "keep") },
    ]);
    const parsed = await parseXlsxBytes(cleanWorkbook({ sheets: [data] }));
    expect(parsed.rows).toEqual([{ rowNumber: 2, cells: ["", "keep"] }]);
    expect(parsed.formulaCells).toBe(1);
  });
});

describe("macro rejection", () => {
  it("rejects binary macro parts by name", async () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
      { name: "xl/vbaProject.bin", data: bytesOf("MZ-fake-macro") },
    ]);
    await expectValidation(parseXlsxBytes(zip));
  });

  it("rejects macro manifests even without the binary", async () => {
    const zip = makeZip([
      {
        name: "[Content_Types].xml",
        data: contentTypes(
          `<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>`,
        ),
      },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
    ]);
    await expectValidation(parseXlsxBytes(zip));
  });
});

describe("zip bombs and hostile archives", () => {
  it("rejects a part that declares gigabytes but carries bytes", async () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
      {
        name: "xl/worksheets/sheet1.xml",
        data: sheet([{ n: 1, cells: c("A1", null, "1") }]),
        centralUncompSize: 0xffffffff,
      },
    ]);
    await expectValidation(parseXlsxBytes(zip));
  });

  it("rejects totals that exceed the uncompressed budget", async () => {
    const entries: TestEntry[] = [
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
    ];
    for (let i = 0; i < 6; i += 1) {
      entries.push({
        name: `xl/worksheets/filler${i}.xml`,
        data: bytesOf("x"),
        method: 0,
        centralUncompSize: 20 * 1024 * 1024,
      });
    }
    await expectValidation(
      parseXlsxBytes(makeZip(entries), {
        bounds: { ...defaultXlsxBounds(), maxTotalUncompressedBytes: 64 * 1024 * 1024 },
      }),
    );
  });

  it("rejects entry-count floods", async () => {
    const entries: TestEntry[] = [{ name: "[Content_Types].xml", data: contentTypes() }];
    for (let i = 0; i < 11; i += 1) {
      entries.push({ name: `filler${i}.txt`, data: bytesOf("x"), method: 0 });
    }
    await expectValidation(
      parseXlsxBytes(makeZip(entries), { bounds: { ...defaultXlsxBounds(), maxEntries: 10 } }),
    );
  });

  it("rejects traversal and absolute entry names", async () => {
    for (const evil of ["../evil.xml", "/abs.xml", "xl/../../evil.xml"]) {
      const zip = makeZip([
        { name: "[Content_Types].xml", data: contentTypes() },
        { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
        { name: evil, data: bytesOf("x"), method: 0 },
      ]);
      await expectValidation(parseXlsxBytes(zip));
    }
  });

  it("rejects unsupported compression methods", async () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
      {
        name: "xl/worksheets/sheet1.xml",
        data: sheet([{ n: 1, cells: c("A1", null, "1") }]),
        centralMethod: 12,
      },
    ]);
    await expectValidation(parseXlsxBytes(zip));
  });

  it("rejects truncated and non-ZIP bytes", async () => {
    await expectValidation(parseXlsxBytes(bytesOf("not a zip at all")));
    await expectValidation(parseXlsxBytes(new Uint8Array([0x50, 0x4b, 0x03])));
    const zip = cleanWorkbook();
    await expectValidation(parseXlsxBytes(zip.slice(0, zip.length - 30)));
  });
});

describe("spreadsheet structure errors", () => {
  it("rejects archives without workbook parts", async () => {
    await expectValidation(
      parseXlsxBytes(makeZip([{ name: "readme.txt", data: bytesOf("hi"), method: 0 }])),
    );
  });

  it("rejects workbooks with no sheets and missing sheet parts", async () => {
    const noSheets = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      {
        name: "xl/workbook.xml",
        data: bytesOf(
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets></sheets></workbook>`,
        ),
      },
    ]);
    await expectValidation(parseXlsxBytes(noSheets));
    const missingSheet = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "Ghost", rid: "rId1" }]) },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: workbookRels([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
      },
    ]);
    await expectValidation(parseXlsxBytes(missingSheet));
  });

  it("rejects out-of-range shared-string references", async () => {
    const data = sheet([{ n: 1, cells: c("A1", "s", "99") }]);
    await expectValidation(parseXlsxBytes(cleanWorkbook({ sheets: [data], shared: ["only"] })));
  });

  it("collects column mismatches as row errors with spreadsheet numbers", async () => {
    const data = sheet([
      { n: 1, cells: c("A1", null, "a") + c("B1", null, "b") },
      { n: 2, cells: c("A2", null, "1") + c("B2", null, "2") },
      { n: 5, cells: c("A5", null, "oops") },
      { n: 6, cells: c("A6", null, "3") + c("B6", null, "4") },
    ]);
    const parsed = await parseXlsxBytes(cleanWorkbook({ sheets: [data] }));
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["1", "2"] },
      { rowNumber: 6, cells: ["3", "4"] },
    ]);
    expect(parsed.errors).toEqual([{ rowNumber: 5, message: "Expected 2 columns, found 1." }]);
  });

  it("skips blank rows but keeps their numbers", async () => {
    const data = sheet([
      { n: 1, cells: c("A1", null, "a") },
      { n: 2, cells: c("A2", null, "") },
      { n: 3, cells: c("A3", null, "b") },
    ]);
    const parsed = await parseXlsxBytes(cleanWorkbook({ sheets: [data] }));
    expect(parsed.rows).toEqual([{ rowNumber: 3, cells: ["b"] }]);
  });

  it("rejects sheets without any content", async () => {
    const data = sheet([]);
    await expectValidation(parseXlsxBytes(cleanWorkbook({ sheets: [data] })));
  });
});

describe("no external resource loading", () => {
  it("ignores external relationship targets and link parts", async () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: contentTypes() },
      { name: "xl/workbook.xml", data: workbook([{ name: "S", rid: "rId1" }]) },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: workbookRels([
          { id: "rId1", target: "worksheets/sheet1.xml" },
          { id: "rId9", target: "https://evil.example.com/prices.xml", external: true },
        ]),
      },
      { name: "xl/externalLinks/externalLink1.xml", data: bytesOf("<externalLink/>"), method: 0 },
      {
        name: "xl/worksheets/sheet1.xml",
        data: sheet([{ n: 1, cells: c("A1", null, "9") }]),
      },
    ]);
    const parsed = await parseXlsxBytes(zip);
    expect(parsed.headers).toEqual(["9"]);
  });
});

describe("bounds", () => {
  it("rejects oversize input files", async () => {
    await expectValidation(
      parseXlsxBytes(cleanWorkbook(), { bounds: { ...defaultXlsxBounds(), maxBytes: 10 } }),
    );
  });

  it("rejects sheets with too many data rows", async () => {
    const data = sheet([
      { n: 1, cells: c("A1", null, "a") },
      { n: 2, cells: c("A2", null, "1") },
      { n: 3, cells: c("A3", null, "2") },
    ]);
    await expectValidation(
      parseXlsxBytes(cleanWorkbook({ sheets: [data] }), {
        bounds: { ...defaultXlsxBounds(), maxRows: 1 },
      }),
    );
  });

  it("rejects rows that exceed the column limit", async () => {
    const data = sheet([
      { n: 1, cells: c("A1", null, "1") + c("B1", null, "2") + c("C1", null, "3") },
    ]);
    await expectValidation(
      parseXlsxBytes(cleanWorkbook({ sheets: [data] }), {
        bounds: { ...defaultXlsxBounds(), maxColumns: 2 },
      }),
    );
  });

  it("rejects cells that exceed the cell-length limit", async () => {
    const data = sheet([
      { n: 1, cells: `<c r="A1" t="inlineStr"><is><t>${"y".repeat(20)}</t></is></c>` },
    ]);
    await expectValidation(
      parseXlsxBytes(cleanWorkbook({ sheets: [data] }), {
        bounds: { ...defaultXlsxBounds(), maxCellChars: 5 },
      }),
    );
  });

  it("rejects shared-string floods", async () => {
    const data = sheet([{ n: 1, cells: c("A1", "s", "0") }]);
    await expectValidation(
      parseXlsxBytes(cleanWorkbook({ sheets: [data], shared: ["z".repeat(100)] }), {
        bounds: { ...defaultXlsxBounds(), maxTotalStringChars: 10 },
      }),
    );
  });

  it("exposes sane defaults aligned with the upload limits", () => {
    const bounds = defaultXlsxBounds();
    expect(bounds.maxBytes).toBe(10 * 1024 * 1024);
    expect(bounds.maxRows).toBe(50_000);
    expect(bounds.maxColumns).toBe(100);
    expect(bounds.maxEntries).toBe(1000);
  });
});
