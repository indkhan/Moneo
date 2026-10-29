import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { replaceCallTask } from "./voice-call";

/** A fake client: chat request statuses advance per read; cards are counted and dismissed by request id. */
function fake(statuses: string[], cards: { id: string; status: string }[], onCancel?: () => void) {
  const updates: { values: Record<string, unknown>; filters: unknown[][] }[] = [];
  const rpc = vi.fn(async () => { onCancel?.(); return { data: "canceled", error: null }; });
  const from = (table: string) => {
    const filters: unknown[][] = [];
    let values: Record<string, unknown> | null = null, head = false;
    const query = {
      select: (_: string, options?: { head?: boolean }) => { head = !!options?.head; return query; },
      update: (next: Record<string, unknown>) => { values = next; return query; },
      eq: (...args: unknown[]) => { filters.push(["eq", ...args]); return query; },
      in: (...args: unknown[]) => { filters.push(["in", ...args]); return query; },
      maybeSingle: async () => ({ data: { status: statuses.length > 1 ? statuses.shift() : statuses[0] }, error: null }),
      then: (resolve: (value: unknown) => void) => {
        if (table === "agent_proposals" && head) return resolve({ count: cards.length, error: null });
        const open = cards.filter(card => ["proposed", "failed"].includes(card.status));
        updates.push({ values: values!, filters });
        for (const card of open) card.status = "rejected";
        resolve({ data: open.map(card => ({ id: card.id })), error: null });
      },
    };
    return query;
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rpc, updates };
}
const ids = { workspaceId: "workspace", conversationId: "conversation", requestId: "old" };

it("stops a running request that has made no card yet", async () => {
  const cards: { id: string; status: string }[] = [];
  const { client, rpc, updates } = fake(["running"], cards, () => cards.push({ id: "raced", status: "proposed" }));
  const result = await replaceCallTask(client, ids, { sleep: async () => {} });
  expect(rpc).toHaveBeenCalledWith("cancel_chat_request", { p_request_id: "old" });
  // A card it made while being canceled is dismissed too.
  expect(result).toMatchObject({ outcome: "stopped", dismissed: 1 });
  expect(updates[0].filters).toEqual(expect.arrayContaining([["eq", "workspace_id", "workspace"], ["eq", "chat_request_id", "old"], ["in", "status", ["proposed", "failed"]]]));
});

it("lets a request with cards finish, then dismisses its open cards as replaced", async () => {
  const cards = [{ id: "a", status: "proposed" }, { id: "b", status: "accepted" }];
  const sleep = vi.fn(async () => {});
  const { client, rpc, updates } = fake(["running", "running", "running", "completed"], cards);
  const result = await replaceCallTask(client, ids, { sleep });
  expect(rpc).not.toHaveBeenCalled();
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({ outcome: "replaced", dismissed: 1 });
  expect(updates[0].values).toMatchObject({ status: "rejected", result: { replaced: true } });
  expect(cards.map(card => card.status)).toEqual(["rejected", "accepted"]);
});

it("stops waiting after the cap", async () => {
  const { client } = fake(["running"], [{ id: "a", status: "proposed" }]);
  expect(await replaceCallTask(client, ids, { sleep: async () => {}, pollMs: 1000, maxWaitMs: 3000 })).toMatchObject({ outcome: "still_running" });
});
