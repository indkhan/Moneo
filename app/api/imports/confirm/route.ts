import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { requireWorkspace } from "@/lib/auth";
import { parseCsv, parseExcel, validateImportConfirmation } from "@/lib/csv";
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
    if (!(file instanceof File) || typeof mappingValue !== "string" || file.size > 10_000_000)
      return NextResponse.json({ error: "File and mapping are required (10 MB maximum)" }, { status: 400 });
    const extension = file.name.toLowerCase().split(".").pop();
    if (extension !== "csv" && extension !== "xlsx") return NextResponse.json({ error: "Only CSV and XLSX are supported" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const rows = extension === "csv" ? parseCsv(bytes.toString("utf8")) : await parseExcel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const mapping = validateImportConfirmation(rows, JSON.parse(mappingValue));
    const { supabase, workspace } = context;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = await supabase.from("imports").select("id, status").eq("workspace_id", workspace.id).eq("file_hash", hash).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data && existing.data.status !== "failed")
      return NextResponse.json({ importId: existing.data.id, status: existing.data.status });

    const storagePath = `${workspace.id}/${hash}.${extension}`;
    const upload = await supabase.storage.from("imports").upload(storagePath, bytes, { contentType: extension === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false });
    if (upload.error && !/already exists|duplicate/i.test(upload.error.message)) throw upload.error;
    let importId = existing.data?.id;
    if (!importId) {
      const inserted = await supabase.from("imports").insert({ workspace_id: workspace.id, filename: file.name, storage_path: storagePath, file_hash: hash, status: "queued", mapping, total_rows: rows.length }).select("id").single();
      if (inserted.error) {
        if (inserted.error.code !== "23505") throw inserted.error;
        const duplicate = await supabase.from("imports").select("id, status").eq("workspace_id", workspace.id).eq("file_hash", hash).single();
        if (duplicate.error) throw duplicate.error;
        return NextResponse.json({ importId: duplicate.data.id, status: duplicate.data.status });
      }
      importId = inserted.data.id;
    }
    try {
      await start(importFile, [importId, workspace.id, rows.length]);
    } catch (error) {
      await supabase.from("imports").update({ status: "failed", error: String(error) }).eq("id", importId).eq("workspace_id", workspace.id);
      throw error;
    }
    return NextResponse.json({ importId, status: "queued" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import failed" }, { status: 400 });
  }
}
