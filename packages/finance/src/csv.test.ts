import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import {
  decodeStatementBytes,
  defaultCsvBounds,
  detectDelimiter,
  parseCsvBytes,
  parseCsvText,
  previewCsv,
} from "./csv.js";

/**
 * Issue 3.3 — bounded CSV parser.
 *
 * Proves, in order: delimiter sniffing (all four kinds, quoted-delimiter
 * content, single-column fallback, consistency tie-breaks); decoding
 * (UTF-8 BOM, UTF-16 LE/BE, umlauts intact); quoting fidelity (escaped
 * quotes, embedded newlines/CRLF, trailing newline, blank-line skipping
 * with stable physical row numbers); row-error collection (short/long rows
 * reported with file lines while good rows survive); fail-closed structure
 * errors (unterminated quotes, empty files); every bound (bytes, rows,
 * columns, cell length, including the mid-split abort); header preview;
 * and byte-entry equivalence.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function expectValidation(fn: () => unknown, field?: string): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("VALIDATION_FAILED");
    if (field !== undefined) {
      expect((error as DomainError).errors?.map((e) => e.field)).toContain(field);
    }
    return error as DomainError;
  }
  throw new Error("Expected a VALIDATION_FAILED DomainError, but parsing succeeded");
}

describe("delimiter detection", () => {
  it("sniffs comma, semicolon, tab, and pipe files", () => {
    expect(detectDelimiter("date,desc,amount\n2026-01-01,coffee,3.50\n")).toBe(",");
    expect(detectDelimiter("date;desc;amount\n2026-01-01;coffee;3,50\n")).toBe(";");
    expect(detectDelimiter("date\tdesc\tamount\n2026-01-01\tcoffee\t3.50\n")).toBe("\t");
    expect(detectDelimiter("date|desc|amount\n2026-01-01|coffee|3.50\n")).toBe("|");
  });

  it("ignores delimiters inside quoted content", () => {
    // Raw counting would see two commas vs one semicolon and pick wrong.
    expect(detectDelimiter('"a,b";c\n"d,e";f\n')).toBe(";");
    expect(detectDelimiter('"a;b",c\n"d;e",f\n')).toBe(",");
  });

  it("falls back to comma for single-column files", () => {
    expect(detectDelimiter("description\ncoffee\ntea\n")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
    expect(detectDelimiter("\n\n")).toBe(",");
  });

  it("prefers the delimiter that splits lines consistently", () => {
    // Semicolons appear but with ragged counts; commas split every line 3-3.
    const text = "a,b;c,d\ne,f;g,h\n";
    expect(detectDelimiter(text)).toBe(",");
  });
});

describe("decoding", () => {
  it("strips a UTF-8 BOM", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("a,b\n1,2\n")]);
    const parsed = parseCsvBytes(withBom);
    expect(parsed.headers).toEqual(["a", "b"]);
  });

  it("transcodes UTF-16 LE and BE via their BOMs", () => {
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from("a,b\n1,2\n", "utf16le")]);
    expect(parseCsvBytes(le).headers).toEqual(["a", "b"]);
    // Node writes UTF-16LE only: swap each pair to get big-endian bytes.
    const leBody = Buffer.from("a,b\n1,2\n", "utf16le");
    const beBody = new Uint8Array(leBody.length);
    for (let i = 0; i < leBody.length; i += 2) {
      beBody[i] = leBody[i + 1] as number;
      beBody[i + 1] = leBody[i] as number;
    }
    const be = new Uint8Array([0xfe, 0xff, ...beBody]);
    expect(parseCsvBytes(be).headers).toEqual(["a", "b"]);
  });

  it("keeps non-ASCII content intact as UTF-8", () => {
    expect(decodeStatementBytes(bytesOf("Müller, Käse\n"))).toBe("Müller, Käse\n");
  });
});

describe("quoting and line structure", () => {
  it("parses quoted fields, escaped quotes, and commas in quotes", () => {
    const parsed = parseCsvText(
      'date,desc,amount\n2026-01-01,"coffee, large",3.50\n2026-01-02,"say ""hi""",1.00\n',
    );
    expect(parsed.headers).toEqual(["date", "desc", "amount"]);
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["2026-01-01", "coffee, large", "3.50"] },
      { rowNumber: 3, cells: ["2026-01-02", 'say "hi"', "1.00"] },
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it("keeps embedded newlines and CRLF inside quotes", () => {
    const parsed = parseCsvText('a,b\n"x\ny",2\n"p\r\nq",3\n');
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["x\ny", "2"] },
      { rowNumber: 4, cells: ["p\r\nq", "3"] },
    ]);
  });

  it("handles CRLF files, trailing newlines, and blank lines with stable numbers", () => {
    const parsed = parseCsvText("a,b\r\n1,2\r\n\r\n3,4\r\n");
    expect(parsed.headers).toEqual(["a", "b"]);
    // The blank line 3 is skipped but still consumes its line number.
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["1", "2"] },
      { rowNumber: 4, cells: ["3", "4"] },
    ]);
  });

  it("treats the first non-blank line as the header", () => {
    const parsed = parseCsvText("\n\na,b\n1,2\n");
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([{ rowNumber: 4, cells: ["1", "2"] }]);
  });

  it("honors an explicit delimiter over sniffing", () => {
    const parsed = parseCsvText("a;b\n1;2\n", { delimiter: ";" });
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["a", "b"]);
  });

  it("parses a lone-CR line ending file", () => {
    const parsed = parseCsvText("a,b\r1,2\r3,4");
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["1", "2"] },
      { rowNumber: 3, cells: ["3", "4"] },
    ]);
  });
});

describe("row errors", () => {
  it("collects short and long rows while keeping the good ones", () => {
    const parsed = parseCsvText("a,b,c\n1,2,3\n4,5\n6,7,8,9\n10,11,12\n");
    expect(parsed.rows).toEqual([
      { rowNumber: 2, cells: ["1", "2", "3"] },
      { rowNumber: 5, cells: ["10", "11", "12"] },
    ]);
    expect(parsed.errors).toEqual([
      { rowNumber: 3, message: "Expected 3 columns, found 2." },
      { rowNumber: 4, message: "Expected 3 columns, found 4." },
    ]);
  });
});

describe("fail-closed structure errors", () => {
  it("rejects unterminated quotes", () => {
    expectValidation(() => parseCsvText('a,b\n"x,2\n'), "file");
  });

  it("rejects files without any content", () => {
    expectValidation(() => parseCsvText(""), "file");
    expectValidation(() => parseCsvText("\n\n  \n"), "file");
  });
});

describe("bounds", () => {
  it("rejects oversize byte input before parsing", () => {
    // "a,b\n1,2\n" is 8 bytes, so a 7-byte bound rejects both entry points.
    const bounds = { ...defaultCsvBounds(), maxBytes: 7 };
    expectValidation(() => parseCsvText("a,b\n1,2\n", { bounds }), "file");
    expectValidation(() => parseCsvBytes(bytesOf("a,b\n1,2\n"), { bounds }), "file");
  });

  it("rejects files with too many data rows, even mid-split", () => {
    const bounds = { ...defaultCsvBounds(), maxRows: 2 };
    const text = "a,b\n1,2\n3,4\n5,6\n";
    expectValidation(() => parseCsvText(text, { bounds }), "rows");
  });

  it("accepts exactly maxRows rows", () => {
    const bounds = { ...defaultCsvBounds(), maxRows: 2 };
    const parsed = parseCsvText("a,b\n1,2\n3,4\n", { bounds });
    expect(parsed.rows).toHaveLength(2);
  });

  it("rejects rows that exceed the column limit", () => {
    const bounds = { ...defaultCsvBounds(), maxColumns: 2 };
    expectValidation(() => parseCsvText("a,b,c\n1,2,3\n", { bounds }), "rows");
  });

  it("rejects cells that exceed the cell-length limit", () => {
    const bounds = { ...defaultCsvBounds(), maxCellChars: 4 };
    expectValidation(() => parseCsvText("a,b\n12345,2\n", { bounds }), "rows");
  });

  it("exposes sane defaults aligned with the upload limits", () => {
    const bounds = defaultCsvBounds();
    expect(bounds.maxRows).toBe(50_000);
    expect(bounds.maxBytes).toBe(10 * 1024 * 1024);
    expect(bounds.maxColumns).toBe(100);
  });
});

describe("preview", () => {
  it("returns headers plus the first N rows and the total", () => {
    const text = "a,b\n1,2\n3,4\n5,6\n7,8\n";
    const preview = previewCsv(text, 2);
    expect(preview.delimiter).toBe(",");
    expect(preview.headers).toEqual(["a", "b"]);
    expect(preview.preview).toEqual([
      { rowNumber: 2, cells: ["1", "2"] },
      { rowNumber: 3, cells: ["3", "4"] },
    ]);
    expect(preview.totalRows).toBe(4);
  });
});

describe("byte entry point", () => {
  it("decodes and parses in one call", () => {
    const parsed = parseCsvBytes(bytesOf("date,amount\n2026-01-01,12.50\n"));
    expect(parsed.headers).toEqual(["date", "amount"]);
    expect(parsed.rows).toEqual([{ rowNumber: 2, cells: ["2026-01-01", "12.50"] }]);
  });
});
