import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const download = vi.fn();
const get = (path: string) => GET(new Request(`http://localhost:3000/api/chat/attachments?${new URLSearchParams({ path })}`));
const path = "7c9e6679-7425-40de-944b-e07fc1f90ae7/0f8fad5b-d9cb-469f-a165-70867728950e.pdf";

beforeEach(() => {
  download.mockReset();
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }, supabase: { storage: { from: () => ({ download }) } } } as never);
});

it("serves the file itself, because the storage address only exists on the computer running Moneo", async () => {
  download.mockResolvedValue({ data: new Blob(["%PDF"]), error: null });
  const response = await get(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("%PDF");
  expect(download).toHaveBeenCalledWith(path);
});

it("does not open another workspace's file or a missing one", async () => {
  expect((await get("550e8400-e29b-41d4-a716-446655440000/0f8fad5b-d9cb-469f-a165-70867728950e.pdf")).status).toBe(404);
  expect(download).not.toHaveBeenCalled();
  download.mockResolvedValue({ data: null, error: new Error("missing") });
  expect((await get(path)).status).toBe(404);
});
