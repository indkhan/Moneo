import { POST as controlImport } from "../control/route";

// Compatibility URL; the Import UI uses an explicit request identity at /control.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => null);
  return controlImport(new Request(request.url, { method: "POST", headers: request.headers,
    body: JSON.stringify({ action: "resume", requestId: body?.requestId ?? crypto.randomUUID() }) }), context);
}
