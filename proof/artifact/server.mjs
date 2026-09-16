import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "../../proof-output/artifact-dist");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm" };

function serve(port, renderer) {
  createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    let path = normalize(join(root, pathname === "/" ? renderer ? "renderer.html" : "host.html" : pathname));
    if (!path.startsWith(root)) { response.writeHead(404).end(); return; }
    try { if ((await stat(path)).isDirectory()) path = join(path, "index.html"); }
    catch { response.writeHead(404).end(); return; }
    const worker = renderer && pathname.startsWith("/assets/worker-");
    const csp = worker
      ? "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src data:; worker-src 'none'; object-src 'none'; base-uri 'none'"
      : renderer
      ? "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://localhost:4173"
      : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:4174; worker-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
      "Content-Security-Policy": csp,
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), clipboard-read=(), clipboard-write=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    response.end(await readFile(path));
  }).listen(port, "127.0.0.1");
}

serve(4173, false);
serve(4174, true);
