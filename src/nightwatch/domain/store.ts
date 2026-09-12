/**
 * Event store. The source of truth for NightWatch.
 *
 * Slack is a projection: never read application state back out of a card.
 * Everything the system believes lives here, and every mutation appends an
 * audit row so the thread can be reconstructed after the fact.
 *
 * JSON-backed on purpose - no native build step to fail at 13:00, and the whole
 * store is small enough to rewrite atomically. Swap the two fs calls for
 * better-sqlite3 if it ever outgrows that; nothing above this file changes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Approval, Notice, Observation, ObservationKey, Plan } from './models.ts';

/** Append-only record of everything that happened, in order. */
export interface AuditRow {
  at: Date;
  eventId: string;
  kind:
    | 'notice.received'
    | 'notice.duplicate'
    | 'notice.revised'
    | 'plan.proposed'
    | 'approval.granted'
    | 'approval.revoked'
    | 'observation.started'
    | 'observation.updated'
    | 'observation.rejected';
  /** Human-readable summary. Prose only - never the authority for a number. */
  detail: string;
}

interface StoreShape {
  notices: Notice[];
  plans: Plan[];
  approvals: Approval[];
  observations: Observation[];
  audit: AuditRow[];
}

const EMPTY: StoreShape = { notices: [], plans: [], approvals: [], observations: [], audit: [] };

export function observationKeyOf(key: ObservationKey): string {
  return [key.eventId, key.noticeVersion, key.telescope, key.planHash].join(' ');
}

export class Store {
  #data: StoreShape;
  readonly #path: string | null;

  private constructor(path: string | null, data: StoreShape) {
    this.#path = path;
    this.#data = data;
  }

  /** In-memory store. Used by tests and by the replay harness. */
  static inMemory(): Store {
    return new Store(null, structuredClone(EMPTY));
  }

  /** File-backed store. Creates the file and its directory if absent. */
  static open(path: string): Store {
    let data: StoreShape;
    try {
      data = reviveDates(JSON.parse(readFileSync(path, 'utf8')) as StoreShape);
    } catch {
      data = structuredClone(EMPTY);
    }
    mkdirSync(dirname(path), { recursive: true });
    return new Store(path, data);
  }

  #flush(): void {
    if (this.#path === null) return;
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
    renameSync(tmp, this.#path);
  }

  // -- audit ---------------------------------------------------------------

  audit(eventId: string, kind: AuditRow['kind'], detail: string, at: Date = new Date()): void {
    this.#data.audit.push({ at, eventId, kind, detail });
    this.#flush();
  }

  auditFor(eventId: string): AuditRow[] {
    return this.#data.audit.filter((r) => r.eventId === eventId);
  }

  // -- notices -------------------------------------------------------------

  putNotice(notice: Notice): void {
    this.#data.notices.push(notice);
    this.#flush();
  }

  /** Every notice for an event, oldest first. */
  noticesFor(eventId: string): Notice[] {
    return this.#data.notices
      .filter((n) => n.eventId === eventId)
      .sort((a, b) => a.version - b.version);
  }

  /** The current notice for an event - highest version wins. */
  latestNotice(eventId: string): Notice | undefined {
    return this.noticesFor(eventId).at(-1);
  }

  hasNotice(eventId: string, version: number): boolean {
    return this.#data.notices.some((n) => n.eventId === eventId && n.version === version);
  }

  knownEventIds(): string[] {
    return [...new Set(this.#data.notices.map((n) => n.eventId))];
  }

  // -- plans ---------------------------------------------------------------

  putPlan(plan: Plan): void {
    this.#data.plans.push(plan);
    this.#flush();
  }

  plansFor(eventId: string): Plan[] {
    return this.#data.plans.filter((p) => p.eventId === eventId);
  }

  // -- approvals -----------------------------------------------------------

  putApproval(approval: Approval): void {
    this.#data.approvals.push(approval);
    this.#flush();
  }

  /** Approvals for an event that have not been revoked. */
  liveApprovals(eventId: string): Approval[] {
    return this.#data.approvals.filter((a) => a.eventId === eventId && !a.revokedAt);
  }

  approvalsFor(eventId: string): Approval[] {
    return this.#data.approvals.filter((a) => a.eventId === eventId);
  }

  /**
   * Mutates an approval in place and persists. Callers must go through
   * state.ts rather than calling this directly.
   */
  markRevoked(approval: Approval, at: Date, reason: string): void {
    approval.revokedAt = at;
    approval.revokedReason = reason;
    this.#flush();
  }

  // -- observations --------------------------------------------------------

  /** Idempotent lookup. A retry with the same key must find this. */
  findObservation(key: ObservationKey): Observation | undefined {
    const k = observationKeyOf(key);
    return this.#data.observations.find((o) => observationKeyOf(o.key) === k);
  }

  putObservation(observation: Observation): void {
    const k = observationKeyOf(observation.key);
    const i = this.#data.observations.findIndex((o) => observationKeyOf(o.key) === k);
    if (i >= 0) this.#data.observations[i] = observation;
    else this.#data.observations.push(observation);
    this.#flush();
  }

  observationsFor(eventId: string): Observation[] {
    return this.#data.observations.filter((o) => o.key.eventId === eventId);
  }
}

/** JSON round-trips Dates to strings; put them back. */
function reviveDates(raw: StoreShape): StoreShape {
  const d = (v: unknown): Date => new Date(v as string);
  return {
    notices: (raw.notices ?? []).map((n) => ({ ...n, receivedAt: d(n.receivedAt) })),
    plans: (raw.plans ?? []).map((p) => ({ ...p, startNoLaterThanUtc: d(p.startNoLaterThanUtc) })),
    approvals: (raw.approvals ?? []).map((a) => ({
      ...a,
      approvedAt: d(a.approvedAt),
      ...(a.revokedAt ? { revokedAt: d(a.revokedAt) } : {}),
    })),
    observations: (raw.observations ?? []).map((o) => ({
      ...o,
      startedAt: d(o.startedAt),
      updatedAt: d(o.updatedAt),
    })),
    audit: (raw.audit ?? []).map((r) => ({ ...r, at: d(r.at) })),
  };
}
