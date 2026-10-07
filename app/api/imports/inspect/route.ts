import { generateObject } from "ai";
import { modelForSettings } from "@/lib/ai/provider";
import { requireAiScope, type WorkspaceSettings } from "@/lib/settings";
import { requireWorkspace } from "@/lib/auth";
import { mappingSchema, parseCsv, inspectExcel, workbookScopeSchema, previewImport, proposeAccountRoutes, proposeKnownStatementMapping, proposeStatementTimezones, validateAiMapping } from "@/lib/csv";

export async function POST(request: Request) {
  let workspaceCurrency: string;
  let settings: WorkspaceSettings | undefined;
  try {
    const context = await requireWorkspace();
    workspaceCurrency = context.workspace.display_currency;
    settings = context.settings;
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !/\.(csv|xlsx)$/i.test(file.name) || file.size > 10_000_000)
    return Response.json({ error: "Choose a CSV or XLSX file under 10 MB" }, { status: 400 });

  try {
    const supplied = form.get("mapping");
    if (typeof supplied === "string" && supplied.length > 10_000_000) throw new Error("Reviewed mapping exceeds the 10 MB limit");
    const suppliedMapping = typeof supplied === "string" ? JSON.parse(supplied) : undefined;
    const selected = form.get("workbookScope");
    if (typeof selected === "string" && selected.length > 100_000) throw new Error("Workbook scope exceeds its limit");
    const scopeInput = typeof selected === "string" ? JSON.parse(selected) : suppliedMapping?.workbookScope;
    const workbookScope = scopeInput ? workbookScopeSchema.parse(scopeInput) : undefined;
    const workbook = file.name.toLowerCase().endsWith(".xlsx") ? await inspectExcel(await file.arrayBuffer(), workbookScope) : undefined;
    if (workbook && !workbookScope) return Response.json({ headers: [], sample: [], mapping: null, preview: null, workbook: {inventory: workbook.inventory}, needsWorkbookSelection: true });
    if (!workbook && workbookScope) throw new Error("Workbook scope is only valid for XLSX files");
    const rows = workbook?.rows ?? parseCsv(await file.text());
    if (!rows.length) throw new Error("Selected file scope has no data rows");
    const headers = Object.keys(rows[0]).filter(header => !header.startsWith("__moneo_csv_"));
    const knownMapping = proposeKnownStatementMapping(rows, file.name.replace(/\.(csv|xlsx)$/i, ""), workspaceCurrency);
    let mapping;
    let preview;
    let previewError: string | undefined;
    let aiError: string | undefined;
    if (typeof supplied === "string") {
      mapping = proposeStatementTimezones(rows, proposeAccountRoutes(rows, suppliedMapping), settings?.timezone);
    } else if (knownMapping) {
      mapping = proposeStatementTimezones(rows, knownMapping, settings?.timezone);
    } else {
      try {
        requireAiScope(settings, "imports");
        const result = await generateObject({
          model: await modelForSettings(settings, { effort: "minimal", exclude: true }),
          abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
          maxRetries: 0,
          maxOutputTokens: 1800,
          schema: mappingSchema,
          prompt: `Return one JSON object with exactly these required keys: accountName (use the filename stem ${JSON.stringify(file.name.replace(/\.(csv|xlsx)$/i, ""))}), currencyCode (three uppercase letters), dateColumn, descriptionColumn, dateFormat (exactly "iso", "dmy", or "mdy"), and amountSign (exactly "signed" or "outflow-positive"). Optional keys are amountColumn, debitColumn, creditColumn, currencyColumn, balanceColumn, merchantColumn, categoryColumn, externalIdColumn, and statusColumn. Omit unused optional keys. Do not use keys such as "currency" or date formats such as "yyyy-MM-dd". Propose a financial statement column mapping. Return only values justified by headers and sample rows. Sign convention: positive means money entering the account; negative means money leaving it. Use amountSign "outflow-positive" only if positive amounts represent expenses. For separate debit/credit columns, include both and omit amountColumn. For a single amount column, include amountColumn and omit debitColumn/creditColumn. dateFormat must match the data. Currency is a three-letter code; when the file has no currency column, use workspace display currency ${workspaceCurrency} as a provisional default. Include merchantColumn only when a header clearly holds merchant/counterparty names, and categoryColumn only when a header clearly holds categories; otherwise omit them. Include statusColumn only when a header clearly holds an explicit posted/pending indicator (values like posted, pending, or COMPLETED); include accountColumn/productColumn for explicit account/product headers. Account routes will be proposed deterministically from all rows for user review; omit accountRoutes. Otherwise omit statusColumn and all rows default to posted. Do not invent columns.\nHeaders: ${JSON.stringify(headers)}\nSample rows: ${JSON.stringify(rows.slice(0, 8))}`,
        });
        mapping = proposeStatementTimezones(rows, { ...validateAiMapping(result.object, rows, workspaceCurrency), timestampTimezoneConfirmed: false }, settings?.timezone);
      } catch (error) {
        aiError = error instanceof Error ? error.message : "AI mapping unavailable";
        mapping = undefined;
      }
    }
    if (mapping && workbookScope) mapping = { ...mapping, workbookScope };
    if (mapping) {
      try { preview = previewImport(rows, mapping); }
      catch (error) { previewError = error instanceof Error ? error.message : "Review the source mapping"; }
    }
    return new Response(JSON.stringify({
      headers,
      ...(workbook ? { workbook: { inventory: workbook.inventory }, workbookScope } : {}),
      warnings: headers.some(header => /^(type|fee)$/i.test(header.trim()))
        ? ["Source type and fee evidence is preserved. Transfers, refunds, exchanges and fees require transaction review; no internal movement or separate fee is guessed."] : [],
      sample: rows.slice(0, 5),
      mapping: mapping ?? null,
      preview: preview ?? null,
      ...(previewError ? { previewError } : {}),
      ...(aiError ? { aiError } : {}),
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not inspect file" }, { status: 400 });
  }
}
