import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMinorMoney,
  recentTransactions,
} from './finance-transactions.mjs';

test('formats exact minor-unit strings without currency conversion', () => {
  assert.equal(formatMinorMoney('-575', 'EUR', 2), '-5,75 EUR');
  assert.equal(formatMinorMoney('1250', 'JPY', 0), '+1.250 JPY');
  assert.equal(formatMinorMoney('2345', 'KWD', 3), '+2,345 KWD');
});

test('sorts recent transactions by booking date and source order', () => {
  const rows = [
    { id: 'older', bookingDate: '2026-08-01', source: { rowNumber: 2 } },
    { id: 'same-later-row', bookingDate: '2026-08-08', source: { rowNumber: 4 } },
    { id: 'same-earlier-row', bookingDate: '2026-08-08', source: { rowNumber: 2 } },
  ];

  assert.deepEqual(recentTransactions(rows).map((row) => row.id), [
    'same-earlier-row',
    'same-later-row',
    'older',
  ]);
});
