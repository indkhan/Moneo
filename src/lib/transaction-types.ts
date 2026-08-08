export type TransactionReference = {
  type: string;
  value: string;
};

export type RawTransactionSource = {
  fileName: string;
  rowNumber: number;
  rawRecord: Record<string, string>;
};

export type TransactionDraft = {
  bookingDate: string;
  valueDate?: string;
  amountMinor: string;
  currency: string;
  currencyMinorUnit: number;
  title: string;
  description: string;
  sender?: string;
  recipient?: string;
  references: TransactionReference[];
  bankTransactionId?: string;
  bankCategory?: string;
  transactionType?: string;
  status?: "booked" | "pending" | "reverted";
  balanceAfterMinor?: string;
  source: RawTransactionSource;
};

export type MoneoTransaction = TransactionDraft & {
  id: string;
  accountId: string;
  importId: string;
};

export type LocalAccount = {
  id: string;
  institution: string;
  displayName: string;
  identifier?: string;
};

export type ImportRowError = {
  rowNumber: number;
  field: string;
  message: string;
};

