import test from 'node:test';
import assert from 'node:assert/strict';
import { unavailableDashboardCapabilities } from './dashboard-capabilities.mjs';

test('unsupported dashboard capabilities use explicit unavailable copy', () => {
  assert.deepEqual(unavailableDashboardCapabilities, {
    budgets: 'No budgets set',
    recurring: 'Detection not available',
    ai: 'AI not connected',
    safeToSpend: 'Not calculated',
  });
});
