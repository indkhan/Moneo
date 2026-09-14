/**
 * Issue 2.5 — transactional outbox dispatcher.
 *
 * The executor (Issue 2.2) writes business state + `outbox_events` rows in
 * ONE database transaction. This dispatcher is the only path those rows take
 * to BullMQ: it claims a batch with `FOR UPDATE SKIP LOCKED` (concurrent
 * dispatchers never block each other, they just take different rows) and
 * publishes each event under the deterministic job id `outbox-{eventId}`.
 *
 * Safety properties:
 * - Duplicate publish is safe: the BullMQ job id is the event id, so a retry
 *   or a second dispatcher resolves to the SAME queue job (BullMQ dedupes by
 *   id; our transport wrapper upserts by id).
 * - Crash between publish and mark-published is safe: the row stays
 *   claimable, gets republished under the same job id, and the consumer
 *   (Issue 2.6) dedupes by that id — one business effect.
 * - One poison event never blocks the batch: per-event failures are recorded
 *   and the dispatcher moves on.
 */

export interface OutboxEventRow {
  id: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxJobData {
  eventId: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxTransport {
  /**
   * Publish one event. Must be idempotent on `jobId`: publishing the same
   * id twice resolves to one queue job (BullMQ `jobId` option semantics).
   */
  publish(jobId: string, data: OutboxJobData): Promise<void>;
}

export interface OutboxStore {
  /** Claim up to `limit` due rows, oldest first. See CLAIM_SQL. */
  claim(limit: number): Promise<OutboxEventRow[]>;
  /** Mark rows durably published (only called after `publish` resolves). */
  markPublished(ids: string[]): Promise<void>;
  /** Record a per-event dispatch failure; the row stays claimable. */
  markDispatchError(id: string, message: string): Promise<void>;
}

export interface DispatchOutcome {
  claimed: number;
  published: number;
  failed: number;
}

/** Deterministic BullMQ job id: one outbox row maps to exactly one queue job. */
export function outboxJobId(eventId: string): string {
  // BullMQ rejects custom job ids containing `:`. UUID event ids make this
  // separator unambiguous while remaining accepted by the transport.
  return `outbox-${eventId}`;
}

/**
 * The claim query. `FOR UPDATE SKIP LOCKED` lets N dispatchers (or a slow
 * dispatcher plus its replacement after a crash) take disjoint batches with
 * no lock waiting. Only `pending` rows whose backoff has expired are due.
 */
export const CLAIM_SQL = `SELECT id, workspace_id, aggregate_type, aggregate_id, event_type, payload, attempts
FROM outbox_events
WHERE status = 'pending' AND next_attempt_at <= now()
ORDER BY created_at ASC
LIMIT $1
FOR UPDATE SKIP LOCKED`;

export function buildClaimSql(limit: number): { text: string; values: [number] } {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`claim limit must be a positive integer, got ${limit}`);
  }
  return { text: CLAIM_SQL, values: [limit] };
}

export function toJobData(row: OutboxEventRow): OutboxJobData {
  return {
    eventId: row.id,
    workspaceId: row.workspaceId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
  };
}

export async function dispatchOutboxBatch(
  store: OutboxStore,
  transport: OutboxTransport,
  limit = 25,
): Promise<DispatchOutcome> {
  const rows = await store.claim(limit);
  let published = 0;
  let failed = 0;
  const done: string[] = [];
  for (const row of rows) {
    try {
      // Same event id → same job id → duplicate publish resolves to one job.
      await transport.publish(outboxJobId(row.id), toJobData(row));
      done.push(row.id);
      published += 1;
    } catch (error) {
      failed += 1;
      await store.markDispatchError(
        row.id,
        error instanceof Error ? error.message : `unknown dispatch error: ${typeof error}`,
      );
    }
  }
  if (done.length > 0) {
    await store.markPublished(done);
  }
  return { claimed: rows.length, published, failed };
}
