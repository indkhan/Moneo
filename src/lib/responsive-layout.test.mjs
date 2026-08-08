import test from 'node:test';
import assert from 'node:assert/strict';
import { isDesktopLayout } from './responsive-layout.mjs';

test('web uses the compact layout below the desktop breakpoint', () => {
  assert.equal(isDesktopLayout(390), false);
  assert.equal(isDesktopLayout(1023), false);
  assert.equal(isDesktopLayout(1024), true);
});
