import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMonthlySpending } from './dashboard-spending.mjs';

const base = {
  currencyMinorUnit: 2,
  title: 'Example',
  description: 'Example',
  references: [],
  accountId: 'account-1',
  importId: 'import-1',
  source: { fileName: 'statement.csv', rowNumber: 2, rawRecord: {} },
};

test('summarizes booked monthly outflow by category and currency', () => {
  const transactions = [
    { ...base, id: '1', bookingDate: '2026-08-01', amountMinor: '-6400', currency: 'EUR', category: { categoryId: 'groceries' } },
    { ...base, id: '2', bookingDate: '2026-08-03', amountMinor: '-1800', currency: 'EUR' },
    { ...base, id: '3', bookingDate: '2026-08-04', amountMinor: '420000', currency: 'EUR', category: { categoryId: 'salary' } },
    { ...base, id: '4', bookingDate: '2026-08-05', amountMinor: '-900', currency: 'USD', category: { categoryId: 'dining' } },
    { ...base, id: '5', bookingDate: '2026-08-06', amountMinor: '-500', currency: 'EUR', status: 'pending' },
  ];

  assert.deepEqual(summarizeMonthlySpending(transactions, '2026-08'), [
    {
      currency: 'EUR',
      currencyMinorUnit: 2,
      totalMinor: '8200',
      categories: [
        { categoryId: 'groceries', amountMinor: '6400' },
        { categoryId: 'uncategorised', amountMinor: '1800' },
      ],
    },
    {
      currency: 'USD',
      currencyMinorUnit: 2,
      totalMinor: '900',
      categories: [{ categoryId: 'dining', amountMinor: '900' }],
    },
  ]);
});
