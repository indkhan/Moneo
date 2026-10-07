import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

for (const mode of ["import-dispatch-once", "import-settings-once"]) {
test(`installed import workflow retries retained first-review ${mode}`, async ({ request }) => {
  const workspace = randomUUID(), importId = randomUUID();
  const hex = createHash("sha256").update(`${workspace}:first-financial-review`).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, import: importId, mode } });
  try {
    const dispatched = await request.post("/api/reviews", { data: { import: importId, workspace } });
    expect(dispatched.ok()).toBe(true); const { runId } = await dispatched.json();
    await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, { timeout: 90_000 }).toBe("completed");
    await expect.poll(async () => (await (await request.get(fixture)).json()).status, { timeout: 90_000 }).toBe("completed");
    const state = await (await request.get(fixture)).json();
    if (mode === "import-dispatch-once") expect(state.register_attempts).toBeGreaterThan(1);
    expect(state.import_finishes).toBe(1); expect(state.attempts.provider).toBe(1); expect(state.saves).toBe(1);
  } finally { await request.delete(fixture); }
});
}

test("installed summary cron dispatch acknowledges and reuses its scheduled claim", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "normal", scheduled: true } });
  try {
    const dispatched = await request.get("/api/cron/summaries", { headers: { authorization: "Bearer synthetic-cron" } });
    expect(dispatched.ok()).toBe(true); expect(await dispatched.json()).toMatchObject({ started: 1 });
    await expect.poll(async () => (await (await request.get(fixture)).json()).status, { timeout: 90_000 }).toBe("completed");
    expect(await (await request.get("/api/cron/summaries", { headers: { authorization: "Bearer synthetic-cron" } })).json()).toMatchObject({ started: 0 });
    const state = await (await request.get(fixture)).json();
    expect(state.workflow_run_id).toBeTruthy(); expect(state.runs).toHaveLength(1); expect(state.saves).toBe(1);
  } finally { await request.delete(fixture); }
});

for (const scheduled of [false, true]) {
  test(`unattended cron recovers an orphan claim (scheduled=${scheduled})`, async ({ request }) => {
    const id = randomUUID(), workspace = randomUUID();
    const fixture = `http://127.0.0.1:3041/fixture/${id}`;
    await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "normal", scheduled } });
    try {
      const recovered = await request.get("/api/cron/reviews", { headers: { authorization: "Bearer synthetic-cron" } });
      expect(recovered.ok()).toBe(true); expect(await recovered.json()).toMatchObject({ recovered: 1, errors: 0 });
      await expect.poll(async () => (await (await request.get(fixture)).json()).status, { timeout: 90_000 }).toBe("completed");
      const state = await (await request.get(fixture)).json();
      expect(state.attempts.provider).toBe(1); expect(state.saves).toBe(1);
    } finally { await request.delete(fixture); }
  });
}

test("persisted running review survives a real Next worker process kill and restart", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "interrupt-provider" } });
  let stopped = false;
  try {
    const dispatched = await request.post("/api/reviews", { data: { job: id, workspace, claimed: true, scheduled: false } });
    expect(dispatched.ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(fixture)).json()).attempts.provider, { timeout: 90_000 }).toBe(1);
    const before = await (await request.get(fixture)).json();
    expect((await request.post("http://127.0.0.1:3041/runtime/kill")).ok()).toBe(true); stopped = true;
    expect((await request.post("http://127.0.0.1:3041/runtime/restart")).ok()).toBe(true); stopped = false;
    await expect.poll(async () => {
      try { return (await request.get("/api/cron/reviews", { headers: { authorization: "Bearer synthetic-cron" }, timeout: 3000 })).status(); }
      catch { return 0; }
    }, { timeout: 90_000 }).toBe(200);
    await expect.poll(async () => (await (await request.get(fixture)).json()).status, { timeout: 90_000 }).toBe("completed");
    const after = await (await request.get(fixture)).json();
    expect(after.workflow_run_id).toBe(before.workflow_run_id);
    expect(after.runs).toHaveLength(1); expect(after.saves).toBe(1); expect(after.attempts.provider).toBe(2);
  } finally { if (stopped) await request.post("http://127.0.0.1:3041/runtime/restart"); await request.delete(fixture); }
});

test("unattended reconciliation finalizes a runtime whose cleanup exhausted", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "failure-write-exhausted" } });
  try {
    const dispatched = await request.post("/api/reviews", { data: { job: id, workspace, claimed: true, scheduled: false } });
    expect(dispatched.ok()).toBe(true);
    const runId = (await (await request.get(fixture)).json()).workflow_run_id;
    await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, { timeout: 90_000 }).toBe("failed");
    expect((await (await request.get(fixture)).json()).status).toBe("running");
    await request.patch(fixture, { data: { mode: "normal" } });
    const recovered = await request.get("/api/cron/reviews", { headers: { authorization: "Bearer synthetic-cron" } });
    expect(recovered.ok()).toBe(true);
    const state = await (await request.get(fixture)).json();
    expect(state.status).toBe("failed"); expect(state.runs).toHaveLength(1); expect(state.saves).toBe(0);
  } finally { await request.delete(fixture); }
});

test("unattended deadline confirms runtime cancellation and suppresses late publication", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "interrupt-provider" } });
  try {
    expect((await request.post("/api/reviews", { data: { job: id, workspace, claimed: true, scheduled: false } })).ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(fixture)).json()).attempts.provider, { timeout: 90_000 }).toBe(1);
    const runId = (await (await request.get(fixture)).json()).workflow_run_id;
    await request.patch(fixture, { data: { dispatched_at: "2026-01-01T00:00:00Z" } });
    expect((await request.get("/api/cron/reviews", { headers: { authorization: "Bearer synthetic-cron" } })).ok()).toBe(true);
    expect((await (await request.get(`/api/reviews?run=${runId}`)).json()).status).toBe("cancelled");
    await expect.poll(async () => (await (await request.get(fixture)).json()).provider_returned, { timeout: 30_000 }).toBe(1);
    const state = await (await request.get(fixture)).json();
    expect(state.status).toBe("failed"); expect(state.stage).toBe("runtime_deadline");
    expect(state.runs).toHaveLength(1); expect(state.saves).toBe(0);
  } finally { await request.delete(fixture); }
});

test("unattended orphan deadline rejects an ambiguously accepted late worker", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "normal", created_at: "2026-01-01T00:00:00Z" } });
  try {
    expect((await request.get("/api/cron/reviews", { headers: { authorization: "Bearer synthetic-cron" } })).ok()).toBe(true);
    const expired = await (await request.get(fixture)).json();
    expect(expired.status).toBe("failed"); expect(expired.workflow_run_id).toBeNull(); expect(expired.runs).toHaveLength(0);
    const delivered = await request.post("/api/reviews", { data: { job: id, workspace, direct: true } });
    const { runId } = await delivered.json();
    await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, { timeout: 90_000 }).toBe("completed");
    const after = await (await request.get(fixture)).json();
    expect(after.status).toBe("failed"); expect(after.workflow_run_id).toBeNull(); expect(after.attempts.provider).toBe(0); expect(after.saves).toBe(0);
  } finally { await request.delete(fixture); }
});

for (const mode of ["evidence-once", "provider-once", "save-once", "save-lost-response", "write-once", "evidence-exhausted", "provider-exhausted", "save-exhausted", "permanent", "provider-permanent", "failure-write-once", "cancel-provider", "cancel-publication"]) {
  test(`installed Workflow runtime: ${mode}`, async ({ request }) => {
    const id = randomUUID(), workspace = randomUUID();
    const fixture = `http://127.0.0.1:3041/fixture/${id}`;
    await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode } });
    try {
      const dispatched = await request.post("/api/reviews", { data: { job: id, workspace, direct: true } });
      expect(dispatched.ok()).toBe(true);
      const { runId } = await dispatched.json();
      const failed = mode.endsWith("exhausted") || ["permanent", "provider-permanent", "failure-write-once"].includes(mode);
      await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, { timeout: 90_000 }).toBe(failed ? "failed" : "completed");
      const state = await (await request.get(fixture)).json();
      expect(state.status).toBe(failed ? "failed" : mode.startsWith("cancel") ? "canceled" : "completed");
      expect(state.saves).toBe(!failed && !mode.startsWith("cancel") ? 1 : 0);
      expect(state.workflow_run_id).toBe(runId);
      expect(state.dispatched_at).toBeTruthy();
      const stage = mode.split("-")[0];
      if (mode.endsWith("once") && stage !== "failure") expect(state.attempts[stage === "write" ? "gathering_evidence" : stage]).toBe(2);
      if (mode.endsWith("exhausted")) expect(state.attempts[stage]).toBe(4);
      if (mode === "permanent") expect(state.attempts.evidence).toBe(0);
      if (mode === "failure-write-once") expect(state.attempts.failure).toBe(2);
      if (mode === "save-lost-response") expect(state.attempts.save).toBe(1);
      if (mode === "provider-permanent") expect(state.attempts.provider).toBe(1);
    } finally { expect((await (await request.delete(fixture)).json()).removed).toBe(true); }
  });
}

test("manual retry dispatches an orphaned claim and duplicate runs do no useful work", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID(), requestId = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, request: requestId, mode: "normal" } });
  try {
    expect((await request.post("/api/reviews", {data: {workspace, request: requestId, interruptBeforeStart: true}})).status()).toBe(503);
    expect((await (await request.get(fixture)).json()).workflow_run_id).toBeNull();
    const dispatched = await request.post("/api/reviews", {data: {workspace, request: requestId}});
    expect(dispatched.ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(fixture)).json()).status, {timeout: 90_000}).toBe("completed");
    const before = await (await request.get(fixture)).json();
    const duplicate = await request.post("/api/reviews", {data: {job: id, workspace, direct: true}});
    const {runId} = await duplicate.json();
    await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, {timeout: 90_000}).toBe("completed");
    const after = await (await request.get(fixture)).json();
    expect(after.attempts.provider).toBe(1); expect(after.saves).toBe(1);
    expect(after.workflow_run_id).toBe(before.workflow_run_id);
  } finally { expect((await (await request.delete(fixture)).json()).removed).toBe(true); }
});

test("simultaneous runtime deliveries elect one run before provider work", async ({request}) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", {data: {id, workspace, mode: "slow-provider"}});
  try {
    const dispatched = await Promise.all([1, 2].map(() => request.post("/api/reviews", {data: {job: id, workspace, direct: true}})));
    for (const response of dispatched) {
      expect(response.ok()).toBe(true); const {runId} = await response.json();
      await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, {timeout: 90_000}).toBe("completed");
    }
    const state = await (await request.get(fixture)).json();
    expect(state.runs).toHaveLength(2); expect(state.attempts.provider).toBe(1); expect(state.saves).toBe(1);
  } finally { expect((await (await request.delete(fixture)).json()).removed).toBe(true); }
});

test("a lost caller response reuses the acknowledged worker without duplicate analysis", async ({request}) => {
  const id = randomUUID(), workspace = randomUUID(), requestId = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", {data: {id, workspace, request: requestId, mode: "normal"}});
  try {
    await expect(request.post("/api/reviews", {data: {workspace, request: requestId, loseResponse: true}, timeout: 500})).rejects.toThrow();
    await expect.poll(async () => (await (await request.get(fixture)).json()).workflow_run_id, {timeout: 90_000}).toBeTruthy();
    const before = await (await request.get(fixture)).json();
    expect((await request.post("/api/reviews", {data: {workspace, request: requestId}})).ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(fixture)).json()).status, {timeout: 90_000}).toBe("completed");
    const after = await (await request.get(fixture)).json();
    expect(after.workflow_run_id).toBe(before.workflow_run_id); expect(after.runs).toHaveLength(1); expect(after.saves).toBe(1);
  } finally { expect((await (await request.delete(fixture)).json()).removed).toBe(true); }
});

test("a repeated request reconciles a runtime whose terminal DB writes exhausted", async ({request}) => {
  const id = randomUUID(), workspace = randomUUID(), requestId = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", {data: {id, workspace, request: requestId, mode: "failure-write-exhausted"}});
  try {
    expect((await request.post("/api/reviews", {data: {workspace, request: requestId}})).ok()).toBe(true);
    const {workflow_run_id: runId} = await (await request.get(fixture)).json();
    await expect.poll(async () => (await (await request.get(`/api/reviews?run=${runId}`)).json()).status, {timeout: 90_000}).toBe("failed");
    const exhausted = await (await request.get(fixture)).json();
    expect(exhausted.status).toBe("running"); expect(exhausted.attempts.failure).toBe(4);
    await request.patch(fixture, {data: {mode: "normal"}});
    const reconciled = await request.post("/api/reviews", {data: {workspace, request: requestId}});
    expect((await reconciled.json()).status).toBe("failed");
    const state = await (await request.get(fixture)).json();
    expect(state.saves).toBe(0); expect(state.runs).toHaveLength(1);
  } finally { expect((await (await request.delete(fixture)).json()).removed).toBe(true); }
});

test("Stop aborts the actual AI SDK/OpenRouter HTTP transport in an installed Workflow step", async ({ request }) => {
  const id = randomUUID(), workspace = randomUUID();
  const fixture = `http://127.0.0.1:3041/fixture/${id}`;
  await request.post("http://127.0.0.1:3041/fixture", { data: { id, workspace, mode: "provider-stop" } });
  try {
    expect((await request.post("/api/reviews", { data: { job: id, workspace, claimed: true, scheduled: false } })).ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(fixture)).json()).attempts.provider, { timeout: 90_000 }).toBe(1);
    const before = await (await request.get(fixture)).json();
    const stoppedAt = Date.now();
    await request.patch(fixture, { data: { cancel_requested: true, stage: "cancel_requested" } });
    await expect.poll(async () => (await (await request.get(fixture)).json()).provider_aborted, { timeout: 5000, intervals: [100] }).toBe(true);
    await expect.poll(async () => (await (await request.get(fixture)).json()).status, { timeout: 5000, intervals: [100] }).toBe("canceled");
    const after = await (await request.get(fixture)).json();
    expect(after.provider_aborted_at - stoppedAt).toBeLessThan(3000);
    expect(after.attempts.provider).toBe(1); expect(after.saves).toBe(0);
    await expect.poll(async () => (await (await request.get(`/api/reviews?run=${before.workflow_run_id}`)).json()).status, { timeout: 5000 }).toBe("cancelled");
    // A fresh request is the reload source of truth, independent of in-memory UI state.
    expect(await (await request.get(fixture)).json()).toMatchObject({ status: "canceled", cancel_requested: true, saves: 0 });
  } finally { await request.delete(fixture); }
});
