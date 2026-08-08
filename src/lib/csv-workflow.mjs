import { normalizeCommerzbankCsv, parseCsv, requiredCommerzbankHeaders } from './csv-import.mjs';
import { mappingSignature, normalizeMappedCsv } from './csv-mapping.mjs';
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

  const mapping = savedMappings.find((candidate) => mappingSignature(text, candidate) === candidate.signature);
  if (mapping) {
    return { kind: 'normalized', result: normalizeMappedCsv(text, fileName, mapping), mapping };
  }

  return {
    kind: 'mapping-required',
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 3).map((row) => row.rawRecord),
  };
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
    balance: ['balance', 'saldo', 'kontostand'],
    bankCategory: ['category', 'kategorie'],
  };
  const normalized = new Map(headers.map((header) => [header.trim().toLowerCase(), header]));
  return Object.fromEntries(Object.entries(aliases).flatMap(([field, choices]) => {
    const header = choices.map((choice) => normalized.get(choice)).find(Boolean);
    return header ? [[field, header]] : [];
  }));
}
