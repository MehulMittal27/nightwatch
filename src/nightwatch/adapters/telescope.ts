/**
 * The write boundary.
 *
 * Everything past this interface commands hardware. The kit's sponsor guide is
 * explicit that approval cards guide behaviour but do not enforce a gate around
 * every tool, and that authorization must be enforced at the write boundary
 * yourself. This file is where NightWatch answers that.
 *
 * Adapters are dumb on purpose: they slew and expose. They do not decide
 * whether they are allowed to. `executeApprovedPlan` below is the only way in,
 * and it re-checks consent against the live store immediately before it calls
 * the adapter - never earlier, never cached.
 */

import type { Approval, Observation, ObservationKey, ObservationResult, Plan } from '../domain/models.ts';
import { approvalStillValid } from '../domain/state.ts';
import type { Store } from '../domain/store.ts';

export interface SlewRequest {
  raDeg: number;
  decDeg: number;
}

export interface ExposeRequest {
  exposureSec: number;
  filter: string;
  count: number;
}

export interface TelescopeAdapter {
  /** Stable identifier, used in the idempotency key. */
  readonly id: string;
  /** True for every adapter in this build. Cards must say SIMULATED. */
  readonly simulated: boolean;
  slew(req: SlewRequest): Promise<void>;
  expose(req: ExposeRequest): Promise<ObservationResult>;
}

/** Raised when a telescope call is attempted without live consent. */
export class ApprovalRevokedError extends Error {}

export type ObservationListener = (observation: Observation) => void;

/**
 * Execute an approved plan.
 *
 * Idempotent on (eventId, noticeVersion, telescope, planHash): calling twice
 * with the same key returns the first observation and commands nothing.
 */
export async function executeApprovedPlan(
  store: Store,
  adapter: TelescopeAdapter,
  plan: Plan,
  approval: Approval,
  onUpdate: ObservationListener = () => {},
): Promise<Observation> {
  const key: ObservationKey = {
    eventId: plan.eventId,
    noticeVersion: plan.noticeVersion,
    telescope: adapter.id,
    planHash: approval.planHash,
  };

  // Idempotency first: a retry must never schedule a second observation.
  const existing = store.findObservation(key);
  if (existing !== undefined) return existing;

  // THE GATE. Immediately before the first command, against the live store.
  // Not at approval time. Not cached. Re-checked again before the exposure.
  if (!approvalStillValid(store, approval, plan)) {
    const rejected = write(store, key, adapter, 'REJECTED', onUpdate, {
      failureReason: approval.revokedReason ?? 'approval is no longer valid for the current notice',
    });
    store.audit(plan.eventId, 'observation.rejected', `telescope call blocked: ${rejected.failureReason}`);
    throw new ApprovalRevokedError(rejected.failureReason ?? 'approval revoked');
  }

  let observation = write(store, key, adapter, 'REQUESTED', onUpdate);
  store.audit(plan.eventId, 'observation.started', `${adapter.id} accepted plan ${approval.planHash}`);

  try {
    observation = write(store, key, adapter, 'SLEWING', onUpdate);
    await adapter.slew({ raDeg: plan.targetRaDeg, decDeg: plan.targetDecDeg });

    // Re-check: a revision can land during the slew, which on a real mount is
    // the better part of a minute. Consent must still hold at the exposure.
    if (!approvalStillValid(store, approval, plan)) {
      const rejected = write(store, key, adapter, 'REJECTED', onUpdate, {
        failureReason: approval.revokedReason ?? 'approval revoked during slew',
      });
      store.audit(plan.eventId, 'observation.rejected', `exposure blocked: ${rejected.failureReason}`);
      throw new ApprovalRevokedError(rejected.failureReason ?? 'approval revoked during slew');
    }

    observation = write(store, key, adapter, 'EXPOSING', onUpdate);
    const result = await adapter.expose({
      exposureSec: plan.exposureSec,
      filter: plan.filter,
      count: plan.exposureCount,
    });

    observation = write(store, key, adapter, 'PROCESSING', onUpdate);
    observation = write(store, key, adapter, 'COMPLETE', onUpdate, { result });
    store.audit(plan.eventId, 'observation.updated', `${adapter.id} completed plan ${approval.planHash}`);
    return observation;
  } catch (err) {
    if (err instanceof ApprovalRevokedError) throw err;
    const failed = write(store, key, adapter, 'FAILED', onUpdate, {
      failureReason: err instanceof Error ? err.message : String(err),
    });
    store.audit(plan.eventId, 'observation.updated', `${adapter.id} failed: ${failed.failureReason}`);
    return failed;
  }
}

function write(
  store: Store,
  key: ObservationKey,
  adapter: TelescopeAdapter,
  state: Observation['state'],
  onUpdate: ObservationListener,
  extra: Partial<Pick<Observation, 'result' | 'failureReason'>> = {},
): Observation {
  const now = new Date();
  const previous = store.findObservation(key);
  const observation: Observation = {
    key,
    state,
    simulated: adapter.simulated,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    ...(previous?.result ? { result: previous.result } : {}),
    ...(previous?.failureReason ? { failureReason: previous.failureReason } : {}),
    ...extra,
  };
  store.putObservation(observation);
  onUpdate(observation);
  return observation;
}
