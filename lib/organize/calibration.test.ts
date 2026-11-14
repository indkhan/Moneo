import { expect, it } from "vitest";
import { calibration, judgeLabel, type AiLabel } from "./calibration";

const now = new Date("2026-11-14T12:00:00Z");
const label = (days: number, extra: Partial<AiLabel> = {}): AiLabel => ({ id: "op", createdAt: new Date(now.getTime() - days * 86_400_000).toISOString(), undoneAt: null, categoryId: "food", merchantId: null, ...extra });

it("judges an AI label by what the owner did with it", () => {
  const untouched = { categoryId: "food", merchantId: null, organizedBy: "ai", organizeOpId: "op" };
  expect(judgeLabel(label(20), untouched, now)).toBe(true);
  expect(judgeLabel(label(3), untouched, now)).toBe(null);
  expect(judgeLabel(label(3, { undoneAt: now.toISOString() }), null, now)).toBe(false);
  expect(judgeLabel(label(3), { ...untouched, organizedBy: "owner", organizeOpId: null, categoryId: "fun" }, now)).toBe(false);
  expect(judgeLabel(label(3), { ...untouched, organizedBy: "memory", organizeOpId: null }, now)).toBe(true);
  expect(judgeLabel(label(3), { ...untouched, organizedBy: "ai", organizeOpId: "later op" }, now)).toBe(null);
});

it("stops auto-applying medium labels when fewer than 90% of the last 200 judged were right", () => {
  const verdicts = (right: number, wrong: number) => [...Array(right).fill(true), ...Array(wrong).fill(false)];
  expect(calibration(verdicts(20, 20))).toMatchObject({ mediumAllowed: true, accuracy: null });
  expect(calibration(verdicts(180, 20))).toMatchObject({ mediumAllowed: true, accuracy: 0.9 });
  const tripped = calibration(verdicts(179, 21));
  expect(tripped).toMatchObject({ mediumAllowed: false, judged: 200 });
  expect(tripped.reason).toBeTruthy();
  // Only the newest 200 count: old mistakes age out.
  expect(calibration([...verdicts(200, 0), ...verdicts(0, 100)]).mediumAllowed).toBe(true);
});
