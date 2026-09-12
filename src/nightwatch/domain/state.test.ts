/**
 * The gate. These tests are the executable form of the project's thesis:
 * consent is bound to one exact state, and a revision destroys it.
 *
 * If one of these goes red, nothing else in the build matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashPlan, isValidFor, type Plan } from './models.ts';
import { Store } from './store.ts';
import {
  approvalStillValid,
  coverageLoss,
  receiveNotice,
  recordApproval,
  recordPlan,
  revokeApproval,
  StaleApprovalError,
} from './state.ts';
import { FIXTURE_PLAN, FIXTURE_SITE_STATUSES, NOTICE_V1, NOTICE_V1_DUPLICATE, NOTICE_V2 } from '../fixtures.ts';

function planForV2(): Plan {
  return {
    ...FIXTURE_PLAN,
    noticeVersion: 2,
    targetRaDeg: NOTICE_V2.raDeg,
    targetDecDeg: NOTICE_V2.decDeg,
  };
}

function armed(): { store: Store; plan: Plan } {
  const store = Store.inMemory();
  receiveNotice(store, NOTICE_V1);
  const plan = recordPlan(store, FIXTURE_PLAN);
  return { store, plan };
}

// -- the thesis -------------------------------------------------------------

test('a version bump invalidates a standing approval', () => {
  const { store, plan } = armed();
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  assert.equal(approvalStillValid(store, approval, plan), true, 'valid before the revision');

  const intake = receiveNotice(store, NOTICE_V2);

  assert.equal(intake.outcome, 'revision');
  assert.equal(intake.revoked.length, 1, 'the standing approval must be revoked');
  assert.equal(intake.revoked[0], approval);
  assert.equal(approvalStillValid(store, approval, plan), false, 'void after the revision');
  assert.ok(approval.revokedAt instanceof Date);
  assert.match(approval.revokedReason ?? '', /superseded by notice v2/);
});

test('revocation happens during intake, not lazily at the telescope call', () => {
  const { store, plan } = armed();
  recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  receiveNotice(store, NOTICE_V2);

  // Nothing downstream had to ask. The store itself no longer offers it.
  assert.equal(store.liveApprovals(NOTICE_V1.eventId).length, 0);
});

test('an edited plan invalidates consent even at the same notice version', () => {
  const { store, plan } = armed();
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  const longer: Plan = { ...plan, exposureSec: plan.exposureSec * 2 };

  assert.notEqual(hashPlan(longer), hashPlan(plan));
  assert.equal(approvalStillValid(store, approval, longer), false, 'consent does not transfer');
  assert.equal(approvalStillValid(store, approval, plan), true, 'original plan still consented');
});

test('rewording the assumptions does NOT void consent - nothing commanded changed', () => {
  const { store, plan } = armed();
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  const reworded: Plan = { ...plan, assumptions: ['reworded for the card'] };

  assert.equal(hashPlan(reworded), hashPlan(plan));
  assert.equal(approvalStillValid(store, approval, reworded), true);
});

test('consent never transfers across events', () => {
  const { store, plan } = armed();
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  const otherEvent = { ...NOTICE_V1, eventId: 'GRB260912B' };
  const otherPlan: Plan = { ...plan, eventId: 'GRB260912B' };

  assert.equal(isValidFor(approval, otherEvent, otherPlan), false);
});

// -- intake ----------------------------------------------------------------

test('a duplicate notice creates no second request', () => {
  const { store } = armed();
  const before = store.noticesFor(NOTICE_V1.eventId).length;

  const intake = receiveNotice(store, NOTICE_V1_DUPLICATE);

  assert.equal(intake.outcome, 'duplicate');
  assert.equal(intake.revoked.length, 0);
  assert.equal(store.noticesFor(NOTICE_V1.eventId).length, before, 'no second notice stored');
});

test('a duplicate arriving after approval leaves consent intact', () => {
  const { store, plan } = armed();
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  receiveNotice(store, NOTICE_V1_DUPLICATE);

  assert.equal(approvalStillValid(store, approval, plan), true);
});

test('a late lower-version notice does not supersede the current one', () => {
  const store = Store.inMemory();
  receiveNotice(store, NOTICE_V2);
  const plan = recordPlan(store, planForV2());
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  const intake = receiveNotice(store, NOTICE_V1);

  assert.equal(intake.outcome, 'stale');
  assert.equal(intake.revoked.length, 0);
  assert.equal(approvalStillValid(store, approval, plan), true, 'current consent survives');
});

// -- approval recording -----------------------------------------------------

test('a click on a card that a revision already overtook is refused', () => {
  const { store, plan } = armed();
  receiveNotice(store, NOTICE_V2);

  assert.throws(() => recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' }), StaleApprovalError);
});

test('approving the revision restores a valid path to the telescope', () => {
  const { store, plan } = armed();
  recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });
  receiveNotice(store, NOTICE_V2);

  const revised = recordPlan(store, planForV2());
  const approval = recordApproval(store, { plan: revised, approvedBy: 'U_CAPTAIN' });

  assert.equal(approvalStillValid(store, approval, revised), true);
});

test('revocation is idempotent and keeps the first reason', () => {
  const { store, plan } = armed();
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });

  revokeApproval(store, approval, 'first reason');
  const at = approval.revokedAt;
  revokeApproval(store, approval, 'second reason');

  assert.equal(approval.revokedReason, 'first reason');
  assert.equal(approval.revokedAt, at);
});

// -- audit ------------------------------------------------------------------

test('the thread can be reconstructed from the audit log alone', () => {
  const { store, plan } = armed();
  recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });
  receiveNotice(store, NOTICE_V2);

  const kinds = store.auditFor(NOTICE_V1.eventId).map((r) => r.kind);
  assert.deepEqual(kinds, [
    'notice.received',
    'plan.proposed',
    'approval.granted',
    'notice.revised',
    'approval.revoked',
  ]);
});

// -- coverage loss ----------------------------------------------------------

test('coverage loss reports minutes given up and whether the site survives', () => {
  const recommended = FIXTURE_SITE_STATUSES.find((s) => s.recommendation === 'RECOMMENDED');
  const none = FIXTURE_SITE_STATUSES.find((s) => s.recommendation === 'NO_WINDOW');
  assert.ok(recommended && none);

  const total = coverageLoss(recommended, none);
  assert.equal(total.stillObservable, false);
  assert.equal(total.lostMinutes, 288);
  assert.match(total.summary, /entire window/);

  const unchanged = coverageLoss(recommended, recommended);
  assert.equal(unchanged.lostMinutes, 0);
  assert.equal(unchanged.stillObservable, true);
});

test('unknown observability yields unknown coverage loss, never a guess', () => {
  const recommended = FIXTURE_SITE_STATUSES.find((s) => s.recommendation === 'RECOMMENDED');
  assert.ok(recommended);

  const loss = coverageLoss(recommended, { ...recommended, nextWindow: 'unknown' });

  assert.equal(loss.lostMinutes, 'unknown');
  assert.equal(loss.stillObservable, 'unknown');
  assert.match(loss.summary, /unknown/);
});
