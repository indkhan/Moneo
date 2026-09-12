/**
 * Issue 2.10 — change propagation and realtime recovery.
 *
 * Pipeline: outbox event → SSE (`GET /api/v1/events`, cookie-authenticated,
 * polling fallback) → typed `DomainEvent` → invalidation map → authoritative
 * refetch → fresh UI. The event NEVER carries recalculated totals: it only
 * says *what changed and at which version*. The UI shows stale/recomputing
 * until the authoritative query returns, and version guards make duplicate
 * or out-of-order delivery harmless.
 *
 * Transports are injected so the whole reconnect/resync story is unit-
 * testable; the fetch-based SSE transport is the production default.
 */

export interface DomainEvent {
  eventId: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  /** Per-aggregate monotonically increasing version (decimal on the wire). */
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * Shared query-invalidation map: each feature adds its recomputation
 * consumer here in the epoch that introduces it (E5 transactions, E10/E11/E12
 * derived surfaces, E14 artifacts). Unknown event types invalidate nothing.
 */
export const INVALIDATION_MAP: Record<string, readonly string[]> = {
  "widget.renamed": ["widgets", "widget-detail"],
  "job.statusChanged": ["jobs", "job-detail"],
  "job.submitted": ["jobs"],
  "command.succeeded": ["commands"],
  "account.balanceRecorded": ["accounts"],
  "account.created": ["accounts"],
  "transaction.created": ["transactions"],
  "match.resolved": ["transactions"],
};

export function invalidationKeysFor(eventType: string): readonly string[] {
  return INVALIDATION_MAP[eventType] ?? [];
}

export type ApplyOutcome = "applied" | "duplicate" | "stale";

export interface AggregateSnapshot {
  version: number;
  stale: boolean;
}

/**
 * Version guard per aggregate. `apply` records the newest version seen;
 * duplicates (same eventId) and regressions (older version) are dropped so
 * at-least-once, out-of-order delivery can never regress the UI.
 */
export class EventApplier {
  private readonly versions = new Map<string, number>();
  private readonly seen = new Set<string>();

  apply(event: DomainEvent): ApplyOutcome {
    if (this.seen.has(event.eventId)) {
      return "duplicate";
    }
    const key = `${event.aggregateType}:${event.aggregateId}`;
    const current = this.versions.get(key) ?? 0;
    if (event.version <= current) {
      return "stale";
    }
    this.seen.add(event.eventId);
    this.versions.set(key, event.version);
    return "applied";
  }

  snapshot(aggregateType: string, aggregateId: string): AggregateSnapshot {
    return { version: this.versions.get(`${aggregateType}:${aggregateId}`) ?? 0, stale: false };
  }
}

export type ConnectionStatus =
  "connecting" | "live" | "stale" | "reconnecting" | "polling" | "unauthorized" | "closed";

export interface SseTransport {
  subscribe(handlers: {
    onOpen(): void;
    onEvent(event: DomainEvent): void;
    onError(error: unknown): void;
  }): () => void;
}

export interface PollTransport {
  poll(cursor: string | null): Promise<{ events: DomainEvent[]; cursor: string | null }>;
}

export interface RealtimeOptions {
  sse: SseTransport;
  poll: PollTransport;
  /** Authoritative refetch for invalidated query keys (never trusts events for data). */
  refetch: (keys: readonly string[]) => Promise<void>;
  onStatus?: (status: ConnectionStatus) => void;
  /** SSE failures before falling back to polling. */
  maxSseFailures?: number;
  pollIntervalMs?: number;
  reconnectDelayMs?: number;
}

/**
 * One tab's realtime session. Events mark queries stale and trigger an
 * authoritative refetch; reconnects always resync through refetch (missed
 * changes recover even if their events are gone); repeated SSE failures
 * degrade to polling and recover back to SSE on the next clean open.
 */
export class RealtimeClient {
  private readonly options: Required<Omit<RealtimeOptions, "onStatus">> &
    Pick<RealtimeOptions, "onStatus">;
  private readonly applier = new EventApplier();
  private status: ConnectionStatus = "connecting";
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseFailures = 0;
  private pollCursor: string | null = null;
  private pendingKeys = new Set<string>();
  private refetching = false;
  private stopped = false;
  readonly applied: ApplyOutcome[] = [];

  constructor(options: RealtimeOptions) {
    this.options = {
      maxSseFailures: 3,
      pollIntervalMs: 5_000,
      reconnectDelayMs: 1_000,
      ...options,
    };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  snapshot(aggregateType: string, aggregateId: string): AggregateSnapshot {
    const snap = this.applier.snapshot(aggregateType, aggregateId);
    return { ...snap, stale: this.status === "stale" || this.status === "reconnecting" };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("closed");
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.setStatus(this.sseFailures > 0 ? "reconnecting" : "connecting");
    this.unsubscribe?.();
    this.unsubscribe = this.options.sse.subscribe({
      onOpen: () => {
        if (this.stopped) {
          return;
        }
        this.sseFailures = 0;
        this.stopPolling();
        this.setStatus("live");
        // Resync on every (re)connect: missed events recover through the
        // authoritative query, never through replayed streams.
        void this.refetchAll();
      },
      onEvent: (event) => {
        if (this.stopped) {
          return;
        }
        this.handleEvent(event);
      },
      onError: (error) => {
        if (this.stopped) {
          return;
        }
        if (isUnauthorized(error)) {
          this.setStatus("unauthorized");
          this.unsubscribe?.();
          this.unsubscribe = null;
          return;
        }
        this.sseFailures += 1;
        if (this.sseFailures > this.options.maxSseFailures) {
          this.startPolling();
        } else {
          this.setStatus("reconnecting");
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, this.options.reconnectDelayMs);
        }
      },
    });
  }

  private handleEvent(event: DomainEvent): void {
    const outcome = this.applier.apply(event);
    this.applied.push(outcome);
    if (outcome !== "applied") {
      return;
    }
    for (const key of invalidationKeysFor(event.eventType)) {
      this.pendingKeys.add(key);
    }
    this.setStatus("stale");
    void this.flushRefetch();
  }

  private async flushRefetch(): Promise<void> {
    if (this.refetching || this.pendingKeys.size === 0) {
      return;
    }
    this.refetching = true;
    try {
      // Drain in a loop: events arriving mid-refetch schedule another pass
      // instead of being lost.
      while (this.pendingKeys.size > 0) {
        const keys = [...this.pendingKeys];
        this.pendingKeys.clear();
        await this.options.refetch(keys);
      }
      if (!this.stopped && this.status === "stale") {
        this.setStatus("live");
      }
    } finally {
      this.refetching = false;
    }
  }

  private refetchAll(): Promise<void> {
    for (const keys of Object.values(INVALIDATION_MAP)) {
      for (const key of keys) {
        this.pendingKeys.add(key);
      }
    }
    return this.flushRefetch();
  }

  private startPolling(): void {
    this.setStatus("polling");
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) {
      return;
    }
    const tick = (): Promise<void> =>
      this.options.poll
        .poll(this.pollCursor)
        .then(({ events, cursor }) => {
          this.pollCursor = cursor;
          for (const event of events) {
            this.handleEvent(event);
          }
        })
        .catch(() => {
          // Poll failures stay in polling mode; the next tick retries.
        });
    void tick();
    this.pollTimer = setInterval(() => {
      void tick();
    }, this.options.pollIntervalMs);
    // Keep probing SSE in the background: a clean open returns to live.
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.options.reconnectDelayMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function isUnauthorized(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "status" in error && error.status === 401) ||
    (error instanceof Error && /401|unauthorized/i.test(error.message))
  );
}

/**
 * Minimal authenticated SSE reader over fetch (`credentials: "include"` so
 * the session cookie travels; EventSource cannot send headers). Parses
 * `data: {...}` frames and ignores heartbeats/comments. Used as
 * `RealtimeOptions.sse` in production; tests inject fakes.
 */
export function createFetchSseTransport(url: string, fetchFn: typeof fetch = fetch): SseTransport {
  return {
    subscribe(handlers) {
      let cancelled = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const decoder = new TextDecoder();
      let buffer = "";
      let opened = false;

      const fail = (error: unknown): void => {
        if (!cancelled) {
          handlers.onError(error);
        }
      };

      void fetchFn(url, {
        headers: { accept: "text/event-stream" },
        credentials: "include",
      })
        .then((response) => {
          if (cancelled) {
            return;
          }
          if (response.status === 401) {
            fail(new Error("unauthorized (401)"));
            return;
          }
          if (!response.ok || !response.body) {
            fail(new Error(`sse request failed with status ${response.status}`));
            return;
          }
          opened = true;
          handlers.onOpen();
          reader = response.body.getReader();
          const pump = (): void => {
            void reader
              ?.read()
              .then(({ done, value }) => {
                if (cancelled) {
                  return;
                }
                if (done) {
                  fail(new Error("sse stream ended"));
                  return;
                }
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split("\n\n");
                buffer = frames.pop() ?? "";
                for (const frame of frames) {
                  for (const line of frame.split("\n")) {
                    if (line.startsWith("data:")) {
                      try {
                        handlers.onEvent(JSON.parse(line.slice(5).trim()) as DomainEvent);
                      } catch (error) {
                        fail(error);
                      }
                    }
                  }
                }
                pump();
              })
              .catch(fail);
          };
          pump();
        })
        .catch(fail);

      return () => {
        cancelled = true;
        if (!opened) {
          // Unsubscribed before open: surface nothing, just stay quiet.
        }
        void reader?.cancel().catch(() => {});
      };
    },
  };
}
