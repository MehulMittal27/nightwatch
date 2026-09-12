/**
 * The state machine, and the invalidation path that is the whole project.
 *
 * One rule governs this file: consent is bound to exactly one
 * (eventId, noticeVersion, siteId, planHash). Nothing here ever widens it.
 * When a revision arrives, every approval standing against the superseded
 * version is revoked BEFORE anything else is allowed to happen.
 */

import {
  hashPlan,
  isUnknown,
  isValidFor,
  UNKNOWN,
  type Approval,
  type Maybe,
  type Notice,
  type Plan,
  type SiteStatus,
} from './models.ts';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------
// Notice intake
// ---------------------------------------------------------------------------

export type NoticeOutcome =
  /** First notice for this event. Open a thread. */
  | 'new'
  /** Same event, same version, seen before. Update the thread; create nothing. */
  | 'duplicate'
  /** Same event, higher version. Consent against the old version is now void. */
  | 'revision'
  /** Same event, LOWER version arriving late. Record it, change nothing. */
  | 'stale';

export interface NoticeIntake {
  outcome: NoticeOutcome;
  notice: Notice;
  /** Approvals revoked as a direct result of this notice. Empty unless 'revision'. */
  revoked: Approval[];
  /** The version this notice superseded, when it was a revision. */
  supersededVersion?: number;
}

/**
 * Take a notice into the store and apply its consequences.
 *
 * This is the only door notices come through. It is deliberately synchronous
 * and total: by the time it returns, no revoked approval can still be treated
 * as live by anything downstream.
 */
export function receiveNotice(store: Store, notice: Notice, at: Date = new Date()): NoticeIntake {
  const previous = store.latestNotice(notice.eventId);

  if (previous === undefined) {
    store.putNotice(notice);
    store.audit(notice.eventId, 'notice.received', `v${notice.version} received`, at);
    return { outcome: 'new', notice, revoked: [] };
  }

  if (store.hasNotice(notice.eventId, notice.version)) {
    store.audit(
      notice.eventId,
      'notice.duplicate',
      `duplicate of v${notice.version} ignored; existing thread retained`,
      at,
    );
    return { outcome: 'duplicate', notice, revoked: [] };
  }

  if (notice.version < previous.version) {
    store.putNotice(notice);
    store.audit(
      notice.eventId,
      'notice.received',
      `late v${notice.version} recorded; v${previous.version} remains current`,
      at,
    );
    return { outcome: 'stale', notice, revoked: [] };
  }

  // A genuine revision. Store it first so nothing can observe a window in which
  // the new version exists but the old approvals have not yet been revoked.
  store.putNotice(notice);
  store.audit(
    notice.eventId,
    'notice.revised',
    `v${previous.version} superseded by v${notice.version}`,
    at,
  );

  const revoked: Approval[] = [];
  for (const approval of store.liveApprovals(notice.eventId)) {
    if (approval.noticeVersion >= notice.version) continue;
    revokeApproval(
      store,
      approval,
      `superseded by notice v${notice.version}: consent was given against v${approval.noticeVersion}`,
      at,
    );
    revoked.push(approval);
  }

  return { outcome: 'revision', notice, revoked, supersededVersion: previous.version };
}

// ---------------------------------------------------------------------------
// Plans and approvals
// ---------------------------------------------------------------------------

export function recordPlan(store: Store, plan: Plan, at: Date = new Date()): Plan {
  store.putPlan(plan);
  store.audit(
    plan.eventId,
    'plan.proposed',
    `plan ${hashPlan(plan)} proposed for ${plan.siteId} against v${plan.noticeVersion}`,
    at,
  );
  return plan;
}

export class StaleApprovalError extends Error {}

/**
 * Record human consent for exactly one plan.
 *
 * Refuses to record consent against anything but the current notice: if a
 * revision landed while the card was on screen, the click is stale and must
 * not become an approval. The human is re-asked against the new proposal.
 */
export function recordApproval(
  store: Store,
  args: { plan: Plan; approvedBy: string },
  at: Date = new Date(),
): Approval {
  const current = store.latestNotice(args.plan.eventId);
  if (current === undefined) {
    throw new StaleApprovalError(`no notice on file for ${args.plan.eventId}`);
  }
  if (args.plan.noticeVersion !== current.version) {
    throw new StaleApprovalError(
      `plan was computed against v${args.plan.noticeVersion} but v${current.version} is current`,
    );
  }

  const approval: Approval = {
    eventId: args.plan.eventId,
    noticeVersion: args.plan.noticeVersion,
    siteId: args.plan.siteId,
    planHash: hashPlan(args.plan),
    approvedBy: args.approvedBy,
    approvedAt: at,
  };
  store.putApproval(approval);
  store.audit(
    approval.eventId,
    'approval.granted',
    `${args.approvedBy} approved plan ${approval.planHash} for ${approval.siteId} (v${approval.noticeVersion})`,
    at,
  );
  return approval;
}

export function revokeApproval(
  store: Store,
  approval: Approval,
  reason: string,
  at: Date = new Date(),
): Approval {
  if (approval.revokedAt) return approval;
  store.markRevoked(approval, at, reason);
  store.audit(
    approval.eventId,
    'approval.revoked',
    `approval ${approval.planHash} revoked: ${reason}`,
    at,
  );
  return approval;
}

/**
 * The check that runs immediately before every telescope call.
 *
 * Reads the CURRENT notice out of the store rather than trusting a notice
 * handed in by a caller - a caller holding a stale notice is exactly the bug
 * this is here to catch. Never cache the result.
 */
export function approvalStillValid(store: Store, approval: Approval, plan: Plan): boolean {
  const current = store.latestNotice(approval.eventId);
  if (current === undefined) return false;
  return isValidFor(approval, current, plan);
}

// ---------------------------------------------------------------------------
// Coverage loss - what the human gives up when consent is voided
// ---------------------------------------------------------------------------

export interface CoverageLoss {
  /** Observing minutes lost at this site, or unknown when either side is unknown. */
  lostMinutes: Maybe<number>;
  /** Whether the site still has any window at all under the new notice. */
  stillObservable: Maybe<boolean>;
  /** One line for the revocation card. Prose only. */
  summary: string;
}

/**
 * Compare a site's observability before and after a revision.
 * Both inputs are computed by the science layer; nothing here invents a number.
 */
export function coverageLoss(before: SiteStatus, after: SiteStatus): CoverageLoss {
  const beforeMin = windowMinutes(before);
  const afterMin = windowMinutes(after);

  if (isUnknown(beforeMin) || isUnknown(afterMin)) {
    return {
      lostMinutes: UNKNOWN,
      stillObservable: UNKNOWN,
      summary: 'Coverage change unknown - observability could not be computed for this site.',
    };
  }

  const lost = Math.max(0, Math.round(beforeMin - afterMin));
  const stillObservable = afterMin > 0;

  if (!stillObservable) {
    return {
      lostMinutes: lost,
      stillObservable: false,
      summary: `Site loses its entire window (${Math.round(beforeMin)} min); target is no longer observable from here tonight.`,
    };
  }
  if (lost === 0) {
    return {
      lostMinutes: 0,
      stillObservable: true,
      summary: `No coverage lost; ${Math.round(afterMin)} min still available.`,
    };
  }
  return {
    lostMinutes: lost,
    stillObservable: true,
    summary: `${lost} min of coverage lost; ${Math.round(afterMin)} min still available.`,
  };
}

function windowMinutes(status: SiteStatus): Maybe<number> {
  if (isUnknown(status.nextWindow)) return UNKNOWN;
  if (status.nextWindow === null) return 0;
  const ms = status.nextWindow.endUtc.getTime() - status.nextWindow.startUtc.getTime();
  return ms / 60_000;
}
