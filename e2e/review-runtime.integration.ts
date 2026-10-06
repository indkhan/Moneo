import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

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
