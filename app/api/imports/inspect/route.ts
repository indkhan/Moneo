import { generateObject } from "ai";
import { getModel } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { mappingSchema, parseCsv, parseExcel, previewImport } from "@/lib/csv";

export async function POST(request: Request) {
  try {
    await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !/\.(csv|xlsx)$/i.test(file.name) || file.size > 10_000_000)
    return Response.json({ error: "Choose a CSV or XLSX file under 10 MB" }, { status: 400 });

  try {
    const rows = file.name.toLowerCase().endsWith(".csv")
      ? parseCsv(await file.text())
      : await parseExcel(await file.arrayBuffer());
    if (!rows.length) throw new Error("File has no data rows");
    const headers = Object.keys(rows[0]);
    const supplied = form.get("mapping");
    let mapping;
    let preview;
    let aiError: string | undefined;
    if (typeof supplied === "string") {
      mapping = mappingSchema.parse(JSON.parse(supplied));
      preview = previewImport(rows, mapping);
    } else {
      try {
        const result = await generateObject({
          model: getModel(),
          schema: mappingSchema,
          prompt: `Propose a financial statement column mapping. Return only values justified by headers and sample rows. Sign convention: positive means money entering the account; negative means money leaving it. Use amountSign "outflow-positive" only if positive amounts represent expenses. For separate debit/credit columns, include both and omit amountColumn. For a single amount column, include amountColumn and omit debitColumn/creditColumn. dateFormat must match the data. Currency is a three-letter code. Do not invent columns.\nHeaders: ${JSON.stringify(headers)}\nSample rows: ${JSON.stringify(rows.slice(0, 8))}`,
        });
        mapping = result.object;
        preview = previewImport(rows, mapping);
      } catch (error) {
        aiError = error instanceof Error ? error.message : "AI mapping unavailable";
        mapping = undefined;
      }
    }
    return Response.json({
      headers,
      sample: rows.slice(0, 5),
      mapping: mapping ?? null,
      preview: preview ? {
        ...preview,
        examples: preview.examples.map((row) => ({
          ...row,
          amountMinor: row.amountMinor.toString(),
          ...(row.balanceMinor !== undefined ? { balanceMinor: row.balanceMinor.toString() } : {}),
        })),
      } : null,
      ...(aiError ? { aiError } : {}),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not inspect file" }, { status: 400 });
  }
}
