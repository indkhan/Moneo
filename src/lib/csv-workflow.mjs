import { normalizeCommerzbankCsv, parseCsv, parseDateWithFormat, requiredCommerzbankHeaders } from './csv-import.mjs';
import { legacyMappingSignature, mappingSignature, normalizeMappedCsv } from './csv-mapping.mjs';
import { sha256Hex } from './transaction-dedup.mjs';

export function decodeCsvBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

export function detectCsvFormat(text, fileName, savedMappings) {
  const parsed = parseCsv(text);
  if (requiredCommerzbankHeaders.every((header) => parsed.headers.includes(header))) {
    return { kind: 'normalized', result: normalizeCommerzbankCsv(text, fileName), mapping: undefined };
  }

  const mapping = savedMappings.find((candidate) => candidate.columns.accountIdentifier && (
    (candidate.signature.startsWith('mapped-v1|')
      ? legacyMappingSignature(text, candidate)
      : mappingSignature(text, candidate)) === candidate.signature
  ));
  if (mapping) {
    return { kind: 'normalized', result: normalizeMappedCsv(text, fileName, mapping), mapping };
  }

  const automatic = automaticMapping(parsed);
  if (automatic) return { kind: 'auto-mapping', headers: parsed.headers, sampleRows: parsed.rows.slice(0, 3).map((row) => row.rawRecord), mapping: automatic };

  return {
    kind: 'mapping-required',
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 3).map((row) => row.rawRecord),
  };
}

function automaticMapping(parsed) {
  const columns = suggestColumnMapping(parsed.headers);
  const required = ['bookingDate', 'title', 'amount', 'currency'];
  if (!required.every((field) => columns[field])) return undefined;
  if (new Set(required.map((field) => columns[field])).size !== required.length) return undefined;
  const dates = parsed.rows.slice(0, 3).map((row) => row.rawRecord[columns.bookingDate]).filter(Boolean);
  const dateFormat = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY'].find((format) => (
    dates.length > 0 && dates.every((value) => {
      try { parseDateWithFormat(value, format); return true; } catch { return false; }
    })
  ));
  const amounts = parsed.rows.slice(0, 3).map((row) => row.rawRecord[columns.amount]).filter(Boolean);
  const numberFormat = amounts.every((value) => /^[-+]?\d+(?:\.\d+)?$/.test(value)) ? 'en-US'
    : amounts.every((value) => /^[-+]?\d+(?:,\d+)?$/.test(value)) ? 'de-DE'
      : undefined;
  return dateFormat && numberFormat ? { columns, dateFormat, numberFormat } : undefined;
}

export async function localAccountId(account) {
  const identity = [account.institution, account.identifier || account.displayName].join('|').toLowerCase();
  const hash = await sha256Hex(new TextEncoder().encode(identity));
  return `account-${hash.slice(0, 16)}`;
}

export function suggestColumnMapping(headers) {
  const aliases = {
    bookingDate: ['booking date', 'buchungstag', 'date', 'datum'],
    valueDate: ['value date', 'valutadatum', 'wertstellung', 'valuta'],
    title: ['title', 'details', 'description', 'verwendungszweck', 'buchungstext', 'text'],
    description: ['booking text', 'buchungstext', 'description'],
    amount: ['amount', 'betrag', 'umsatz'],
    debit: ['debit', 'soll', 'belastung'],
    credit: ['credit', 'haben', 'gutschrift'],
    currency: ['currency', 'währung', 'waehrung'],
    sender: ['sender', 'auftraggeber', 'payer'],
    recipient: ['recipient', 'empfänger', 'empfaenger', 'payee'],
    reference: ['reference', 'referenz', 'kundenreferenz'],
    transactionId: ['transaction id', 'transactionid', 'transaktionsnummer'],
    transactionType: ['transaction type', 'type', 'buchungsart'],
    status: ['status', 'state', 'buchungsstatus'],
    balance: ['balance', 'saldo', 'kontostand'],
    bankCategory: ['category', 'kategorie'],
    accountIdentifier: ['account iban', 'iban', 'account number', 'kontonummer'],
    purpose: ['purpose', 'transfer purpose', 'remittance'],
  };
  const normalized = new Map(headers.map((header) => [header.trim().toLowerCase(), header]));
  return Object.fromEntries(Object.entries(aliases).flatMap(([field, choices]) => {
    const header = choices.map((choice) => normalized.get(choice)).find(Boolean);
    return header ? [[field, header]] : [];
  }));
}
