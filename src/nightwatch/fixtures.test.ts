/**
 * Guards the demo arc. These fixtures are what the whole team renders and
 * replays against, so a careless edit here breaks the 13:45 gate silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOTICE_V1, NOTICE_V1_DUPLICATE, NOTICE_V2, FIXTURE_PLAN, FIXTURE_SITE_STATUSES, SITES } from './fixtures.ts';
import { isUnknown, type SiteRecommendation } from './domain/models.ts';

test('the revision is the same event at a later version', () => {
  assert.equal(NOTICE_V2.eventId, NOTICE_V1.eventId);
  assert.ok(NOTICE_V2.version > NOTICE_V1.version, 'revision must bump the version');
  assert.ok(NOTICE_V2.receivedAt > NOTICE_V1.receivedAt, 'revision must arrive later');
});

test('the revision actually moves the target, so consent cannot survive it', () => {
  const moved = Math.hypot(NOTICE_V2.raDeg - NOTICE_V1.raDeg, NOTICE_V2.decDeg - NOTICE_V1.decDeg);
  assert.ok(moved > NOTICE_V1.errorRadiusDeg * 0.5, 'revision must move the target meaningfully');
  assert.ok(NOTICE_V2.errorRadiusDeg < NOTICE_V1.errorRadiusDeg, 'revision must refine the localisation');
});

test('the duplicate is the same version and must not open a second request', () => {
  assert.equal(NOTICE_V1_DUPLICATE.eventId, NOTICE_V1.eventId);
  assert.equal(NOTICE_V1_DUPLICATE.version, NOTICE_V1.version);
});

test('the plan is bound to the version it was computed from', () => {
  assert.equal(FIXTURE_PLAN.eventId, NOTICE_V1.eventId);
  assert.equal(FIXTURE_PLAN.noticeVersion, NOTICE_V1.version);
  assert.ok(SITES.some((s) => s.id === FIXTURE_PLAN.siteId), 'plan must name a configured site');
  assert.ok(FIXTURE_PLAN.assumptions.length > 0, 'a proposal must state its assumptions');
});

test('the card fixtures cover one of every recommendation', () => {
  const seen = new Set<SiteRecommendation>(FIXTURE_SITE_STATUSES.map((s) => s.recommendation));
  for (const want of ['RECOMMENDED', 'WAIT', 'NO_WINDOW'] as const) {
    assert.ok(seen.has(want), `missing a ${want} row for card layout work`);
  }
});

test('every status row names a configured site and carries its timestamp', () => {
  for (const status of FIXTURE_SITE_STATUSES) {
    assert.ok(SITES.some((s) => s.id === status.siteId), `unknown site ${status.siteId}`);
    assert.ok(status.computedAt instanceof Date, 'every number must carry when it was computed');
  }
});

test('NO_WINDOW means no window, not unknown', () => {
  const none = FIXTURE_SITE_STATUSES.find((s) => s.recommendation === 'NO_WINDOW');
  assert.ok(none, 'expected a NO_WINDOW row');
  assert.ok(!isUnknown(none.nextWindow), 'NO_WINDOW is a computed answer, not missing data');
  assert.equal(none.nextWindow, null);
});
