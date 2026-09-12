import { listCategories } from "@moneo/db/category-queries";
import type { Category as DbCategory } from "@moneo/db/schema";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import type { Category as CategoryDto } from "../generated/client";
import { categoryListQuerySchema, parseOrProblem } from "./contract";

/**
 * Issue 5.5 — workspace category HTTP surface.
 *
 * Thin adapter over the shared query service: the ONLY SQL runs inside
 * `withWorkspaceTransaction`. Storage is injected so the handler unit-tests
 * without Postgres; the route default is the Drizzle implementation below.
 */

export interface CategoryStore {
  list(workspaceId: string, options: { includeArchived?: boolean }): Promise<DbCategory[]>;
}

export function createDrizzleCategoryStore(): CategoryStore {
  return {
    list: (workspaceId, options) =>
      withWorkspaceTransaction(workspaceId, (tx) => listCategories(tx, workspaceId, options)),
  };
}

export function toCategoryDto(category: DbCategory): CategoryDto {
  return {
    id: category.id,
    name: category.name,
    kind: category.kind as CategoryDto["kind"],
    systemCategoryCode: category.systemCategoryCode,
    archivedAt: category.archivedAt?.toISOString() ?? null,
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function splitQuery(value: string | null): Record<string, string> {
  const params = new URLSearchParams(value ?? "");
  return Object.fromEntries(params.entries());
}

/** GET /api/v1/categories — workspace categories in name order. */
export async function handleListCategories(
  query: string | null,
  ctx: { workspaceId: string | undefined; categories: CategoryStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(categoryListQuerySchema, splitQuery(query), "/categories");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const rows = await ctx.categories.list(ctx.workspaceId, {
    ...(parsed.data.includeArchived !== undefined
      ? { includeArchived: parsed.data.includeArchived }
      : {}),
  });
  return NextResponse.json({ items: rows.map(toCategoryDto) });
}
