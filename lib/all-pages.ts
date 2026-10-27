type Page = PromiseLike<{ data: unknown[] | null; error: unknown; count?: number | null }>;
const PARALLEL = 6;

/**
 * Reads every row of a stably ordered query, `size` rows per request. The first page's
 * exact count lets the remaining pages load several at a time instead of one round trip
 * at a time; reading continues while pages come back full, so rows added meanwhile are not dropped.
 * `page` must build a fresh query each call (PostgREST builders are mutable).
 */
export async function allPages<T>(page: (from: number, to: number, count?: "exact") => Page, size = 500): Promise<T[]> {
  const read = async (index: number, count?: "exact") => {
    const result = await page(index * size, index * size + size - 1, count);
    if (result.error) throw result.error;
    return { rows: (result.data ?? []) as T[], count: result.count };
  };
  const first = await read(0, "exact");
  const counted = Math.ceil((first.count ?? 0) / size);
  const pages = [first.rows];
  for (let next = 1; next < counted; next += PARALLEL) {
    const batch = await Promise.all(Array.from({ length: Math.min(PARALLEL, counted - next) }, (_, index) => read(next + index)));
    pages.push(...batch.map(result => result.rows));
  }
  while (pages.at(-1)!.length === size) pages.push((await read(pages.length)).rows);
  return pages.flat();
}
