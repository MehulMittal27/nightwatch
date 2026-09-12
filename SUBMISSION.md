# Submission — NightWatch

**Event:** Agents, Everywhere — AI Tinkerers global hackathon, 12 September 2026
**Repository:** https://github.com/MehulMittal27/nightwatch
**Video:** https://youtu.be/OsU66kmfuuI
**Deployed URL:** Not deployed. The listener holds an outbound websocket and must run as a persistent worker; a `Dockerfile` is included and the image builds clean.
**Social post:** <!-- URL -->

---

## Build eligibility

- [x] Our submitted project is a net-new build created during the official hackathon period
- [x] Its core functionality was built during the event; we are not resubmitting or extending a pre-existing project
- [x] We identify inherited templates, libraries, prompts, components, and starter code separately from our event work

### The inherited/built line is a commit, not a claim

The repository's **first commit** is the starter kit, verbatim and unmodified:

| | |
|---|---|
| **Baseline commit** | `30f70bd181d1e95c48bda8b67d00edea176a6302` — *"chore: starter kit baseline (inherited)"* |
| **Upstream source** | `CopilotKit/agents-everywhere-starter-kit` @ `86f547d74e8bd32e047226b0e1fb862cca02a5c7` |

**Everything after that commit was written during the event.** To see exactly what we built:

```bash
git diff 30f70bd..HEAD
```

That is 18 commits and roughly 2,800 lines across `src/nightwatch/` and `apps/channel/`.

### What we inherited

- **The CopilotKit Channels Slack template** (`apps/channel/`) — the runtime, the Slack delivery
  path, the component primitives (`Message`, `Header`, `Table`, `Button`, …), `server.ts`,
  `agent.ts`, `env.ts`, `search.tsx`, and `readThread`.
- **The kit's build scaffolding** — workspaces, TypeScript config, `npm run verify`, and the kit's
  own test suites, which we left passing rather than deleting.
- **Libraries** — `@copilotkit/channels`, `@copilotkit/runtime`, `zod`, `astronomy-engine`
  (added during the event), the OpenAI and Exa integrations the template registers.
- **Real data** — NASA GCN Unified Schema notice payloads, unmodified, from `nasa-gcn/gcn-schema`.

We did **not** reskin the kit's on-call incident sample. It was removed. `IncidentCard`, `Timeline`,
`proposeAction` and the on-call welcome message are gone from the live channel; the domain was
replaced, not renamed.

### What we built during the hackathon

Every file below is new:

| Area | Files | What it is |
|---|---|---|
| **Domain** | `src/nightwatch/domain/models.ts`, `state.ts`, `store.ts` | The consent model, the state machine, the event store and audit log |
| **The gate** | `isValidFor`, `hashPlan`, `receiveNotice`, `recordApproval`, `revokeApproval`, `coverageLoss` | Consent bound to `(event, version, site, planHash)`, revoked at intake when a revision lands |
| **Write boundary** | `src/nightwatch/adapters/telescope.ts`, `simulator.ts` | The only path to the telescope: re-checks consent twice, idempotent on a four-part key |
| **Science** | `src/nightwatch/science/visibility.ts` | `astronomy-engine` altitude, Moon separation, and grid-sampled observing windows. Pure |
| **Slack surface** | `apps/channel/src/nightwatch.tsx` | Alert card, computed site table, APPROVE/MODIFY/IGNORE round-trip, in-place simulator status, revocation card, approval-gated circular |
| **Workspace boundary** | `apps/channel/src/ambiguous.ts` | Minimal MCP client behind the gate; the model holds no workspace tools |
| **Tests** | `state.test.ts`, `telescope.test.ts`, `visibility.test.ts`, `fixtures.test.ts`, `sites.test.ts` | 42 tests, including the two that encode the thesis |

## Title and description

**What you built.** NightWatch is a transient-astronomy follow-up coordinator that lives in a Slack
thread. A gamma-ray burst alert arrives; it computes real observing windows across three
observatories on three continents, proposes an observation, and waits for a human to approve it.
When a revised alert arrives — as GCN revisions routinely do — it **revokes its own approval in
front of the user**, shows the coverage lost, and proposes a repoint to whichever site can still
reach the new position.

**Who it is for.** The astronomer on target-of-opportunity duty at 02:00, deciding in minutes
whether to interrupt a scheduled programme for a burst that may or may not still be where the first
notice said it was.

**Why the context matters.** The thread *is* the coordination surface. The alert, the site
comparison, the approval, the revocation and the result all live in one place that the whole team is
already watching — so the record of who authorised what, against which version of reality, is the
conversation itself rather than a log someone has to go and find. A standalone chatbox would lose
the one thing that makes the revocation meaningful: the approval it revokes is visible directly
above it, and everyone saw it.

**Sponsor technologies used**

| Sponsor | Visible contribution |
|---|---|
| **CopilotKit Channels** | The entire Slack surface: managed delivery, the interactive approval round-trip, and in-place card updates as the simulated observation progresses |
| **OpenAI** (`gpt-5.6-sol`) | The agent's prose and tool selection. Deliberately produces **no numbers** |
| **Exa** | Evidence lookup on the burst, auto-registered by the template |
| **Ambiguous** | The follow-up circular is composed from the event store and written to the workspace as a document - but only behind the same approval gate as the telescope. The model has no workspace tools at all |

**Cut during the event, and why.** Auth0 was scoped as post-gate stretch work with a hard cap.
Slack app provisioning overran by roughly 50 minutes - a hand-made Slack app was missing the
scopes, events and interactivity endpoint that the CLI-generated manifest carries - so we invoked
our own rule that the approval gate outranks every integration, and cut it rather than risk the
core. Ambiguous was cut for the same reason and then reinstated once the gate was proven, on the
condition that it went in behind a real boundary rather than as raw model access.

**What that condition meant in practice.** Ambiguous exposes create, edit, share and
permanent-delete tools. Registering them for the model would have been an ungated external write -
the exact failure this project argues against, in the build that argues against it. So workplace
MCP is disabled for the model entirely, and the workspace is reachable only through one
approval-gated tool.

**And one honest note about that boundary.** Our first version reported a successful publish while
the workspace stayed empty: MCP returns a tool failure as a *successful* JSON-RPC response carrying
`isError`, and the client ignored it. We caught it by checking the workspace rather than trusting
the thread, and the client now refuses to confirm a write that returns no document id. A system
that claims an action it did not take is the failure mode this project exists to prevent; we
committed it, found it, and fixed it.

## Evidence for the judging criteria

| Criterion | Where to look |
|---|---|
| **Core Requirements & Functionality** | One complete workflow in Slack, live: notice → computed site table → APPROVE → simulated observation → revision → **approval voided** → repoint → completion. Shown end to end in the video, and reproducible with `@yourbot start the drill` |
| **Innovation & Theme Alignment** | The revocation. Consent is modelled as a claim about state that can be falsified later, not a checkpoint in a run — closer to optimistic concurrency control than to a confirmation dialog |
| **Technical Execution & Integration** | The write boundary answers the kit's own instruction to enforce authorisation yourself. Consent is re-checked *after* the slew, so a revision landing mid-slew stops the exposure. Idempotent on `(event, version, telescope, planHash)`. 42 tests; the astronomy independently re-derived in Python and agreeing to 0.002° |
| **Usefulness & Agentic Experience** | Three consent tiers, with every telescope action in the blocking tier and no timeout-to-proceed anywhere. Missing data renders as `unknown` and blocks recommendation rather than guessing |

**Clearly labelled, not implied:**

- **The telescope is SIMULATED.** Every card says so. No observatory is contacted.
- **Notices are replayed** from real NASA GCN payloads, not a live feed.
- **The store is in-process** and resets when the runtime restarts.
- **Observing windows are altitude-only** — no Sun model, so a window can fall in daylight. Nothing
  in the code or cards claims otherwise. See the README's known limitations.

## Public repository

- [x] A new participant can run the quickstart from a clean clone
- [x] The README lists the credentials and separate processes required
- [x] `npm run verify` passes — 42 project tests plus the kit's own suites
- [x] `.env` is gitignored and was verified untracked; no key is committed
- [x] Sample data, session-only state, and unimplemented integrations are clearly labeled

## Two-minute demo video

- [x] Show the surface and existing context before the prompt
- [x] Demonstrate one complete interaction
- [x] Show a visible result
- [x] Distinguish the approval decision from execution, and show the resulting behaviour
- [x] State which sponsor technologies made the interaction possible
- [x] Check length and audio

## Team

| | Lane |
|---|---|
| Mehul Mittal | Domain, state machine, approval gate, write boundary, simulator, Slack surface |
| Manish | Science: `astronomy-engine` visibility, GCN replay fixtures |
| Andrii Agarkov | Channels: cards and approval round-trip |

## Final submission

- [ ] Follow the organizer's posting and sponsor-tagging instructions
- [x] Link the public repository and video
- [x] Credit the sponsors used
- [x] Check the live integration once more before recording or submitting
- [x] Inspect the repository, video and screenshots for secrets
