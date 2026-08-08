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
  transferPurpose?: string;
  references: TransactionReference[];
  bankTransactionId?: string;
  bankCategory?: string;
  transactionType?: string;
  status?: "booked" | "pending" | "reverted";
  balanceAfterMinor?: string;
  source: RawTransactionSource;
};

export type TransactionCategoryAssignment = {
  categoryId: string;
  method: "built-in" | "user-rule" | "manual";
  classifierVersion: "moneo-category-v1";
  evidence: string[];
};

export type CategoryRule = {
  id: string;
  counterpartyKey: string;
  categoryId: string;
  createdAt: string;
};

export type MoneoTransaction = TransactionDraft & {
  id: string;
  accountId: string;
  importId: string;
  category?: TransactionCategoryAssignment;
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
  rawRecord?: Record<string, string>;
};

export type ColumnMapping = {
  bankName: string;
  accountName: string;
  accountIdentifier?: string;
  dateFormat: "DD.MM.YYYY" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
  numberFormat: "de-DE" | "en-US";
  constantCurrency?: string;
  columns: {
    bookingDate: string;
    title: string;
    amount?: string;
    debit?: string;
    credit?: string;
    currency?: string;
    valueDate?: string;
    description?: string;
    sender?: string;
    recipient?: string;
    reference?: string;
    transactionId?: string;
    transactionType?: string;
    status?: string;
    balance?: string;
    bankCategory?: string;
    accountIdentifier?: string;
    purpose?: string;
  };
};

export type SourceFileRecord = {
  id: string;
  name: string;
  type: string;
  blob: Blob;
};

export type ImportRecord = {
  id: string;
  accountId: string;
  sourceFileId: string;
  fileName: string;
  fileHash: string;
  adapterId: string;
  importedAt: string;
  importedCount: number;
  duplicateCount: number;
  duplicateTransactionIds?: string[];
  skippedRowNumbers: number[];
};

export type SavedColumnMapping = ColumnMapping & {
  signature: string;
};

export type FinanceData = {
  accounts: LocalAccount[];
  imports: ImportRecord[];
  transactions: MoneoTransaction[];
  mappings: SavedColumnMapping[];
  categoryRules: CategoryRule[];
};
