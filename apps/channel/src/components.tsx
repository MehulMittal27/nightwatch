/**
 * Agent-rendered components for the NightWatch on-call agent.
 *
 * `defineChannelComponent` turns a component into a tool the agent can call to
 * draw UI itself. Every numeric field here must be copied verbatim from a data
 * tool's result (see tools.tsx) — the agent renders these cards, it never
 * computes the numbers that go in them.
 *
 * One tree renders as Slack Block Kit, Teams Adaptive Cards, and Discord
 * components. A surface that cannot render a node skips it rather than failing.
 */
import {
  defineChannelComponent,
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

/**
 * A GCN transient notice. A revision of the same event arrives as a new
 * version with the same event id — this card is deliberately silent on
 * "what changed" prose; that belongs in the thread, not invented here.
 */
export const AlertCard = defineChannelComponent({
  name: "alert_card",
  description:
    "Render a GCN transient alert: event id, notice version, sky position, error radius, and when it was received. Call this once you have the notice from a data tool result. Copy every number exactly as given — never estimate, round, or recompute one.",
  parameters: z.object({
    eventId: z.string().describe("e.g. GRB260912A"),
    version: z.number().int().describe("Notice version. A higher version voids any approval bound to a lower one."),
    raDeg: z.number(),
    decDeg: z.number(),
    errorRadiusDeg: z.number(),
    receivedAtUtc: z.string().describe("ISO-8601 UTC instant, exactly as given by the data tool."),
  }),
  render({ eventId, version, raDeg, decDeg, errorRadiusDeg, receivedAtUtc }) {
    return (
      <Message accent="#C4145F">
        <Header>{`${eventId} — notice v${version}`}</Header>
        <Fields>
          <Field label="RA">{`${raDeg.toFixed(4)}°`}</Field>
          <Field label="Dec">{`${decDeg.toFixed(4)}°`}</Field>
          <Field label="Error radius">{`${errorRadiusDeg.toFixed(2)}°`}</Field>
          <Field label="Received">{`${receivedAtUtc} UTC`}</Field>
        </Fields>
        <Context>Position from the notice payload. No number here is model-generated.</Context>
      </Message>
    );
  },
});

const RECOMMENDATION_LABEL: Record<string, string> = {
  RECOMMENDED: "✅ RECOMMENDED",
  WAIT: "🕒 WAIT",
  NO_WINDOW: "🚫 NO WINDOW",
  UNKNOWN: "❓ UNKNOWN",
};

/**
 * Per-site observability comparison. This is the card the whole approval
 * decision hangs on, so every cell must trace back to astronomy-engine via a
 * data tool — never to the model's own estimate.
 */
export const SiteTableCard = defineChannelComponent({
  name: "site_table_card",
  description:
    "Render the per-site observability table for a notice: recommendation, current altitude, Moon separation, and next usable window. Call this with the exact rows a data tool returned, in the same order. Never invent, round, or recompute a row's numbers.",
  parameters: z.object({
    eventId: z.string(),
    rows: z
      .array(
        z.object({
          siteName: z.string(),
          recommendation: z.enum(["RECOMMENDED", "WAIT", "NO_WINDOW", "UNKNOWN"]),
          altitudeNowDeg: z.union([z.number(), z.literal("unknown")]),
          moonSeparationDeg: z.union([z.number(), z.literal("unknown")]),
          nextWindow: z
            .string()
            .describe("Next usable window as free text, e.g. '23:52–02:14 UTC', or 'none tonight'."),
          notes: z.array(z.string()).max(4).default([]),
        }),
      )
      .min(1)
      .max(6),
  }),
  render({ eventId, rows }) {
    return (
      <Message>
        <Header>{`Site comparison — ${eventId}`}</Header>
        <Table
          columns={[
            { header: "Site" },
            { header: "Status" },
            { header: "Alt now" },
            { header: "Moon sep" },
            { header: "Next window" },
          ]}
        >
          {rows.map((r) => (
            <Row>
              <Cell>{r.siteName}</Cell>
              <Cell>{RECOMMENDATION_LABEL[r.recommendation] ?? r.recommendation}</Cell>
              <Cell>{r.altitudeNowDeg === "unknown" ? "unknown" : `${r.altitudeNowDeg.toFixed(1)}°`}</Cell>
              <Cell>{r.moonSeparationDeg === "unknown" ? "unknown" : `${r.moonSeparationDeg.toFixed(1)}°`}</Cell>
              <Cell>{r.nextWindow}</Cell>
            </Row>
          ))}
        </Table>
        {rows.some((r) => r.notes.length > 0) && (
          <Section>
            <Markdown>
              {rows
                .filter((r) => r.notes.length > 0)
                .map((r) => `*${r.siteName}*: ${r.notes.join("; ")}`)
                .join("\n")}
            </Markdown>
          </Section>
        )}
        <Divider />
        <Context>Computed by astronomy-engine. No number here comes from a language model.</Context>
      </Message>
    );
  },
});

/**
 * The welcome message. A bot that says nothing when invited looks broken; one
 * that says what it will do on its own gets used.
 */
export function welcomeMessage(platform: string) {
  return (
    <Message accent="#C4145F">
      <Header>NightWatch, in the thread</Header>
      <Section>
        <Markdown>
          {"When a transient notice lands, I post the alert and a site-by-site observability table, computed, never guessed. " +
            "Nothing gets commanded to a telescope without an explicit approval click from a human in this " +
            platform +
            " thread."}
        </Markdown>
      </Section>
      <Fields>
        <Field label="I will">Post alerts, compare sites, propose a plan, wait for a click</Field>
        <Field label="I won't">Invent a number, or execute a plan without approval</Field>
      </Fields>
    </Message>
  );
}
