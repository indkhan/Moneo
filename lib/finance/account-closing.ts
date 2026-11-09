import { z } from "zod";

// Archiving an account that still holds money: the owner says where it went, and that answer becomes ordinary records.
// Moved or taken as cash, the money is a linked own transfer dated today, so net worth doesn't change. Gone, it leaves
// as a normal posting. Nothing here hides money: every path ends with the account at zero through a row you can see.

export const closingAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("moved"), targetAccountId: z.uuid() }),
  z.object({ outcome: z.literal("cash"), targetAccountId: z.uuid().optional() }),
  z.object({ outcome: z.literal("gone") }),
]);
export type ClosingAnswer = z.infer<typeof closingAnswerSchema>;

// A synced target's bank sends its own row, so only the outgoing side is added here. This wording is how the two find each other.
const MOVED_TO = "Closing balance moved to ";
/** The account a closing row says the money went to. */
export const closingMovedTo = (text?: string) => text?.startsWith(MOVED_TO) ? text.slice(MOVED_TO.length) : null;

type Account = { id: string; name: string; type?: string; currency_code: string; archived_at?: string | null };

/** The other accounts the money can go to. */
export const closingTargets = <T extends Account>(account: Account, accounts: T[]) => accounts.filter(other => other.id !== account.id && !other.archived_at && other.currency_code === account.currency_code);

/** The rows an answer needs. `createCash` means there is no Cash account yet and the action makes one. */
export function closingPlan(account: Account, balanceMinor: bigint, answer: ClosingAnswer, accounts: Account[], isBankSynced: (target: Account) => boolean = () => false) {
  if (balanceMinor === 0n) throw new Error("This account has no money to account for");
  const targets = closingTargets(account, accounts);
  if (answer.outcome === "gone") return { out: { amountMinor: -balanceMinor, description: "Closing balance gone" }, into: null, target: null, createCash: false };
  let target: Account | null;
  let createCash = false;
  if (answer.outcome === "moved") {
    target = targets.find(other => other.id === answer.targetAccountId) ?? null;
    if (!target) throw new Error(`Choose another ${account.currency_code} account`);
  } else {
    const cash = targets.filter(other => other.type === "cash");
    target = answer.targetAccountId ? cash.find(other => other.id === answer.targetAccountId) ?? null : cash.length === 1 ? cash[0] : null;
    if (!target && (answer.targetAccountId || cash.length > 1)) throw new Error("Choose a Cash account");
    createCash = !target;
  }
  const name = target?.name ?? "Cash";
  const out = { amountMinor: -balanceMinor, description: `${MOVED_TO}${name}`.slice(0, 500) };
  if (answer.outcome === "moved" && target && isBankSynced(target)) return { out, into: null, target, createCash };
  return { out, into: { amountMinor: balanceMinor, description: `Closing balance from ${account.name}`.slice(0, 500) }, target, createCash };
}
