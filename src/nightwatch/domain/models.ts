/**
 * NightWatch domain contract.
 *
 * This file is the interface every track builds against. P1 renders these
 * types, P2 implements the gate over them, P3 computes them. Change a shape
 * here only at a SYNC point - a silent change breaks two other people.
 *
 * Rules this file encodes (see AGENTS.nightwatch.md):
 *  - No LLM ever produces a number. Every numeric field here is computed.
 *  - All times are UTC. `Date` values are instants; never format them with a
 *    local timezone in the domain layer.
 *  - Unknown is a value, not a gap. Missing or stale data is `"unknown"`,
 *    which blocks automatic recommendation. Never guess or interpolate.
 */

import { createHash } from 'node:crypto';

/** Missing or stale data. Renders literally as `unknown`; blocks recommendation. */
export const UNKNOWN = 'unknown' as const;
export type Unknown = typeof UNKNOWN;

/** A value that may legitimately be unavailable. Callers must handle both. */
export type Maybe<T> = T | Unknown;

export function isUnknown<T>(v: Maybe<T>): v is Unknown {
  return v === UNKNOWN;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * One GCN notice. A revision of the same event arrives as a NEW Notice with
 * the same `eventId` and an incremented `version`. Notices are immutable.
 */
export interface Notice {
  eventId: string;
  /** Increments on revision. The number consent is bound to. */
  version: number;
  raDeg: number;
  decDeg: number;
  errorRadiusDeg: number;
  /** UTC instant the notice was received. */
  receivedAt: Date;
  /** Original payload, stored verbatim, never mutated. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** Static configuration of an observing site. Hand-written, never computed. */
export interface Site {
  id: string;
  name: string;
  latDeg: number;
  /** East-positive. */
  lonDeg: number;
  elevationM: number;
  /** Target must be above this altitude to be observable from here. */
  altitudeLimitDeg: number;
  instruments: string[];
}

export type SiteRecommendation =
  /** Observable now, above the limit, Moon acceptable. */
  | 'RECOMMENDED'
  /** Rises above the limit later tonight. */
  | 'WAIT'
  /** Never clears the limit tonight. */
  | 'NO_WINDOW'
  /** Inputs were missing or stale. Never auto-recommend from this. */
  | 'UNKNOWN';

/** A contiguous span during which the target is above the site's limit. */
export interface ObservingWindow {
  /** UTC. */
  startUtc: Date;
  /** UTC. */
  endUtc: Date;
  /** Peak altitude reached within the span. */
  maxAltitudeDeg: number;
}

/**
 * The computed observability of one target from one site.
 * Every field here comes from astronomy-engine. None comes from a model.
 */
export interface SiteStatus {
  siteId: string;
  recommendation: SiteRecommendation;
  /** Target altitude at `computedAt`. Negative means below the horizon. */
  altitudeNowDeg: Maybe<number>;
  /** Angular separation from the Moon. Small values degrade the observation. */
  moonSeparationDeg: Maybe<number>;
  /** Next usable window tonight, or `null` when there is none at all. */
  nextWindow: Maybe<ObservingWindow | null>;
  /**
   * UTC instant these numbers were computed for. Slack renders this beside
   * every number so a stale card is visibly stale.
   */
  computedAt: Date;
  /** Why the recommendation is what it is. Prose is allowed here; numbers are not invented. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** A proposed observation. Proposing is free; executing requires approval. */
export interface Plan {
  eventId: string;
  /** The notice version this plan was computed from. */
  noticeVersion: number;
  siteId: string;
  targetRaDeg: number;
  targetDecDeg: number;
  exposureSec: number;
  filter: string;
  /** Number of exposures in the sequence. */
  exposureCount: number;
  /** UTC. Past this instant the plan is no longer worth executing. */
  startNoLaterThanUtc: Date;
  /** Stated assumptions behind the proposal, for the human reading the card. */
  assumptions: string[];
}

/**
 * Stable content hash of a plan. Two plans that would command the telescope
 * identically must hash identically; any change that alters what the telescope
 * does must change the hash. Approvals are bound to this value.
 */
export function hashPlan(plan: Plan): string {
  // Only the fields that determine what the telescope is commanded to do.
  // `assumptions` is prose for the human reading the card: rewording it must
  // NOT void a standing approval, because nothing about the pointing changed.
  const commanded = [
    plan.eventId,
    plan.noticeVersion,
    plan.siteId,
    plan.targetRaDeg.toFixed(6),
    plan.targetDecDeg.toFixed(6),
    plan.exposureSec,
    plan.filter,
    plan.exposureCount,
    plan.startNoLaterThanUtc.toISOString(),
  ].join('\u0000');
  return createHash('sha256').update(commanded).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Approval - the thesis
// ---------------------------------------------------------------------------

/**
 * Human consent for exactly one (event, notice version, site, plan).
 * Consent never generalises: a revised notice or an edited plan voids it.
 */
export interface Approval {
  eventId: string;
  /** The version consent was given against. */
  noticeVersion: number;
  siteId: string;
  planHash: string;
  /** Slack user id of the human who approved. */
  approvedBy: string;
  approvedAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
}

/**
 * Is this approval still valid for the current notice and plan?
 *
 * Call this IMMEDIATELY BEFORE every telescope call. Not at approval time.
 * Never cache the result. This is the whole project.
 */
export function isValidFor(a: Approval, n: Notice, p: Plan): boolean {
  return !a.revokedAt
    && a.eventId === n.eventId
    && a.noticeVersion === n.version
    && a.planHash === hashPlan(p);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ObservationState =
  | 'REQUESTED'
  | 'SLEWING'
  | 'EXPOSING'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'FAILED'
  | 'REJECTED';

/**
 * Idempotency key for every external action.
 * A retry with the same key must never schedule a second observation.
 */
export interface ObservationKey {
  eventId: string;
  noticeVersion: number;
  telescope: string;
  planHash: string;
}

export interface Observation {
  key: ObservationKey;
  state: ObservationState;
  /** Always true for this build. Every card must say SIMULATED. */
  simulated: boolean;
  startedAt: Date;
  updatedAt: Date;
  /** Present once the state is COMPLETE. */
  result?: ObservationResult;
  /** Present when FAILED or REJECTED. */
  failureReason?: string;
}

export interface ObservationResult {
  candidateRaDeg: Maybe<number>;
  candidateDecDeg: Maybe<number>;
  snr: Maybe<number>;
  limitingMagnitude: Maybe<number>;
  /** Path or URL to the simulated frame. Labelled SIMULATED wherever shown. */
  imageRef: Maybe<string>;
}

// ---------------------------------------------------------------------------
// Signatures implemented elsewhere
// ---------------------------------------------------------------------------

/**
 * P3 - science/visibility.ts. Pure: no I/O, no model calls.
 * `at` is the UTC instant to compute for.
 */
export function computeSiteStatus(_site: Site, _notice: Notice, _at: Date): SiteStatus {
  throw new Error('not implemented');
}

/**
 * P2 - adapters. Executes an approved plan against the telescope adapter.
 * MUST re-check `isValidFor` immediately before commanding, and MUST be
 * idempotent on `ObservationKey`.
 */
export function executePlan(_plan: Plan, _approval: Approval, _notice: Notice): Promise<Observation> {
  throw new Error('not implemented');
}
