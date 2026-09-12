/**
 * NightWatch in Slack.
 *
 * Two rules shape every line of this file:
 *
 * 1. **No number here comes from the model.** Every figure rendered below is
 *    read out of the event store or the science layer. The agent writes prose;
 *    it never supplies a coordinate, an altitude, or an SNR.
 * 2. **Slack is a projection.** Nothing is read back out of a card. The store
 *    is the source of truth and the cards are rendered from it.
 *
 * The approval round-trip is the point of the project: consent is bound to one
 * exact (event, notice version, site, plan hash), and a revision destroys it
 * visibly, in the thread, while the telescope is mid-slew.
 */
import {
  defineChannelTool,
  Message,
  Header,
  Section,
  Markdown,
  Fields,
  Field,
  Context,
  Divider,
  Actions,
  Button,
  Table,
  Row,
  Cell,
} from "@copilotkit/channels";
import { z } from "zod";

import {
  hashPlan,
  isUnknown,
  type Maybe,
  type Notice,
  type Observation,
  type Plan,
  type SiteStatus,
} from "../../../src/nightwatch/domain/models.ts";
import { Store } from "../../../src/nightwatch/domain/store.ts";
import {
  approvalStillValid,
  coverageLoss,
  receiveNotice,
  recordApproval,
  recordPlan,
} from "../../../src/nightwatch/domain/state.ts";
import { SimulatedTelescope } from "../../../src/nightwatch/adapters/simulator.ts";
import { executeApprovedPlan } from "../../../src/nightwatch/adapters/telescope.ts";
import {
  FIXTURE_PLAN,
  FIXTURE_PLAN_V2,
  FIXTURE_SITE_STATUSES,
  FIXTURE_SITE_STATUSES_V2,
  NOTICE_V1,
  NOTICE_V2,
  SITES,
} from "../../../src/nightwatch/fixtures.ts";

/** One store for the process. Slack holds no state; this does. */
const store = Store.inMemory();

/**
 * How long into the slew the revision lands.
 *
 * It has to happen INSIDE a live delivery: the thread handed to a handler stops
 * accepting operations the moment that delivery closes, so a timer firing after
 * the turn cannot post. Landing it mid-slew is also the sharpest version of the
 * thesis - consent dies between the slew and the shutter.
 */
const REVISION_AFTER_SLEW_MS = 3_500;

/** The drill fires exactly one revision, however many times APPROVE is clicked. */
let revisionLanded = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ACCENT = {
  alert: "#B23A48",
  proposal: "#1F6FB2",
  voided: "#C4145F",
  running: "#8A5C10",
  done: "#2E7D5B",
} as const;

const siteName = (id: string) => SITES.find((s) => s.id === id)?.name ?? id;

/** Slack truncates a wide table. The observatory name alone identifies the row. */
const shortSite = (id: string) => siteName(id).split(",")[0] ?? id;

function num(v: Maybe<number>, digits = 1, suffix = ""): string {
  return isUnknown(v) ? "unknown" : `${v.toFixed(digits)}${suffix}`;
}

const utc = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

function windowText(status: SiteStatus): string {
  if (isUnknown(status.nextWindow)) return "unknown";
  if (status.nextWindow === null) return "none tonight";
  const w = status.nextWindow;
  const mins = Math.round((w.endUtc.getTime() - w.startUtc.getTime()) / 60_000);
  return `${utc(w.startUtc)}-${utc(w.endUtc)} (${mins} min)`;
}

const VERDICT: Record<SiteStatus["recommendation"], string> = {
  RECOMMENDED: "OBSERVABLE",
  WAIT: "RISES LATER",
  NO_WINDOW: "NO WINDOW",
  UNKNOWN: "UNKNOWN",
};

// ---------------------------------------------------------------------------
// Cards - every value below is read from the store, never generated
// ---------------------------------------------------------------------------

function alertCard(notice: Notice, statuses: SiteStatus[]) {
  const computedAt = statuses[0]?.computedAt;
  return (
    <Message accent={ACCENT.alert}>
      <Header>{`${notice.eventId} - notice v${notice.version}`}</Header>
      <Context>
        {notice.version === 1
          ? "Gamma-ray burst alert received"
          : "REVISED LOCALISATION received"}
      </Context>
      <Fields>
        <Field label="Right ascension">{`${notice.raDeg.toFixed(4)} deg`}</Field>
        <Field label="Declination">{`${notice.decDeg.toFixed(4)} deg`}</Field>
        <Field label="Error radius">{`${notice.errorRadiusDeg.toFixed(2)} deg`}</Field>
        <Field label="Received">{utc(notice.receivedAt)}</Field>
      </Fields>
      <Divider />
      <Table
        columns={[
          { header: "Site" },
          { header: "Alt now" },
          { header: "Window tonight" },
          { header: "Verdict" },
        ]}
      >
        {statuses.map((s) => (
          <Row>
            <Cell>{shortSite(s.siteId)}</Cell>
            <Cell>{num(s.altitudeNowDeg, 1, " deg")}</Cell>
            <Cell>{windowText(s)}</Cell>
            <Cell>{VERDICT[s.recommendation]}</Cell>
          </Row>
        ))}
      </Table>
      <Context>
        {`Moon separation: ${statuses.map((s) => `${shortSite(s.siteId)} ${num(s.moonSeparationDeg, 0, " deg")}`).join("  ·  ")}`}
      </Context>
      {computedAt ? <Context>{`Computed for ${utc(computedAt)}`}</Context> : null}
    </Message>
  );
}

function progressCard(observation: Observation, plan: Plan) {
  const label: Record<Observation["state"], string> = {
    REQUESTED: "Accepted by the telescope",
    SLEWING: "Slewing to target...",
    EXPOSING: "Exposing...",
    PROCESSING: "Processing frames...",
    COMPLETE: "Complete",
    FAILED: "Failed",
    REJECTED: "Blocked - no valid approval",
  };
  const done = observation.state === "COMPLETE";
  return (
    <Message accent={done ? ACCENT.done : ACCENT.running}>
      <Header>{`SIMULATED observation - ${siteName(plan.siteId)}`}</Header>
      <Context>{`${label[observation.state]} - ${observation.key.telescope}`}</Context>
      {done && observation.result ? (
        <Fields>
          <Field label="Candidate RA">{num(observation.result.candidateRaDeg, 4, " deg")}</Field>
          <Field label="Candidate Dec">{num(observation.result.candidateDecDeg, 4, " deg")}</Field>
          <Field label="SNR">{num(observation.result.snr, 1)}</Field>
          <Field label="Limiting mag">{num(observation.result.limitingMagnitude, 2)}</Field>
        </Fields>
      ) : null}
      {observation.failureReason ? (
        <Section>
          <Markdown>{observation.failureReason}</Markdown>
        </Section>
      ) : null}
      <Context>SIMULATED - no real telescope was commanded.</Context>
    </Message>
  );
}

// ---------------------------------------------------------------------------
// The approval round-trip
// ---------------------------------------------------------------------------

/**
 * Post a proposal carrying a live APPROVE button bound to one exact plan.
 *
 * The click records consent and then goes straight through the write boundary,
 * which re-checks validity against the store before it commands anything. The
 * button does not decide; the gate does.
 */
async function postProposal(thread: any, plan: Plan): Promise<void> {
  const planHash = hashPlan(plan);
  let settled = false;

  await thread.post(
    <Message accent={ACCENT.proposal}>
      <Header>{`Proposed observation - ${siteName(plan.siteId)}`}</Header>
      <Context>{`SIMULATED telescope - plan ${planHash} - notice v${plan.noticeVersion}`}</Context>
      <Fields>
        <Field label="Target">{`${plan.targetRaDeg.toFixed(4)}, ${plan.targetDecDeg.toFixed(4)} deg`}</Field>
        <Field label="Sequence">{`${plan.exposureCount} x ${plan.exposureSec}s, ${plan.filter} band`}</Field>
        <Field label="Start by">{utc(plan.startNoLaterThanUtc)}</Field>
        <Field label="Consent binds to">{`v${plan.noticeVersion} / ${planHash}`}</Field>
      </Fields>
      <Section>
        <Markdown>{`*Assumptions*\n${plan.assumptions.map((a) => `- ${a}`).join("\n")}`}</Markdown>
      </Section>
      <Context>
        Approval authorises exactly this plan against this notice version. A revised
        alert voids it automatically.
      </Context>
      <Actions>
        <Button
          value="approve"
          style="primary"
          onClick={async (ctx: any) => {
            if (settled) return;
            settled = true;
            await approveAndObserve(ctx, plan, planHash);
          }}
        >
          APPROVE
        </Button>
        <Button
          value="ignore"
          style="danger"
          onClick={async (ctx: any) => {
            if (settled) return;
            settled = true;
            await ctx.thread.update(
              ctx.message.ref,
              <Message>
                <Header>Stood down</Header>
                <Context>No approval recorded. Nothing was commanded.</Context>
              </Message>,
            );
          }}
        >
          IGNORE
        </Button>
      </Actions>
    </Message>,
  );
}

async function approveAndObserve(ctx: any, plan: Plan, planHash: string): Promise<void> {
  const approval = recordApproval(store, { plan, approvedBy: "slack-user" });

  await ctx.thread.update(
    ctx.message.ref,
    <Message accent={ACCENT.done}>
      <Header>Approved</Header>
      <Context>{`${siteName(plan.siteId)} - plan ${planHash} - v${plan.noticeVersion}`}</Context>
      <Context>
        Consent recorded. It is re-checked immediately before every telescope call, and
        again after the slew.
      </Context>
    </Message>,
  );

  // `thread.post` resolves to the MessageRef itself - not an object carrying
  // one. Getting that wrong calls update(undefined) and takes the process down.
  let progressRef: unknown = null;
  let pending: Promise<void> = Promise.resolve();

  const render = (observation: Observation) => {
    // Serialised: Slack applies edits in order, and an out-of-order update
    // would leave the card showing an earlier step than the one it reached.
    pending = pending.then(async () => {
      const card = progressCard(observation, plan);
      if (progressRef === null) progressRef = await ctx.thread.post(card);
      else await ctx.thread.update(progressRef, card);
    });
    // A failed card update must never kill the runtime mid-observation.
    pending.catch(() => {});
  };

  const run = executeApprovedPlan(
    store,
    new SimulatedTelescope({ stepMs: 3000 }),
    plan,
    approval,
    render,
  );

  // The revised notice arrives on its own while the mount is still moving.
  // Nobody types anything; this is awaited here only so the delivery that
  // carries it is still open when it posts.
  if (!revisionLanded && plan.noticeVersion === NOTICE_V1.version) {
    revisionLanded = true;
    await sleep(REVISION_AFTER_SLEW_MS);
    await landRevision(ctx.thread).catch(() => {});
  }

  try {
    await run;
    await pending;
  } catch (err) {
    await pending.catch(() => {});
    await ctx.thread.post(
      <Message accent={ACCENT.voided}>
        <Header>Telescope call blocked</Header>
        <Section>
          <Markdown>{err instanceof Error ? err.message : String(err)}</Markdown>
        </Section>
        <Context>The approval was no longer valid. Nothing was commanded.</Context>
      </Message>,
    );
  }
}

/** Fire the revision, revoke what it invalidates, and propose the repoint. */
async function landRevision(thread: any): Promise<void> {
  const before = FIXTURE_SITE_STATUSES.find((s) => s.siteId === FIXTURE_PLAN.siteId);
  const intake = receiveNotice(store, NOTICE_V2);

  await thread.post(alertCard(NOTICE_V2, FIXTURE_SITE_STATUSES_V2));

  for (const approval of intake.revoked) {
    const after = FIXTURE_SITE_STATUSES_V2.find((s) => s.siteId === approval.siteId);
    const loss =
      before && after ? coverageLoss(before, after).summary : "Coverage change unknown.";
    await thread.post(
      <Message accent={ACCENT.voided}>
        <Header>APPROVAL VOIDED</Header>
        <Context>{`${siteName(approval.siteId)} - plan ${approval.planHash} - consent was given against v${approval.noticeVersion}`}</Context>
        <Section>
          <Markdown>{`*Why*\n${approval.revokedReason ?? "superseded by a revised notice"}`}</Markdown>
        </Section>
        <Section>
          <Markdown>{`*Coverage lost*\n${loss}`}</Markdown>
        </Section>
        <Context>No telescope action was taken on this approval. A fresh proposal follows.</Context>
      </Message>,
    );
  }

  await postProposal(thread, recordPlan(store, FIXTURE_PLAN_V2));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Start the drill. The only entry point; everything after happens on its own,
 * which is the point - the thread fills up without anyone typing.
 */
export const startDrill = defineChannelTool({
  name: "start_grb_drill",
  description:
    "Start the NightWatch gamma-ray burst drill in this thread. Replays a real GCN alert, reports observability across the three sites, and proposes an observation for human approval. Call this when asked to run the drill, start the demo, or replay an alert. Do not describe what will happen - call the tool and stop; it posts everything itself.",
  parameters: z.object({}),
  async handler(_args, { thread }: any) {
    receiveNotice(store, NOTICE_V1);
    const plan = recordPlan(store, FIXTURE_PLAN);

    await thread.post(alertCard(NOTICE_V1, FIXTURE_SITE_STATUSES));
    await postProposal(thread, plan);

    return "Drill started. The alert, the site table and the approval request are posted. Say nothing further - a revised notice will arrive on its own and the thread will update itself.";
  },
});

/** Report the current state of the event, read from the store. */
export const readStatus = defineChannelTool({
  name: "nightwatch_status",
  description:
    "Report the current state of the burst being tracked in this thread: the latest notice version, any live or revoked approvals, and any observation. Call this when asked what the status is. Every number in your answer must come from this tool - never state a coordinate, altitude or SNR you did not read here.",
  parameters: z.object({}),
  async handler() {
    const eventId = store.knownEventIds().at(-1);
    if (eventId === undefined) {
      return "No burst is being tracked in this thread yet. Offer to start the drill.";
    }
    const notice = store.latestNotice(eventId);
    const current = store.plansFor(eventId).at(-1);

    return {
      eventId,
      currentNoticeVersion: notice?.version,
      approvals: store.approvalsFor(eventId).map((a) => ({
        site: a.siteId,
        boundToNoticeVersion: a.noticeVersion,
        planHash: a.planHash,
        revoked: Boolean(a.revokedAt),
        revokedReason: a.revokedReason,
        validRightNow: current ? approvalStillValid(store, a, current) : false,
      })),
      observations: store.observationsFor(eventId).map((o) => ({
        state: o.state,
        simulated: o.simulated,
        result: o.result,
        failureReason: o.failureReason,
      })),
      auditTrail: store.auditFor(eventId).map((r) => `${utc(r.at)} ${r.kind}: ${r.detail}`),
    };
  },
});

export function welcomeMessage(platform: string) {
  return (
    <Message accent={ACCENT.alert}>
      <Header>NightWatch - transient follow-up coordinator</Header>
      <Section>
        <Markdown>
          {"When a gamma-ray burst alert arrives I open a thread here, report real observing " +
            "windows across three sites, and propose an observation. I never command a telescope " +
            "without an explicit click - and if a revised alert invalidates the plan, I revoke my " +
            "own approval in front of you.\n\nMention me in this " +
            platform +
            " thread and ask me to start the drill."}
        </Markdown>
      </Section>
      <Fields>
        <Field label="I will">Report windows, propose, and revoke my own consent</Field>
        <Field label="I won't">Move a telescope without a click, or invent a number</Field>
      </Fields>
      <Context>Every telescope action in this build is SIMULATED.</Context>
    </Message>
  );
}
