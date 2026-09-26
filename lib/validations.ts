import { z } from "zod";

// CSV/Excel import rows + manual entries. Source rows are preserved (stack.md).
export const transactionInput = z.object({
  date: z.coerce.date(),
  description: z.string().min(1).max(500),
  amount: z.number().finite(),
  category: z.string().max(100).optional(),
  accountId: z.string().uuid().optional(),
});

export const accountInput = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["checking", "savings", "investment", "debt", "cash", "other"]).default("checking"),
  balance: z.number().finite().default(0),
  currency: z.string().length(3).default("USD"),
});

export type TransactionInput = z.infer<typeof transactionInput>;
export type AccountInput = z.infer<typeof accountInput>;
