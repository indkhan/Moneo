import { readFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_LIBRARIES } from "@/lib/ai/artifact-data";

const FILES: Record<keyof typeof ARTIFACT_LIBRARIES, () => Promise<Buffer>> = {
  "echarts.min.js": () => readFile(path.join(process.cwd(), "node_modules", "echarts", "dist", "echarts.min.js")),
};

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const file = (await params).file;
  if (!Object.hasOwn(FILES, file)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await FILES[file as keyof typeof FILES]()), {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin" },
  });
}
