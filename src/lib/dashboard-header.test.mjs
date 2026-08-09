import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHeader } from './dashboard-header.mjs';

test('dashboard header uses a time-aware greeting without inventing a name', () => {
  assert.deepEqual(
    dashboardHeader(new Date('2026-08-08T08:00:00Z'), 'en-GB', 'UTC'),
    {
      title: 'Good morning',
      subtitle: 'Saturday, 8 August · your local view is ready',
    },
  );
});

test('dashboard header changes greeting after noon', () => {
  assert.equal(
    dashboardHeader(new Date('2026-08-08T18:00:00Z'), 'en-GB', 'UTC').title,
    'Good evening',
  );
});
