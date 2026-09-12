# NightWatch — Run Sheet

### Three people, one day, everything shipped

**12 Sep 2026 · Build 11:15–15:30 · Submit by 17:00 CEST**
Wall-clock times. **SYNC** = everyone stops and works together. **PARALLEL** = heads down, no interruptions.

---

## Roles

| | Owns | Directories (nobody else edits these) |
|---|---|---|
| **P1 — Channels** | Slack surface: channel setup, tools, cards, approval round-trip, in-place updates, revocation card, simulator status rendering | `apps/channel/` |
| **P2 — Core** | Domain store, state machine, versioning, `isValidFor`, the approval gate, telescope adapter + simulator, Auth0 write-boundary | `src/nightwatch/domain/`, `src/nightwatch/adapters/` |
| **P3 — Science + Words** | `astronomy-engine` visibility, site configs, GCN replay fixtures, Exa, Ambiguous circular, **and all docs + the video** | `src/nightwatch/science/`, `src/nightwatch/replay/`, `docs/`, `README.md`, `SUBMISSION.md` |

**Give P1 the Channels track if they're fastest with unfamiliar SDKs.** It has the most unknowns and the least room to recover.

**One owner per directory. Never edit a file you don't own.** With three people and four hours, a merge conflict in `tools.tsx` costs more than the feature did.

---

## Phase 0 — Pre-flight (10:30–11:15, during the briefing)

Not build time. Do it while the opening broadcast runs.

| | Task |
|---|---|
| **All** | Attend briefing. Note any deadline or template changes. Join the hackathon Discord. |
| **P1** | CopilotKit Intelligence account. Create the project. Have `INTELLIGENCE_API_KEY` (project-scoped) and `CHANNEL_CODE` ready. Slack workspace where you can install apps. |
| **P2** | Node 22+ verified (`node -v`). GitHub repo created, all three added as collaborators. |
| **P3** | API keys in a scratchpad: OpenAI, OpenRouter, Exa, Ambiguous. Redeem credits from the city portal → **Credits & Offers**. Download 2 real GCN notices incl. a revision. |

**Decide before 11:15:** who is P1, P2, P3. Do not debate this during build time.

---

## Phase 1 — Repo (11:15–11:25) · **SYNC**

**P2 drives, screen shared. P1 and P3 watch and set up their own clones.**

```bash
git clone https://github.com/CopilotKit/agents-everywhere-starter-kit.git nightwatch
cd nightwatch
rm -rf .git && git init
git remote add origin git@github.com:<you>/nightwatch.git
npm ci
cp .env.example .env
git add -A && git commit -m "chore: starter kit baseline (inherited)"
git push -u origin main
```

**The baseline commit matters.** It is the single cleanest proof of what was inherited versus built today — an eligibility requirement. `SUBMISSION.md` will point at this commit hash.

Then: `git checkout -b p1-channels` / `p2-core` / `p3-science`. Merge to `main` only at SYNC points.

---

## Phase 2 — Contract sprint (11:25–11:45) · **SYNC**

The twenty minutes that buy four hours of parallel work. All three at one screen, P2 types.

Commit two files to `main`:

**`src/nightwatch/domain/models.ts`** — `Notice`, `Site`, `SiteStatus`, `Plan`, `Approval`, `Observation`, plus signatures for `isValidFor()`, `computeSiteStatus()`, `executePlan()`, `hashPlan()`. Bodies throw `not implemented`.

**`src/nightwatch/fixtures.ts`** — hardcoded `Notice` v1, its v2 revision, three `SiteStatus` rows (one RECOMMENDED, one WAIT, one NO WINDOW), one `Plan`. Real-looking numbers, zero computation.

```bash
git add -A && git commit -m "feat: domain contract + fixtures" && git push
```

**After this nobody is blocked on anybody.** Everyone builds against `fixtures.ts`.

---

## Phase 3 — Parallel block 1 (11:45–12:45) · **PARALLEL**

| P1 — Channels | P2 — Core | P3 — Science |
|---|---|---|
| `npm run channel:setup`, fill `CHANNEL_CODE` + `INTELLIGENCE_API_KEY` in `.env` | Store: SQLite (`better-sqlite3`) or JSON. Events, notices, approvals, audit rows | `npm i astronomy-engine`. Write `raDegToHours()` helper and **test it** |
| `npm run dev:slack`, invite the bot, confirm it answers in a thread | State machine: version bump on revision, transitions, audit append | `computeSiteStatus()`: altitude via `Horizon()`, Moon separation, window by 5-min grid sampling |
| Alert card + site table card, rendered **from `fixtures.ts`** | `Approval` + `isValidFor()` + `hashPlan()`. **Unit test: version bump invalidates.** | Three site configs: Tenerife, Arizona, Bengaluru — lat/lon/alt, altitude limit, instruments |
| Approval card with APPROVE / MODIFY / IGNORE buttons wired to a stub handler | Telescope adapter interface + simulator skeleton (`slew → expose → complete`) | 3 tests: target up / below horizon all night / rises later |

**Gate 12:15 — P1 only:** if `dev:slack` has not responded in a thread by now, stop everything else and all three debug it. Channel Code must match Intelligence **exactly**; the key must be project-scoped.

**Gotcha for P3:** `Horizon()` takes **RA in hours, Dec in degrees**. `raHours = raDeg / 15`. Get it wrong and every number is silently plausible and wrong.

---

## Phase 4 — Swap 1: real science into the cards (12:45–13:00) · **SYNC**

Merge `p3-science` and `p1-channels` into `main`. Replace the fixture `computeSiteStatus` with the real one.

**Success:** the site table card renders real computed numbers with **zero changes to card code.**
If card code has to change, the contract was wrong — fix `models.ts`, not the callers.

```bash
git checkout main && git merge p3-science && git merge p1-channels && git push
```

---

## Phase 5 — Parallel block 2 (13:00–13:45) · **PARALLEL**

| P1 — Channels | P2 — Core | P3 — Replay + docs |
|---|---|---|
| Approval handler writes a real `Approval` through P2's store | `recordApproval()`, `revokeApproval(reason)`, coverage-loss calculation | `replay.ts`: fires real GCN notices v1 → v2 on a timer at demo speed |
| **Revocation card**: title → `APPROVAL VOIDED`, action disabled, reason + coverage loss shown | **The invalidation path**: new notice version → find live approvals → revoke → emit event | Wire Exa (`EXA_API_KEY` in `.env`; the Slack template auto-registers it) |
| In-place card updates via the Channels update path | Duplicate-notice handling: update the existing event, never create a second | **Start `README.md` and `SUBMISSION.md` now.** Architecture diagram. |

---

## Phase 6 — Swap 2: THE GATE (13:45–14:00) · **SYNC**

**All three people. Nothing else happens until this works.**

Merge everything to `main`. Run the replay end to end:

1. Notice v1 lands → thread opens → real site table
2. APPROVE → approval stored → simulator starts
3. Notice v2 lands → **approval voids visibly in the thread** → coverage loss → new proposal
4. Approve the revision → completes → result card

**This is the go/no-go on the whole project.**

- **Works?** → Phase 7 as written.
- **Doesn't?** → Phase 7 becomes gate recovery for all three. Ambiguous and Auth0 are cut. That is the trade, and it is not negotiable: the gate is the project.

Tag it: `git tag gate-passed && git push --tags`

---

## Phase 7 — Parallel block 3 (14:00–14:50) · **PARALLEL**

Everything runs at once. Hard caps — when the clock hits, stop wherever you are and commit what works.

| P1 — Polish + capture | P2 — Auth0 (**30 min cap, stop 14:30**) | P3 — Ambiguous (**40 min cap, stop 14:40**) |
|---|---|---|
| Simulator status streaming in place: slewing → exposing → processing | `npm ci --prefix dev-docs/auth0`, `npm test --prefix dev-docs/auth0` | Identity check first: `GET https://app.ambiguous.ai/api/users/me` with the Bearer key |
| Result card: candidate position, SNR, labelled image | Auth0 API, RS256, audience, permission granted to an M2M app | Connect over MCP via `capabilities/workplace.ts` |
| `SIMULATED` label audit — every card, no exceptions | Token + scope check **inside the telescope write boundary**, beside `isValidFor` | Draft the follow-up circular with provenance; **approval required before write** |
| Set up screen recording, clean the workspace, rehearse the demo once | If `.env` values aren't working by 14:30, **stop.** Commit what runs. | **Never invent MCP tool names or record URLs** — schemas come from the live workspace |
| | | Then back to README + SUBMISSION.md |

**Failure design** (P2, whatever time is left): all-sites-unavailable explanation, telescope-rejects fallback to the next site.

---

## Phase 8 — Dress rehearsal (14:50–15:05) · **SYNC**

Run the full demo **twice, start to finish, no edits between runs.**

- [ ] Notice lands, nobody typed anything
- [ ] Real site table with three different statuses
- [ ] APPROVE → simulator streams
- [ ] Revision → approval voids → new proposal
- [ ] Approve revision → result returns
- [ ] Duplicate notice creates no second request
- [ ] Every telescope mention says SIMULATED

Any bug found here is fixed only if it takes under five minutes. Otherwise it gets a README line under known limitations.

---

## Phase 9 — Freeze (15:05) · **PARALLEL, final**

**No code changes after 15:05. The freeze is a rule.**

| P1 | P2 | P3 |
|---|---|---|
| **Record the video.** Two minutes, shot list below. Multiple takes, pick the best. | Deploy to Cloud Run. Verify the URL is reachable from a phone on mobile data. | Finish README + `SUBMISSION.md`. Write the social post. |
| | `git log` → confirm no keys committed. `.env` in `.gitignore`. | Repo public. |

### Video shot list (2:00)

| | |
|---|---|
| 0:00–0:12 | Notice lands beside a ticking timer. **Nobody typed anything.** |
| 0:12–0:30 | Thread opens, GRB identified, Exa evidence with sources |
| 0:30–0:50 | Three sites compared — below horizon / late / observable now |
| 0:50–1:05 | APPROVE tapped; simulator slews and exposes |
| **1:05–1:30** | **Revision lands. Approval voids. Coverage loss. New proposal.** Don't narrate — let it void on screen. |
| 1:30–1:45 | Approve the revision; result returns to the same thread |
| 1:45–2:00 | Architecture, trust-split table, one sentence of thesis |

---

## Phase 10 — Submit (15:30–16:00) · **SYNC**

**P3 drives the portal, P1 and P2 watch and check off.**

- [ ] Project title
- [ ] Written description
- [ ] Public GitHub repo URL
- [ ] Two-minute video
- [ ] Social post tagging the event partners — **posted, link saved**
- [ ] Deployed URL reachable
- [ ] `SUBMISSION.md` names the baseline commit and lists inherited vs built-today
- [ ] README: thesis · video · consent tiers · trust split · architecture · failure design · idempotency key · the kit's write-boundary line and how NightWatch answers it

**Submit at 15:45 even if something is imperfect.** A submitted imperfect project scores; an unsubmitted perfect one does not.

---

## Standing rules

1. **Never edit a file you don't own.** Ask the owner.
2. **Merge to `main` only at SYNC points.** Work on your branch otherwise.
3. **Hard caps are hard.** When the clock hits, commit what works and move on.
4. **The 13:45 gate outranks everything.** If it slips, the stretch integrations die — not the gate.
5. **No number in Slack comes from a language model.** Ever.
6. **If you can't classify an action's tier, it's tier 3** — blocked, human approval required.
7. **Coding agents get a scope line**: *"You own `<dir>` only. Import types from `domain/models.ts`. Do not edit files outside your directory."* Without it they will all refactor `tools.tsx`.
