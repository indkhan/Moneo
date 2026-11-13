import { expect, it } from "vitest";
import { citations, locationLabel, parseLocation } from "./citations";

it("reads the locations models write and labels them for chips", () => {
  const label = (text: string) => { const location = parseLocation(text); return location && locationLabel(location); };
  expect(label("p.3")).toBe("p.3");
  expect(label("page 3-5")).toBe("p.3–5");
  expect(label("slide.2")).toBe("slide 2");
  expect(label("para.12")).toBe("¶12");
  expect(label("Sheet1!b12")).toBe("Sheet1!B12");
  expect(label("'My ''best'' sheet'!A1:C3")).toBe("'My ''best'' sheet'!A1:C3");
  expect(parseLocation("AA10:AB12")).toEqual({ kind: "cells", fromRow: 10, toRow: 12, fromColumn: 27, toColumn: 28 });
  for (const bad of ["p.0", "p.5-3", "B12:A1", "Sheet1!", "A1:B2:C3", "javascript:alert(1)", ""]) expect(parseLocation(bad)).toBeNull();
});

it("parses citation markers and drops the parts that are not valid", () => {
  const text = 'Rent is 950. {{cite a1b2c3d4 p.3 "Rent 950.00"}} Power is 60. {{cite A1B2C3D4 Budget!C3}} {{cite a1b2c3d4}} {{cite nothex12 p.1}} {{cite a1b2c3d4 p.0}}';
  expect(citations(text)).toEqual([
    { id: "a1b2c3d4", location: "p.3", quote: "Rent 950.00", parsed: { kind: "page", from: 3, to: 3 } },
    { id: "a1b2c3d4", location: "Budget!C3", parsed: { kind: "cells", sheet: "Budget", fromRow: 3, toRow: 3, fromColumn: 3, toColumn: 3 } },
    { id: "a1b2c3d4" },
    // A location that cannot be read still cites the file, without a place.
    { id: "a1b2c3d4" },
  ]);
});
