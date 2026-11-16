export type ReplayItem = { role: string; request_id?: string | null; answer_of?: string | null };

export function replayableHistory<T extends ReplayItem>(newestFirst: T[], regenerates?: string): T[] {
  const root = regenerates ? newestFirst.findIndex(item => item.request_id === regenerates) : -1;
  const kept = new Set<string>();
  return (root < 0 ? newestFirst : newestFirst.slice(root + 1)).filter(item => {
    if (regenerates && item.answer_of === regenerates) return false;
    if (item.role !== "assistant" || !item.answer_of) return true;
    if (kept.has(item.answer_of)) return false;
    kept.add(item.answer_of);
    return true;
  });
}
