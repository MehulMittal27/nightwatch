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

// ---------------------------------------------------------------------------
// Independent cross-checks
//
// The values pinned below were computed OUTSIDE this codebase, in a separate
// python3 script that uses neither astronomy-engine nor anything in src/: GMST
// from Meeus 12.4 with plain spherical trigonometry for altitude, and the
// abbreviated ELP-2000/82 lunar series of Meeus 47 plus the topocentric
// parallax correction of Meeus 40 for the Moon. They therefore catch the two
// silent-but-plausible failure modes that reviewing the code cannot: an RA
// given to Horizon in degrees instead of hours, and a negated site longitude.
// Both would still return a well-formed altitude - just the wrong one.
// ---------------------------------------------------------------------------

/** Real replayed GCN localisations; see replay/notices/. */
const REPLAY_V1 = { raDeg: 236.783, decDeg: 66.633, at: new Date('2024-08-24T02:15:03Z') };
const REPLAY_V2 = { raDeg: 90.56, decDeg: -67.87, at: new Date('2024-08-24T02:16:35Z') };

/** The highest altitude declination `dec` can ever reach from latitude `lat`. */
function culminationBoundDeg(latDeg: number, decDeg: number): number {
  return 90 - Math.abs(latDeg - decDeg);
}

function numeric(value: number | typeof UNKNOWN, label: string): number {
  if (typeof value !== 'number') {
    throw new Error('expected a computed number for ' + label);
  }
  return value;
}

test('altitudes match an independently computed ephemeris', () => {
  const expected: { siteId: string; target: typeof REPLAY_V1; altitudeDeg: number }[] = [
    { siteId: 'teide', target: REPLAY_V1, altitudeDeg: 17.273 },
    { siteId: 'kittpeak', target: REPLAY_V1, altitudeDeg: 53.657 },
    { siteId: 'sso', target: REPLAY_V2, altitudeDeg: 37.905 },
  ];

  for (const { siteId, target, altitudeDeg } of expected) {
    const status = computeSiteStatus(
      siteById(siteId),
      noticeAt(target.raDeg, target.decDeg, target.at),
      target.at,
    );
    const actual = numeric(status.altitudeNowDeg, siteId);
    assert.ok(
      Math.abs(actual - altitudeDeg) < 0.05,
      `${siteId}: altitude ${actual} deg differs from the independent ${altitudeDeg} deg`,
    );
  }
});

test('moon separation matches an independently computed lunar position', () => {
  const expected: { siteId: string; target: typeof REPLAY_V1; separationDeg: number }[] = [
    { siteId: 'teide', target: REPLAY_V1, separationDeg: 97.138 },
    { siteId: 'sso', target: REPLAY_V2, separationDeg: 93.578 },
  ];

  for (const { siteId, target, separationDeg } of expected) {
    const status = computeSiteStatus(
      siteById(siteId),
      noticeAt(target.raDeg, target.decDeg, target.at),
      target.at,
    );
    const actual = numeric(status.moonSeparationDeg, siteId);
    assert.ok(
      Math.abs(actual - separationDeg) < 0.1,
      `${siteId}: Moon separation ${actual} deg differs from the independent ${separationDeg} deg`,
    );

    // A flat sqrt(dRA^2 + dDec^2) distance is the classic bug here. For the
    // teide case it answers 161 deg instead of 97, so any value that close to
    // the Euclidean answer means the spherical formula was lost.
    assert.ok(actual <= 180, 'an angular separation above 180 deg is not a separation');
  }
});

test('no reported altitude exceeds what culmination geometry permits', () => {
  for (const target of [REPLAY_V1, REPLAY_V2]) {
    for (const site of SITES) {
      const bound = culminationBoundDeg(site.latDeg, target.decDeg);
      const status = computeSiteStatus(
        site,
        noticeAt(target.raDeg, target.decDeg, target.at),
        target.at,
      );

      const now = numeric(status.altitudeNowDeg, site.id);
      assert.ok(now <= bound + 1e-9, `${site.id}: altitude ${now} exceeds the bound ${bound}`);

      const window = status.nextWindow;
      if (window === UNKNOWN || window === null) continue;
      assert.ok(
        window.maxAltitudeDeg <= bound + 1e-9,
        `${site.id}: window max ${window.maxAltitudeDeg} exceeds the bound ${bound}`,
      );
    }
  }
});

test('a site that can never clear its own limit reports no window', () => {
  // dec -67.87 from Kitt Peak culminates at 90 - |31.9583 + 67.87| = -9.83 deg:
  // the target is permanently below the horizon, let alone the 25 deg limit.
  const site = siteById('kittpeak');
  assert.ok(culminationBoundDeg(site.latDeg, REPLAY_V2.decDeg) < site.altitudeLimitDeg);

  const status = computeSiteStatus(
    site,
    noticeAt(REPLAY_V2.raDeg, REPLAY_V2.decDeg, REPLAY_V2.at),
    REPLAY_V2.at,
  );
  assert.equal(status.recommendation, 'NO_WINDOW');
  assert.equal(status.nextWindow, null);
});

// ---------------------------------------------------------------------------
// Window boundaries
//
// Regression guard: endUtc used to be the first grid sample BELOW the limit,
// so every window ended at an instant the target was not observable and every
// span was overstated by one grid step. coverageLoss() in domain/state.ts
// derives rendered minutes from endUtc - startUtc, so that reached a card.
// ---------------------------------------------------------------------------

test('both window boundaries are instants the site can actually observe', () => {
  for (const target of [REPLAY_V1, REPLAY_V2]) {
    for (const site of SITES) {
      const notice = noticeAt(target.raDeg, target.decDeg, target.at);
      const status = computeSiteStatus(site, notice, target.at);
      const window = status.nextWindow;
      if (window === UNKNOWN || window === null) continue;

      assert.ok(window.endUtc >= window.startUtc, `${site.id}: window ends before it starts`);

      for (const [label, edge] of [['start', window.startUtc], ['end', window.endUtc]] as const) {
        // Recompute from scratch at the boundary: the public answer there must
        // agree that the target is observable.
        const atEdge = computeSiteStatus(site, notice, edge);
        const altitude = numeric(atEdge.altitudeNowDeg, `${site.id} ${label}`);
        assert.ok(
          altitude >= site.altitudeLimitDeg,
          `${site.id}: window ${label} ${edge.toISOString()} sits at ${altitude} deg, `
            + `below the site limit of ${site.altitudeLimitDeg} deg`,
        );
        assert.equal(atEdge.recommendation, 'RECOMMENDED');
      }
    }
  }
});

test('the window end is the last observable sample, not an earlier one', () => {
  const gridStepMs = 5 * 60 * 1000;
  const lookaheadMs = 24 * 60 * 60 * 1000;

  for (const target of [REPLAY_V1, REPLAY_V2]) {
    for (const site of SITES) {
      const notice = noticeAt(target.raDeg, target.decDeg, target.at);
      const window = computeSiteStatus(site, notice, target.at).nextWindow;
      if (window === UNKNOWN || window === null) continue;

      const horizon = target.at.getTime() + lookaheadMs;
      if (window.endUtc.getTime() >= horizon) continue; // window runs to the lookahead edge

      const justAfter = new Date(window.endUtc.getTime() + gridStepMs);
      const altitude = numeric(
        computeSiteStatus(site, notice, justAfter).altitudeNowDeg,
        site.id,
      );
      assert.ok(
        altitude < site.altitudeLimitDeg,
        `${site.id}: the window was cut short - ${justAfter.toISOString()} is still observable `
          + `at ${altitude} deg`,
      );
    }
  }
});

test('the window for the revised position at Siding Spring is exactly the observable span', () => {
  // Pinned end-to-end: the revision demo hands this site table to the judges.
  const status = computeSiteStatus(
    siteById('sso'),
    noticeAt(REPLAY_V2.raDeg, REPLAY_V2.decDeg, REPLAY_V2.at),
    REPLAY_V2.at,
  );
  assert.equal(status.recommendation, 'RECOMMENDED');
  const window = usableWindow(status);
  assert.equal(window.startUtc.toISOString(), '2024-08-24T02:16:35.000Z');
  assert.equal(window.endUtc.toISOString(), '2024-08-24T03:36:35.000Z');
});
