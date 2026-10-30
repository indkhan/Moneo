import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const fetchMock = vi.fn();
let GET: typeof import("./route").GET;
const request = (query: string) => new Request(`http://localhost/api/voice/sample${query}`);

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  ({ GET } = await import("./route"));
  process.env.OPENAI_API_KEY = "test";
  vi.mocked(requireWorkspace).mockResolvedValue({} as Awaited<ReturnType<typeof requireWorkspace>>);
  fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", fetchMock);
});

it("requires a signed-in workspace", async () => {
  vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error("no"));
  expect((await GET(request("?voice=marin"))).status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(["", "?voice=nope", "?voice=juniper", "?voice=marin&extra=1"])("rejects %j", async query => {
  expect((await GET(request(query))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("returns a clip in the requested voice and makes each voice once", async () => {
  const first = await GET(request("?voice=cedar"));
  expect(first.headers.get("Content-Type")).toBe("audio/mpeg");
  expect(first.headers.get("Cache-Control")).toContain("private");
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  await GET(request("?voice=cedar"));
  await GET(request("?voice=marin"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "cedar" });
  expect(body.input).toContain("Moneo");
});
it("does not cache a failed clip", async () => {
  fetchMock.mockResolvedValueOnce(new Response("no", { status: 500 }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await GET(request("?voice=ash"))).status).toBe(502);
  expect((await GET(request("?voice=ash"))).status).toBe(200);
});
