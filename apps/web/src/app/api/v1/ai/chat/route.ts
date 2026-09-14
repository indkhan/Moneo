import { aiRoute, chatRequest, readAiBody } from "@/lib/ai-api";
import { runChat } from "@/lib/ai-chat";
export const runtime = "nodejs";
export const maxDuration = 90;
export async function POST(request: Request) {
  return aiRoute(async (workspaceId) => {
    const input = chatRequest.parse(await readAiBody(request));
    const abort = new AbortController(),
      signal = AbortSignal.any([request.signal, abort.signal]);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: Record<string, unknown>) => {
          if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        void runChat({ workspaceId, input, signal, emit })
          .catch(() => {
            emit({
              type: "error",
              message: "Unable to start chat. A request may already be running; retry shortly.",
            });
          })
          .finally(() => {
            try {
              controller.close();
            } catch {
              /* Client disconnected. */
            }
          });
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
