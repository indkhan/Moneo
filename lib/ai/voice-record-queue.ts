import type { CallRecordInput } from "./voice-call-record";

export const MAX_REJECTIONS = 3;
export const CALL_RECORD_EVENT = "moneo:call-record";

export type QueuedCallRecord = CallRecordInput;
export type QueueEntry = { record: QueuedCallRecord; rejections: number };

export type RecordStore = {
  list(): Promise<QueueEntry[]>;
  put(entry: QueueEntry): Promise<void>;
  remove(id: string): Promise<void>;
};

export type SendRecord = (record: QueuedCallRecord) => Promise<Response>;

export type SaveResult = { kind: "saved" } | { kind: "queued" } | { kind: "failed"; message: string };
export type FlushResult = { saved: number; pending: number; offline: boolean; failures: string[] };

type Attempt = { kind: "saved" } | { kind: "offline" } | { kind: "rejected"; message: string };

const TRANSIENT_STATUSES = [502, 503, 504];
const nothingWasQueuedWhenStorageIsBlocked = () => [] as QueueEntry[];

async function attempt(send: SendRecord, record: QueuedCallRecord): Promise<Attempt> {
  let response: Response;
  try { response = await send(record); } catch { return { kind: "offline" }; }
  if (response.ok) return { kind: "saved" };
  if (TRANSIENT_STATUSES.includes(response.status)) return { kind: "offline" };
  const body: { error?: unknown } = await response.json().catch(() => ({}));
  return { kind: "rejected", message: typeof body.error === "string" ? body.error : `Moneo could not save the call record (${response.status}).` };
}

export async function saveOrQueue(store: RecordStore, send: SendRecord, record: QueuedCallRecord): Promise<SaveResult> {
  const result = await attempt(send, record);
  if (result.kind === "saved") return result;
  if (result.kind === "rejected") return { kind: "failed", message: result.message };
  try {
    await store.put({ record, rejections: 0 });
    return { kind: "queued" };
  } catch {
    return { kind: "failed", message: "Moneo couldn't save the call record because you're offline and this browser wouldn't keep it for later." };
  }
}

export async function flushQueue(store: RecordStore, send: SendRecord, workspaceId: string): Promise<FlushResult> {
  const entries = (await store.list().catch(nothingWasQueuedWhenStorageIsBlocked)).filter(entry => entry.record.workspaceId === workspaceId);
  const result: FlushResult = { saved: 0, pending: entries.length, offline: false, failures: [] };
  for (const entry of entries) {
    const outcome = await attempt(send, entry.record);
    if (outcome.kind === "offline") { result.offline = true; break; }
    if (outcome.kind === "saved") { await store.remove(entry.record.id); result.saved++; result.pending--; continue; }
    const rejections = entry.rejections + 1;
    if (rejections >= MAX_REJECTIONS) {
      await store.remove(entry.record.id);
      result.pending--;
      result.failures.push(`${outcome.message} Moneo gave up on this call record.`);
    } else {
      await store.put({ record: entry.record, rejections });
      result.failures.push(outcome.message);
    }
  }
  return result;
}

export const postCallRecord: SendRecord = record => fetch("/api/voice/calls", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });

const DATABASE = "moneo-call-records", STORE = "records";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is not available")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "record.id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not open"));
  });
}

async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
    });
  } finally { database.close(); }
}

export const indexedDbStore: RecordStore = {
  list: () => inStore("readonly", store => store.getAll() as IDBRequest<QueueEntry[]>),
  put: async entry => { await inStore("readwrite", store => store.put(entry)); },
  remove: async id => { await inStore("readwrite", store => store.delete(id)); },
};

export type CallRecordEventDetail = { kind: "queued" } | { kind: "failed"; message: string };

export function announceCallRecord(detail: CallRecordEventDetail) {
  window.dispatchEvent(new CustomEvent<CallRecordEventDetail>(CALL_RECORD_EVENT, { detail }));
}
