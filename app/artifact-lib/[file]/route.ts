import { readFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_LIBRARIES } from "@/lib/ai/artifact-data";

// Literal paths, so the build knows each file and traces only it.
const FILES: Record<keyof typeof ARTIFACT_LIBRARIES, () => Promise<Buffer>> = {
  "echarts.min.js": () => readFile(path.join(process.cwd(), "node_modules", "echarts", "dist", "echarts.min.js")),
};

/**
 * A chart library for artifact pages, from Moneo's own node_modules, so a page works offline and its sandbox can
 * forbid every other origin. Public (the sandboxed page sends no session) and limited to the listed files.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const file = (await params).file;
  if (!Object.hasOwn(FILES, file)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await FILES[file as keyof typeof FILES]()), {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin" },
  });
}
