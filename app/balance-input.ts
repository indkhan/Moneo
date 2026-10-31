import { z } from "zod";

const coveredRows = z.array(z.object({ id: z.uuid(), version: z.number().int().nonnegative(),
  amount_minor: z.string().regex(/^-?\d+$/), currency_code: z.string().regex(/^[A-Z]{3}$/),
  posted_on: z.iso.date(), posted_at: z.iso.datetime({ offset: true }).nullable(),
}).strict()).max(5000);

// The postings a user confirmed today's booked balance includes; null when they didn't confirm.
export function reviewedCoverage(form: FormData, asOf: string, today: string) {
  const reviewed = form.get("reviewedActivity") === "on";
  if (reviewed && asOf !== today) throw new Error("Reviewed activity applies only to today's booked balance");
  return { reviewed, covered: reviewed ? coveredRows.parse(JSON.parse(z.string().max(2_000_000).parse(form.get("coveredTransactions")))) : null };
}
