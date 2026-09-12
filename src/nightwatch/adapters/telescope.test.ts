/**
 * The write boundary under test: idempotency, and consent re-checked at the
 * moment of the call rather than at the moment of the click.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isUnknown, type Plan } from '../domain/models.ts';
import { Store } from '../domain/store.ts';
import { receiveNotice, recordApproval, recordPlan } from '../domain/state.ts';
import { FIXTURE_PLAN, NOTICE_V1, NOTICE_V2 } from '../fixtures.ts';
import { SimulatedTelescope } from './simulator.ts';
import { ApprovalRevokedError, executeApprovedPlan } from './telescope.ts';

function armed(): { store: Store; plan: Plan; approval: ReturnType<typeof recordApproval> } {
  const store = Store.inMemory();
  receiveNotice(store, NOTICE_V1);
  const plan = recordPlan(store, FIXTURE_PLAN);
  const approval = recordApproval(store, { plan, approvedBy: 'U_CAPTAIN' });
  return { store, plan, approval };
}

test('an approved plan runs to completion and returns a labelled result', async () => {
  const { store, plan, approval } = armed();
  const states: string[] = [];

  const obs = await executeApprovedPlan(store, new SimulatedTelescope(), plan, approval, (o) =>
    states.push(o.state),
  );

  assert.equal(obs.state, 'COMPLETE');
  assert.equal(obs.simulated, true, 'every observation in this build is SIMULATED');
  assert.deepEqual(states, ['REQUESTED', 'SLEWING', 'EXPOSING', 'PROCESSING', 'COMPLETE']);
  assert.ok(obs.result);
  assert.ok(!isUnknown(obs.result.snr) && obs.result.snr > 0);
});

test('a retry with the same key schedules nothing and returns the first observation', async () => {
  const { store, plan, approval } = armed();
  const adapter = new SimulatedTelescope();

  const first = await executeApprovedPlan(store, adapter, plan, approval);
  let secondRunCommanded = false;
  const watched = {
    ...adapter,
    id: adapter.id,
    simulated: true,
    slew: async () => {
      secondRunCommanded = true;
    },
    expose: adapter.expose.bind(adapter),
  };

  const second = await executeApprovedPlan(store, watched, plan, approval);

  assert.equal(secondRunCommanded, false, 'a retry must never command the telescope again');
  assert.deepEqual(second, first);
  assert.equal(store.observationsFor(plan.eventId).length, 1);
});

test('a revoked approval is blocked at the boundary, before any command', async () => {
  const { store, plan, approval } = armed();
  receiveNotice(store, NOTICE_V2); // revokes it

  let commanded = false;
  const adapter = new SimulatedTelescope();
  const watched = {
    id: adapter.id,
    simulated: true,
    slew: async () => {
      commanded = true;
    },
    expose: adapter.expose.bind(adapter),
  };

  await assert.rejects(
    () => executeApprovedPlan(store, watched, plan, approval),
    ApprovalRevokedError,
  );
  assert.equal(commanded, false, 'the telescope must never be commanded without live consent');

  const obs = store.observationsFor(plan.eventId);
  assert.equal(obs[0]?.state, 'REJECTED');
});

test('a revision landing DURING the slew stops the exposure', async () => {
  const { store, plan, approval } = armed();
  let exposed = false;

  const watched = {
    id: 'sim-teide-iac80',
    simulated: true,
    // The revision arrives while the mount is still moving.
    slew: async () => {
      receiveNotice(store, NOTICE_V2);
    },
    expose: async () => {
      exposed = true;
      throw new Error('unreachable');
    },
  };

  await assert.rejects(
    () => executeApprovedPlan(store, watched, plan, approval),
    ApprovalRevokedError,
  );
  assert.equal(exposed, false, 'consent must be re-checked after the slew, not only before it');
});

test('the simulator is deterministic - two runs produce identical numbers', async () => {
  const a = armed();
  const b = armed();

  const first = await executeApprovedPlan(a.store, new SimulatedTelescope(), a.plan, a.approval);
  const second = await executeApprovedPlan(b.store, new SimulatedTelescope(), b.plan, b.approval);

  assert.deepEqual(first.result, second.result);
});

test('a telescope failure is recorded, not thrown away', async () => {
  const { store, plan, approval } = armed();

  const obs = await executeApprovedPlan(
    store,
    new SimulatedTelescope({ failSlew: true }),
    plan,
    approval,
  );

  assert.equal(obs.state, 'FAILED');
  assert.match(obs.failureReason ?? '', /below mount limit/);
});
