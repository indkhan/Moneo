import type { Category as DbCategory } from "@moneo/db/schema";
import { describe, expect, it } from "vitest";
import { handleListCategories, toCategoryDto, type CategoryStore } from "./categories";

/**
 * Issue 5.5 — category handler unit-tests without Postgres.
 *
 * Proves the HTTP boundary: 401 without a workspace, contract validation
 * before any store call, archived filtering forwarded, and DTO mapping of
 * kinds and nullables.
 */

const WID = "11111111-1111-7111-8111-111111111111";

function category(overrides: Partial<DbCategory> = {}): DbCategory {
  return {
    id: "44444444-4444-7444-8444-444444444444",
    workspaceId: WID,
    name: "Groceries",
    kind: "expense",
    systemCategoryCode: "groceries",
    version: 1,
    archivedAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

function store(rows: DbCategory[] = []): CategoryStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    list: (workspaceId, options) => {
      calls.push({ workspaceId, options });
      return Promise.resolve(rows);
    },
  };
}

describe("handleListCategories", () => {
  it("answers 401 without a workspace and never touches the store", async () => {
    const categories = store();
    const res = await handleListCategories("", { workspaceId: undefined, categories });
    expect(res.status).toBe(401);
    expect(categories.calls).toHaveLength(0);
  });

  it("lists categories with DTO mapping", async () => {
    const categories = store([category(), category({ id: "55555555-5555-7555-8555-555555555555", name: "Salary", kind: "income", systemCategoryCode: "income-salary" })]);
    const res = await handleListCategories("", { workspaceId: WID, categories });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; name: string; kind: string; systemCategoryCode: string | null }[];
    };
    expect(body.items.map((i) => i.name)).toEqual(["Groceries", "Salary"]);
    expect(body.items[0]).toMatchObject({ kind: "expense", systemCategoryCode: "groceries" });
    expect(categories.calls).toEqual([{ workspaceId: WID, options: {} }]);
  });

  it("forwards includeArchived and maps archived rows", async () => {
    const categories = store([category({ archivedAt: new Date("2026-08-03T00:00:00Z") })]);
    const res = await handleListCategories("?includeArchived=true", {
      workspaceId: WID,
      categories,
    });
    expect(res.status).toBe(200);
    expect(categories.calls).toEqual([{ workspaceId: WID, options: { includeArchived: true } }]);
    const dto = toCategoryDto(category({ archivedAt: new Date("2026-08-03T00:00:00Z") }));
    expect(dto.archivedAt).toBe("2026-08-03T00:00:00.000Z");
    expect(toCategoryDto(category()).archivedAt).toBeNull();
  });
});
