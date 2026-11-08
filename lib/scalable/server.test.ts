import { afterEach, expect, it, vi } from "vitest";
import { serviceDb } from "@/lib/bank/server";
import { refreshTokens, scalableMcp } from "./client";
import { withScalable } from "./server";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/bank/token-crypto", () => ({ decryptToken: (sealed: string) => sealed, encryptToken: (plain: string) => plain }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), refreshTokens: vi.fn(), scalableMcp: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const MINUTE = 60_000;
function connectedWithTokenLasting(ms: number) {
  const eqUpdate = { eq: () => eqUpdate, then: (done: (value: { error: null }) => void) => done({ error: null }) };
  const select = { eq: () => select, single: async () => ({ error: null, data: { client_id: "client", tokens_encrypted: JSON.stringify({ accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + ms }) } }) };
  vi.mocked(serviceDb).mockReturnValue({ from: () => ({ select: () => select, update: () => eqUpdate }) } as never);
  vi.mocked(refreshTokens).mockResolvedValue({ accessToken: "new", refreshToken: "next", expiresAt: Date.now() + 60 * MINUTE });
  vi.mocked(scalableMcp).mockReturnValue({ connect: async () => {} } as never);
}

it("keeps a token that outlasts a short call", async () => {
  connectedWithTokenLasting(5 * MINUTE);
  await withScalable("c", "w", async () => "done");
  expect(refreshTokens).not.toHaveBeenCalled();
  expect(vi.mocked(scalableMcp).mock.calls[0][0]).toBe("old");
});

it("refreshes first when long work would outlast the token, so it can't look like an ended login halfway through", async () => {
  connectedWithTokenLasting(5 * MINUTE);
  await withScalable("c", "w", async () => "done", fetch, 15 * MINUTE);
  expect(refreshTokens).toHaveBeenCalledOnce();
  expect(vi.mocked(scalableMcp).mock.calls[0][0]).toBe("new");
});
