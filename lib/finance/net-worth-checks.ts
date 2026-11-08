import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "./calendar";
import { formatMoney } from "./format";
import type { BalanceSnapshot, BalanceTransaction } from "./balances";

// The numbers checking each other. Worked out from the records whenever they are read, so one piece of evidence is
// one entry for as long as it's unresolved, and it goes away by itself once a correction fixes the records. Nothing here
// changes a number. Deliberately not findings: negative balances, differences from Scalable's returns, slow transfers.

export type Discrepancy = { key: string; kind: "bank_balance" | "broker_parts" | "history_boundary" | "import" | "repayment"; title: string; detail: string; href: string; repaymentId?: string };

export const BOOKED_BALANCE_TYPES = new Set(["CLBD", "ITBD"]);
const BROKER_TOLERANCE_MINOR = 100n; // Rounding across positions can't reach a euro.
const abs = (value: bigint) => value < 0n ? -value : value;

/** Booked closing balances of one type must differ by exactly the accepted postings between them. */
export function bankBalanceFindings(accounts: { id: string; name: string; currency_code: string }[], snapshots: BalanceSnapshot[], ledger: BalanceTransaction[], timeZone: string, locale?: string): Discrepancy[] {
  const findings: Discrepancy[] = [];
  for (const account of accounts) {
    const closing = new Map<string, BalanceSnapshot>();
    for (const row of snapshots) {
      if (row.account_id !== account.id || row.undone_at || !row.balance_type || !BOOKED_BALANCE_TYPES.has(row.balance_type) || (row.boundary_kind ?? "date_only") !== "date_only") continue;
      // Only a balance at a clear point in the day compares: during a day, a date-only posting may fall on either side.
      if (calendarDate(new Date(Date.parse(row.as_of) - 1).toISOString(), timeZone) === calendarDate(row.as_of, timeZone)) continue;
      const key = `${row.balance_type}:${calendarDate(row.as_of, timeZone)}`, prior = closing.get(key);
      if (!prior || (row.created_at ?? "") > (prior.created_at ?? "")) closing.set(key, row);
    }
    const byType = new Map<string, BalanceSnapshot[]>();
    for (const row of closing.values()) byType.set(row.balance_type!, [...(byType.get(row.balance_type!) ?? []), row]);
    for (const rows of byType.values()) {
      rows.sort((a, b) => Date.parse(a.as_of) - Date.parse(b.as_of));
      for (let index = 1; index < rows.length; index++) {
        const before = rows[index - 1], after = rows[index];
        const from = calendarDate(before.as_of, timeZone), to = calendarDate(after.as_of, timeZone);
        const moved = ledger.reduce((sum, row) => {
          if (row.account_id !== account.id || row.status !== "posted" || row.currency_code !== after.currency_code) return sum;
          const day = row.posted_at ? calendarDate(row.posted_at, timeZone) : row.posted_on;
          return day > from && day <= to ? sum + BigInt(row.amount_minor) : sum;
        }, 0n);
        const expected = BigInt(before.amount_minor) + moved, stated = BigInt(after.amount_minor);
        if (expected === stated) continue;
        const money = (amount: bigint) => formatMoney(amount, after.currency_code, locale);
        findings.push({ key: `bank:${account.id}:${from}:${to}`, kind: "bank_balance", href: "/money/accounts",
          title: `${account.name} doesn't add up between ${from} and ${to}`,
          detail: `The bank said ${money(BigInt(before.amount_minor))} and then ${money(stated)}, but the postings between them make ${money(expected)}, ${money(abs(stated - expected))} ${stated > expected ? "less" : "more"} than it stated. A row still waiting in review, or one the bank never sent, can explain this.` });
      }
    }
  }
  return findings;
}

/** A broker's parts must add up to its own total. */
export function brokerFindings(portfolio: { currency: string; totalMinor: string; differenceMinor?: string; unsupported?: string[] } | null, locale?: string): Discrepancy[] {
  if (!portfolio) return [];
  const findings: Discrepancy[] = [];
  const difference = BigInt(portfolio.differenceMinor ?? "0");
  if (abs(difference) > BROKER_TOLERANCE_MINOR) findings.push({ key: "broker:parts", kind: "broker_parts", href: "/money/wealth#scalable-heading",
    title: "Scalable's parts don't add up to its total",
    detail: `Holdings, crypto and cash come to ${formatMoney(abs(difference), portfolio.currency, locale)} ${difference > 0n ? "less" : "more"} than Scalable's total of ${formatMoney(portfolio.totalMinor, portfolio.currency, locale)}. Net worth counts the parts.` });
  for (const item of portfolio.unsupported ?? []) findings.push({ key: `broker:unsupported:${item}`, kind: "broker_parts", href: "/money/wealth#scalable-heading", title: "Scalable reports something Moneo can't count", detail: item });
  return findings;
}

/** The last calculated day must roughly meet the first real value. A day's market move is allowed; a wrong replay isn't. */
export function historyBoundaryFindings(lastCalculated: { on_date: string; currency_code: string; total_minor: string } | null, firstReal: { date: string; minor: bigint } | null, movedOnBoundaryMinor = 0n, locale?: string): Discrepancy[] {
  if (!lastCalculated || !firstReal) return [];
  const expected = BigInt(lastCalculated.total_minor) + movedOnBoundaryMinor, gap = abs(firstReal.minor - expected);
  const allowed = abs(firstReal.minor) / 10n > 2000n ? abs(firstReal.minor) / 10n : 2000n; // 10%, or €20 on a small portfolio.
  if (gap <= allowed) return [];
  return [{ key: `history:${lastCalculated.on_date}`, kind: "history_boundary", href: "/money/wealth#scalable-heading", title: "Calculated Scalable history doesn't meet the first real value",
    detail: `The last calculated day, ${lastCalculated.on_date}, comes to ${formatMoney(expected, lastCalculated.currency_code, locale)}, and the first real value, ${firstReal.date}, is ${formatMoney(firstReal.minor, lastCalculated.currency_code, locale)}.` }];
}

/** A failed import stays listed until a later import of that account lands. */
export function importFindings(imports: { id: string; filename: string; status: string; created_at: string; mapping?: { accountName?: string | null } | null }[]): Discrepancy[] {
  return imports.filter(row => row.status === "failed" && !imports.some(other => other.status === "completed" && other.created_at > row.created_at && other.mapping?.accountName && other.mapping.accountName === row.mapping?.accountName))
    .map(row => ({ key: `import:${row.id}`, kind: "import", href: "/import", title: `${row.filename} didn't finish importing`, detail: "Its rows aren't in your numbers. The next sync retries a bank import; a file can be imported again." }));
}

export type RepaymentLink = { id: string; transaction_id: string | null; applied_minor: string; currency_code: string; transaction_amount_minor: string; transaction_posted_on: string; undone_at?: string | null };

/** A repayment stands on a bank payment in a known state. If the payment changed or went, the owner decides again. */
export function repaymentFindings(links: RepaymentLink[], ledger: BalanceTransaction[], locale?: string): Discrepancy[] {
  const rows = new Map(ledger.map(row => [row.id, row]));
  return links.flatMap(link => {
    if (link.undone_at) return [];
    const row = link.transaction_id ? rows.get(link.transaction_id) : undefined;
    if (row && row.status === "posted" && row.currency_code === link.currency_code && BigInt(row.canonical_amount_minor ?? row.amount_minor) === BigInt(link.transaction_amount_minor) && row.posted_on === link.transaction_posted_on) return [];
    return [{ key: `repayment:${link.id}`, kind: "repayment" as const, href: "/money/wealth#wealth-history", repaymentId: row?.status === "posted" ? link.id : undefined,
      title: "The bank changed a payment you counted as a loan repayment",
      detail: `It repaid ${formatMoney(link.applied_minor, link.currency_code, locale)}. ${row?.status === "posted" ? "If it still stands, keep it; otherwise undo it in the Wealth history." : "That payment is gone, so undo the repayment in the Wealth history."}` }];
  });
}

export async function loadRepaymentLinks(db: SupabaseClient, workspaceId: string): Promise<RepaymentLink[]> {
  const { data, error } = await db.from("iou_repayments").select("id, transaction_id, applied_minor::text, currency_code, transaction_amount_minor::text, transaction_posted_on, undone_at").eq("workspace_id", workspaceId).is("undone_at", null).limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RepaymentLink[];
}

export type FindingsInput = {
  accounts: { id: string; name: string; currency_code: string }[]; snapshots: BalanceSnapshot[]; ledger: BalanceTransaction[]; timeZone: string; locale?: string;
  portfolio: Parameters<typeof brokerFindings>[0];
  lastCalculated: Parameters<typeof historyBoundaryFindings>[0]; firstReal: Parameters<typeof historyBoundaryFindings>[1]; movedOnBoundaryMinor?: bigint;
  imports: Parameters<typeof importFindings>[0]; repayments?: RepaymentLink[];
};

/** Every check, in the order the owner reads them. */
export const netWorthFindings = (input: FindingsInput): Discrepancy[] => [
  ...bankBalanceFindings(input.accounts, input.snapshots, input.ledger, input.timeZone, input.locale),
  ...brokerFindings(input.portfolio, input.locale),
  ...historyBoundaryFindings(input.lastCalculated, input.firstReal, input.movedOnBoundaryMinor, input.locale),
  ...importFindings(input.imports),
  ...repaymentFindings(input.repayments ?? [], input.ledger, input.locale),
];

/** Imports that didn't land, for the checks above. */
export async function loadImportStates(db: SupabaseClient, workspaceId: string) {
  const { data, error } = await db.from("imports").select("id, filename, status, created_at, mapping").eq("workspace_id", workspaceId).in("status", ["failed", "completed"]).order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The sentence for Home's passing message: it changes only when the findings do, so it shows once per change. */
export function checksNotice(findings: { title: string }[]) {
  if (!findings.length) return null;
  return findings.length === 1 ? findings[0].title : `${findings.length} things in your numbers don't add up.`;
}
