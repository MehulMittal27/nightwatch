/**
 * Hardcoded fixtures for the contract sprint.
 *
 * Real-looking numbers, ZERO computation. Every track builds against these
 * until the real implementations land at the swap points:
 *   - Phase 4 replaces FIXTURE_SITE_STATUSES with computeSiteStatus()
 *   - Phase 5 replaces the plan with the planner's output
 *
 * If rendering these requires changing card code later, the contract was
 * wrong - fix models.ts, not the callers.
 */

import type { Notice, Plan, Site, SiteStatus } from './domain/models.js';

// ---------------------------------------------------------------------------
// Sites - static config, the real values
// ---------------------------------------------------------------------------

export const SITES: Site[] = [
  {
    id: 'teide',
    name: 'Teide Observatory, Tenerife',
    latDeg: 28.3,
    lonDeg: -16.5097,
    elevationM: 2390,
    altitudeLimitDeg: 30,
    instruments: ['IAC80 / CAMELOT-2'],
  },
  {
    id: 'kittpeak',
    name: 'Kitt Peak National Observatory, Arizona',
    latDeg: 31.9583,
    lonDeg: -111.5967,
    elevationM: 2096,
    altitudeLimitDeg: 25,
    instruments: ['WIYN 0.9m / HDI'],
  },
  {
    id: 'vbo',
    name: 'Vainu Bappu Observatory, Kavalur',
    latDeg: 12.5764,
    lonDeg: 78.8253,
    elevationM: 725,
    altitudeLimitDeg: 30,
    instruments: ['1.3m JCB / photometer'],
  },
];

// ---------------------------------------------------------------------------
// Notices - v1 and the revision that voids consent
// ---------------------------------------------------------------------------

/** Initial alert. Large error radius, typical of a first-pass localisation. */
export const NOTICE_V1: Notice = {
  eventId: 'GRB260912A',
  version: 1,
  raDeg: 213.4917,
  decDeg: 18.7342,
  errorRadiusDeg: 2.85,
  receivedAt: new Date('2026-09-12T21:14:03Z'),
  raw: {
    notice_type: 'FERMI_GBM_FLT_POS',
    trigger_num: 779412873,
    ra: 213.4917,
    dec: 18.7342,
    error_radius: 2.85,
  },
};

/**
 * The revision. Refined localisation moves the target ~3.1 deg and shrinks the
 * error radius by an order of magnitude. Any approval bound to v1 is now void.
 */
export const NOTICE_V2: Notice = {
  eventId: 'GRB260912A',
  version: 2,
  raDeg: 216.2083,
  decDeg: 17.2156,
  errorRadiusDeg: 0.19,
  receivedAt: new Date('2026-09-12T21:27:41Z'),
  raw: {
    notice_type: 'FERMI_GBM_GND_POS',
    trigger_num: 779412873,
    ra: 216.2083,
    dec: 17.2156,
    error_radius: 0.19,
  },
};

/** A duplicate of v1. Must update the existing thread, never open a second. */
export const NOTICE_V1_DUPLICATE: Notice = {
  ...NOTICE_V1,
  receivedAt: new Date('2026-09-12T21:14:09Z'),
};

// ---------------------------------------------------------------------------
// Site statuses - one of each recommendation, for card layout work
// ---------------------------------------------------------------------------

const COMPUTED_AT = new Date('2026-09-12T21:14:05Z');

export const FIXTURE_SITE_STATUSES: SiteStatus[] = [
  {
    siteId: 'teide',
    recommendation: 'RECOMMENDED',
    altitudeNowDeg: 54.2,
    moonSeparationDeg: 97.4,
    nextWindow: {
      startUtc: new Date('2026-09-12T20:48:00Z'),
      endUtc: new Date('2026-09-13T01:36:00Z'),
      maxAltitudeDeg: 61.8,
    },
    computedAt: COMPUTED_AT,
    notes: ['Above limit now', 'Moon well separated', '4h48m of usable window remaining'],
  },
  {
    siteId: 'vbo',
    recommendation: 'WAIT',
    altitudeNowDeg: -12.6,
    moonSeparationDeg: 96.9,
    nextWindow: {
      startUtc: new Date('2026-09-12T23:52:00Z'),
      endUtc: new Date('2026-09-13T02:14:00Z'),
      maxAltitudeDeg: 38.4,
    },
    computedAt: COMPUTED_AT,
    notes: ['Below limit now', 'Rises above 30 deg at 23:52 UTC'],
  },
  {
    siteId: 'kittpeak',
    recommendation: 'NO_WINDOW',
    altitudeNowDeg: -41.3,
    moonSeparationDeg: 98.1,
    nextWindow: null,
    computedAt: COMPUTED_AT,
    notes: ['Daylight at site', 'Target sets before astronomical twilight'],
  },
];

// ---------------------------------------------------------------------------
// Plan - the proposal approved against NOTICE_V1
// ---------------------------------------------------------------------------

export const FIXTURE_PLAN: Plan = {
  eventId: 'GRB260912A',
  noticeVersion: 1,
  siteId: 'teide',
  targetRaDeg: 213.4917,
  targetDecDeg: 18.7342,
  exposureSec: 120,
  filter: 'r',
  exposureCount: 5,
  startNoLaterThanUtc: new Date('2026-09-13T01:36:00Z'),
  assumptions: [
    'Localisation error 2.85 deg fits within the CAMELOT-2 field in a single pointing',
    'Afterglow assumed r ~ 18.5 at T+30min; 5x120s reaches SNR 10 at that brightness',
    'No target-of-opportunity conflict assumed on the IAC80 queue',
  ],
};
