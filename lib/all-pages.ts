type Page = PromiseLike<{ data: unknown[] | null; error: unknown; count?: number | null }>;
const PARALLEL = 6;

/**
 * Reads every row of a stably ordered query, `size` rows per request. The first page's
 * exact count lets the remaining pages load several at a time instead of one round trip
 * at a time; reading continues while pages come back full, so rows added meanwhile are not dropped.
 * The default matches Supabase's 1000-row response limit; a server that caps pages lower is
 * detected from the first page (short of both the request and the count) and paged at its limit.
 * `page` must build a fresh query each call (PostgREST builders are mutable).
 */
export async function allPages<T>(page: (from: number, to: number, count?: "exact") => Page, requested = 1000): Promise<T[]> {
  let size = requested;
  const read = async (index: number, count?: "exact") => {
    const result = await page(index * size, index * size + size - 1, count);
    if (result.error) throw result.error;
    return { rows: (result.data ?? []) as T[], count: result.count };
  };
  const first = await read(0, "exact");
  const total = first.count ?? 0;
  if (first.rows.length && first.rows.length < size && total > first.rows.length) size = first.rows.length;
  const counted = Math.ceil(total / size);
  const pages = [first.rows];
  for (let next = 1; next < counted; next += PARALLEL) {
    const batch = await Promise.all(Array.from({ length: Math.min(PARALLEL, counted - next) }, (_, index) => read(next + index)));
    pages.push(...batch.map(result => result.rows));
  }
  while (pages.at(-1)!.length === size) pages.push((await read(pages.length)).rows);
  return pages.flat();
}
