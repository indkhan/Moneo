import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateTransactions,
  sha256Hex,
  transactionFingerprint,
} from './transaction-dedup.mjs';

const transaction = {
  bookingDate: '2026-08-08',
  valueDate: '2026-08-08',
  amountMinor: '-500',
  currency: 'EUR',
  currencyMinorUnit: 2,
  title: 'Example Cafe',
  description: 'CARD PAYMENT EXAMPLE CAFE',
  references: [],
  transactionType: 'Debit',
  source: { fileName: 'one.csv', rowNumber: 2, rawRecord: {} },
};

test('hashes the complete source bytes for exact-file duplicate detection', async () => {
  const bytes = new TextEncoder().encode('example bank csv');
  assert.equal(
    await sha256Hex(bytes),
    '3ac492855f4074de7dad5885cad232e7e717d5b0009264ebfb74461d5994e0b7',
  );
});

test('prefers a bank transaction ID and scopes it to the account', () => {
  const withId = { ...transaction, bankTransactionId: 'BANK-42' };

  assert.equal(transactionFingerprint('account-a', withId), 'account-a|bank-id|BANK-42');
  assert.notEqual(
    transactionFingerprint('account-a', withId),
    transactionFingerprint('account-b', withId),
  );
});

test('skips only matching occurrences from overlapping statements', () => {
  const existing = [
    { ...transaction, id: 'old-1', accountId: 'account-a', importId: 'first' },
    { ...transaction, id: 'old-2', accountId: 'account-a', importId: 'first' },
  ];
  const incoming = [
    { ...transaction, source: { ...transaction.source, rowNumber: 2 } },
    { ...transaction, source: { ...transaction.source, rowNumber: 3 } },
    { ...transaction, source: { ...transaction.source, rowNumber: 4 } },
  ];

  const result = deduplicateTransactions(existing, incoming, 'account-a');

  assert.equal(result.skipped.length, 2);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].source.rowNumber, 4);
});

test('does not match the same transaction details across different accounts', () => {
  const existing = [
    { ...transaction, id: 'old-1', accountId: 'account-b', importId: 'first' },
  ];

  const result = deduplicateTransactions(existing, [transaction], 'account-a');
  assert.equal(result.skipped.length, 0);
  assert.equal(result.accepted.length, 1);
});
