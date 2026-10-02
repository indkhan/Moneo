import { expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

it("forwards refreshed cookies to rendering and the browser without caching session responses", async () => {
  const request = new NextRequest("http://localhost:3000/plan", { headers: { cookie: "session=expired" } });
  const getClaims = vi.fn(async () => {
    const adapter = vi.mocked(createServerClient).mock.calls[0][2].cookies!;
    expect(adapter.getAll!()).toEqual([{ name: "session", value: "expired" }]);
    adapter.setAll!([{ name: "session", value: "fresh", options: { httpOnly: true, path: "/" } }], { "Cache-Control": "private, no-store" });
    return { data: null, error: null };
  });
  vi.mocked(createServerClient).mockReturnValue({ auth: { getClaims } } as unknown as ReturnType<typeof createServerClient>);
  const response = await proxy(request);
  expect(getClaims).toHaveBeenCalledOnce();
  expect(request.cookies.get("session")?.value).toBe("fresh");
  expect(response.headers.get("x-middleware-request-cookie")).toBe("session=fresh");
  expect(response.cookies.get("session")).toMatchObject({ value: "fresh", httpOnly: true });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
