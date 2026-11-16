import { afterEach, expect, it, vi } from "vitest";

type Route = { GET: (request: Request) => Promise<Response> };
const loaders = import.meta.glob("../app/api/cron/*/route.ts") as Record<string, () => Promise<Route>>;
const routes = Object.fromEntries(await Promise.all(Object.entries(loaders).map(async ([file, load]) => [file, (await load()).GET] as const)));

afterEach(() => vi.unstubAllEnvs());

it("every scheduled job refuses a caller without the cron secret", async () => {
  vi.stubEnv("CRON_SECRET", "right-secret");
  expect(Object.keys(routes).length).toBeGreaterThan(0);
  for (const [file, GET] of Object.entries(routes)) {
    for (const authorization of [undefined, "Bearer wrong-secret!", "Bearer right-secre", "right-secret"]) {
      const response = await GET(new Request("http://127.0.0.1/job", { headers: authorization ? { authorization } : {} }));
      expect(response.status, `${file} with ${authorization ?? "no header"}`).toBe(401);
    }
  }
});

it("no scheduled job runs when the cron secret is not set", async () => {
  vi.stubEnv("CRON_SECRET", "");
  for (const [file, GET] of Object.entries(routes)) {
    const response = await GET(new Request("http://127.0.0.1/job", { headers: { authorization: "Bearer " } }));
    expect(response.status, file).toBe(401);
  }
});
