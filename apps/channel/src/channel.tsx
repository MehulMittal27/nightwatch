import { createChannel } from "@copilotkit/channels";
import { isSearchConfigured, isWorkplaceConfigured, WORKPLACE_CONTEXT } from "agent-core";
import { makeChannelAgent } from "./agent";
import { required } from "./env";
import { AlertCard, RevocationCard, SiteTableCard, welcomeMessage } from "./components";
import { getSiteStatus, proposeObservationPlan, readThread, searchTheWeb, voidApprovalCard } from "./tools";

// Tools are registered only when their credential is present, so the agent is
// never handed a tool that will fail when it calls it.
const tools = [
  readThread,
  getSiteStatus,
  proposeObservationPlan,
  voidApprovalCard,
  ...(isSearchConfigured() ? [searchTheWeb] : []),
];

export const channel = createChannel({
  // Must equal the Channel Code in Intelligence, character for character. A
  // mismatch leaves the Channel at "Waiting for runtime" and is validated at
  // startup, not here.
  name: required("CHANNEL_CODE"),

  // Required. "platform" derives the canonical user from provider + workspace +
  // platform user id. Do NOT move this onto CopilotRuntime — that one is for
  // web requests and must be absent on a Channels-only runtime.
  identifyUser: "platform",

  agent: makeChannelAgent,
  tools,
  components: [AlertCard, SiteTableCard, RevocationCard],

  // Injected into the agent's prompt on every run.
  context: [
    {
      description: "Rendering",
      value:
        "Call get_site_status first for any question about the current notice or which site to use — never estimate a position, altitude, or window yourself. " +
        "Then draw alert_card and site_table_card with those exact numbers. " +
        "If a notice you already posted an observation plan for gets a new version, call void_approval_card — it edits the original card into a voided state itself. Do not post a separate revocation_card next to it; that leaves both visible and defeats the point. " +
        "Prefer cards over prose whenever the answer has structure. No number in this channel is ever produced by you — only copied from a tool result.",
    },
    ...(isWorkplaceConfigured()
      ? [{ description: "Workplace", value: WORKPLACE_CONTEXT }]
      : []),
    {
      description: "Surface",
      value:
        "This is a chat thread in a channel people are actively working in. Assume others are reading and that some joined late.",
    },
  ],

});

// A mention subscribes the conversation, so the agent then follows along instead
// of needing to be @-mentioned every single turn.
channel.onMention(async ({ thread }) => {
  await thread.subscribe();
  await thread.runAgent();
});

// Non-mentioned turns only ever reach onMessage — gate them on the flag or the
// agent will answer every message in every channel it has been invited to.
channel.onMessage(async ({ thread }) => {
  if (await thread.isSubscribed()) {
    await thread.runAgent();
  }
});

channel.onWelcome(async ({ thread, platform }) => {
  await thread.post(welcomeMessage(platform));
});
