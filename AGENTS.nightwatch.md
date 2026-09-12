# AGENTS.nightwatch.md

Project-specific instructions for AI coding agents on **NightWatch**.

> **This does not replace the starter kit's `AGENTS.md`.** Keep that file. Add one line at its top:
> `Project-specific rules live in AGENTS.nightwatch.md — read it after this file.`
>
> Before touching the Slack template, also read `.agents/skills/build-channels-agent/SKILL.md`,
> `hackathon-rules.md`, and `using-sponsor-tools.md`.

Deadline-driven: **submission 17:00 CEST, 12 Sep 2026.**

---

## What this project is

NightWatch is a transient-astronomy coordinator living in a Slack thread, built on the kit's
**CopilotKit Channels** template. A gamma-ray burst alert arrives, the system computes real
observing windows across three sites, proposes a plan, gets human approval, executes against a
simulated telescope, and — the point of the whole build — **revokes its own approval when a revised
alert invalidates the plan**.

The self-revoking approval is the thesis. If a change makes that path less reliable, don't make it.

The kit's sponsor guide states that approval cards guide behaviour but do not enforce a gate around
every tool, and that you must enforce authorization at the write boundary yourself. **That gate is
this project.**

---

## Non-negotiable rules

1. **No LLM ever produces a number.** Coordinates, altitudes, Moon separation, window times, SNR —
   all deterministic. The model writes prose only. A number in a model response is a bug.
2. **Any telescope action requires explicit human approval.** No timeout-to-proceed, no
   auto-approval, no confidence threshold. Ever.
3. **Approvals are bound to state:** exactly one `(event_id, notice_version, site_id, plan_hash)`.
   **Re-check validity immediately before every telescope call.** Never cache the result.
4. **Every external action is idempotent**, keyed `(event_id, notice_version, telescope, plan_hash)`.
   A retry must never schedule a second observation.
5. **The simulator is always labelled `SIMULATED`** in every card and message.
6. **Unknown is a value.** Missing or stale data renders as `unknown` and blocks automatic
   recommendation. Never guess or interpolate.
7. **All times are UTC.** One conversion helper. No local timezones in the domain layer.
8. **Slack is a projection.** The event store is the source of truth. Never read application state
   back out of a Slack card.
9. **Never invent MCP tool names, arguments, or record URLs.** Schemas come from the live workspace.
10. **No keys in code or in the repo.** Root `.env` only.

---

## Stack — settled, do not relitigate

- Node.js 22+, TypeScript. Root install, root `.env`.
- CopilotKit Channels (`apps/channel`) — the environment.
- OpenAI `gpt-5.6-sol` via `MODEL_PROVIDER=openai`; OpenRouter as a pre-configured fallback.
- `astronomy-engine` (npm) for all science.
- Exa — auto-registered by the Slack template when `EXA_API_KEY` exists. Don't wire it manually.
- SQLite (`better-sqlite3`) or a JSON store. Not Postgres.
- **No LangGraph, no CrewAI, no agent framework.** Plain tool-calling loops, three narrow specialists.
- **No Trigger.dev, no Kafka, no web or mobile template.**

---

## Layout (additions to the kit)

```
apps/channel/src/
  channel.tsx            kit file - customize
  tools.tsx              kit file - register NightWatch tools here
  components.tsx         kit file - alert card, site table, approval card, revocation card
src/nightwatch/
  domain/
    models.ts            Event, Notice, Site, Plan, Approval, Observation
    state.ts             state machine: transitions, version bumps, invalidation
    store.ts             SQLite persistence + audit log
  science/
    visibility.ts        astronomy-engine. Pure. NO LLM, NO I/O.
    sites.ts             three site configs: lat/lon/alt, altitude limit, instruments
  agents/
    triage.ts            parse, dedupe, science fit, urgency
    planner.ts           exposure/filter proposal + stated assumptions
    narrator.ts          state -> Slack copy. Prose only.
  adapters/
    telescope.ts         TelescopeAdapter interface
    simulator.ts         deterministic: request -> slew -> expose -> complete
  replay/
    notices/             real historical GCN JSON, incl. a v1 -> v2 revision
    replay.ts            fires notices at demo speed
```

---

## Core model

```ts
interface Notice {
  eventId: string;
  version: number;          // increments on revision
  raDeg: number;
  decDeg: number;
  errorRadiusDeg: number;
  receivedAt: Date;         // UTC
  raw: unknown;             // original payload, never mutated
}

interface Approval {
  eventId: string;
  noticeVersion: number;    // the version consent was given against
  siteId: string;
  planHash: string;
  approvedBy: string;       // Slack user id
  approvedAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
}

function isValidFor(a: Approval, n: Notice, p: Plan): boolean {
  return !a.revokedAt
    && a.noticeVersion === n.version
    && a.planHash === hashPlan(p);
}
```

`isValidFor` runs immediately before every telescope call. Not at approval time. Not cached.

---

## Science layer — the credibility of the project

`science/visibility.ts` is pure: inputs in, numbers out. No I/O, no model calls.

**`astronomy-engine` gotchas — read before writing:**

- `Horizon(date, observer, ra, dec, refraction)` takes **RA in HOURS**, Dec in degrees.
  `raHours = raDeg / 15`. Get this wrong and every number is silently wrong. One tested helper.
- `SearchRiseSet` works on solar-system bodies, not fixed RA/Dec targets. For an observing window,
  **sample altitude on a time grid** (5-minute steps across the night) and find contiguous spans
  above the site's altitude limit. Simple, deterministic, fast enough.
- Moon separation: `Equator(Body.Moon, date, observer, true, true)` for the Moon's RA/Dec, then
  spherical angular distance against the target.
- Every returned value carries the timestamp it was computed for. Slack renders both.

**Tests required — three cases:** target up now; target below horizon all night; target rising later.

---

## Consent tiers

| Tier | Applies to | Behaviour |
|---|---|---|
| 1 Silent | recalculation, state refresh, re-evaluation | act, post compact status |
| 2 Announce + veto | scheduling re-eval, extending exposure, standing down a site | announce with countdown; silence proceeds; Stop cancels |
| 3 Block | **any telescope action** | explicit approval; never proceeds on timeout |

Classify every new action explicitly. **If you can't decide, it's tier 3.**

---

## Agent pattern

Plain tool-calling loops. Rejections and blocks come back **as tool results** — the model re-plans
on its own. Don't build special control flow for refusal.

```ts
for (const call of response.toolCalls) {
  const tool = TOOLS[call.name];
  const result = (tool.tier === 3 && !approvalValid(call))
    ? "blocked: requires human approval"
    : await tool.run(call.args);
  messages.push(toolResult(call.id, result));
}
```

---

## Slack / Channels conventions

- One thread per `eventId`. Root message = the alert; everything else is a threaded reply.
- Update cards **in place** when state changes. The thread reads as a log, not a firehose.
- **On revocation:** disable the approve action, card title → `APPROVAL VOIDED`, post the reason and
  coverage loss, then post the new proposal with fresh controls.
- Every number shown carries its computation timestamp.
- Keep the tested Channels/runtime versions and the `@ag-ui/client` override. Don't upgrade.

---

## Build order — do not reorder

1. Domain models + store + state machine
2. `visibility.ts` with tests + three site configs
3. Channels: thread, site table, working approval round-trip
4. **Approval → revision → self-revocation.** The gate. Nothing else matters until this works.
5. Simulator: approved plan → slew → expose → result back in thread
6. Triage + Exa evidence
7. *(T+3h, 45 min cap)* Ambiguous: draft the follow-up circular over MCP
8. *(T+3h, 30 min cap)* Auth0: scope check at the telescope write boundary

Steps 7 and 8 only if step 4 passed. Neither starts before T+3h.

---

## Definition of done

- [ ] A replayed notice opens a thread with a real computed site table
- [ ] APPROVE executes against the simulator and streams status in place
- [ ] A revision **visibly voids the approval** and proposes a repoint
- [ ] Approving the revision completes and returns a labelled result
- [ ] A duplicate notice updates the existing thread, creates no second request
- [ ] `npm run verify` passes
- [ ] Everything telescope-related is labelled SIMULATED

---

## Don't — these waste the day

- Don't add an agent framework. The orchestrator is your own code and judges read it.
- Don't add Postgres, Kafka, or a live GCN feed. Replay fixtures.
- Don't build tiling, image subtraction, or a second transient class.
- Don't build the web or mobile template. Slack is the environment.
- Don't reskin the kit's on-call sample — replace the domain, and say what's inherited in `SUBMISSION.md`.
- Don't refactor for elegance after T+3h45. The freeze is real.

---

## Docs to write as you go, not at the end

**README:** thesis · embedded video · consent-tier table · trust-split table · architecture diagram ·
failure design · idempotency key · the kit's write-boundary line and how we answer it · related work ·
run instructions · deployed URL.

**SUBMISSION.md:** what is inherited from the starter kit versus what was built during the event.
Be precise — this is an eligibility requirement, not a formality.
