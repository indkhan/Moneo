import { getSession } from "@/lib/auth-session";
import { createDrizzleCategoryStore, handleListCategories } from "@/lib/categories";

/**
 * GET /api/v1/categories — workspace categories in name order for the
 * transaction correction controls (Issue 5.5).
 */
export async function GET(request: Request) {
  const session = await getSession();
  return handleListCategories(new URL(request.url).search, {
    workspaceId: session?.wid,
    categories: createDrizzleCategoryStore(),
  });
}
