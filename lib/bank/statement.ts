import Papa from "papaparse";
import { parseCsv, validateImportConfirmation, type ImportMapping } from "@/lib/import/csv";
import { calendarDate, calendarDayBoundary } from "@/lib/finance/calendar";
import { compactIban } from "@/lib/iban";
import { BOOKED_BALANCE_TYPES } from "@/lib/finance/net-worth-checks";
import { wealthAmount } from "@/lib/finance/wealth";
import type { BankBalance, BankTransaction } from "./enable-banking";

const headers = ["id", "date", "description", "amount", "currency", "balance", "counterparty", "counterparty_iban"] as const;

const clip = (value: string, length: number) => Array.from(value.replace(/\s+/g, " ").trim()).slice(0, length).join("");

export function bankStatementRow(tx: BankTransaction) {
  const debit = tx.credit_debit_indicator === "DBIT";
  const magnitude = tx.transaction_amount.amount.replace(/^-/, "");
  const amount = tx.credit_debit_indicator ? `${debit ? "-" : ""}${magnitude}` : tx.transaction_amount.amount;
  const counterparty = clip((debit ? tx.creditor?.name : tx.debtor?.name) ?? "", 200);
  const description = clip((tx.remittance_information ?? []).join(" "), 500) || counterparty || "Bank transaction";
  const balance = tx.balance_after_transaction?.currency === tx.transaction_amount.currency ? tx.balance_after_transaction.amount : "";
  return {
    id: clip(tx.entry_reference ?? tx.transaction_id ?? "", 500),
    date: tx.booking_date ?? tx.value_date ?? tx.transaction_date ?? "",
    description, amount, currency: tx.transaction_amount.currency, balance, counterparty,
    counterparty_iban: compactIban((debit ? tx.creditor_account?.iban : tx.debtor_account?.iban) ?? ""),
  } satisfies Record<(typeof headers)[number], string>;
}

export function bankStatement(transactions: BankTransaction[], account: { accountName: string; currencyCode: string; calendarTimezone?: string }) {
  type Entry = { row: ReturnType<typeof bankStatementRow>; tx: BankTransaction };
  const byId = new Map<string, Entry>();
  const unidentified: Entry[] = [];
  for (const tx of transactions) {
    if (tx.status !== "BOOK") continue;
    const row = bankStatementRow(tx);
    if (!row.date) throw new Error("Booked bank transaction has no date");
    if (row.id) byId.set(row.id, { row, tx }); else unidentified.push({ row, tx });
  }
  const entries = [...byId.values(), ...unidentified].sort((a, b) => a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id)
    || a.row.amount.localeCompare(b.row.amount) || a.row.description.localeCompare(b.row.description));
  const rows = entries.map(entry => entry.row);
  const last = rows.at(-1);
  if (!last) return null;
  const csv = Papa.unparse({ fields: [...headers], data: rows.map(row => headers.map(header => row[header])) }, { newline: "\n" });
  const mapping: ImportMapping = {
    accountName: account.accountName, currencyCode: account.currencyCode,
    dateColumn: "date", descriptionColumn: "description", amountColumn: "amount", currencyColumn: "currency",
    balanceColumn: "balance", merchantColumn: "counterparty", externalIdColumn: "id", completeWindow: true,
    dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot",
    ...(account.calendarTimezone ? { calendarTimezone: account.calendarTimezone } : {}),
  };
  const parsed = parseCsv(csv);
  return { csv, rowCount: parsed.length, sources: entries.map(entry => entry.tx), lastBookedOn: last.date, mapping: validateImportConfirmation(parsed, mapping) };
}

export function preferredBalance(balances: BankBalance[], currencyCode: string) {
  const order = ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV"];
  const usable = balances.filter(balance => balance.balance_amount.currency === currencyCode && order.includes(balance.balance_type));
  return usable.sort((a, b) => order.indexOf(a.balance_type) - order.indexOf(b.balance_type))[0];
}

export function bankObservation(balances: BankBalance[], currencyCode: string, fetchedAt: Date, timeZone: string) {
  const balance = preferredBalance(balances, currencyCode);
  if (!balance) return null;
  const closesEarlierDay = BOOKED_BALANCE_TYPES.has(balance.balance_type) && balance.reference_date && balance.reference_date < calendarDate(fetchedAt, timeZone);
  return { amountMinor: wealthAmount(balance.balance_amount.amount, currencyCode).toString(), balanceType: balance.balance_type,
    asOf: closesEarlierDay ? calendarDayBoundary(balance.reference_date!, timeZone) : fetchedAt.toISOString() };
}
