import { expect, it } from "vitest";
import { loadArtifactBuilds } from "./artifact-builds";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const rows = [
  { id: "live", workspace_id: "owned", artifact_id: "a", prompt: "Rent", status: "running", error: null, created_at: ago(1) },
  { id: "cut-off", workspace_id: "owned", artifact_id: null, prompt: "Car", status: "running", error: null, created_at: ago(10) },
  { id: "broke", workspace_id: "owned", artifact_id: "a", prompt: "Budget", status: "failed", error: "Provider unavailable", created_at: ago(20) },
  { id: "done", workspace_id: "owned", artifact_id: "a", prompt: "Goals", status: "completed", error: null, created_at: ago(2) },
  { id: "old", workspace_id: "owned", artifact_id: "a", prompt: "Old", status: "failed", error: "x", created_at: ago(120) },
  { id: "foreign", workspace_id: "other", artifact_id: "a", prompt: "Other", status: "running", error: null, created_at: ago(1) },
];
const client = { from() {
  let data = [...rows];
  const query = {
    select: () => query, limit: () => query, order: () => query,
    eq: (key: string, value: string) => { data = data.filter(row => row[key as keyof typeof row] === value); return query; },
    neq: (key: string, value: string) => { data = data.filter(row => row[key as keyof typeof row] !== value); return query; },
    gte: (key: string, value: string) => { data = data.filter(row => String(row[key as keyof typeof row]) >= value); return query; },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
  }; return query;
} };

it("lists running and recently failed builds, and shows a cut-off run as stopped", async () => {
  expect(await loadArtifactBuilds(client as never, "owned")).toMatchObject([
    { id: "live", artifact_id: "a", prompt: "Rent", status: "running", error: null },
    { id: "cut-off", artifact_id: null, prompt: "Car", status: "failed", error: "Stopped before it finished" },
    { id: "broke", artifact_id: "a", prompt: "Budget", status: "failed", error: "Provider unavailable" },
  ]);
  expect((await loadArtifactBuilds(client as never, "owned", "a")).map(build => build.id)).toEqual(["live", "broke"]);
});
