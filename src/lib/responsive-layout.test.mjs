import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrationSafeWebWidth, isDesktopLayout } from './responsive-layout.mjs';

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
