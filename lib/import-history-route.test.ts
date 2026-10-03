import { expect, it, vi } from "vitest";
import { GET } from "@/app/api/imports/route";
import { requireWorkspace } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

it("excludes undone imports before applying the history limit", async () => {
  let rows = [{ id: "removed", status: "undone" }, { id: "kept", status: "completed" }];
  const query = {
    select: () => query, eq: () => query, order: () => query,
    neq: (column: string, value: string) => {
      expect(column).toBe("status");
      rows = rows.filter(row => row.status !== value);
      return query;
    },
    limit: async (count: number) => ({ data: rows.slice(0, count), error: null }),
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "workspace" },
    supabase: { from: () => query } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  expect(await (await GET()).json()).toEqual([{ id: "kept", status: "completed" }]);
});
