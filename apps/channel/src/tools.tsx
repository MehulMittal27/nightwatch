/**
 * The NightWatch on-call agent's tools.
 *
 * A channel tool handler receives the LIVE thread, which is what makes the
 * proposal below possible: it posts a card and returns. A later click reports
 * the decision; it does not resume the agent or execute an action.
 *
 * The return value is what the *agent* reads back, not what the user sees.
 * Return raw data (it is JSON-stringified for you) or a short natural-language
 * confirmation — never `{ ok: true }`, and never hand-stringify.
 */
import {
  defineChannelTool,
  Message,
  Header,
  Section,
  Markdown,
  Context,
  Actions,
  Button,
} from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";
export { searchTheWeb } from "./search";
import { z } from "zod";
import { FIXTURE_SITE_STATUSES, NOTICE_V1, SITES } from "../../../src/nightwatch/fixtures";

/**
 * Read the incident context already present in the conversation.
 */
export const readThread = defineChannelTool({
  name: "read_thread",
  description:
    "Read the recent messages in this conversation. Call this FIRST on any question about an ongoing event — the thread almost certainly already says what landed, when, and what has been decided. Asking someone to re-explain a notice is the worst thing you can do here.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    const messages = await thread.getMessages();
    if (messages.length === 0) {
      return "This surface does not expose conversation history, or the thread is empty. Say that you cannot see earlier messages and ask for the shortest possible summary.";
    }
    return messages;
  },
});

/**
 * Ground-truth data for the current notice and its per-site observability.
 *
 * FIXTURE-BACKED FOR NOW: real numbers come from computeSiteStatus() once P2/P3
 * wire it in (the Phase 4 swap in the run sheet). Until then this returns the
 * hardcoded fixtures verbatim. Either way, the agent must copy these numbers
 * into alert_card / site_table_card exactly as returned — never estimate or
 * recompute them.
 */
export const getSiteStatus = defineChannelTool({
  name: "get_site_status",
  description:
    "Get the current transient notice and its per-site observability (recommendation, altitude, Moon separation, next window). ALWAYS call this before drawing alert_card or site_table_card — never invent, guess, or recompute these numbers yourself.",
  parameters: z.object({}),
  async handler() {
    const notice = NOTICE_V1;
    const rows = FIXTURE_SITE_STATUSES.map((status) => {
      const site = SITES.find((s) => s.id === status.siteId);
      return {
        siteName: site?.name ?? status.siteId,
        recommendation: status.recommendation,
        altitudeNowDeg: status.altitudeNowDeg,
        moonSeparationDeg: status.moonSeparationDeg,
        nextWindow:
          status.nextWindow === "unknown"
            ? "unknown"
            : status.nextWindow === null
              ? "none tonight"
              : `${status.nextWindow.startUtc.toISOString().slice(11, 16)}–${status.nextWindow.endUtc
                  .toISOString()
                  .slice(11, 16)} UTC`,
        notes: status.notes,
      };
    });
    return {
      eventId: notice.eventId,
      version: notice.version,
      raDeg: notice.raDeg,
      decDeg: notice.decDeg,
      errorRadiusDeg: notice.errorRadiusDeg,
      receivedAtUtc: notice.receivedAt.toISOString(),
      sites: rows,
    };
  },
});

/**
 * Post the observation plan for human review. This returns pending immediately.
 * Stop after posting: do not execute the plan or call write tools. A later
 * click reports a decision only; it does not execute anything or resume you.
 *
 * STUB HANDLER: the click only edits the message in place. Nothing is written
 * to an approval store yet — that lands when P2's domain store is wired in.
 */
export const proposeObservationPlan = defineChannelTool({
  name: "propose_observation_plan",
  description:
    "Post an observation plan for human approval: site, target, exposure sequence, and deadline. This returns pending immediately. Stop after posting: do not execute the plan, command a telescope, or call write tools. A later click reports a decision only; it does not execute anything or resume you.",
  parameters: z.object({
    eventId: z.string(),
    noticeVersion: z.number().int(),
    siteName: z.string(),
    exposureSec: z.number(),
    exposureCount: z.number().int(),
    filter: z.string(),
    startNoLaterThanUtc: z.string().describe("ISO-8601 UTC deadline, exactly as given by the data tool."),
    assumptions: z.array(z.string()).max(5).default([]),
  }),
  async handler(
    { eventId, noticeVersion, siteName, exposureSec, exposureCount, filter, startNoLaterThanUtc, assumptions },
    { thread },
  ) {
    // The SDK retains inline action handlers after a message replacement. Queue
    // clicks and settle only after a successful update, so stale/opposite clicks
    // cannot overwrite a decision and a failed update remains retryable.
    let settled = false;
    let previousReport = Promise.resolve();
    const summary = `**${eventId} v${noticeVersion} → ${siteName}**\n${exposureCount}×${exposureSec}s, ${filter} filter — start no later than ${startNoLaterThanUtc} UTC`;
    const reportDecision = (
      decision: "approved" | "modify" | "ignored",
      ctx: InteractionContext<string>,
    ) => {
      const report = async () => {
        if (settled) return;
        const label =
          decision === "approved"
            ? "APPROVED (stub). No telescope command sent — the approval store is not wired in yet."
            : decision === "modify"
              ? "MODIFICATION REQUESTED (stub). No handler for edits yet — flag this to a human directly."
              : "IGNORED. No action taken.";
        await ctx.thread.update(ctx.message.ref, `${label}\n\n${summary}`);
        settled = true;
      };
      previousReport = previousReport.then(report, report);
      return previousReport;
    };
    await thread.post(
      <Message accent="#C4145F">
        <Header>Review observation plan</Header>
        <Section>
          <Markdown>{summary}</Markdown>
        </Section>
        {assumptions.length > 0 && (
          <Section>
            <Markdown>{`*Assumptions*\n${assumptions.map((a) => `• ${a}`).join("\n")}`}</Markdown>
          </Section>
        )}
        <Context>
          Demo proposal only. Clicking records a decision; no telescope command is sent.
        </Context>
        <Actions>
          <Button
            value="approved"
            style="primary"
            onClick={async (ctx) => {
              await reportDecision("approved", ctx);
            }}
          >
            Approve
          </Button>
          <Button
            value="modify"
            onClick={async (ctx) => {
              await reportDecision("modify", ctx);
            }}
          >
            Modify
          </Button>
          <Button
            value="ignored"
            style="danger"
            onClick={async (ctx) => {
              await reportDecision("ignored", ctx);
            }}
          >
            Ignore
          </Button>
        </Actions>
      </Message>,
    );

    return "Plan posted; decision pending. Stop here. Do not execute the plan, command a telescope, or call write tools. A later click only reports the decision; the agent does not automatically resume.";
  },
});
