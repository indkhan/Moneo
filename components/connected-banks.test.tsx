import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SYNC_STALE_MS, syncRunning } from "@/lib/bank/sync-state";
import { consentState, SyncProgress, syncSteps, syncSummary } from "./connected-banks";

it("shows the reconnect banner from 7 days before consent ends", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const until = (days: number) => new Date(now + days * 86_400_000).toISOString();
  expect(consentState({ status: "active", valid_until: until(30) }, now)).toBeNull();
  expect(consentState({ status: "active", valid_until: until(6.9) }, now)).toBe("expiring");
  expect(consentState({ status: "active", valid_until: until(-1) }, now)).toBe("expired");
  expect(consentState({ status: "expired", valid_until: until(30) }, now)).toBe("expired");
  expect(consentState({ status: "error", valid_until: null }, now)).toBeNull();
});

const sync = (imports: { status: string; total_rows: number; new_rows?: number; matched_rows?: number }[]) =>
  ({ running: true, imports: imports.map((item, index) => ({ id: `i${index}`, review_rows: 0, rejected_rows: 0, new_rows: 0, matched_rows: 0, ...item })) });

it("walks a sync through asking the bank, importing rows and finishing", () => {
  const states = (imports: Parameters<typeof sync>[0]) => syncSteps({ aspsp_name: "Revolut", sync: sync(imports) }).steps.map(step => step.state);
  expect(states([])).toEqual(["active", "pending", "pending"]);
  expect(states([{ status: "running", total_rows: 131, new_rows: 40 }])).toEqual(["done", "active", "pending"]);
  expect(states([{ status: "completed", total_rows: 131, new_rows: 131 }])).toEqual(["done", "done", "active"]);
  const html = renderToStaticMarkup(<SyncProgress now={Date.parse("2026-10-17T10:01:05Z")}
    connection={{ aspsp_name: "Revolut", sync_started_at: "2026-10-17T10:00:00Z", sync: sync([{ status: "running", total_rows: 131, new_rows: 40 }]) }} />);
  expect(html).toContain("Importing 40 of 131 rows");
  expect(html).toContain("1:05");
  expect(html).toContain("<progress");
});

it("summarises the finished sync and treats a stuck one as stale", () => {
  const finished = { sync_started_at: "2026-10-17T10:00:00Z", last_synced_at: "2026-10-17T10:02:00Z" };
  expect(syncSummary({ ...finished, sync: sync([{ status: "completed", total_rows: 131, new_rows: 117, matched_rows: 14 }]) })?.text).toBe("Last sync: 117 new · 14 already imported.");
  expect(syncSummary({ ...finished, sync: sync([]) })?.text).toBe("Last sync found no new transactions.");
  expect(syncSummary({ ...finished, last_synced_at: "2026-10-17T09:00:00Z", sync: sync([]) })).toBeNull();
  const started = Date.parse(finished.sync_started_at);
  expect(syncRunning({ sync_started_at: finished.sync_started_at, last_synced_at: null }, started + 60_000)).toBe(true);
  expect(syncRunning(finished, started + 60_000)).toBe(false);
  expect(syncRunning({ sync_started_at: finished.sync_started_at, last_synced_at: null }, started + SYNC_STALE_MS)).toBe(false);
});
