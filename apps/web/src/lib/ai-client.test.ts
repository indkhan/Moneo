import { describe, expect, it, vi } from "vitest";
import { consumeChatStream, type ChatEvent } from "./ai-client";

function response(lines: string[]): Response {
  return new Response(lines.join("\n"), { status: 200 });
}

describe("consumeChatStream", () => {
  it("rejects unknown tool states at the stream boundary", async () => {
    await expect(
      consumeChatStream(
        () =>
          Promise.resolve(
            response([
              JSON.stringify({ type: "tool", name: "analytics.cashflow", status: "anything" }),
              JSON.stringify({ type: "done", runId: "r1" }),
            ]),
          ),
        undefined,
        { message: "Hi" },
        () => undefined,
      ),
    ).rejects.toThrow("invalid assistant response");
  });
  it("rejects truncated streams instead of treating a partial answer as complete", async () => {
    await expect(
      consumeChatStream(
        () => Promise.resolve(response([JSON.stringify({ type: "text", text: "partial" })])),
        undefined,
        { message: "Hi" },
        () => undefined,
      ),
    ).rejects.toThrow("interrupted");
  });
  it("parses NDJSON events in order and carries the CSRF header", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        response([
          JSON.stringify({ type: "conversation", conversationId: "c1" }),
          JSON.stringify({ type: "tool", name: "analytics.spending", status: "running" }),
          JSON.stringify({ type: "text", text: "€293" }),
          JSON.stringify({
            type: "evidence",
            evidence: { id: "ev1", label: "September restaurants", href: "/ai/evidence/ev1" },
          }),
          JSON.stringify({ type: "done", runId: "r1" }),
        ]),
      ),
    );
    const events: ChatEvent[] = [];

    await consumeChatStream(fetchImpl, "csrf", { message: "How much?" }, (event) =>
      events.push(event),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/ai/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "csrf" },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "conversation",
      "tool",
      "text",
      "evidence",
      "done",
    ]);
  });

  it("rejects a malformed stream event so the UI can offer retry", async () => {
    await expect(
      consumeChatStream(
        () => Promise.resolve(response(["not json"])),
        undefined,
        { message: "Hi" },
        () => undefined,
      ),
    ).rejects.toThrow("invalid assistant response");
  });
});
