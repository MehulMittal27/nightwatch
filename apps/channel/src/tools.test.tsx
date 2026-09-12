import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createChannel } from "@copilotkit/channels";
import { startChannelsWithGatewayControl } from "@copilotkit/channels-intelligence";
import {
  ManagedGateway,
  preparedDelivery,
  concreteThread,
} from "./testing/managed-gateway";
import { z } from "zod";
import { getSiteStatus, proposeObservationPlan, readThread } from "./tools";

/** Only the methods these tools call; the rest of Thread is irrelevant here. */
const stubContext = (thread: Record<string, unknown>) =>
  ({
    thread,
    user: { id: "u1", name: "priya" },
    actor: { id: "a1" },
    platform: "slack",
  }) as never;

describe("read_thread", () => {
  it("returns the messages when the surface exposes history", async () => {
    const messages = [
      { id: "1", role: "user", content: "notice just landed" },
    ];
    const result = await readThread.handler(
      {},
      stubContext({ getMessages: mock.fn(async () => messages) }),
    );
    assert.deepEqual(result, messages);
  });

  it("degrades into an instruction, not an empty array, when history is unavailable", async () => {
    // getMessages() is capability-gated: it returns [] rather than throwing on
    // surfaces that cannot read history. Handing that [] straight to the model
    // reads as "the thread is empty", and the agent then answers confidently
    // about a notice it knows nothing about.
    const result = await readThread.handler(
      {},
      stubContext({ getMessages: mock.fn(async () => []) }),
    );
    assert.equal(typeof result, "string");
    assert.match(String(result), /cannot see earlier messages/i);
  });
});

describe("get_site_status", () => {
  it("returns the fixture notice and site rows verbatim, never a computed or estimated number", async () => {
    const result = (await getSiteStatus.handler({}, stubContext({}))) as {
      eventId: string;
      version: number;
      sites: Array<{ siteName: string; recommendation: string }>;
    };
    assert.equal(result.eventId, "GRB260912A");
    assert.equal(result.version, 1);
    assert.ok(result.sites.length > 0);
    assert.ok(result.sites.some((s) => s.recommendation === "RECOMMENDED"));
    assert.ok(result.sites.some((s) => s.siteName.includes("Teide")));
  });
});

describe("propose_observation_plan", () => {
  const args = {
    eventId: "GRB260912A",
    noticeVersion: 1,
    siteName: "Teide Observatory, Tenerife",
    exposureSec: 120,
    exposureCount: 5,
    filter: "r",
    startNoLaterThanUtc: "2026-09-13T01:36:00Z",
    assumptions: ["Localisation fits the CAMELOT-2 field in a single pointing"],
  };

  for (const choice of ["Approve", "Modify", "Ignore"]) {
    it(
      `posts a real managed card and reports ${choice} on a later delivery`,
      { timeout: 10_000 },
      async () => {
        const gateway = new ManagedGateway();
        const channel = createChannel({
          name: "nightwatch",
          identifyUser: "platform",
        });
        let result: unknown;
        channel.onMessage(async ({ thread }) => {
          try {
            assert.equal(thread.supportsBlockingChoice, false);
            result = await proposeObservationPlan.handler(args, {
              thread: concreteThread(thread),
              user: { id: "u1", name: "Priya" },
              actor: { id: "a1", kind: "human" },
              platform: "slack",
            });
          } catch (error) {
            result = String(error);
            throw error;
          }
        });
        const runCanonical = mock.fn();
        const handle = await startChannelsWithGatewayControl([channel], {
          session: gateway,
          scope: { projectId: 1, channelName: "nightwatch" },
          runtimeInstanceId: "rti_proposal",
          runCanonical: async (args) => {
            // Neither the proposal handler nor the click resumes an agent.
            runCanonical();
            return args.execute({});
          },
          loadHistory: async () => [],
        });
        try {
          const proposalDelivery = preparedDelivery("proposal", "slack", {
            kind: "text",
            text: "Propose the observation plan",
          });
          await gateway.deliver(proposalDelivery);
          assert.match(
            String(result),
            /decision pending/,
            JSON.stringify(gateway.packets),
          );
          assert.match(
            String(result),
            /Do not execute the plan, command a telescope, or call write tools/,
          );
          const payloads = gateway.packets.map(({ payload }) => payload);
          const card = payloads.find(
            (payload) => payload.kind === "slack.message.create",
          );
          assert.ok(
            card,
            "managed adapter must post the proposal before ending the delivery",
          );
          assert.match(JSON.stringify(card), /GRB260912A/);
          assert.match(JSON.stringify(card), /Teide Observatory, Tenerife/);
          assert.match(JSON.stringify(card), /5×120s/);
          assert.match(JSON.stringify(card), /Localisation fits the CAMELOT-2 field/);
          assert.match(JSON.stringify(card), /Approve/);
          assert.match(JSON.stringify(card), /Modify/);
          assert.match(JSON.stringify(card), /Ignore/);
          // Read the real Slack action ID generated by Channels, then deliver it
          // through the gateway in a separate (nonblocking) interaction turn.
          const blocks = z
            .array(
              z.object({
                type: z.string(),
                elements: z.array(z.unknown()).optional(),
              }),
            )
            .parse(card.blocks);
          const buttons = blocks
            .flatMap((block) =>
              block.type === "actions" ? (block.elements ?? []) : [],
            )
            .map((element) =>
              z
                .object({
                  type: z.literal("button"),
                  text: z.object({ text: z.string() }),
                  action_id: z.string(),
                })
                .parse(element),
            );
          const button = buttons.find(
            (element) => element.text.text === choice,
          );
          assert.ok(button);
          const clickDelivery = preparedDelivery("proposal_click", "slack", {
            kind: "interaction",
            actionId: button.action_id,
            messageRef: { id: "pref_v1_proposal_message_123" },
          });
          await gateway.deliver({
            ...proposalDelivery,
            deliveryId: clickDelivery.deliveryId,
            turn: clickDelivery.turn,
          });
          const update = gateway.packets
            .map(({ payload }) => payload)
            .find((payload) => payload.kind === "slack.message.replace");
          assert.ok(
            update,
            "click must replace the proposal with the decision",
          );
          const expectedLabel =
            choice === "Approve"
              ? /APPROVED \(stub\)/
              : choice === "Modify"
                ? /MODIFICATION REQUESTED \(stub\)/
                : /IGNORED/;
          assert.match(JSON.stringify(update), expectedLabel);
          // The SDK keeps every action ID registered after replacing the card.
          // Replay the first choice, then deliver a stale different choice: none
          // may overwrite the first recorded decision.
          const otherButton = buttons.find(
            (element) => element.text.text !== choice,
          );
          assert.ok(otherButton);
          for (const [index, actionId] of [
            button.action_id,
            otherButton.action_id,
          ].entries()) {
            const replayDelivery = preparedDelivery(
              `proposal_replay_${index}`,
              "slack",
              {
                kind: "interaction",
                actionId,
                messageRef: { id: "pref_v1_proposal_message_123" },
              },
            );
            await gateway.deliver({
              ...proposalDelivery,
              deliveryId: replayDelivery.deliveryId,
              turn: replayDelivery.turn,
            });
          }
          const updates = gateway.packets
            .map(({ payload }) => payload)
            .filter((payload) => payload.kind === "slack.message.replace");
          assert.equal(
            updates.length,
            1,
            "duplicate and opposite clicks must preserve the first decision",
          );
          assert.equal(
            runCanonical.mock.callCount(),
            0,
            "click reporting must not automatically resume the agent",
          );
        } finally {
          await handle.stop();
        }
      },
    );
  }
});
