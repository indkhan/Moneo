import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPoints, monthOverMonthTenths } from './net-worth-chart.mjs';

test('maps labelled balances into a bounded rising chart', () => {
  const points = chartPoints([
    { label: '1 Aug', value: 9000 },
    { label: '3 Aug', value: 11500 },
  ]);

  assert.deepEqual(points, [
    { label: '1 Aug', x: 25, y: 74 },
    { label: '3 Aug', x: 75, y: 18 },
  ]);
});

test('centres every chart point in its matching month cell', () => {
  const points = chartPoints(Array.from({ length: 6 }, (_, index) => ({
    label: `Month ${index + 1}`,
    value: index,
  })));

  points.forEach((point, index) => {
    assert.equal(point.x, ((index + 0.5) / points.length) * 100);
  });
});

test('handles empty and single-balance charts safely', () => {
  assert.deepEqual(chartPoints([]), []);
  assert.deepEqual(chartPoints([{ label: '3 Aug', value: 11500 }]), [
    { label: '3 Aug', x: 50, y: 46 },
  ]);
});

test('rounds positive and negative month-over-month changes to one decimal place', () => {
  assert.equal(monthOverMonthTenths([{ amountMinor: '10000' }, { amountMinor: '10567' }]), 57);
  assert.equal(monthOverMonthTenths([{ amountMinor: '10000' }, { amountMinor: '9433' }]), -57);
});

test('omits month-over-month change without a usable previous balance', () => {
  assert.equal(monthOverMonthTenths([]), undefined);
  assert.equal(monthOverMonthTenths([{ amountMinor: '10000' }]), undefined);
  assert.equal(monthOverMonthTenths([{ amountMinor: '0' }, { amountMinor: '10000' }]), undefined);
});
