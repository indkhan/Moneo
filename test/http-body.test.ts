import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readLimitedBody } from "../apps/web/src/http-controls.ts";

describe("HTTP request body limit", () => {
  it("counts bytes and stops retaining a streaming body after rejection", async () => {
    const request = new PassThrough();
    const body = readLimitedBody(request, 64 * 1024);
    request.write(Buffer.alloc(64 * 1024 - 2));
    request.write(Buffer.from("€"));
    await expect(body).rejects.toThrow("body_too_large");
    expect(request.listenerCount("data")).toBe(0);
    request.write(Buffer.alloc(1024 * 1024));
    await new Promise((resolve) => setImmediate(resolve));
    expect(request.readableLength).toBe(0);
    request.end();
  });
});
