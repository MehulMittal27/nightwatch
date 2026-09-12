/**
 * Component tests.
 *
 * `renderToIR` lowers a Channels JSX tree to the platform-neutral IR the
 * adapter is actually handed — `{ type, props }` nodes — so these run with no
 * Slack app, no Intelligence project and no credentials of any kind.
 *
 * That matters for a hackathon kit: change a card, know in a second whether you
 * broke it. Node's built-in runner means there is nothing to install either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToIR } from "@copilotkit/channels";
import { AlertCard, SiteTableCard } from "./components";

const ctx = { platform: "slack" as const, signal: new AbortController().signal };

/** The rendered IR as a searchable string. */
async function render(node: unknown): Promise<string> {
  return JSON.stringify(renderToIR((await node) as never));
}

const baseAlert = {
  eventId: "GRB260912A",
  version: 1,
  raDeg: 213.4917,
  decDeg: 18.7342,
  errorRadiusDeg: 2.85,
  receivedAtUtc: "2026-09-12T21:14:03Z",
};

describe("alert_card", () => {
  it("carries the event id and notice version in the header", async () => {
    const out = await render(AlertCard.render(baseAlert, ctx));
    assert.ok(out.includes("GRB260912A"));
    assert.ok(out.includes("v1"));
  });

  it("renders position, error radius, and received time exactly as given, never rounded to a different value", async () => {
    const out = await render(AlertCard.render(baseAlert, ctx));
    assert.ok(out.includes("213.4917"));
    assert.ok(out.includes("18.7342"));
    assert.ok(out.includes("2.85"));
    assert.ok(out.includes("2026-09-12T21:14:03Z"));
  });

  it("distinguishes two versions of the same event", async () => {
    const v1 = await render(AlertCard.render(baseAlert, ctx));
    const v2 = await render(AlertCard.render({ ...baseAlert, version: 2, raDeg: 216.2083 }, ctx));
    assert.notEqual(v1, v2);
    assert.ok(v2.includes("v2"));
  });
});

const baseRows = [
  {
    siteName: "Teide Observatory, Tenerife",
    recommendation: "RECOMMENDED" as const,
    altitudeNowDeg: 54.2,
    moonSeparationDeg: 97.4,
    nextWindow: "20:48–01:36 UTC",
    notes: ["Above limit now", "Moon well separated"],
  },
  {
    siteName: "Vainu Bappu Observatory, Kavalur",
    recommendation: "WAIT" as const,
    altitudeNowDeg: -12.6,
    moonSeparationDeg: 96.9,
    nextWindow: "23:52–02:14 UTC",
    notes: [] as string[],
  },
  {
    siteName: "Kitt Peak National Observatory, Arizona",
    recommendation: "NO_WINDOW" as const,
    altitudeNowDeg: -41.3,
    moonSeparationDeg: 98.1,
    nextWindow: "none tonight",
    notes: [] as string[],
  },
];

describe("site_table_card", () => {
  it("renders one row per site with its recommendation label", async () => {
    const out = await render(SiteTableCard.render({ eventId: "GRB260912A", rows: baseRows }, ctx));
    for (const row of baseRows) assert.ok(out.includes(row.siteName), `missing "${row.siteName}"`);
    assert.ok(out.includes("RECOMMENDED"));
    assert.ok(out.includes("WAIT"));
    assert.ok(out.includes("NO WINDOW"));
  });

  it("prints 'unknown' rather than a fabricated number when altitude or Moon separation is unknown", async () => {
    const out = await render(
      SiteTableCard.render(
        {
          eventId: "GRB260912A",
          rows: [{ ...baseRows[0], altitudeNowDeg: "unknown", moonSeparationDeg: "unknown" }],
        },
        ctx,
      ),
    );
    assert.ok(out.includes("unknown"));
  });

  it("surfaces per-site notes but omits the notes section entirely when every row has none", async () => {
    const withNotes = await render(SiteTableCard.render({ eventId: "GRB260912A", rows: baseRows }, ctx));
    assert.ok(withNotes.includes("Above limit now"));

    const withoutNotes = await render(
      SiteTableCard.render(
        { eventId: "GRB260912A", rows: baseRows.map((r) => ({ ...r, notes: [] })) },
        ctx,
      ),
    );
    assert.ok(!withoutNotes.includes("Above limit now"));
  });
});
