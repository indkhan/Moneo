import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { serviceDb } from "@/lib/bank/server";
import { registerClient } from "@/lib/scalable/client";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/scalable/client", () => ({ authorizeUrl: vi.fn(), pkcePair: vi.fn(), registerClient: vi.fn() }));
vi.mock("@/lib/scalable/server", () => ({ scalableConfigured: () => true, scalableRedirectUri: () => "http://localhost:3000/api/scalable/callback" }));

beforeEach(() => { vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "ws-1" } } as never); });

it("sends a Scalable login from a phone back to the computer without starting anything", async () => {
  const response = await POST(new Request("http://127.0.0.1:3000/api/scalable/connect", { method: "POST", headers: { "x-forwarded-host": "pc.example.ts.net" } }));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/computer running Moneo/);
  expect(registerClient).not.toHaveBeenCalled();
  expect(serviceDb).not.toHaveBeenCalled();
});
