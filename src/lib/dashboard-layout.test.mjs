import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPresentation } from './dashboard-layout.mjs';

test('empty dashboard keeps the reference sections and exposes import', () => {
  assert.deepEqual(dashboardPresentation(0), {
    showImporter: true,
    main: ['net-worth', 'spending', 'budgets', 'transactions'],
    rail: ['ai-insight', 'accounts', 'recurring'],
  });
});

test('populated dashboard hides the empty-state importer', () => {
  assert.equal(dashboardPresentation(12).showImporter, false);
});
