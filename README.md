# Fishbowl

A tiny persistent world where LLM agents live under fog: they know only the
cells they have stood in, see bands instead of numbers, and learn physics by
failing at it. The daemon owns the world and holds no model credentials; each
client supplies decisions for exactly one agent; the observatory watches from
outside the fog. What the protocol refuses to provide — money, law,
ownership, reputation, trade with consent — is exactly what the runs exist to
watch agents invent.

**Current version: v0.8** (`specs/`) — **the operator release**. Protocol
v0.5 stays in force, read jointly with the v0.6 and v0.7 amendments; v0.8
adds none. Its defining property is what it doesn't touch: no prompt
changes, no world semantics, `client/` never opened — run 12 ran on it
directly comparable to run 11. Everything in it is operator instrumentation.
The daemon gains a **run archive** (per-run `record.json` plus a derived
index that rebuilds byte-identically; a run killed mid-flight stays indexed
as incomplete) and a **supervised post-run crosscheck** — automatic when a
run stops, non-blocking, one at a time, process-group-killed on timeout and
on shutdown, never outliving the daemon. Its scoped extract (world events
minus reflections, windows around deaths and first-of-kind events, a
death-specifics appendix) **refuses above a byte ceiling rather than
truncating** — the run-11 diagnosis showed vendor latency tracks input
size, not invocation shape. Spawning crosscheck is not a credentials
breach: it authenticates via its own CLI OAuth exactly as a client does.
The observatory gains an **LLM-backed analyst** (read-only *structurally* —
its client cannot construct a request to `/control`, `/spark`, or any
config path; a fifth billing surface; private objectives behind a
default-off toggle; watch mode riding `situationChanged`), a **pre-boot
config panel** (the ported viability arithmetic previews ratio, capacity,
deaths-structurally-required and slack live; diffs against the prior run's
archived config; frozen at tick 1; the built bundle greps clean of every
recipe key), a **crosscheck report page** (disagreements first, faulted
vendors as labelled faults, rendered from the report file alone), a paced
**ticker** that recycles real headlines through quiet stretches, and tab
identity. Run 12's result: 6 of 12 survived against 2 structurally required
deaths — zero attacks and zero begets across twelve runs now, with gifts
under famine instead.

**v0.7** answered run 10 (twelve agents, five dead), whose postmortem found the
deaths came from three causes and **only one was scarcity — which is
deliberate and stays**. The other two were broken affordances: a `consume`
now always reports what it restored, including nothing (twenty units of
inert khal were eaten across four agents' dying ticks with zero feedback),
and agents perceive their own `vitalityTrend`
(`recovering`/`holding`/`falling`) — the outcome of an invisible recovery
mechanic that made every one-unit gift in ten runs a gesture that could not
work. The mechanic itself stays invisible: nothing exposes `regenThreshold`
or the regen rate, so the state is perceivable but the strategy is not.
Viability now computes `capacity − expectedAgents` at boot and headlines how
many deaths are structurally required (run 10's two designed-in deaths were
discovered in the postmortem; a lethal world still boots — announced, never
refused), `tripDistance` measures to the furthest *required* material
instead of the nearest any-material (the old minimum would pass an
unbuildable world), and gathering at a corpse says "a corpse holds nothing"
instead of claiming the cell is empty. The client gains a fourth surface —
**GLM**, the same claude binary against z.ai's Anthropic-compatible endpoint
via per-vendor env, confirmed empirically before the config (6.3s
single-shot against a 45s tick; the fearsome 512s crosscheck number was an
agentic-loop artifact) — plus three pieces of adapter hardening run 8
earned: per-adapter version pins with a loud drift warning, a startup smoke
test (a client that cannot produce a response must not take a slot), and a
consecutive-fault alarm. The v0.6 failed-attempt record was investigated,
not extended: it works end-to-end, but it keys on the exact failure reason,
so a builder gathering between attempts fragments the count — a finding,
recorded, not fixed.

**v0.6** brought **append-only inscriptions**: `inscribe` can never modify or remove
an existing entry, `inscriptionMax` is a permanent per-structure budget (a
full wall stays full forever — no compaction, no reclamation), anyone in the
cell may append to any structure, and each entry carries its author's name
and tick **in-world** — a deliberate opacity exception, because a multi-author
wall is useless if a reader cannot tell whose entry is whose. Vandalism —
exhausting someone else's wall with junk — is possible and deliberately
undefended. Alongside it: the exclusivity claim ("the only thing that does")
is cut from spec and prompt, `beget` gets a costed factual line at the attack
line's register, `wait` reads as an ordinary action, agents perceive their own
failed-attempt counts, viability demand computes over `expectedAgents` rather
than slots, a construction-slack ratio sits beside subsistence, death records
flag whether reachable food existed, clients emit a typed `clientStatus`, SSE
streams keep-alive, and the observatory gains a moonlight floor, eye-cast
lights, a lighting override, and an inscription history panel.

**v0.5** was an amendment pass, not a rewrite: the
daemon now computes its own viability at boot — subsistence ratio, steady-state
carrying capacity, and an optimal-play survivor baseline — and **refuses to
boot** below `viabilityFloor`, arithmetic in the error. It exists because the
v0.4 extinction run (tick 180, all 5 agents) was decided at generation, with
supply at 0.70 of demand and a carrying capacity of 1.25 agents against a
population of 5 — nothing had ever computed the product of the two knobs that
decided it. Sivet is now seeded by `targetRatio`, not density, and every
resource is guaranteed `minSpringsPerResource` springs before any surplus.
The client gained three subprocess CLI vendors (`claude-cli`, `codex-cli`,
`kimi-cli`) over one base adapter, each declaring a `surface` (vendor + 4-hex
account fingerprint, never a credential) and classifying faults as slow /
adapter_fault / bad output — so an expired session reads as a fault, not 200
ticks of a pensive agent. The observatory adds viability, spend-per-surface,
and Departed-roster panels, plus a real material/lighting pass. A same-day
follow-up (found live running a 5-founder, three-vendor world) fixed four
client startup/tick-loop reliability bugs: overlapping decide/act chains
under a slow adapter, an uncaught registration-time fault that could kill the
whole client process, launch-order-determined heir claim races, and a
persona-generation call with no timeout. See `client/README.md`'s v0.5
section for specifics.

## Packages

| Package | What | Tests |
|---|---|---|
| [`daemon/`](daemon/) | The world: grid, bodies, vitals, resources, structures, destruction, lineage, memory, the four fogs, viability arithmetic, tick engine, operator channel, run archive, crosscheck supervision. Express only, no credentials ever. | 178 |
| [`client/`](client/) | Decisions for one agent: prompt building, parsing, cheap-tick continuation, deadline budgeting, persona authoring, subprocess CLI adapters. The only place a model credential exists. | 119 |
| [`observatory/`](observatory/) | Standalone three.js viewer. Live SSE from the daemon or replay of a saved `ticks.log`, one shared reducer for both. Sphere robots, simTime sun, fog-overlay agent maps, destruction ledger, viability/spend/norm/inscription panels, plus the v0.8 analyst, pre-boot config panel, crosscheck page, and ticker. | 36 |

## Quick start

```bash
# world
cd daemon && npm install && npm start            # http://localhost:3100, paused
# refuses to boot below viability.viabilityFloor — the error gives the arithmetic

# a couple of agents (repeat with different --label)
cd client && npm install
node index.js --label a --adapter scripted --server http://localhost:3100   # credential-free
node index.js --label b --adapter scripted --server http://localhost:3100
# or a real vendor: claude-code, claude, claude-cli, codex-cli, kimi-cli, glm-cli — see client/README.md

# the viewer — press play in its transport bar to start the run
cd observatory && npm install && npm run dev     # http://localhost:5173
cd observatory && npm run analyst                # the analyst sidecar, http://localhost:3200
```

Replay a finished run with no daemon: `cd observatory && npm run dev`, then
open `?source=replay` with a served `ticks.log`, or just drop the file onto
the page.

## Layout

```
specs/      normative documents: protocol v0.5 + the v0.6 and v0.7
            amendments (jointly normative), the v0.8 daemon/observatory
            specs, and the v0.7 client spec (still current)
daemon/     world half
client/     client half
observatory/ viewer
archive/    superseded specs, goals, and packages (v0–v0.7)
```

Each package has its own README with the full picture.
