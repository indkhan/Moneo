import type { BankTransaction } from "./enable-banking";

// Generic context from one Enable Banking transaction, for any bank: no bank-specific code. Banks differ in what they send
// (ISO 20022 codes, proprietary codes, merchant category codes, remittance conventions), so every field is optional and
// "unknown" never blocks anything. None of this feeds ledger amounts; it only describes the row for the organizer.

export const PAYMENT_TYPES = ["card", "transfer", "direct_debit", "cash", "fee_interest", "top_up", "exchange", "unknown"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export type NormalizedBankTransaction = {
  payment_type: PaymentType;
  bank_code: string | null;
  bank_sub_code: string | null;
  mcc: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  counterparty_bic: string | null;
  /** Additional identifications of the counterparty's account, as the bank sent them. */
  counterparty_ids: Identification[];
  /** The same for the owner's own side (card ids on card payments, for one neobank). */
  own_side_ids: Identification[];
  creditor_id: string | null;
  mandate_ref: string | null;
  instructed_amount: string | null;
  instructed_currency: string | null;
  exchange_rate: string | null;
  own_account: boolean;
};
type Identification = { identification: string; scheme_name?: string };

// ISO 20022 external bank transaction codes (ExternalBankTransactionDomain1Code / Family1Code / Subfamily1Code,
// https://www.iso20022.org/external_code_list.page). Only the families and sub-families that decide the payment type.
// The most specific level wins: PMNT/CCRD/CWDL is a cash withdrawal although CCRD is a card family.
const ISO_SUBFAMILY: Record<string, PaymentType> = {
  CWDL: "cash", CDPT: "cash", // cash withdrawal / cash deposit
  POSD: "card", POSC: "card", // point-of-sale debit / credit card payment
  STDO: "transfer", ESCT: "transfer", DMCT: "transfer", XBCT: "transfer", BOOK: "transfer", // standing order, SEPA, domestic, cross-border, book transfer
  PMDD: "direct_debit", ESDD: "direct_debit", UPDD: "direct_debit", // direct debit payment, SEPA, unpaid
  INTR: "fee_interest", CHRG: "fee_interest", FEES: "fee_interest", COMM: "fee_interest", // interest, charges, fees, commission
};
const ISO_FAMILY: Record<string, PaymentType> = {
  CCRD: "card", MCRD: "card", // customer card / merchant card transactions
  ICDT: "transfer", RCDT: "transfer", ICCT: "transfer", RCCT: "transfer", // issued / received (cross-border) credit transfers
  IDDT: "direct_debit", RDDT: "direct_debit", // issued / received direct debits
  CNTR: "cash", // counter transactions
  MCOP: "fee_interest", // miscellaneous credit operations
};
const ISO_DOMAIN: Record<string, PaymentType> = { FORX: "exchange" };

// Proprietary codes are matched as whole words of the upper-cased code, in this order (CARD_FEE is a fee, not a card payment).
// Words are tokens split on anything that isn't a letter or digit, so CARD_PAYMENT is CARD + PAYMENT.
const HEURISTICS: [PaymentType, RegExp][] = [
  ["exchange", /(?:^|_)(?:EXCHANGE|FX|FOREX)(?:_|$)/],
  ["top_up", /(?:^|_)(?:TOPUP|TOP_UP)(?:_|$)/],
  ["fee_interest", /(?:^|_)(?:FEE|FEES|CHARGE|CHARGES|INTEREST)(?:_|$)/],
  ["direct_debit", /(?:^|_)(?:DIRECT_DEBIT|DD|LASTSCHRIFT)(?:_|$)/],
  ["cash", /(?:^|_)(?:ATM|CASH|CWDL)(?:_|$)/],
  ["transfer", /(?:^|_)(?:TRANSFER|TRF)(?:_|$)/],
  ["card", /(?:^|_)CARD(?:_|$)/],
];

const words = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Payment type from the bank's transaction code: ISO 20022 tables first, then generic word matching, else "unknown". */
export function paymentType(code: string | null, subCode: string | null, description: string | null = null): PaymentType {
  const iso = [code, subCode].flatMap(value => (value ?? "").toUpperCase().split(/[^A-Z0-9]+/)).filter(token => /^[A-Z]{4}$/.test(token));
  for (const table of [ISO_SUBFAMILY, ISO_FAMILY, ISO_DOMAIN]) {
    for (const token of iso) if (table[token]) return table[token];
  }
  const text = words([code, subCode, description].filter(Boolean).join(" "));
  return HEURISTICS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
}

const SEPA_ID = "[A-Z]{2}\\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}";
// "Gläubiger-ID: DE98ZZZ09999999999", "CI DE98ZZZ...", "Creditor ID DE98ZZZ...", SEPA tag "CRED+DE98ZZZ...".
const CREDITOR_LABELLED = new RegExp(`(?:gl(?:ä|ae|a)ubiger[-\\s]?(?:id|identifikation(?:snummer)?)|creditor[-\\s]?id(?:entifier)?|\\bCI|\\bCRED)\\s*[:=+]?\\s*(${SEPA_ID})(?![A-Z0-9])`, "i");
// Any SEPA creditor identifier is recognisable by its ZZZ business code.
const CREDITOR_BARE = /\b([A-Z]{2}\d{2}ZZZ[A-Z0-9]{1,28})(?![A-Z0-9])/;
// "Mandatsref: M12345", "Mandatsreferenz M12345", "MREF+M12345", "Mandate reference M12345". A reference carries a digit.
const MANDATE = /(?:mandats?[-\s]?(?:ref(?:erenz)?)?|mref|mandate(?:\s+(?:ref(?:erence)?|id))?)\s*[:=+.]?\s*(?=[A-Za-z0-9\-_./?:()]*\d)([A-Za-z0-9\-_./?:()]{3,35})/i;

/** SEPA creditor identifier and mandate reference as banks print them inside the remittance text. */
export function sepaReferences(remittance: string) {
  const text = remittance.replace(/\s+/g, " ");
  const creditor = CREDITOR_LABELLED.exec(text)?.[1] ?? CREDITOR_BARE.exec(text)?.[1] ?? null;
  const mandate = MANDATE.exec(text)?.[1]?.replace(/[.,;:]+$/, "") ?? null;
  return { creditor_id: creditor?.toUpperCase() ?? null, mandate_ref: mandate };
}

// Postgres can't store NUL in text or jsonb.
const clean = (value: unknown, length: number): string | null => {
  if (typeof value !== "string") return null;
  const text = Array.from(value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim()).slice(0, length).join("");
  return text || null;
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const normalizedIban = (value: unknown) => clean(typeof value === "string" ? value.replace(/\s/g, "").toUpperCase() : null, 34);
const decimal = (value: unknown) => (typeof value === "string" || typeof value === "number") && /^-?\d+(?:\.\d+)?$/.test(String(value)) ? String(value) : null;

function identifications(value: unknown): Identification[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap(item => {
    const identification = clean(isRecord(item) ? item.identification : null, 100);
    if (!identification) return [];
    const scheme = clean(isRecord(item) ? item.scheme_name : null, 50);
    return [scheme ? { identification, scheme_name: scheme } : { identification }];
  });
}

/** Normalizes one bank transaction. `ownIbans` are the workspace's own account IBANs (spaces removed, upper case). */
export function normalizeBankTransaction(tx: BankTransaction, ownIbans: ReadonlySet<string> = new Set()): NormalizedBankTransaction {
  const record = tx as Record<string, unknown>;
  const debit = tx.credit_debit_indicator === "DBIT";
  // Same side as the statement's counterparty column: the creditor when money leaves, the debtor when it arrives.
  const [side, own] = debit ? (["creditor", "debtor"] as const) : (["debtor", "creditor"] as const);
  const party = record[side], account = record[`${side}_account`], agent = record[`${side}_agent`];
  const code = isRecord(record.bank_transaction_code) ? record.bank_transaction_code : {};
  const bankCode = clean(code.code, 200), subCode = clean(code.sub_code, 200);
  const rate = isRecord(record.exchange_rate) ? record.exchange_rate : {};
  const instructed = isRecord(rate.instructed_amount) ? rate.instructed_amount : isRecord(record.instructed_amount) ? record.instructed_amount : {};
  const instructedAmount = decimal(instructed.amount), instructedCurrency = clean(instructed.currency, 3);
  const hasInstructed = !!instructedAmount && !!instructedCurrency && /^[A-Z]{3}$/.test(instructedCurrency);
  const remittance = (tx.remittance_information ?? []).join(" ");
  const counterpartyIban = normalizedIban(isRecord(account) ? account.iban : null);
  return {
    payment_type: paymentType(bankCode, subCode, clean(code.description, 200)),
    bank_code: bankCode, bank_sub_code: subCode,
    mcc: clean(record.merchant_category_code, 10),
    counterparty_name: clean(isRecord(party) ? party.name : null, 500),
    counterparty_iban: counterpartyIban,
    counterparty_bic: clean(isRecord(agent) ? agent.bic_fi ?? agent.bic : null, 11),
    counterparty_ids: identifications(record[`${side}_account_additional_identification`]),
    own_side_ids: identifications(record[`${own}_account_additional_identification`]),
    ...sepaReferences(remittance),
    instructed_amount: hasInstructed ? instructedAmount : null, instructed_currency: hasInstructed ? instructedCurrency : null,
    exchange_rate: decimal(rate.exchange_rate),
    own_account: !!counterpartyIban && ownIbans.has(counterpartyIban),
  };
}

// jsonb rows are bounded: a bank that sends something huge keeps the fields that matter and says it was cut.
const RAW_BYTES = 16_000;
const KEEP = ["entry_reference", "transaction_id", "transaction_amount", "credit_debit_indicator", "status", "booking_date", "value_date", "transaction_date",
  "creditor", "debtor", "creditor_account", "debtor_account", "creditor_agent", "debtor_agent", "bank_transaction_code", "merchant_category_code", "exchange_rate"];

/** The transaction as received, JSON-safe and bounded. */
export function boundedRaw(tx: BankTransaction): Record<string, unknown> {
  const strip = (_key: string, value: unknown) => typeof value === "string" ? value.replace(/\u0000/g, "") : value;
  const json = JSON.stringify(tx, strip);
  if (Buffer.byteLength(json) <= RAW_BYTES) return JSON.parse(json);
  const reduced = JSON.stringify({ truncated: true, ...Object.fromEntries(KEEP.filter(key => key in tx).map(key => [key, (tx as Record<string, unknown>)[key]])),
    remittance_information: (tx.remittance_information ?? []).slice(0, 4).map(line => line.slice(0, 200)) }, strip);
  return Buffer.byteLength(reduced) <= RAW_BYTES ? JSON.parse(reduced) : { truncated: true };
}

/** The sidecar rows for one statement: rows[i] is the transaction behind CSV row number i + 2. */
export function bankRawRows(workspaceId: string, importId: string, transactions: BankTransaction[], ownIbans: ReadonlySet<string>) {
  return transactions.map((tx, index) => ({
    import_id: importId, row_number: index + 2, workspace_id: workspaceId,
    bank_id: clean(tx.entry_reference ?? tx.transaction_id, 500),
    raw: boundedRaw(tx), ...normalizeBankTransaction(tx, ownIbans),
  }));
}
