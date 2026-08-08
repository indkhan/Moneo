import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationItems } from './navigation.mjs';

test('navigation exposes the Lumen workspace sections in reference order', () => {
  assert.deepEqual(
    navigationItems.map((item) => item.route),
    ['index', 'transactions', 'budgets', 'investments', 'recurring'],
  );
});
