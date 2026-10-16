import Papa from "papaparse";
import { parseCsv, validateImportConfirmation, type ImportMapping } from "@/lib/csv";
import type { BankBalance, BankTransaction } from "./enable-banking";

// A bank sync is an ordinary import: booked transactions become a canonical CSV with a
// fixed mapping, so dedupe, review, undo and source history work unchanged (issue #82).
const headers = ["id", "date", "description", "amount", "currency", "balance", "counterparty", "counterparty_iban"] as const;

const clip = (value: string, length: number) => Array.from(value.replace(/\s+/g, " ").trim()).slice(0, length).join("");

export function bankStatementRow(tx: BankTransaction) {
  const debit = tx.credit_debit_indicator === "DBIT";
  const magnitude = tx.transaction_amount.amount.replace(/^-/, "");
  // The indicator is the sign of record; without one, keep the amount's own sign.
  const amount = tx.credit_debit_indicator ? `${debit ? "-" : ""}${magnitude}` : tx.transaction_amount.amount;
  const counterparty = clip((debit ? tx.creditor?.name : tx.debtor?.name) ?? "", 200);
  const description = clip((tx.remittance_information ?? []).join(" "), 500) || counterparty || "Bank transaction";
  const balance = tx.balance_after_transaction?.currency === tx.transaction_amount.currency ? tx.balance_after_transaction.amount : "";
  return {
    id: clip(tx.entry_reference ?? tx.transaction_id ?? "", 500),
    date: tx.booking_date ?? tx.value_date ?? tx.transaction_date ?? "",
    description, amount, currency: tx.transaction_amount.currency, balance, counterparty,
    counterparty_iban: ((debit ? tx.creditor_account?.iban : tx.debtor_account?.iban) ?? "").replace(/\s/g, ""),
  } satisfies Record<(typeof headers)[number], string>;
}

// Deterministic bytes: the same bank data always hashes to the same import, so a repeated
// sync of an unchanged window is a no-op at the imports(file_hash) unique index.
export function bankStatement(transactions: BankTransaction[], account: { accountName: string; currencyCode: string; calendarTimezone?: string }) {
  const byId = new Map<string, ReturnType<typeof bankStatementRow>>();
  const unidentified: ReturnType<typeof bankStatementRow>[] = [];
  for (const tx of transactions) {
    if (tx.status !== "BOOK") continue;
    const row = bankStatementRow(tx);
    if (!row.date) throw new Error("Booked bank transaction has no date");
    if (row.id) byId.set(row.id, row); else unidentified.push(row);
  }
  const rows = [...byId.values(), ...unidentified].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    || a.amount.localeCompare(b.amount) || a.description.localeCompare(b.description));
  if (!rows.length) return null;
  const csv = Papa.unparse({ fields: [...headers], data: rows.map(row => headers.map(header => row[header])) }, { newline: "\n" });
  const mapping: ImportMapping = {
    accountName: account.accountName, currencyCode: account.currencyCode,
    dateColumn: "date", descriptionColumn: "description", amountColumn: "amount", currencyColumn: "currency",
    balanceColumn: "balance", merchantColumn: "counterparty", externalIdColumn: "id",
    dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot",
    ...(account.calendarTimezone ? { calendarTimezone: account.calendarTimezone } : {}),
  };
  const parsed = parseCsv(csv);
  return { csv, rowCount: parsed.length, lastBookedOn: rows[rows.length - 1].date, mapping: validateImportConfirmation(parsed, mapping) };
}

// Prefer the booked closing balance, then the most authoritative interim one.
export function preferredBalance(balances: BankBalance[], currencyCode: string) {
  const order = ["CLBD", "ITBD", "XPCD", "ITAV", "CLAV"];
  const usable = balances.filter(balance => balance.balance_amount.currency === currencyCode);
  return usable.sort((a, b) => (order.indexOf(a.balance_type) + 1 || 99) - (order.indexOf(b.balance_type) + 1 || 99))[0];
}
