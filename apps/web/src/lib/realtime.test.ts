import { describe, expect, it, vi } from "vitest";
import {
  createFetchSseTransport,
  EventApplier,
  invalidationKeysFor,
  INVALIDATION_MAP,
  RealtimeClient,
  type ConnectionStatus,
  type DomainEvent,
  type SseTransport,
} from "./realtime";

/**
 * Issue 2.10 — change propagation and realtime recovery.
 *
 * A synthetic versioned entity (`widget`) stands in for finance rows until
 * E5. Two `RealtimeClient`s on a shared fake bus play two browser tabs:
 * a command in one tab refreshes the other, disconnect/reconnect recovers
 * through authoritative refetch, and duplicate/out-of-order events never
 * regress versions. SSE auth, polling fallback, and the stale-until-refetch
 * UI contract are pinned alongside.
 */

let eventSeq = 0;

function widgetEvent(version: number, aggregateId = "w1", eventId?: string): DomainEvent {
  eventSeq += 1;
  return {
    eventId: eventId ?? `evt-${eventSeq}`,
    workspaceId: "ws-1",
    aggregateType: "widget",
    aggregateId,
    eventType: "widget.renamed",
    version,
    occurredAt: new Date().toISOString(),
    payload: { label: `v${version}` },
  };
}

interface SseHandlers {
  onOpen(): void;
  onEvent(event: DomainEvent): void;
  onError(error: unknown): void;
}

/** Shared controllable bus: N tabs subscribe, the test drives delivery. */
class FakeBus {
  readonly subscribers = new Set<SseHandlers>();
  transport(): SseTransport {
    return {
      subscribe: (handlers: SseHandlers) => {
        this.subscribers.add(handlers);
        return () => {
          this.subscribers.delete(handlers);
        };
      },
    };
  }
  openAll(): void {
    for (const sub of [...this.subscribers]) {
      sub.onOpen();
    }
  }
  publish(event: DomainEvent): void {
    for (const sub of [...this.subscribers]) {
      sub.onEvent(event);
    }
  }
  failAll(error: unknown): void {
    for (const sub of [...this.subscribers]) {
      sub.onError(error);
    }
  }
  dropAll(): void {
    this.subscribers.clear();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function statusesOf(): { seen: ConnectionStatus[]; onStatus: (s: ConnectionStatus) => void } {
  const seen: ConnectionStatus[] = [];
  return { seen, onStatus: (s: ConnectionStatus) => void seen.push(s) };
}

function nullPoll() {
  return {
    poll: { poll: (_cursor: string | null) => Promise.resolve({ events: [], cursor: null }) },
  };
}

describe("invalidation map", () => {
  it("maps known event types to their query keys and nothing else", () => {
    expect(invalidationKeysFor("widget.renamed")).toEqual(["widgets", "widget-detail"]);
    expect(invalidationKeysFor("job.statusChanged")).toEqual(["jobs", "job-detail"]);
    expect(invalidationKeysFor("something.new")).toEqual([]);
    // Every map value is a non-empty key list (a consumer to recompute).
    for (const [type, keys] of Object.entries(INVALIDATION_MAP)) {
      expect(keys.length, type).toBeGreaterThan(0);
    }
  });
});

describe("event applier", () => {
  it("applies newer versions, drops duplicates and regressions", () => {
    const applier = new EventApplier();
    const v2 = widgetEvent(2, "w1", "e2");
    expect(applier.apply(v2)).toBe("applied");
    expect(applier.apply(v2)).toBe("duplicate");
    expect(applier.apply(widgetEvent(1, "w1", "e1-late"))).toBe("stale");
    expect(applier.apply(widgetEvent(2, "w1", "e2-other"))).toBe("stale");
    expect(applier.apply(widgetEvent(3, "w1", "e3"))).toBe("applied");
    expect(applier.snapshot("widget", "w1").version).toBe(3);
    // Aggregates track independently.
    expect(applier.apply(widgetEvent(1, "w2", "e-w2"))).toBe("applied");
  });
});

describe("two tabs stay in sync", () => {
  it("a command in one tab refreshes the other through authoritative refetch", async () => {
    const bus = new FakeBus();
    const refetchedA: string[][] = [];
    const refetchedB: string[][] = [];
    const tabA = new RealtimeClient({
      sse: bus.transport(),
      ...nullPoll(),
      refetch: (keys) => {
        refetchedA.push([...keys]);
        return Promise.resolve();
      },
    });
    const tabB = new RealtimeClient({
      sse: bus.transport(),
      ...nullPoll(),
      refetch: (keys) => {
        refetchedB.push([...keys]);
        return Promise.resolve();
      },
    });
    tabA.start();
    tabB.start();
    bus.openAll();
    await sleep(5);
    // Initial (re)connect resyncs; clear it to isolate the command's effect.
    refetchedA.length = 0;
    refetchedB.length = 0;

    // Tab A runs a command (version 1 → 2); the outbox fan-out reaches both tabs.
    bus.publish(widgetEvent(2));
    await sleep(10);

    expect(tabA.applied).toEqual(["applied"]);
    expect(tabB.applied).toEqual(["applied"]);
    expect(refetchedA).toEqual([["widgets", "widget-detail"]]);
    expect(refetchedB).toEqual([["widgets", "widget-detail"]]);
    expect(tabA.getStatus()).toBe("live");
    expect(tabB.getStatus()).toBe("live");
    expect(tabA.snapshot("widget", "w1").version).toBe(2);
    tabA.stop();
    tabB.stop();
  });

  it("shows stale until the authoritative query returns (never invents data)", async () => {
    const bus = new FakeBus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new RealtimeClient({
      sse: bus.transport(),
      ...nullPoll(),
      refetch: () => gate,
    });
    client.start();
    bus.openAll();
    await sleep(5);

    bus.publish(widgetEvent(2));
    await sleep(5);
    // Refetch is still blocked: the UI reports stale, not the event's payload.
    expect(client.getStatus()).toBe("stale");
    expect(client.snapshot("widget", "w1")).toMatchObject({ version: 2, stale: true });

    release();
    await sleep(10);
    expect(client.getStatus()).toBe("live");
    expect(client.snapshot("widget", "w1").stale).toBe(false);
    client.stop();
  });
});

describe("disconnect and reconnect", () => {
  it("recovers missed changes through resync refetch", async () => {
    const bus = new FakeBus();
    const refetches: string[][] = [];
    const { seen, onStatus } = statusesOf();
    const client = new RealtimeClient({
      sse: bus.transport(),
      ...nullPoll(),
      refetch: (keys) => {
        refetches.push([...keys]);
        return Promise.resolve();
      },
      onStatus,
      reconnectDelayMs: 5,
    });
    client.start();
    bus.openAll();
    await sleep(5);
    bus.publish(widgetEvent(1));
    await sleep(5);
    refetches.length = 0;

    // Connection drops; two commands land while the tab is dark.
    bus.failAll(new Error("socket hang up"));
    bus.dropAll();
    await sleep(15);
    expect(seen).toContain("reconnecting");

    // Reconnect resyncs through the authoritative query even though the
    // v2/v3 events themselves are gone forever.
    bus.openAll();
    await sleep(15);
    const resync = refetches.flat();
    expect(resync).toEqual(expect.arrayContaining(["widgets", "widget-detail"]));

    // Later events still apply on top: versions never regress.
    bus.publish(widgetEvent(4));
    await sleep(10);
    expect(client.snapshot("widget", "w1").version).toBe(4);
    expect(client.getStatus()).toBe("live");
    client.stop();
  });

  it("duplicate and out-of-order redelivery never regresses versions", async () => {
    const bus = new FakeBus();
    let refetchCalls = 0;
    const client = new RealtimeClient({
      sse: bus.transport(),
      ...nullPoll(),
      refetch: () => {
        refetchCalls += 1;
        return Promise.resolve();
      },
      reconnectDelayMs: 5,
    });
    client.start();
    bus.openAll();
    await sleep(5);
    refetchCalls = 0;

    const v5 = widgetEvent(5, "w1", "e5");
    bus.publish(v5);
    bus.publish(v5); // at-least-once duplicate
    bus.publish(widgetEvent(4, "w1", "e4-late")); // reordered elder
    bus.publish(widgetEvent(5, "w1", "e5-other")); // same version, other id
    await sleep(10);

    expect(client.applied).toEqual(["applied", "duplicate", "stale", "stale"]);
    expect(client.snapshot("widget", "w1").version).toBe(5);
    // One refetch for the one real change — duplicates schedule no extra work.
    expect(refetchCalls).toBe(1);
    client.stop();
  });
});

describe("transport degradation", () => {
  it("falls back to polling after repeated SSE failures and recovers", async () => {
    const bus = new FakeBus();
    const polled: DomainEvent[] = [widgetEvent(9, "w9", "e9")];
    const { seen, onStatus } = statusesOf();
    let refetchCalls = 0;
    const client = new RealtimeClient({
      sse: bus.transport(),
      poll: {
        poll: () => Promise.resolve({ events: polled.splice(0, 1), cursor: "c1" }),
      },
      refetch: () => {
        refetchCalls += 1;
        return Promise.resolve();
      },
      onStatus,
      maxSseFailures: 1,
      pollIntervalMs: 5,
      reconnectDelayMs: 20,
    });
    client.start();
    bus.failAll(new Error("boom 1"));
    await sleep(5);
    bus.failAll(new Error("boom 2")); // exceeds budget → polling
    await sleep(25);

    expect(seen).toContain("polling");
    // The polled event applied through the same version-guarded path.
    expect(client.applied).toContain("applied");

    // SSE recovers in the background: clean open returns to live.
    bus.openAll();
    await sleep(10);
    expect(client.getStatus()).toBe("live");
    expect(refetchCalls).toBeGreaterThan(0);
    client.stop();
  });

  it("stops retrying on 401 (re-auth is a navigation, not a reconnect)", async () => {
    const bus = new FakeBus();
    let subscribes = 0;
    const wrapped: SseTransport = {
      subscribe: (handlers) => {
        subscribes += 1;
        return bus.transport().subscribe(handlers);
      },
    };
    const { seen, onStatus } = statusesOf();
    const client = new RealtimeClient({
      sse: wrapped,
      ...nullPoll(),
      refetch: () => Promise.resolve(),
      onStatus,
      reconnectDelayMs: 5,
    });
    client.start();
    bus.failAll(new Error("unauthorized (401)"));
    await sleep(15);
    expect(client.getStatus()).toBe("unauthorized");
    expect(seen).not.toContain("reconnecting");
    expect(seen).not.toContain("polling");
    expect(subscribes).toBe(1);
    client.stop();
  });
});

describe("fetch sse transport", () => {
  it("sends cookies, parses data frames, and surfaces 401s", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(widgetEvent(2, "w1", "e2"))}\n\n`),
        );
      },
    });
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve({
        ok: true,
        status: 200,
        body: stream,
      });
    });
    const transport = createFetchSseTransport("/api/v1/events", fetchFn as unknown as typeof fetch);
    const events: DomainEvent[] = [];
    let opened = false;
    const unsubscribe = transport.subscribe({
      onOpen: () => {
        opened = true;
      },
      onEvent: (event) => {
        events.push(event);
      },
      onError: () => {},
    });
    await sleep(10);
    expect(opened).toBe(true);
    expect(events.map((e) => e.eventId)).toEqual(["e2"]);
    expect(calls[0]?.url).toBe("/api/v1/events");
    expect(calls[0]?.init.credentials).toBe("include");
    unsubscribe();
  });

  it("reports unauthorized instead of hanging", async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: false, status: 401, body: null }));
    const transport = createFetchSseTransport("/api/v1/events", fetchFn as unknown as typeof fetch);
    const errors: unknown[] = [];
    transport.subscribe({
      onOpen: () => {},
      onEvent: () => {},
      onError: (error) => {
        errors.push(error);
      },
    });
    await sleep(10);
    expect(String(errors[0])).toContain("401");
  });
});
