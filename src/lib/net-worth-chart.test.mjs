import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPoints, pointAtIndex, tooltipLeft } from './net-worth-chart.mjs';

test('net-worth chart rises through August and highlights April', () => {
  const points = chartPoints([68_200, 70_140, 71_980, 74_510, 76_920, 79_430, 83_967]);

  assert.equal(points.length, 7);
  assert.equal(points[2].label, 'Apr');
  assert.ok(points[0].y > points.at(-1).y);
});

test('keeps the first and last tooltips inside the chart', () => {
  assert.equal(tooltipLeft(0, 600), 8);
  assert.equal(tooltipLeft(600, 600), 424);
});

test('returns the hovered month and keeps the selection in range', () => {
  const points = chartPoints([68_200, 70_140, 71_980, 74_510, 76_920, 79_430, 83_967]);

  assert.equal(pointAtIndex(points, 0)?.label, 'Feb');
  assert.equal(pointAtIndex(points, 6)?.label, 'Aug');
  assert.equal(pointAtIndex(points, 99)?.label, 'Aug');
});
