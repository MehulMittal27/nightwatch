import { createChannel } from "@copilotkit/channels";
import { isSearchConfigured, isWorkplaceConfigured, WORKPLACE_CONTEXT } from "agent-core";
import { makeChannelAgent } from "./agent";
import { required } from "./env";
import { draftCircular, readStatus, startDrill, welcomeMessage } from "./nightwatch";
import { readThread, searchTheWeb } from "./tools";

// Tools are registered only when their credential is present, so the agent is
// never handed a tool that will fail when it calls it.
const tools = [
  startDrill,
  readStatus,
  draftCircular,
  readThread,
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
  components: [],

  // Injected into the agent's prompt on every run.
  context: [
    
    {
      description: "Numbers",
      value:
        "You NEVER produce a number. Coordinates, altitudes, Moon separations, window times, exposure times and SNR all come from tools, which render their own cards. If you do not have a number from a tool, say 'unknown'. Never estimate, interpolate or recall one.",
    },
    ...(isWorkplaceConfigured()
      ? [{ description: "Workplace", value: WORKPLACE_CONTEXT }]
      : []),
    {
      description: "Surface",
      value:
        "This is a Slack thread coordinating follow-up of a gamma-ray burst. One thread per burst. Every telescope action is SIMULATED and must be described as such. You never command a telescope; a human clicks APPROVE and the system re-checks that consent immediately before acting.",
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
