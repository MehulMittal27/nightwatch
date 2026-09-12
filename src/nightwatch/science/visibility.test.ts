import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNKNOWN,
  type Notice,
  type ObservingWindow,
  type Site,
  type SiteStatus,
} from '../domain/models.ts';
import { SITES } from '../fixtures.ts';
import { computeSiteStatus, raDegToHours } from './visibility.ts';

function siteById(id: string): Site {
  const site = SITES.find((candidate) => candidate.id === id);
  assert.ok(site, 'missing fixture site ' + id);
  return site;
}

function noticeAt(raDeg: number, decDeg: number, at: Date): Notice {
  return {
    eventId: 'TEST-EVENT',
    version: 1,
    raDeg,
    decDeg,
    errorRadiusDeg: 1,
    receivedAt: new Date(at.getTime()),
    raw: { source: 'unit-test' },
  };
}

function usableWindow(status: SiteStatus): ObservingWindow {
  const window = status.nextWindow;
  if (window === UNKNOWN || window === null) {
    throw new Error('expected a usable observing window');
  }
  return window;
}

test('raDegToHours converts degrees to sidereal hours', () => {
  assert.equal(raDegToHours(0), 0);
  assert.equal(raDegToHours(15), 1);
  assert.equal(raDegToHours(180), 12);
  assert.equal(raDegToHours(360), 24);
  assert.ok(Math.abs(raDegToHours(213.4917) - 14.23278) < 1e-10);
});

test('target up now is recommended and has a current window', () => {
  const at = new Date('2026-09-12T20:00:00Z');
  const site = siteById('teide');
  const status = computeSiteStatus(site, noticeAt(213.4917, 18.7342, at), at);

  assert.equal(status.recommendation, 'RECOMMENDED');
  assert.equal(status.computedAt.getTime(), at.getTime());
  assert.notEqual(status.altitudeNowDeg, UNKNOWN);
  assert.ok(typeof status.altitudeNowDeg === 'number');
  assert.ok(status.altitudeNowDeg >= site.altitudeLimitDeg);
  assert.notEqual(status.moonSeparationDeg, UNKNOWN);
  assert.ok(typeof status.moonSeparationDeg === 'number');
  const window = usableWindow(status);
  assert.ok(window.startUtc <= at);
  assert.ok(window.endUtc > at);
});

test('target below the horizon all night has no window', () => {
  const at = new Date('2026-09-12T12:00:00Z');
  const site = siteById('kittpeak');
  const status = computeSiteStatus(site, noticeAt(0, -80, at), at);

  assert.equal(status.recommendation, 'NO_WINDOW');
  assert.notEqual(status.altitudeNowDeg, UNKNOWN);
  assert.ok(typeof status.altitudeNowDeg === 'number');
  assert.ok(status.altitudeNowDeg < site.altitudeLimitDeg);
  assert.equal(status.nextWindow, null);
});

test('target rising later is marked WAIT with a future window', () => {
  const at = new Date('2026-09-12T00:00:00Z');
  const site = siteById('teide');
  const status = computeSiteStatus(site, noticeAt(213.4917, 18.7342, at), at);

  assert.equal(status.recommendation, 'WAIT');
  const window = usableWindow(status);
  assert.ok(window.startUtc > at);
  assert.ok(window.endUtc > window.startUtc);
});

test('stale notices return unknown values and block recommendation', () => {
  const at = new Date('2026-09-12T20:00:00Z');
  const staleAt = new Date('2026-09-10T19:59:59Z');
  const status = computeSiteStatus(
    siteById('teide'),
    noticeAt(213.4917, 18.7342, staleAt),
    at,
  );

  assert.equal(status.recommendation, 'UNKNOWN');
  assert.equal(status.altitudeNowDeg, UNKNOWN);
  assert.equal(status.moonSeparationDeg, UNKNOWN);
  assert.equal(status.nextWindow, UNKNOWN);
});
