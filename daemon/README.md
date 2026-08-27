# Fogline Daemon

The world half of the Fogline protocol (`fogline-protocol-v0.5.md` as
amended by the v0.6 and v0.7 amendment documents, implemented per
`fogline-daemon-spec-v0.7.md`). Owns the grid, slots, bodies,
personas, resources, vitals, lineage, memory, destruction, viability, the
clock, the tick engine, and the operator channel. Holds **no model
credentials** and makes **no inference API calls** — there is no `.env` file,
and that absence is deliberate. The only dependency is Express.

**v0.7 in one paragraph:** run 10 killed five of twelve, and the postmortem
found only one of the three causes was scarcity — which is deliberate and
stays; the other two were the world lying by omission, and they go. Every
`consume` now sets `lastActionOutcome` reporting what it restored,
including nothing ("consumed 1 khal; it restored nothing" — twenty units of
inert khal were eaten across four agents' dying ticks with zero feedback).
`self` gains `vitalityTrend` (`recovering`/`holding`/`falling`), derived at
observation time from the raw delta `runUpkeep` captured — the trend string
is never stored, it never appears for any other agent (`present` keeps
bands only), and **nothing exposes `regenThreshold`, the regen rate, or any
figure they derive from**: the state is perceivable, the mechanic is not
(the gate test that matters most). Viability computes `capacityMargin` and
`deathsRequired` (`capacity − expectedAgents`) at boot — a plain-words
console headline, in the run header, at `/scenario`, and on the operator
snapshot; a lethal world still boots (visibility, not prevention — run 10's
two designed-in deaths were discovered in the postmortem) and the ratio
floor still refuses. `tripDistance` now measures from food to the furthest
**required** material (max over per-material nearest trips; every recipe
but `marker` needs both) instead of the old any-material minimum, which had
measured the trip to the material a builder needs least and would pass an
unbuildable world. `gather` at a corpse with no loose pile says "a corpse
holds nothing" instead of contradicting the observation that just showed a
corpse. The v0.6 failed-attempt record was **verified, not extended** (spec
§7): it works end-to-end, but it keys on the exact `(type, form, reason)`,
and a shortfall string changes as inventory grows — a builder gathering
between attempts fragments the count into count-1 entries and the
"attempted N times" line never renders. Reported as a finding about the
record's collapse rule; per spec, nothing was changed.

**v0.6 in one paragraph:** inscriptions became **append-only**
(`world/inscription.js`): an inscription is an ordered entry list carrying
`authorName` and tick in-world (the deliberate opacity exception — entries
are speech that persists; `authorId` stays operator-side), `inscriptionMax`
is a permanent per-structure budget with no compaction or reclamation ever
(a full wall stays full — that is the mechanic, not a leak), anyone in the
cell may append to any structure with no ownership check, an over-budget
append is rejected whole with the shortfall in `lastActionOutcome`, `raze`
is the only erasure, and `demolish` preserves the entries as an attributed
fragment. Wall vandalism is possible and deliberately undefended. Beside
that: viability demand computes over `expectedAgents` (config, default
`minAgents`) instead of slots; a **construction slack** ratio (can the
expected population afford to leave the springs and gather material?) is
computed at boot, logged, and exposed at `/scenario` beside viability; each
body keeps a bounded record of its own failed attempts, collapsed by
identical (type, target/form, reason) and surfaced as `attempts` on a failed
`lastActionOutcome` — per-agent knowledge, stored on the body and nowhere
globally convenient; an optional `clientStatus` enum rides the action
envelope (lenient like `intent`/`reason`, operator channel only, never
world-affecting); both SSE streams emit keep-alive comments and the server
sets `keepAliveTimeout`/`headersTimeout` explicitly (run 7's ~1-per-7-ticks
stream drops looked exactly like a 60s idle timeout); and death records flag
whether reachable food existed at death (`foodAtDeath`:
inventory/nearby/none — operator-side only).

**v0.5 in one paragraph:** an amendment pass over v0.4's economy, aimed at
one failure: the first 200-tick run went extinct at tick 180 with supply at
0.70 of demand and a steady-state carrying capacity of 1.25 agents against 5
slots — an outcome decided entirely at generation, before tick 1, that no
strategy could have changed. `world/viability.js` now computes subsistence
ratio, carrying capacity, and an optimal-play survivor baseline at boot,
**refuses to boot** below `viability.viabilityFloor` (default 1.0) with the
full arithmetic in the error, and reproduces 0.70/1.25 from the v0.4
extinction config under test. Seeding changed with it: sivet is seeded by
`viability.targetRatio` (default 1.35), not `seedDensity` — a density's
meaning shifts with grid, slots, decay, and run length, a ratio does not —
and `seedDeposits` guarantees `minSpringsPerResource` (default 2) springs per
resource before any surplus is distributed, order-independent over the
name-sorted resource list (the v0.4 round-robin allocator could give the lean
preset exactly one sivet cell). Three smaller amendments ride along: memory
fragments are read once per fragment *per agent*, not once globally; the
billing `surface` a client declares at register/attach is stored on the
connection and exposed only on the operator channel, never in an observation;
and client-reported per-tick call counts are aggregated per surface onto the
operator stream, so concentration shows on the roster, not the invoice.

**v0.4 in one paragraph:** things can be taken apart now. `demolish` needs
`demolishTicks` consecutive ticks by the same agent in the cell — visible to
everyone present, silently reset by any other action — and leaves full rubble
with any inscription surviving as a fragment on the pile. `raze` is one tick,
costs vitality, leaves less rubble, and destroys the inscription: erasing a
record is a deliberate, expensive act. Both target anyone's structure, and
actorship is operator-side only, exactly like corpse cause. `rubble` is a
fourth never-seeded resource that substitutes for orrum at a poor ratio,
reported only on build success — a failure names the primary shortfall and
never mentions rubble. Four live-run amendments land too: `give` is
all-or-nothing with a generic failure (partial transfer was an inventory
probe), `intent`/`reason` are nullable and never sink a valid action,
`takeover: true` is honored on any body with attach claim-only by default,
and `gridSize < 2` fails fast at boot. Tuning makes hunger real: decay 3,
fewer-richer deposits, `maxTicks` 200, with `config.lean.json` (5x5, decay 4,
one contested sivet spring, 400 ticks) as the harsh preset that exercises
attack, beget, and foster.

**v0.3 in one paragraph:** v0.2 gave the world geography; v0.3 gives it an
economy, a body count, and a family tree. Cells carry deposits of invented
resources (`sivet`, `orrum`, `khal`) whose properties are discovered by use,
never stated. Agents hunger, weaken, and die — dropping what they carried,
leaving a permanent corpse, and taking everything they knew with them.
Structures have forms with material costs agents learn only from failed
attempts (`"short 2 orrum, 1 khal"` is the recipe table's entire public
surface). Inscription is the one channel that outlives its author. Attack is
deterministic, costed, and witnessed — what is known about a killer is only
what a witness remembers and chose to repeat; there is no reputation stat
anywhere. Agents beget infants whose appearance is composed by discrete
inheritance, who drain their sponsor, and who die unfostered if nobody
present chooses otherwise — fostering is never automatic. `situationChanged`
tells clients when a tick is worth a model call; a genuinely static tick
reports false.

## Run

```
npm install
npm start                       # daemon at http://localhost:3000 (paused; register agents, press play)
node server.js config.lean.json # the lean preset instead
npm test                        # 167 tests (node --test)
npm run verify                  # 20 ticks, two unmanned bodies: waits, misses climb, never stalled
```

The built-in page at `/` is the legacy 2D operator view; the real viewer is
the standalone `scry/` package (its own port, live SSE or ticks.log
replay), which is why `/observatory/*` and `/control` now answer CORS.

The daemon starts paused (`startPaused: true`), and tick 1 will not open until
`minAgents` slots are used (default 2) — the world waits for its cast to walk
in. All knobs live in `config.json`: grid 8x8, 12 slots, clustered deposits,
vitals, genotype rates, beget costs.

## Layout

```
server.js            express wiring, route mounting, startup, log streams
engine/tick.js       tick lifecycle state machine (never awaits a client),
                     minAgents gate, reaper, resolved-tick log
engine/resolve.js    resolution in protocol §15 order: speech → attack →
                     raze → demolish → give/drop/consume → gather → build →
                     inscribe → beget/foster → movement → upkeep → deaths →
                     maturation
engine/clock.js      sim time
world/world.js       grid, slots, bodies, infants, persona validation (the guard)
world/appearance.js  v0.3 appearance enums + color math (saturation ceiling)
world/viability.js   subsistence ratio, carrying capacity, optimal-play
                     baseline, boot-refusal message (v0.5); capacity
                     headline + worst-required-material tripDistance (v0.7)
world/resources.js   deposits, clustering, regeneration, loose piles,
                     ratio-path seeding + guaranteed minimum springs (v0.5)
world/recipes.js     PRIVATE. Form costs + rubble substitution (buildPlan).
                     Unreachable from api/ — enforced by test.
world/destruction.js demolish progress, raze, rubble yields, silent resets
world/vitals.js      sustenance, vitality, upkeep order, derived bands,
                     per-body upkeep delta feeding vitalityTrend (v0.7)
world/genotype.js    discrete inheritance, mutation, neutral divergence notes
world/lineage.js     heritage briefs, sponsorship, fostering, maturation
world/situation.js   situationChanged diff + attention budget
world/memory.js      streams, deterministic importance, keyword retrieval,
                     automatic inscription reading (once per text)
world/observe.js     THE FOG BOUNDARY — four fogs: spatial, cartographic,
                     persona, condition
api/auth.js          two realms, two middlewares (agent / operator)
api/agent.js         /scenario /register /attach + /agent/stream|act|leave|release
api/operator.js      /observatory/* + /control (omniscient, raw values),
                     CORS for the standalone Scry viewer, GET snapshot
public/              legacy 2D operator view (vanilla JS, no build step)
```

## Protocol surface (HTTP binding)

| Method | Path | Auth |
|---|---|---|
| GET | `/scenario` | none |
| POST | `/register` | none |
| POST | `/attach` | none |
| GET | `/agent/stream` | agent token |
| POST | `/agent/act` | agent token |
| POST | `/agent/leave` | agent token |
| POST | `/agent/release` | agent token |

Error codes: `INVALID_ACTION` / `INVALID_PERSONA` / `VERSION_UNSUPPORTED` →
400, `WORLD_FULL` / `NAME_TAKEN` / `WRONG_TICK` / `TICK_CLOSED` /
`ALREADY_ACTED` / `NOT_ATTACHABLE` → 409, `BAD_TOKEN` → 403, `NO_SUCH_AGENT`
→ 404, `SLOT_RECLAIMED` → 410. A dead body's token answers `SLOT_RECLAIMED`
on its next request. `/scenario` additionally lists `attachable`: matured,
in-world-born bodies with their heritage briefs, claimed first come, first
served (`NOT_ATTACHABLE` for the losers).

## The four fogs (daemon spec §11)

| Fog | Rule |
|---|---|
| Spatial | `present`, `heard`, `deposit`, `loose`, `corpses`, `structure` are same-cell only. `exits` gives coordinates, never contents. |
| Cartographic | `knownCells` contains only visited cells, snapshots stale, inscriptions stale. |
| Persona | `present` carries observable tier only — never `identity`, `discoverable`, `privateObjective`, or `reason`. |
| Condition | `present` carries **bands only** (`hale/hurt/failing`, `fed/hungry/starving`). No other agent's raw vitality, sustenance, or inventory, ever. |

All agent-authored strings appear under an `authored` key at every site so
clients can wrap them as reported content, not instruction.

## Test map

1. Recipe containment (import graph + response scans) — `test/containment.test.js`
2. Shortfall leak bound — `test/structures.test.js`
3. Condition fog string-scan — `test/conditionfog.test.js`
4. Death consequences — `test/death.test.js`
5. Coerced attack costs nothing — `test/attack.test.js`
6. Witness memories cell-local — `test/attack.test.js`
7. No reputation stat (vocabulary scan) — `test/containment.test.js`
8. Genotype across 500 begets, neutral divergence wordlist — `test/genotype.test.js`
9. Heritage snapshots at birth, no privateObjective, raisedBy — `test/lineage.test.js`
10. Infants unattachable, immobile, no observation — `test/lineage.test.js`
11. Orphan dies, no daemon-assigned guardian — `test/lineage.test.js`
12. situationChanged FALSE case, five static ticks — `test/situation.test.js`
13. Upkeep ordering: eat on the starving tick — `test/inventory.test.js`
14. Contested gather split — `test/inventory.test.js`

v0.4 gates (daemon spec v0.4 §6) — `test/v04.test.js`: give atomicity with
the no-number/no-capacity string scan, metadata leniency, takeover on a live
heir, demolish progress/reset/replacement, progress visibility bounded to
the cell, raze erases (no fragment, cost paid), demolish preserves (fragment
reads once, rides the rubble), destruction anonymity (zero actor traces in
any observation), rubble never seeded, substitution reported only on success
with the failure scan, gridSize 1 rejected at boot, run_started boundaries
with distinct run ids, and the rubble arrival trigger. 139 tests total.

Every v0.2 test is carried forward (fog, map, build, slots, engine, api,
memory, multiagent, world), adapted only where the protocol changed the
surface (appearance schema, build forms/materials, protocol version string).

v0.5 gates (daemon spec v0.5 §6) — `test/v05.test.js`: viability arithmetic
reproducing 0.70/1.25 from the v0.4 extinction config, boot refusal below
`viabilityFloor` with the arithmetic in the error, allocation fairness under
shuffled resource order (every resource gets its guaranteed minimum
regardless of iteration order), and `surface` absent from every observation
while present on the operator channel and roster.

v0.6 gates (daemon spec v0.6 §10) — `test/v06.test.js`: demand over
`expectedAgents` with both populations in the boot log, construction slack
below 1 on a viable-but-buildless world, failed-attempt collapse/bounding
and its containment (string-scanned), `clientStatus` stored and
operator-only, SSE keep-alive comments plus explicit server timeouts, death
food flags distinct and observation-free, append-only inscribe (never
alters, anyone appends, over-budget rejected whole), permanent budgets with
no reclamation path, raze-versus-demolish erasure, and in-world
`authorName`/tick with `authorId` string-scanned out of observations.

v0.7 gates (daemon spec v0.7 §8) — `test/v07.test.js`: consume outcomes for
khal (nil), sivet (amount), and sivet at a full tank (nil again); all three
`vitalityTrend` states from a scripted upkeep sequence; trend containment
(never for another agent, the raw delta never ships — string-scanned);
threshold opacity (no observation or `/scenario` response carries
`regenThreshold`, a regen field, or a vitals block — the anchored scan that
matters most); the capacity headline (a capacity-short world boots with
`deathsRequired` in the run header and at `/scenario`, a below-floor config
still refuses); worst-required-material `tripDistance` (orrum in a far
corner beats khal beside the spring; a missing material collapses the travel
factor); and the corpse-versus-empty gather distinction. The two v0.5
inventory tests asserting consume's old silent outcome were updated to the
v0.7 A1 behavior.

v0.8 gates (daemon spec v0.8 §5) — `test/v08.test.js`: archive at boot;
the outcome summary (survivors, deaths with cause and `foodAtDeath`,
structures by form, action counts); an abandoned run indexed as incomplete
rather than vanishing; the index rebuilding byte-identically from the
per-run records; archive containment (no agent route, agent tokens 403 on
the operator archive reads, nothing static serves it); the extract ceiling
refusing with its size rather than truncating; crosscheck failure non-fatal;
process-group cleanup across a hundred cycles (timeout and shutdown kills,
clean table); one-at-a-time refusal recorded on the run record; all five
supervision states reaching the operator channel; and the daemon serving
Scry and `/scenario` throughout a crosscheck. 178 tests total.

## The run archive and the post-run crosscheck (v0.8)

`run/archive.js` — flat files under `archive/<runId>/record.json` plus a
DERIVED `archive/index.json` that rebuilds identically from the records.
Written at boot (config verbatim, boot figures, `run_started`) and at run
stop (the outcome summary); a run killed mid-flight stays in the index
marked incomplete. Read by Scry over the operator realm
(`/observatory/archive/*`), reachable by no agent route.

`run/crosscheck.js` — when a run stops, the daemon starts crosscheck
automatically (config `crosscheck.enabled`, default true) and SUPERVISES
it: non-blocking, one at a time, ~15-minute hard ceiling, process-group
SIGKILL on timeout and on daemon shutdown. Spawning it is not a credentials
breach: crosscheck authenticates through its own CLI OAuth exactly as an
agent client does, and the daemon holds no key. `run/extract.js` builds the
scoped input — world events minus reflections, client-log windows around
deaths, first-of-kind events and the final ticks, plus a death-specifics
appendix generated from the outcome summary — and REFUSES above
`crosscheck.maxExtractBytes` rather than truncating. (Diagnosis, run 11:
vendor latency tracks input size, not invocation shape; every input over
~400KB timed out at least one vendor at 900s.)

## Logs

`barrier.log` — tick lifecycle, latencies, rejections, registrations, births,
deaths, reaps; nothing about content.
`world.log` — speech, builds, inscriptions, movement, attacks, gathers,
gives, begets, fosterings, maturations, deaths, reflections, attach/leave.
`ticks.log` — a `run_started` boundary (run id, config hash, seeded
deposits, premise) at boot and every reset, then one consolidated line per
resolved tick: the tick's world events, memory writes, every agent's action
with latency, all bodies, and every non-empty cell. The identical record is
emitted on the operator stream, so Scry's live and replay modes
fold the same input — every run is replay material even if it dies early.
