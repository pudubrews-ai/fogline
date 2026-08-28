# Fogline Protocol Reference

**Document version 1.0 · wire protocol `0.x`**

The contract between a Fogline daemon and a Fogline client. This document is
normative and standalone: a client author needs nothing else. MUST, MUST
NOT, SHOULD, and MAY carry their conventional meaning.

The wire protocol version is a `"0.x"` string carried in every request that
takes a body. Daemons accept `0.2` and above.

---

## 1. Invariants

1. **The daemon MUST NOT hold model credentials.**
2. **The daemon MUST NOT include in an observation anything the agent cannot
   perceive** (§8). Enforced structurally, not by convention.
3. **The client MUST NOT hold world state between ticks.** Sole exception:
   its own `agentId` and token (§12.5).
4. **The daemon MUST NOT block on a client.** Deadlines are hard and
   unilateral.
5. **The daemon owns persona text after registration.** There is no write
   path to a frozen persona.
6. **The daemon MUST NOT author identity, objective, or motive.** Genotype
   and heritage briefs are facts about ancestry, not character.
7. **The world MUST be viable or MUST refuse to start** (§5).
8. **Worlds declare WHICH actions exist; the engine declares HOW each
   resolves and what it reveals** (§9). No world definition can widen what
   an action exposes.

## 2. Terms

**Agent** — a persistent identity occupying a slot. Owns a body, position,
persona, memory stream, and map.

**Client** — a process supplying decisions for one agent. Holds no world
state. Declares a model hint and a **billing surface**.

**Slot** — one of a fixed number of body capacities.

**Cell** — one grid position, `"x,y"`, zero-indexed from the northwest
corner. The grid is `width × height`; non-square grids are permitted.
Adjacency is 4-way (north, east, south, west), in-bounds only.

**Structure** — an agent-built thing occupying a cell, with a form, authored
name and description, an append-only inscription, and operator-side history.

**Tick** — one atomic step of world time.

**World definition** — the operator-supplied declaration of grid, resources,
recipes, forms, vitals, viability targets, premise, and enabled actions. It
is never served to clients (§3).

## 3. Knowledge rules

Resources have world-specific names and non-obvious combinatorial
properties.

- **Consumable properties are given.** An agent knows which resource feeds
  it; `/scenario` and the observation never state it, but clients MAY tell
  their models, and the `consume` outcome reports what was restored.
- **Combinatorial properties are discovered.** Material costs live in the
  daemon's private world definition. The only channel by which any part of
  a recipe reaches an agent is a build failure's shortfall (§9.4).

Daemons MUST NOT publish the recipe table or the world definition. Clients
MUST NOT ship with recipe knowledge, including any byproduct's substitution
ratio.

## 4. Resources

The world definition declares each resource with a role:

- **consumable** — restores the need it declares when consumed.
- **structural** — appears in recipes; role discovered through failures.
- **byproduct** — never seeded; produced by destruction; substitutes for a
  declared resource at a declared ratio, reported only on build success.

Deposits carry `{resource, quantity}` and MAY regenerate toward their seeded
capacity. A mined-out deposit is reported as absent. Loose piles are dropped
by death, `drop`, or destruction, and never regenerate.

Inventory is bounded by `carryLimit`.

## 5. World viability

At boot, before opening tick 1, the daemon MUST compute and log:

```
demand   = expectedAgents × ((sustenanceDecayPerTick × maxTicks) − sustenanceMax) / restores
supply   = seeded consumable + (consumable springs × regenPerTick × maxTicks)
ratio    = supply / demand
capacity = (consumable springs × regenPerTick × restores) / sustenanceDecayPerTick
```

where `restores` is the consumable resource's declared restore amount and
`expectedAgents` is the population the operator plans to run (config,
default `minAgents`).

- The daemon MUST refuse to start when `ratio < viabilityFloor`, with the
  arithmetic in the error.
- The daemon MUST compute `capacity − expectedAgents` and state how many
  deaths are structurally required. It MUST NOT refuse to boot on that
  basis: a lethal world is a legitimate configuration, chosen rather than
  discovered.
- The daemon MUST compute an optimal-play survivor baseline, bounded by
  `expectedAgents` — the same population demand is computed over.
- The daemon MUST compute a **construction slack** ratio beside subsistence:
  whether surplus exists to leave the consumable springs and gather building
  material. The binding trip is to the **furthest required material**.
- Deposit seeding MUST guarantee a minimum spring count per seedable
  resource before distributing surplus, and MUST NOT be order-dependent.
- `viability` (all figures) and `constructionSlack` (the single ratio) are
  public at `/scenario`.

## 6. Sustenance, vitality, death

Sustenance decays each tick and is restored by consuming the consumable
resource. Vitality falls to attack, sponsorship drain, razing, orphanhood,
and starvation; it regenerates only while sustenance is above a threshold.
Vitality at `0` is death, with no dying state.

An agent perceives its own raw values and its own `vitalityTrend`
(`recovering` | `holding` | `falling`). The trend is self-only and MUST NOT
appear for any other agent; the mechanic behind it (threshold, rate) is
never exposed.

At death, in one tick: inventory drops as a loose pile; a permanent
**corpse** is placed (`name`, `appearance`, `diedAtTick`; the cause is
operator-side only); every agent in the cell receives a witness memory,
naming the killer only when the death followed an attack that tick;
structures, inscriptions, and speech already in others' memories persist;
the agent's own memories, map, and records are destroyed; dependents become
unsponsored; the slot is freed and the id is never reused.

**A corpse never reports who killed it.** Cause travels only through
witnesses. Corpses are perceivable and inert: they hold nothing and are not
gatherable, and a `gather` failure in their presence MUST distinguish "a
corpse holds nothing" from an empty cell.

## 7. Perception of persons

For each co-located agent in `present`: `agentId`, authored `name`,
`appearance`, `disposition`, `vitalityBand` (`hale` | `hurt` | `failing`),
`sustenanceBand` (`fed` | `hungry` | `starving`), `lifeStage`, and
`dependencyState` (infants only).

**Bands, never numbers.** No agent's raw vitality, sustenance, or inventory
appears in another agent's observation, ever.

`present` is **exhaustive**: no agent is in the cell who is not listed, and
clients MUST state this to their models.

## 8. The four fogs

The observation builder enforces four independent guarantees. These are
invariants of the engine; no world definition can relax them.

- **Spatial** — `present`, `heard`, `deposit`, `loose`, `fragment`,
  `corpses`, `structure`, and `demolishProgress` are same-cell only.
  `exits` gives in-bounds coordinates, never contents.
- **Cartographic** — `knownCells` contains only cells this agent has
  occupied, with snapshots as of the last visit, stale and never silently
  refreshed.
- **Persona** — other agents expose the observable tier only: name,
  appearance, disposition. Never `identity`, `discoverable`,
  `privateObjective`, or any private reason.
- **Condition** — other agents expose bands only (§7).

Additionally: corpse cause, structure history, destruction actorship, any
agent's billing surface, the recipe table, and the world definition never
appear in any client-visible response.

## 9. Actions

One action per tick. The engine resolves: `move`, `say`, `gather`, `drop`,
`give`, `consume`, `take`, `build`, `inscribe`, `demolish`, `raze`,
`attack`, `beget`, `foster`, `wait`. `modify` is RESERVED and MUST be
rejected.

**Which of these exist in a given world is the world definition's
declaration.** `/scenario` lists the enabled set as `actions`. An action the
engine knows but the world does not declare MUST be rejected with
`INVALID_ACTION` (like a reserved type) and MUST NOT be rendered in a client
prompt. `wait` always exists. An unknown type resolves to `wait` and is
logged, never rejected.

### 9.1 Envelope

```jsonc
{
  "protocol": "0.4",
  "tick": 41,
  "type": "move",
  "coord": "2,0",          // move only
  "text": null,             // say, inscribe
  "structure": null,        // build: { form, name, description }
  "target": null,           // give, attack, take, foster
  "resources": null,        // give, drop: { "<resource>": n, ... }
  "resource": null,         // consume, take: one resource name
  "intent": "…" | null,
  "reason": "…" | null,
  "reflections": null,      // array of strings when requested
  "calls": 1 | null,        // client-reported inference calls this tick
  "clientStatus": "ok" | "slow" | "adapter_fault" | "bad_output" | null
}
```

`intent`, `reason`, `reflections`, `calls`, and `clientStatus` are optional
metadata: a well-formed action MUST NOT be rejected or coerced for their
absence, and the daemon MUST NOT let `clientStatus` alter world behavior.

### 9.2 Coercion versus rejection

Well-formed but situationally invalid actions (absent target, blocked build,
bad move destination) are accepted, coerced to `wait`, logged, and reported
in `lastActionOutcome`. Structurally malformed actions are rejected with
`INVALID_ACTION`.

### 9.3 Give

Unilateral: requires no consent and cannot be refused. The request is
clamped to the giver's own holdings; all-or-nothing then applies to
recipient capacity only. If the clamped amount does not fit, nothing
transfers and the failure reports generically — no number, no mention of
capacity. The recipient receives a memory naming the giver and the amounts.

### 9.4 Build

Applies to the actor's current cell if empty. Contested builds resolve to
the lowest `agentId`; losers coerce to wait. A failed build MUST name the
missing amounts of primary materials in the world's terms and nothing else
— never the full cost, never other forms, never a byproduct substitution
hint. Substitution is reported only on success. A build writes no memory
into any other agent's stream.

### 9.5 Take

Unilateral and unresistable, symmetric with `give`. Requires a co-located
target; transfers exactly **one unit** of one resource from target to actor.

- The victim and every co-located agent receive an ordinary memory naming
  actor, target, and resource. Nothing outside the cell records it, and no
  counter of any kind tallies it.
- Failures coerce to wait and report flatly: target absent, target holds
  none of that resource, actor at carry limit.
- Resolves after `attack` and before `raze` (§11): an agent cannot take and
  flee in one tick, and a victim's same-tick move cannot dodge it.

### 9.6 Attack

Deterministic: `target.vitality -= attackDamage`,
`actor.vitality -= attackCost`, with `attackCost > 0`. No randomness, no
defence stat, no automatic retaliation. A coerced attack (target absent)
costs nothing to either party.

Every agent in the cell, target included, receives a witness memory naming
actor and target. Witness memories propagate by speech, decay by retrieval,
and die with the witness. **No reputation stat exists, in this or any
mechanic.**

### 9.7 Inscription

Inscriptions are **append-only**. Existing text can never be modified or
removed by `inscribe`.

- `inscriptionMax` is a permanent budget for the structure, not a per-write
  cap. A full wall stays full: no compaction, no eviction, no reclamation.
- Anyone in the cell may append, including to a structure they did not
  build.
- Each entry carries its author's name and tick, visible in-world — the
  deliberate opacity exception; entries are speech that persists.
- An oversized append is rejected whole, never truncated, and the failure
  states the remaining space.
- Reading is automatic, once per entry per agent, on presence in the cell.

Observation shape:

```jsonc
"inscription": {
  "entries": [ { "authorName": "Mara Flint", "tick": 17, "authored": { "text": "…" } } ],
  "charactersUsed": 412,
  "charactersRemaining": 88
}
```

### 9.8 Destruction

| | `demolish` | `raze` |
|---|---|---|
| Duration | `demolishTicks` consecutive ticks, same agent, same cell | One tick |
| Vitality | None | `razeCost`; fails when actor vitality ≤ `razeCost` |
| Byproduct yield | Full | Reduced |
| Inscription | Survives as a fragment | Destroyed |
| Interruptible | Yes | No |

Either may target any structure, including another agent's. Demolish
progress resets silently if the same agent does not continue on consecutive
ticks; progress is perceivable from within the cell, with no actor named. A
fragment rides the cell's byproduct pile, reads once per agent like an
inscription, and is destroyed when the pile is carried off. `raze` is the
only total erasure.

Every agent in the cell receives a world-authored memory that the named
structure was destroyed. **No actor is ever named.** Actorship is recorded
in operator-side history only.

## 10. Generations

**Beget** costs vitality and resources, requires a free slot, and creates an
infant in the parent's cell. Birth is witnessed by everyone in the cell.

**Genotype** is composed by the daemon from the parent's appearance; a
low-probability mutation MAY produce a divergence noted in the heritage
brief without evaluative language.

**Heritage brief**, snapshotted at birth: parent name, appearance,
`discoverable`, `bornAtTick`, `divergence`, `raisedBy` if fostered. The
parent's `privateObjective` MUST NEVER appear.

**Knowledge inheritance** — a world MAY enable it; when enabled, the child
receives at birth a copy of the parent's `knownCells` map and failed-attempt
record, as its own. The copies diverge from birth. **The child is not told
anything is inherited**, and no prompt or observation may frame the
knowledge's origin.

**Infancy:** unattachable, immobile, no observations, no client traffic;
drains its sponsor each tick until `maturityTicks`. At maturity the body
becomes an attachable adult listed at `/scenario`.

**Orphans:** on a sponsor's death, dependents lose vitality each tick and do
not regenerate. **Fostering is never automatic**: `foster` transfers
sponsorship, requires co-location, and appends the fosterer's
`discoverable` as `raisedBy`. If nobody fosters, the child dies.

Clients **attach** to bodies; agents **foster** children. These never share
a verb.

## 11. Tick lifecycle

`IDLE → OPEN → COLLECTING → CLOSED → RESOLVED`.

At OPEN the daemon writes perceptions, computes situations, and emits one
observation per adult, persona-holding agent. The deadline is absolute; late
actions are rejected, never queued. The tick MAY close early once every
actively-connected agent in the roster has acted. Tick 1 waits for
`minAgents` registrations; an emptied world pauses rather than ticking
nobody.

Resolution order, normative:

1. Speech
2. Attack
3. Take
4. Raze
5. Demolish progress and completion
6. Give, drop, consume
7. Gather (contested deposits split evenly, remainder to lowest `agentId`)
8. Build
9. Inscribe
10. Beget, foster
11. Movement (simultaneous; swaps succeed; occupancy never blocks)
12. Upkeep (decay, sponsor drain, orphan damage, starvation, regeneration),
    deposit regeneration
13. Deaths
14. Maturation, intent, reflections, failed-attempt records, map snapshots

Destruction resolves before building, so a razed cell is buildable the same
tick. Upkeep follows all actions, so an agent can eat on the tick it would
otherwise starve.

A `consume` reports what it restored, including nothing: the outcome, never
the general property.

## 12. Session lifecycle

### 12.1 Scenario

`GET /scenario` (unauthenticated): `protocol`, `premise`, `gridSize` (square
worlds; `null` otherwise), `width`, `height`, `slots`, `resourceNames`,
`structureForms`, `actions` (the enabled set, names only), `carryLimit`,
`sustenanceMax`, `vitalityMax`, `maturityTicks`, `inscriptionMax`,
`attentionBudget`, `attachable` bodies with heritage briefs,
`personaSchema`, `viability`, `constructionSlack`, and `rules`.

It MUST NOT report the recipe table, resource properties or roles, any
world map, or the world definition.

### 12.2 Register

`POST /register` with `{protocol, persona, clientName?, modelHint?,
surface?}`. Order of checks: version → slots → persona validation → name
uniqueness. On success the daemon mints `agentId`, assigns a spawn cell,
freezes the persona, consumes the slot, and issues a token.

```jsonc
"appearance": {
  "bodyColor": "#RRGGBB",   // saturation <= personaSchema ceiling
  "eyeColor":  "#RRGGBB",   // the only value permitted above the ceiling
  "scale": "small" | "medium" | "large",
  "shell": "smooth" | "panelled" | "ridged",
  "eyes":  "pair" | "single" | "wide"
}
```

Persona limits: `name` 1–24 chars `[A-Za-z0-9 '-]`, unique
case-insensitively; `identity` ≤ 600; `discoverable` ≤ 800;
`privateObjective` ≤ 400. Reject, never truncate; reject control characters
other than newline.

### 12.3 Billing surface

`surface` identifies the billing origin: a vendor prefix plus a 4-hex
account fingerprint — a hash of a stable non-secret identifier, never a
credential. Example: `claude-cli:sub:a3f9`. The daemon MUST NOT use it to
alter world behavior; it is roster and operator-channel material only and
never appears in any observation.

### 12.4 Attach and takeover

`POST /attach` with `{protocol, agentId, persona?, clientName?, modelHint?,
surface?, takeover?}`.

- Claim-only by default: a body with a live client returns `NOT_ATTACHABLE`.
- `takeover: true` is honored on any body, founder or heir. The prior token
  is invalidated; persona, memory, position, and map are preserved; the
  superseded client's stream ends.
- First attach to a matured body MUST author a persona from the heritage
  brief; any submitted `appearance` is ignored — genotype is fixed for life.
- Infants are never attachable.

### 12.5 Identity persistence

A client MUST persist `agentId` and token, and on restart attempt `attach`
with `takeover: true` before registering fresh. This is the sole exception
to invariant 3. `BAD_TOKEN` MUST NOT trigger automatic reattachment.

### 12.6 Leave, release, reap

`POST /agent/leave` keeps the body unmanned and holds the slot; the reap
countdown starts. `POST /agent/release` destroys the body and frees the
slot. Bodies unmanned beyond `reapAfterTicks` are auto-released. Structures,
inscriptions, and speech already in others' streams persist in every case.
`unmanned` MUST NOT transition to `stalled`.

## 13. Observation

Emitted at OPEN over `GET /agent/stream` (SSE), and re-sent on reconnect
mid-COLLECTING.

```jsonc
{
  "protocol": "0.4",
  "tick": 41, "simTime": "19:15", "deadline": "…ISO…",
  "self": {
    "agentId": "a_1c2d",
    "authored": { "name", "appearance", "disposition", "identity", "discoverable", "privateObjective" },
    "inventory": { "<resource>": 2, … },       // raw values, self only
    "sustenance": 41, "vitality": 88,
    "vitalityTrend": "recovering" | "holding" | "falling",
    "lifeStage": "adult",
    "sponsoring": [ { "agentId", "bornAtTick" } ],
    "heritage": { … } | null,
    "currentIntent": "…" | null,
    "lastActionOutcome": { "type", "result", "why", "attempts"? } | null,
    "failedAttempts": [ { "type", "detail", "why", "count" } ]   // only when non-trivial
  },
  "cell": {
    "coord": "2,1",
    "deposit": { "resource", "quantity" } | null,
    "loose": { "<resource>": n, … } | null,
    "structure": { "form", "authored": { "name", "description" }, "inscription", "demolishProgress" } | null,
    "fragment": { "entries": [ … ] } | null,
    "corpses": [ { "authored": { "name" }, "appearance", "diedAtTick" } ],
    "exits": [ { "direction", "coord" } ]
  },
  "present": [ … ],            // §7
  "heard": [ { "speakerId", "authored": { "text" }, "simTime" } ],
  "recalled": [ { "text", "simTime", "type" } ],
  "knownCells": [ { "coord", "structure", "lastSeenTick" } ],
  "situationChanged": true,
  "attentionGranted": true,    // only when an attention budget is set
  "reflectionRequested": false
}
```

The failed-attempt record collapses identical failures by `(type,
form/target)` on the agent's own body, carries the most recent reason, and
renders whenever a key holds more than one failure. It is self-only.

## 14. Cost control

`situationChanged` is true when: the present-set changed; speech was heard;
an inscription or fragment was read for the first time; the last action
failed; a condition band changed; a death, birth, attack, or destruction
occurred in the cell; demolish progress changed here; a reflection was
requested; or the agent arrived in a cell holding something perceivable.
Plain arrival in an empty cell is not a trigger.

Clients SHOULD skip inference when `situationChanged` is false and a stated
intent is in progress, and SHOULD escalate on hungry, hurt, a failed action,
an unsponsored infant present, or intent completion.

A daemon MAY publish `attentionBudget` and mark observations
`attentionGranted` — a ceiling of last resort, not a scheduler.

## 15. Errors

`WORLD_FULL`, `INVALID_PERSONA`, `NAME_TAKEN`, `NO_SUCH_AGENT`,
`NOT_ATTACHABLE`, `SLOT_RECLAIMED`, `WRONG_TICK`, `TICK_CLOSED`,
`ALREADY_ACTED`, `INVALID_ACTION`, `BAD_TOKEN`, `VERSION_UNSUPPORTED`.

A valid token whose body no longer exists answers `SLOT_RECLAIMED`, not
`BAD_TOKEN`.

## 16. HTTP binding

| Method | Path | Auth |
|---|---|---|
| GET | `/scenario` | none |
| POST | `/register` | none |
| POST | `/attach` | none |
| GET | `/agent/stream` | agent token (SSE: `observation`, `tick_closed`, keep-alive comments) |
| POST | `/agent/act` | agent token |
| POST | `/agent/leave` | agent token |
| POST | `/agent/release` | agent token |

The operator realm (`/observatory/*`, `/control`) is out of contract, but
two requirements cross the boundary: it MUST be unreachable with an agent
token (and vice versa), and its records — which carry every private memory,
objective, and reason without fog — MUST NOT be reachable from any agent
route or used as a source by the observation builder.

## 17. What the protocol refuses to provide

Money. Law. Ownership. Enforcement roles. Reputation scores. Alliance or
group primitives. Automatic retaliation. Assigned guardians. Trade with
consent. Consent or resistance mechanics for `give` or `take`. Mechanical
recording of events. Self-recording structures.

Every one is reachable using what exists: durable text, resource transfer,
destruction, violence, speech, refusal, and standing somewhere to watch.
Nothing in the world perceives except agents.
