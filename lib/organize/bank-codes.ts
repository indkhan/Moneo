import type { RawContext } from "@/lib/bank/raw-context";

// What the bank already says about a payment, as one of Moneo's default categories: the card network's merchant
// category code (ISO 18245) or a fee posting. Only codes that name one kind of spending are listed. A workspace
// without a category of that name gets nothing from here, and the AI decides instead.
const MCC: [from: number, to: number, category: string][] = [
  [3000, 3299, "Travel"], [3501, 3999, "Travel"], [4511, 4511, "Travel"], [4722, 4722, "Travel"], [7011, 7011, "Travel"], // airlines, hotels, travel agencies
  [4011, 4011, "Transport"], [4111, 4112, "Transport"], [4121, 4121, "Transport"], [4131, 4131, "Transport"], [4784, 4784, "Transport"],
  [5541, 5542, "Transport"], [7523, 7523, "Transport"], // rail, commuter, taxis, buses, tolls, fuel, parking
  [4814, 4814, "Utilities"], [4900, 4900, "Utilities"], // telecom, electricity/gas/water
  [4899, 4899, "Subscriptions"], // cable and streaming
  [5411, 5411, "Groceries"], [5422, 5422, "Groceries"], [5451, 5451, "Groceries"], [5462, 5462, "Groceries"], [5499, 5499, "Groceries"],
  [5811, 5814, "Dining"], // caterers, restaurants, bars, fast food
  [5912, 5912, "Health"], [8011, 8099, "Health"], // pharmacies, doctors, dentists, hospitals
  [7832, 7832, "Entertainment"], [7922, 7922, "Entertainment"], [7991, 7991, "Entertainment"], [7996, 7996, "Entertainment"],
  [5651, 5651, "Shopping"], [5691, 5691, "Shopping"], [5732, 5732, "Shopping"], [5942, 5942, "Shopping"], [5945, 5945, "Shopping"], // clothing, electronics, books, toys
];

export type BankCategory = { name: string; reason: string };

export function bankCategory(raw: Pick<RawContext, "mcc" | "payment_type"> | null | undefined, amountMinor: bigint): BankCategory | null {
  const code = raw?.mcc && /^\d{4}$/.test(raw.mcc.trim()) ? Number(raw.mcc.trim()) : null;
  const match = code === null ? undefined : MCC.find(([from, to]) => code >= from && code <= to);
  if (match) return { name: match[2], reason: `Bank: merchant category code ${raw!.mcc!.trim()}` };
  if (raw?.payment_type === "fee_interest" && amountMinor < 0n) return { name: "Fees", reason: "Bank: fee or interest charge" };
  return null;
}
