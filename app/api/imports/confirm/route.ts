import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { createClient } from "@supabase/supabase-js";
import { requireWorkspace } from "@/lib/auth";
import { parseCsv, parseExcel, workbookScopeSchema, validateImportConfirmation } from "@/lib/csv";
import { importFile } from "@/workflows/import-file";

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Import service is not configured" }, { status: 503 });

  try {
    const form = await request.formData();
    const file = form.get("file");
    const mappingValue = form.get("mapping");
    if (!(file instanceof File) || typeof mappingValue !== "string" || mappingValue.length > 10_000_000 || file.size > 10_000_000)
      return NextResponse.json({ error: "File and mapping are required (10 MB maximum)" }, { status: 400 });
    const extension = file.name.toLowerCase().split(".").pop();
    if (extension !== "csv" && extension !== "xlsx") return NextResponse.json({ error: "Only CSV and XLSX are supported" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const suppliedMapping = JSON.parse(mappingValue);
    if (extension === "xlsx" && !suppliedMapping.workbookScope) throw new Error("Review and confirm the workbook scope before importing");
    if (extension === "csv" && suppliedMapping.workbookScope) throw new Error("Workbook scope is only valid for XLSX files");
    const workbookScope = extension === "xlsx" ? workbookScopeSchema.parse(suppliedMapping.workbookScope) : undefined;
    const rows = extension === "csv" ? parseCsv(bytes.toString("utf8")) : await parseExcel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), workbookScope);
    const mapping = validateImportConfirmation(rows, suppliedMapping);
    const { supabase, workspace } = context;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = await supabase.from("imports").select("id, status, mapping").eq("workspace_id", workspace.id).eq("file_hash", hash).neq("status", "undone").maybeSingle();
    if (existing.error) throw existing.error;
    const scopeIdentity = (value: unknown) => JSON.stringify(workbookScopeSchema.parse(value).tables.sort((a, b) => a.sheetId - b.sheetId || a.headerRow - b.headerRow));
    const differs = (previous: {mapping?: {workbookScope?: unknown}}) => workbookScope && (!previous.mapping?.workbookScope || scopeIdentity(previous.mapping.workbookScope) !== scopeIdentity(workbookScope));
    if (existing.data && differs(existing.data)) return NextResponse.json({error: "This file already has a different reviewed workbook scope. Review or undo that import before changing its scope.", importId: existing.data.id}, {status: 409});
    if (existing.data)
      return NextResponse.json({ importId: existing.data.id, status: existing.data.status });

    const storagePath = `${workspace.id}/${hash}.${extension}`;
    const upload = await supabase.storage.from("imports").upload(storagePath, bytes, { contentType: extension === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false });
    if (upload.error && !/already exists|duplicate/i.test(upload.error.message)) throw upload.error;
    let importId: string | undefined;
    if (!importId) {
      const inserted = await supabase.from("imports").insert({ workspace_id: workspace.id, filename: file.name, storage_path: storagePath, file_hash: hash, status: "queued", mapping, total_rows: rows.length }).select("id").single();
      if (inserted.error) {
        if (inserted.error.code !== "23505") throw inserted.error;
        const duplicate = await supabase.from("imports").select("id, status, mapping").eq("workspace_id", workspace.id).eq("file_hash", hash).neq("status", "undone").single();
        if (duplicate.error) throw duplicate.error;
        if (differs(duplicate.data)) return NextResponse.json({error: "This file was concurrently imported with a different reviewed workbook scope.", importId: duplicate.data.id}, {status: 409});
        return NextResponse.json({ importId: duplicate.data.id, status: duplicate.data.status });
      }
      importId = inserted.data.id;
    }
    if (!importId) throw new Error("Import identity was not persisted");
    try {
      await start(importFile, [importId, workspace.id, rows.length, 1]);
    } catch (error) {
      const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const failed = await service.rpc("finish_import_run", { p_import_id: importId, p_workspace_id: workspace.id, p_run_version: 1, p_error: String(error) });
      if (failed.error) throw failed.error;
      throw error;
    }
    return NextResponse.json({ importId, status: "queued" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import failed" }, { status: 400 });
  }
}
