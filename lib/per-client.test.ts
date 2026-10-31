import { describe, expect, it, vi } from "vitest";
import { perClient } from "./per-client";

describe("perClient", () => {
  it("shares a read between callers with the same client and arguments", async () => {
    const read = vi.fn(async (_client: object, id: string) => `rows for ${id}`);
    const load = perClient(read);
    const client = {};
    expect(await Promise.all([load(client, "a"), load(client, "a"), load(client, "b")])).toEqual(["rows for a", "rows for a", "rows for b"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads fresh for a new client", async () => {
    const read = vi.fn(async () => "rows");
    const load = perClient(read);
    await load({}); await load({});
    expect(read).toHaveBeenCalledTimes(2);
  });
});
