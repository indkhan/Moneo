import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPoints } from './net-worth-chart.mjs';

test('maps labelled balances into a bounded rising chart', () => {
  const points = chartPoints([
    { label: '1 Aug', value: 9000 },
    { label: '3 Aug', value: 11500 },
  ]);

  assert.deepEqual(points, [
    { label: '1 Aug', x: 0, y: 74 },
    { label: '3 Aug', x: 100, y: 18 },
  ]);
});

test('places a single balance safely in the middle of the chart', () => {
  assert.deepEqual(chartPoints([{ label: '3 Aug', value: 11500 }]), [
    { label: '3 Aug', x: 50, y: 46 },
  ]);
});
