type Page = PromiseLike<{ data: unknown[] | null; error: unknown; count?: number | null }>;
const PARALLEL = 6;

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
