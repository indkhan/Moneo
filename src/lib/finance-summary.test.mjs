import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceSeriesByCurrency,
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

test('uses source balances where available and calculates other accounts from zero', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-08-01', amountMinor: '-100', currency: 'EUR', balanceAfterMinor: '9000' },
    { ...base, id: '2', accountId: 'a', bookingDate: '2026-08-02', amountMinor: '-100', currency: 'EUR' },
    { ...base, id: '3', accountId: 'a', bookingDate: '2026-08-03', amountMinor: '500', currency: 'EUR', balanceAfterMinor: '9400' },
    { ...base, id: '4', accountId: 'b', bookingDate: '2026-08-03', amountMinor: '500', currency: 'USD' },
  ];

  assert.deepEqual(latestBalanceByAccount(transactions), {
    a: {
      amountMinor: '9400',
      currency: 'EUR',
      currencyMinorUnit: 2,
      bookingDate: '2026-08-03',
      basis: 'source-backed',
    },
    b: {
      amountMinor: '500',
      currency: 'USD',
      currencyMinorUnit: 2,
      bookingDate: '2026-08-03',
      basis: 'calculated-from-zero',
    },
  });
});

test('calculates the latest account balance from zero when the CSV has no balances', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-07-01', amountMinor: '10000', currency: 'EUR' },
    { ...base, id: '2', accountId: 'a', bookingDate: '2026-07-02', amountMinor: '-2500', currency: 'EUR' },
    { ...base, id: '3', accountId: 'a', bookingDate: '2026-07-03', amountMinor: '5000', currency: 'EUR' },
    { ...base, id: '4', accountId: 'a', bookingDate: '2026-07-04', amountMinor: '-9000', currency: 'EUR', status: 'pending' },
  ];

  assert.deepEqual(latestBalanceByAccount(transactions), {
    a: {
      amountMinor: '12500',
      currency: 'EUR',
      currencyMinorUnit: 2,
      bookingDate: '2026-07-03',
      basis: 'calculated-from-zero',
    },
  });
});

test('builds month-end balance history per currency without conversion', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-08-01', amountMinor: '-100', currency: 'EUR', balanceAfterMinor: '9000' },
    { ...base, id: '2', accountId: 'b', bookingDate: '2026-08-01', amountMinor: '100', currency: 'EUR', balanceAfterMinor: '2000', source: { ...base.source, rowNumber: 3 } },
    { ...base, id: '3', accountId: 'a', bookingDate: '2026-08-03', amountMinor: '500', currency: 'EUR', balanceAfterMinor: '9500' },
    { ...base, id: '4', accountId: 'c', bookingDate: '2026-08-02', amountMinor: '100', currency: 'USD', balanceAfterMinor: '4100' },
  ];

  assert.deepEqual(balanceSeriesByCurrency(transactions), [
    {
      currency: 'EUR',
      currencyMinorUnit: 2,
      basis: 'source-backed',
      points: [{ month: '2026-08', amountMinor: '11500' }],
    },
    {
      currency: 'USD',
      currencyMinorUnit: 2,
      basis: 'source-backed',
      points: [{ month: '2026-08', amountMinor: '4100' }],
    },
  ]);
});

test('rolls complete transaction history from zero into every month-end balance', () => {
  const transactions = [
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-01-02', amountMinor: '10000', currency: 'EUR' },
    { ...base, id: '2', accountId: 'a', bookingDate: '2026-01-31', amountMinor: '-2500', currency: 'EUR' },
    { ...base, id: '3', accountId: 'a', bookingDate: '2026-02-14', amountMinor: '5000', currency: 'EUR' },
    { ...base, id: '4', accountId: 'a', bookingDate: '2026-02-20', amountMinor: '-1000', currency: 'EUR', status: 'reverted' },
    { ...base, id: '5', accountId: 'a', bookingDate: '2026-03-01', amountMinor: '-1250', currency: 'EUR' },
  ];

  assert.deepEqual(balanceSeriesByCurrency(transactions), [{
    currency: 'EUR',
    currencyMinorUnit: 2,
    basis: 'calculated-from-zero',
    points: [
      { month: '2026-01', amountMinor: '7500' },
      { month: '2026-02', amountMinor: '12500' },
      { month: '2026-03', amountMinor: '11250' },
    ],
  }]);
});

test('net worth history excludes non-booked balance snapshots', () => {
  assert.deepEqual(balanceSeriesByCurrency([
    { ...base, id: '1', accountId: 'a', bookingDate: '2026-08-01', amountMinor: '-100', currency: 'EUR', balanceAfterMinor: '9000', status: 'pending' },
  ]), []);
});
