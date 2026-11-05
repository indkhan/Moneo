import { expect, it } from "vitest";
import { workbookRangeError } from "./workbook-scope";

const table = (headerRow: number, endRow: number, sheetId = 1) => ({ sheetId, headerRow, endRow });

it("accepts a range inside the sheet and two separate tables", () => {
  const first = table(3, 4), second = table(6, 7);
  expect(workbookRangeError(first, [first, second], 7)).toBeNull();
});

it("explains ranges that cannot be imported", () => {
  expect(workbookRangeError(table(5, 5), [], 7)).toMatch(/after the header/);
  expect(workbookRangeError(table(1, 8), [], 7)).toMatch(/ends at row 7/);
  expect(workbookRangeError(table(0, 2), [], 7)).toMatch(/whole row numbers/);
});

it("flags overlap only on the same sheet", () => {
  const first = table(1, 5), second = table(5, 7);
  expect(workbookRangeError(first, [first, second], 7)).toMatch(/overlaps/);
  const other = table(1, 5, 2);
  expect(workbookRangeError(first, [first, other], 7)).toBeNull();
});
