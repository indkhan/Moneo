import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mappingSignature,
  normalizeMappedCsv,
} from './csv-mapping.mjs';

const unknownCsv = `Date,Details,Debit,Credit,Currency,Reference
07/31/2026,Coffee,4.20,,USD,CARD-1
08/01/2026,Salary,,1000.00,USD,PAY-1`;

const mapping = {
  bankName: 'Example Bank',
  accountName: 'Main account',
  accountIdentifier: 'example-main',
  dateFormat: 'MM/DD/YYYY',
  numberFormat: 'en-US',
  columns: {
    bookingDate: 'Date',
    title: 'Details',
    debit: 'Debit',
    credit: 'Credit',
    currency: 'Currency',
    reference: 'Reference',
  },
};

test('normalizes a one-time mapping with separate debit and credit columns', () => {
  const result = normalizeMappedCsv(unknownCsv, 'example.csv', mapping);

  assert.equal(result.adapterId, 'mapped-v1');
  assert.deepEqual(result.account, {
    institution: 'Example Bank',
    displayName: 'Main account',
    identifier: 'example-main',
  });
  assert.deepEqual(
    result.transactions.map((transaction) => ({
      date: transaction.bookingDate,
      amount: transaction.amountMinor,
      currency: transaction.currency,
      title: transaction.title,
      reference: transaction.references[0]?.value,
    })),
    [
      { date: '2026-07-31', amount: '-420', currency: 'USD', title: 'Coffee', reference: 'CARD-1' },
      { date: '2026-08-01', amount: '100000', currency: 'USD', title: 'Salary', reference: 'PAY-1' },
    ],
  );
});

test('uses an explicit constant currency and German number format', () => {
  const csv = `Datum;Text;Betrag\n08.08.2026;Miete;-1.234,56`;
  const result = normalizeMappedCsv(csv, 'german.csv', {
    bankName: 'Andere Bank',
    accountName: 'Girokonto',
    dateFormat: 'DD.MM.YYYY',
    numberFormat: 'de-DE',
    constantCurrency: 'EUR',
    columns: { bookingDate: 'Datum', title: 'Text', amount: 'Betrag' },
  });

  assert.equal(result.transactions[0].bookingDate, '2026-08-08');
  assert.equal(result.transactions[0].amountMinor, '-123456');
  assert.equal(result.transactions[0].currency, 'EUR');
});

test('creates an exact reusable signature from the parsed shape and mapping version', () => {
  const first = mappingSignature(unknownCsv, mapping);
  const same = mappingSignature(unknownCsv.replace('Coffee', 'Tea'), mapping);
  const changedHeader = mappingSignature(unknownCsv.replace('Details', 'Description'), mapping);

  assert.equal(first, same);
  assert.notEqual(first, changedHeader);
  assert.match(first, /^mapped-v1\|,/);
});

test('accepts edited normalized values for a bad row without changing its raw source', () => {
  const invalid = unknownCsv.replace('07/31/2026', 'not-a-date');
  const failed = normalizeMappedCsv(invalid, 'example.csv', mapping);
  assert.equal(failed.transactions.length, 1);
  assert.equal(failed.errors[0].rowNumber, 2);

  const corrected = normalizeMappedCsv(invalid, 'example.csv', mapping, {
    2: { bookingDate: '2026-07-31' },
  });

  assert.equal(corrected.errors.length, 0);
  assert.equal(corrected.transactions[0].bookingDate, '2026-07-31');
  assert.equal(corrected.transactions[0].source.rawRecord.Date, 'not-a-date');
});

test('rejects an invalid corrected mapped date', () => {
  const invalid = unknownCsv.replace('07/31/2026', 'not-a-date');
  const corrected = normalizeMappedCsv(invalid, 'example.csv', mapping, {
    2: { bookingDate: 'not-a-date' },
  });

  assert.equal(corrected.transactions.length, 1);
  assert.equal(corrected.errors[0].field, 'bookingDate');
});

test('rejects an invalid corrected mapped currency', () => {
  const corrected = normalizeMappedCsv(unknownCsv, 'example.csv', mapping, {
    2: { currency: 'EURO' },
  });

  assert.equal(corrected.transactions.length, 1);
  assert.equal(corrected.errors[0].field, 'currency');
});

test('rejects mappings that omit required columns instead of guessing', () => {
  assert.throws(
    () => normalizeMappedCsv(unknownCsv, 'example.csv', {
      ...mapping,
      columns: { bookingDate: 'Date', title: 'Details', amount: 'Missing', currency: 'Currency' },
    }),
    /Mapped column is missing: Missing/,
  );
});

test('normalizes optional balance, status, transaction ID, and bank category fields', () => {
  const csv = `Date,Details,Amount,Currency,Balance,State,ID,Category\n2026-08-08,Coffee,-5.00,EUR,995.00,BOOKED,TX-1,Food`;
  const result = normalizeMappedCsv(csv, 'optional.csv', {
    bankName: 'Example Bank',
    accountName: 'Main',
    dateFormat: 'YYYY-MM-DD',
    numberFormat: 'en-US',
    columns: {
      bookingDate: 'Date',
      title: 'Details',
      amount: 'Amount',
      currency: 'Currency',
      balance: 'Balance',
      status: 'State',
      transactionId: 'ID',
      bankCategory: 'Category',
    },
  });

  assert.equal(result.transactions[0].balanceAfterMinor, '99500');
  assert.equal(result.transactions[0].status, 'booked');
  assert.equal(result.transactions[0].bankTransactionId, 'TX-1');
  assert.equal(result.transactions[0].bankCategory, 'Food');
});
