import { createRequire } from "node:module";
import { expect, it } from "vitest";
import ExcelJS from "exceljs";

it("rejects undersized output buffers in ExcelJS's UUID dependency", () => {
  const require = createRequire(import.meta.url);
  const excelRequire = createRequire(require.resolve("exceljs/package.json"));
  const { v5 } = excelRequire("uuid") as { v5: (name: string, namespace: string, buffer: Uint8Array, offset: number) => unknown };
  expect(() => v5("synthetic", "6ba7b810-9dad-11d1-80b4-00c04fd430c8", new Uint8Array(8), 4)).toThrow(RangeError);
});

it("round-trips XLSX extended conditional formatting through the CommonJS UUID API", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Synthetic");
  sheet.addRows([["Amount"], [12], [34]]);
  sheet.addConditionalFormatting({
    ref: "A2:A3",
    rules: [{ type: "iconSet", iconSet: "3Stars", priority: 1, cfvo: [{ type: "percent", value: 0 }, { type: "percent", value: 33 }, { type: "percent", value: 67 }] }],
  });
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const restoredSheet = restored.getWorksheet("Synthetic")!;
  expect(restoredSheet.getCell("A2").value).toBe(12);
  expect(restoredSheet).toMatchObject({ conditionalFormattings: [{ ref: "A2:A3", rules: [{ type: "iconSet", iconSet: "3Stars" }] }] });
});
