import {z} from "zod";

// Shared with the client-side review request; keep server readers out of this schema module.
export const forecastInput = z.object({
  horizonDays: z.number().int().min(1).max(365).default(30), scenarioId: z.uuid().optional(),
  accountId: z.string().min(1).max(100).optional(),
  funding: z.array(z.object({ date: z.iso.date(), currencyCode: z.string().regex(/^[A-Z]{3}$/),
    fromAccountId: z.string().min(1).max(100), toAccountId: z.string().min(1).max(100),
    amountMinor: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n),
  })).max(100).optional(),
});
