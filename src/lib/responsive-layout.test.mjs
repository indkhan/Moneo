import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hydrationSafeWebWidth,
  isCompactAccountsLayout,
  isDesktopLayout,
} from './responsive-layout.mjs';

test('web uses the compact layout below the desktop breakpoint', () => {
  assert.equal(isDesktopLayout(390), false);
  assert.equal(isDesktopLayout(1023), false);
  assert.equal(isDesktopLayout(1024), true);
});

test('web waits for a client measurement before choosing desktop markup', () => {
  assert.equal(hydrationSafeWebWidth(0), 0);
  assert.equal(hydrationSafeWebWidth(390), 390);
  assert.equal(hydrationSafeWebWidth(1440), 1024);
});

test('accounts stack their balance only in the narrow desktop range', () => {
  assert.equal(isCompactAccountsLayout(1024), true);
  assert.equal(isCompactAccountsLayout(1399), true);
  assert.equal(isCompactAccountsLayout(1400), false);
});
