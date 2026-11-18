import { expect, it } from "vitest";
import { MAX_REJECTIONS, flushQueue, saveOrQueue, type QueueEntry, type RecordStore, type SendRecord } from "./voice-record-queue";

const record = (id: string, workspaceId = "00000000-0000-4000-8000-0000000000a1") => ({
  id, workspaceId, conversationId: "00000000-0000-4000-8000-000000000002", durationSeconds: 60,
  transcript: [{ role: "user" as const, text: "How much at Netto?" }], tasks: [],
});
const one = record("00000000-0000-4000-8000-000000000001");
const workspace = one.workspaceId;

function memoryStore(options: { failPut?: boolean } = {}) {
  const entries = new Map<string, QueueEntry>();
  const store: RecordStore = {
    list: async () => [...entries.values()],
    put: async entry => { if (options.failPut) throw new Error("blocked"); entries.set(entry.record.id, entry); },
    remove: async id => { entries.delete(id); },
  };
  return { store, entries };
}

function server() {
  const saved = new Map<string, unknown>();
  let mode: "online" | "offline" | "lose-response" | { status: number; error?: string } = "online";
  const send: SendRecord = async body => {
    if (mode === "offline") throw new TypeError("Failed to fetch");
    if (typeof mode === "object") return Response.json({ error: mode.error }, { status: mode.status });
    saved.set(body.id, body);
    if (mode === "lose-response") throw new TypeError("Failed to fetch");
    return Response.json({ id: body.id });
  };
  return { saved, send, set: (next: typeof mode) => { mode = next; } };
}

it("keeps a record that could not be sent offline and saves it once the connection returns", async () => {
  const { store, entries } = memoryStore();
  const remote = server();
  remote.set("offline");
  expect(await saveOrQueue(store, remote.send, one)).toEqual({ kind: "queued" });
  expect([...entries.keys()]).toEqual([one.id]);
  expect(await flushQueue(store, remote.send, workspace)).toMatchObject({ saved: 0, pending: 1, offline: true });
  remote.set("online");
  expect(await flushQueue(store, remote.send, workspace)).toMatchObject({ saved: 1, pending: 0, offline: false });
  expect([...remote.saved.keys()]).toEqual([one.id]);
  expect(entries.size).toBe(0);
});

it("retries with the same id after a lost response, so the server holds one record", async () => {
  const { store } = memoryStore();
  const remote = server();
  remote.set("lose-response");
  expect(await saveOrQueue(store, remote.send, one)).toEqual({ kind: "queued" });
  remote.set("online");
  await flushQueue(store, remote.send, workspace);
  expect(remote.saved.size).toBe(1);
});

it("surfaces a rejection instead of queueing it, and storage that refuses a record", async () => {
  const remote = server();
  remote.set({ status: 400, error: "Invalid call record" });
  const { store, entries } = memoryStore();
  expect(await saveOrQueue(store, remote.send, one)).toEqual({ kind: "failed", message: "Invalid call record" });
  expect(entries.size).toBe(0);
  remote.set("offline");
  const blocked = memoryStore({ failPut: true });
  expect(await saveOrQueue(blocked.store, remote.send, one)).toMatchObject({ kind: "failed" });
});

it("tells the owner about a queued record the server rejects, and gives up after a few tries", async () => {
  const { store, entries } = memoryStore();
  const remote = server();
  remote.set("offline");
  await saveOrQueue(store, remote.send, one);
  remote.set({ status: 409, error: "Call id is already used" });
  for (let round = 1; round < MAX_REJECTIONS; round++) {
    const result = await flushQueue(store, remote.send, workspace);
    expect(result).toMatchObject({ pending: 1, failures: ["Call id is already used"] });
    expect(entries.size).toBe(1);
  }
  const last = await flushQueue(store, remote.send, workspace);
  expect(last.pending).toBe(0);
  expect(last.failures[0]).toContain("gave up");
  expect(entries.size).toBe(0);
});

it("never sends a record queued for another workspace", async () => {
  const { store, entries } = memoryStore();
  const remote = server();
  const other = record("00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-0000000000b2");
  entries.set(other.id, { record: other, rejections: 0 });
  expect(await flushQueue(store, remote.send, workspace)).toMatchObject({ saved: 0, pending: 0 });
  expect(remote.saved.size).toBe(0);
  expect(entries.has(other.id)).toBe(true);
});
