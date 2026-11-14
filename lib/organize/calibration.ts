// The calibration kill switch: AI labels are checked against what the owner did with them. When too many of the
// recent ones were wrong, medium-confidence labels stop being applied by themselves and wait for the owner instead.

/** An AI label stands when the owner kept it this long without changing it. */
export const CONFIRM_AFTER_DAYS = 14;
const WINDOW = 200, MIN_JUDGED = 50, MIN_ACCURACY = 0.9;

export type AiLabel = { id: string; createdAt: string; undoneAt: string | null; categoryId: string | null; merchantId: string | null };
export type LabelledRow = { categoryId: string | null; merchantId: string | null; organizedBy: string | null; organizeOpId: string | null };

/** Whether the owner proved an AI label right (true) or wrong (false); null while nobody has said. */
export function judgeLabel(label: AiLabel, row: LabelledRow | null, now: Date): boolean | null {
  if (label.undoneAt) return false;
  if (!row) return null;
  if (row.organizeOpId === label.id) return now.getTime() - Date.parse(label.createdAt) >= CONFIRM_AFTER_DAYS * 86_400_000 ? true : null;
  if (row.organizedBy !== "owner" && row.organizedBy !== "memory") return null;
  return (!label.categoryId || row.categoryId === label.categoryId) && (!label.merchantId || row.merchantId === label.merchantId);
}

export type Calibration = { mediumAllowed: boolean; accuracy: number | null; judged: number; reason: string | null };

/** `judged` is newest first. Too few judged labels say nothing yet, so medium labels stay on. */
export function calibration(judged: boolean[]): Calibration {
  const window = judged.slice(0, WINDOW);
  if (window.length < MIN_JUDGED) return { mediumAllowed: true, accuracy: null, judged: window.length, reason: null };
  const accuracy = window.filter(Boolean).length / window.length;
  const mediumAllowed = accuracy >= MIN_ACCURACY;
  return { mediumAllowed, accuracy, judged: window.length,
    reason: mediumAllowed ? null : `Only ${Math.floor(accuracy * 100)}% of the last ${window.length} AI labels you checked were right, so medium-confidence labels now wait for you; only high-confidence ones are applied` };
}
