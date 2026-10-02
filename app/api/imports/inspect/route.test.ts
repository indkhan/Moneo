import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { generateObject } from "ai";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => ({}) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { display_currency: "EUR" } }) }));
afterEach(() => vi.clearAllMocks());

it("cancels provider mapping when the upload request is canceled", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(generateObject).mockImplementationOnce(async options => {
    started();
    await new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(new Error("Mapping canceled")), { once: true }));
    throw new Error("Unreachable");
  });
  const form = new FormData();
  form.set("file", new File(["date,description,amount\n2026-10-01,Coffee,-2.00"], "bank.csv"));
  const response = POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form, signal: controller.signal }));
  await ready;
  controller.abort();
  expect(await (await response).json()).toMatchObject({ mapping: null, aiError: "Mapping canceled" });
});
