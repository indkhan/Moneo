import { beforeEach, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "./server";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it("permits read-only rendering while preserving real cookie failures", async () => {
  const set = vi.fn();
  vi.mocked(cookies).mockResolvedValue({ getAll: () => [], set } as unknown as Awaited<ReturnType<typeof cookies>>);
  await createClient();
  const adapter = vi.mocked(createServerClient).mock.calls[0][2].cookies!;
  const write = () => adapter.setAll!([{ name: "session", value: "refreshed", options: {} }], {});
  set.mockImplementationOnce(() => { throw new Error("Cookies can only be modified in a Server Action or Route Handler. Read more: docs"); });
  expect(write).not.toThrow();
  set.mockImplementationOnce(() => { throw new Error("Cookie serialization failed"); });
  expect(write).toThrow("Cookie serialization failed");
  expect(write).not.toThrow();
  expect(set).toHaveBeenLastCalledWith("session", "refreshed", {});
});
