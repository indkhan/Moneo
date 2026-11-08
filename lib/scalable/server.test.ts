import { afterEach, expect, it, vi } from "vitest";
import { serviceDb } from "@/lib/bank/server";
import { refreshTokens, ScalableError, scalableMcp } from "./client";
import { withScalable } from "./server";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/bank/token-crypto", () => ({ decryptToken: (sealed: string) => sealed, encryptToken: (plain: string) => plain }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), refreshTokens: vi.fn(), scalableMcp: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const MINUTE = 60_000;
/** One connection row with the trigger's behaviour: saving tokens moves token_version and ends the claim. */
let row: { client_id: string; tokens_encrypted: string | null; token_version: number; status: string; claimed: boolean };
function connectedWithTokenLasting(ms: number) {
  row = { client_id: "client", status: "active", token_version: 3, claimed: false, tokens_encrypted: JSON.stringify({ accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + ms }) };
  const select = { eq: () => select, single: async () => ({ error: null, data: { ...row } }) };
  const update = (patch: Partial<typeof row> & { refresh_claimed_until?: null }) => {
    const filters: Record<string, unknown> = {};
    const apply = () => {
      if (filters.token_version !== undefined && filters.token_version !== row.token_version) return [];
      if (patch.tokens_encrypted !== undefined && patch.tokens_encrypted !== row.tokens_encrypted) { row.token_version++; row.claimed = false; }
      if (patch.refresh_claimed_until === null) row.claimed = false;
      Object.assign(row, patch);
      return [{ id: "c" }];
    };
    const query = { eq: (column: string, value: unknown) => { filters[column] = value; return query; }, select: async () => ({ error: null, data: apply() }),
      then: (done: (value: { error: null }) => void) => { apply(); done({ error: null }); } };
    return query;
  };
  const rpc = vi.fn(async (_name: string, args: { p_token_version: number }) => {
    if (row.claimed || args.p_token_version !== row.token_version) return { error: null, data: false };
    row.claimed = true;
    return { error: null, data: true };
  });
  vi.mocked(serviceDb).mockReturnValue({ from: () => ({ select: () => select, update }), rpc } as never);
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

it("spends a rotating refresh token once when several requests need it at the same time", async () => {
  connectedWithTokenLasting(0);
  let finish!: (tokens: Awaited<ReturnType<typeof refreshTokens>>) => void;
  vi.mocked(refreshTokens).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const results = [withScalable("c", "w", async () => "a"), withScalable("c", "w", async () => "b")];
  await vi.waitFor(() => expect(refreshTokens).toHaveBeenCalledOnce());
  finish({ accessToken: "new", refreshToken: "next", expiresAt: Date.now() + 60 * MINUTE });
  await expect(Promise.all(results)).resolves.toEqual(["a", "b"]);
  expect(refreshTokens).toHaveBeenCalledOnce();
  expect(vi.mocked(scalableMcp).mock.calls.map(call => call[0])).toEqual(["new", "new"]);
});

it("does not end the login when another request renewed it while this one failed", async () => {
  connectedWithTokenLasting(60 * MINUTE);
  const rejected = new ScalableError("Unauthorized", 401, true);
  const failing = withScalable("c", "w", async () => { row.tokens_encrypted = JSON.stringify({ accessToken: "fresher", refreshToken: "next", expiresAt: Date.now() + 60 * MINUTE }); row.token_version++; throw rejected; });
  await expect(failing).rejects.toMatchObject({ expired: false });
  expect(row).toMatchObject({ status: "active", tokens_encrypted: expect.stringContaining("fresher") });
});

it("ends the login when nothing newer was saved", async () => {
  connectedWithTokenLasting(60 * MINUTE);
  await expect(withScalable("c", "w", async () => { throw new ScalableError("Unauthorized", 401, true); })).rejects.toMatchObject({ expired: true });
  expect(row).toMatchObject({ status: "expired", tokens_encrypted: null });
});

it("releases the claim when the refresh fails for another reason, leaving the login in place", async () => {
  connectedWithTokenLasting(0);
  vi.mocked(refreshTokens).mockRejectedValue(new Error("network"));
  await expect(withScalable("c", "w", async () => "x")).rejects.toThrow("network");
  expect(row).toMatchObject({ status: "active", claimed: false });
  expect(row.tokens_encrypted).toContain("refresh");
});
