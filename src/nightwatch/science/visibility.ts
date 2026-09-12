/**
 * Pure astronomy calculations for NightWatch site recommendations.
 *
 * Keep all coordinate and visibility numbers here. The language model may
 * explain these results, but it must never produce them.
 */

import { Body, Equator, Horizon, Observer } from 'astronomy-engine';

import { UNKNOWN } from '../domain/models.ts';
import type {
  Notice,
  ObservingWindow,
  Site,
  SiteStatus,
} from '../domain/models.ts';

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const GRID_STEP_MS = 5 * 60 * 1000;
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
const GRID_SAMPLE_COUNT = LOOKAHEAD_MS / GRID_STEP_MS;
const MAX_NOTICE_AGE_MS = LOOKAHEAD_MS;

/** Convert right ascension from degrees (the domain representation) to hours. */
export function raDegToHours(raDeg: number): number {
  return raDeg / 15;
}

function isFiniteDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function isFreshNotice(notice: Notice, at: Date): boolean {
  const receivedAt = notice.receivedAt.getTime();
  const observedAt = at.getTime();
  return Number.isFinite(receivedAt)
    && receivedAt <= observedAt
    && observedAt - receivedAt <= MAX_NOTICE_AGE_MS;
}

function hasValidInputs(site: Site, notice: Notice, at: Date): boolean {
  return site.id.length > 0
    && Number.isFinite(site.latDeg)
    && site.latDeg >= -90
    && site.latDeg <= 90
    && Number.isFinite(site.lonDeg)
    && site.lonDeg >= -180
    && site.lonDeg <= 180
    && Number.isFinite(site.elevationM)
    && Number.isFinite(site.altitudeLimitDeg)
    && notice.eventId.length > 0
    && Number.isFinite(notice.raDeg)
    && Number.isFinite(notice.decDeg)
    && notice.raDeg >= 0
    && notice.raDeg <= 360
    && notice.decDeg >= -90
    && notice.decDeg <= 90
    && isFiniteDate(notice.receivedAt)
    && isFiniteDate(at)
    && isFreshNotice(notice, at);
}

function unknownStatus(site: Site, at: Date, reason: string): SiteStatus {
  return {
    siteId: site.id,
    recommendation: 'UNKNOWN',
    altitudeNowDeg: UNKNOWN,
    moonSeparationDeg: UNKNOWN,
    nextWindow: UNKNOWN,
    computedAt: new Date(at.getTime()),
    notes: [reason],
  };
}

function observerFor(site: Site): Observer {
  return new Observer(site.latDeg, site.lonDeg, site.elevationM);
}

function altitudeAt(
  observer: Observer,
  notice: Notice,
  at: Date,
): number {
  return Horizon(at, observer, raDegToHours(notice.raDeg), notice.decDeg).altitude;
}

function angularSeparationDeg(
  firstRaDeg: number,
  firstDecDeg: number,
  secondRaDeg: number,
  secondDecDeg: number,
): number {
  const firstRa = firstRaDeg * DEGREES_TO_RADIANS;
  const firstDec = firstDecDeg * DEGREES_TO_RADIANS;
  const secondRa = secondRaDeg * DEGREES_TO_RADIANS;
  const secondDec = secondDecDeg * DEGREES_TO_RADIANS;
  const cosine = Math.sin(firstDec) * Math.sin(secondDec)
    + Math.cos(firstDec) * Math.cos(secondDec) * Math.cos(firstRa - secondRa);

  // Floating-point roundoff can move a valid cosine just outside [-1, 1].
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * RADIANS_TO_DEGREES;
}

function moonSeparationDeg(
  observer: Observer,
  notice: Notice,
  at: Date,
): number {
  const moon = Equator(Body.Moon, at, observer, true, true);
  return angularSeparationDeg(notice.raDeg, notice.decDeg, moon.ra * 15, moon.dec);
}

/**
 * Find the first contiguous above-limit span on a five-minute grid covering
 * the next 24 hours. The grid boundaries are intentionally conservative:
 * no interpolation is used to invent a more precise crossing time.
 *
 * Both `startUtc` and `endUtc` are grid samples at which the target was
 * actually measured above `site.altitudeLimitDeg`. The next sample after
 * `endUtc` is the one that fell below the limit, so the reported span never
 * claims time the target is not observable. A span the grid only ever caught
 * once is reported with `endUtc === startUtc` rather than rounded outwards.
 */
function nextWindow(
  site: Site,
  observer: Observer,
  notice: Notice,
  at: Date,
): ObservingWindow | null {
  let startUtc: Date | undefined;
  let lastAboveLimitAt: Date | undefined;
  let maxAltitudeDeg = Number.NEGATIVE_INFINITY;

  for (let index = 0; index <= GRID_SAMPLE_COUNT; index += 1) {
    const sampleAt = new Date(at.getTime() + index * GRID_STEP_MS);
    const altitudeDeg = altitudeAt(observer, notice, sampleAt);

    if (altitudeDeg >= site.altitudeLimitDeg) {
      startUtc ??= sampleAt;
      lastAboveLimitAt = sampleAt;
      maxAltitudeDeg = Math.max(maxAltitudeDeg, altitudeDeg);
      continue;
    }

    if (startUtc && lastAboveLimitAt) {
      return {
        startUtc,
        endUtc: lastAboveLimitAt,
        maxAltitudeDeg,
      };
    }
  }

  if (!startUtc || !lastAboveLimitAt) {
    return null;
  }

  return {
    startUtc,
    endUtc: lastAboveLimitAt,
    maxAltitudeDeg,
  };
}

function notesFor(
  recommendation: SiteStatus['recommendation'],
  nextUsableWindow: ObservingWindow | null,
): string[] {
  switch (recommendation) {
    case 'RECOMMENDED':
      return ['Target is above the site altitude limit at the computation time.'];
    case 'WAIT':
      return ['Target is below the site altitude limit now; a later grid window is available.'];
    case 'NO_WINDOW':
      return ['No five-minute grid window clears the site altitude limit in the next 24 hours.'];
    case 'UNKNOWN':
      return ['Input data is missing or stale; automatic recommendation is blocked.'];
    default:
      return nextUsableWindow
        ? ['A usable window is available.']
        : ['No usable window is available.'];
  }
}

/**
 * Compute deterministic visibility for one site.
 *
 * This function has no I/O and no model calls. Every returned number comes
 * from astronomy-engine at the requested instant, and every time is a UTC instant.
 */
export function computeSiteStatus(
  site: Site,
  notice: Notice,
  at: Date,
): SiteStatus {
  if (!hasValidInputs(site, notice, at)) {
    return unknownStatus(site, at, 'Input data is missing or stale; automatic recommendation is blocked.');
  }

  const observer = observerFor(site);
  const altitudeNowDeg = altitudeAt(observer, notice, at);
  const moonSeparation = moonSeparationDeg(observer, notice, at);
  const usableWindow = nextWindow(site, observer, notice, at);

  if (!Number.isFinite(altitudeNowDeg) || !Number.isFinite(moonSeparation)) {
    return unknownStatus(site, at, 'Astronomy input produced an unknown value; automatic recommendation is blocked.');
  }

  const recommendation: SiteStatus['recommendation'] = altitudeNowDeg >= site.altitudeLimitDeg
    ? 'RECOMMENDED'
    : usableWindow
      ? 'WAIT'
      : 'NO_WINDOW';

  return {
    siteId: site.id,
    recommendation,
    altitudeNowDeg,
    moonSeparationDeg: moonSeparation,
    nextWindow: usableWindow,
    computedAt: new Date(at.getTime()),
    notes: notesFor(recommendation, usableWindow),
  };
}
