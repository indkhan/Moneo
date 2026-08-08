import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestBalanceByAccount,
  summarizeByCurrency,
} from './finance-summary.mjs';

const base = {
  currencyMinorUnit: 2,
  title: 'Example',
  description: 'Example',
  references: [],
  importId: 'import-1',
  source: { fileName: 'statement.csv', rowNumber: 2, rawRecord: {} },
};

test('summarizes income and outflow separately for every currency', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-08-01', amountMinor: '10000', currency: 'EUR' },
    { ...base, id: '2', accountId: 'a', bookingDate: '2026-08-02', amountMinor: '-2500', currency: 'EUR' },
    { ...base, id: '3', accountId: 'b', bookingDate: '2026-08-03', amountMinor: '5000', currency: 'USD' },
  ];

  assert.deepEqual(summarizeByCurrency(transactions), [
    { currency: 'EUR', currencyMinorUnit: 2, incomeMinor: '10000', outflowMinor: '2500', netMinor: '7500', count: 2 },
    { currency: 'USD', currencyMinorUnit: 2, incomeMinor: '5000', outflowMinor: '0', netMinor: '5000', count: 1 },
  ]);
});

test('excludes pending and reverted transactions from cash flow', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-08-01', amountMinor: '10000', currency: 'EUR', status: 'booked' },
    { ...base, id: '2', accountId: 'a', bookingDate: '2026-08-02', amountMinor: '-2500', currency: 'EUR', status: 'pending' },
    { ...base, id: '3', accountId: 'a', bookingDate: '2026-08-03', amountMinor: '-5000', currency: 'EUR', status: 'reverted' },
  ];

  assert.deepEqual(summarizeByCurrency(transactions), [
    { currency: 'EUR', currencyMinorUnit: 2, incomeMinor: '10000', outflowMinor: '0', netMinor: '10000', count: 1 },
  ]);
});

test('uses only the latest source-backed balance for each account', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-08-01', amountMinor: '-100', currency: 'EUR', balanceAfterMinor: '9000' },
    { ...base, id: '2', accountId: 'a', bookingDate: '2026-08-02', amountMinor: '-100', currency: 'EUR' },
    { ...base, id: '3', accountId: 'a', bookingDate: '2026-08-03', amountMinor: '500', currency: 'EUR', balanceAfterMinor: '9400' },
    { ...base, id: '4', accountId: 'b', bookingDate: '2026-08-03', amountMinor: '500', currency: 'USD' },
  ];

  assert.deepEqual(latestBalanceByAccount(transactions), {
    a: { amountMinor: '9400', currency: 'EUR', currencyMinorUnit: 2, bookingDate: '2026-08-03' },
  });
});
