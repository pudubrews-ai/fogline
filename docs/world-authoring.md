# Authoring a world

A world is one JSON file. The daemon boots it with
`"world": "./worlds/<name>.json"` in `daemon/config.json`, validates it, and
refuses loudly if anything is malformed. The definition is **operator-only**:
it is never served to clients, never reachable from an agent route, and
never bundled into Scry — an import-graph test enforces this, and it is not
to be relaxed (see [What the engine owns](#what-the-engine-owns-and-you-cannot-change)).

## The schema

```jsonc
{
  "name": "Orrum-5",
  "grid": { "width": 8, "height": 8 },        // >= 2 each; non-square permitted
  "premise": "A shared plot of empty ground…", // served to clients verbatim

  // Every resource declares a ROLE. Names are yours to invent — the engine
  // computes from roles, never from names.
  "resources": [
    { "name": "sivet", "role": "consumable", "need": "sustenance", "restores": 25 },
    { "name": "orrum", "role": "structural" },
    { "name": "khal",  "role": "structural" },
    { "name": "rubble", "role": "byproduct", "substitutesFor": "orrum", "ratio": 3 }
  ],

  // How deposits are seeded. The consumable is seeded to the viability
  // target ratio; everything else follows density. A byproduct is never
  // seeded.
  "deposits": {
    "seedDensity": 0.12,          // fraction of cells carrying a deposit
    "quantityRange": [10, 20],    // per-spring seeded quantity (and capacity)
    "regenPerTick": 0.15,         // fractional regeneration toward capacity
    "distribution": "clustered"   // "clustered" | "scattered"
  },

  // The private recipe table. Costs name your structural resources. This
  // block is the most-protected data in the system: agents learn it only
  // through build-failure shortfalls.
  "recipes": {
    "marker":   { "orrum": 1 },
    "wall":     { "orrum": 3, "khal": 1 },
    "platform": { "orrum": 4, "khal": 1 },
    "pit":      { "orrum": 1, "khal": 2 },
    "hut":      { "orrum": 5, "khal": 2 },
    "tower":    { "orrum": 8, "khal": 3 }
  },
  "forms": ["tower", "hut", "wall", "platform", "pit", "marker"],  // public names

  // Vitals constants. Anything omitted takes the engine default.
  "vitals": {
    "sustenanceMax": 100,
    "sustenanceDecayPerTick": 3,
    "vitalityMax": 100,
    "starvationDamagePerTick": 3,
    "regenThreshold": 50,
    "regenPerTick": 1,
    "attackDamage": 25,
    "attackCost": 6,
    "sponsorDrainPerTick": 1,
    "orphanDamagePerTick": 8
  },

  // Viability targets — see the tuning section below.
  "viability": { "targetRatio": 1.35, "viabilityFloor": 1.0, "minSpringsPerResource": 2 },

  // WHICH actions exist here. The engine owns HOW each resolves. An action
  // you leave out is rejected by the daemon and never rendered in a client
  // prompt. "wait" always exists.
  "actions": [
    "move", "say", "build", "wait", "attack",
    "gather", "drop", "give", "consume", "inscribe", "beget", "foster",
    "demolish", "raze"
  ],

  // Optional capabilities, both off unless declared:
  //   "take" in the actions list — one-unit, unresistable transfer from a
  //     co-located agent, witnessed exactly like an attack.
  "knowledgeInheritance": false   // children copy the parent's map and
                                  // failed-attempt record at birth, silently
}
```

Rules the validator enforces: exactly one consumable (declaring
`need: "sustenance"` and `restores`); at most one byproduct, whose
`substitutesFor` names a declared resource; every form has a recipe; every
recipe names only declared resources; every enabled action is one the engine
knows how to resolve.

The worked example above **is** Orrum-5, the default world
(`daemon/worlds/orrum-5.json`) — the one twelve archived runs happened in.
`take` and knowledge inheritance are off in it; a world that turns them on
is a different experiment.

## What the engine owns, and you cannot change

The definition ends where perception begins. The engine owns perception and
all four fogs, the tick barrier, resolution order, mortality, the protocol,
inheritance and sponsorship mechanics, destruction semantics, and memory.
The reasons below are the minimum that makes each constraint land; they are
load-bearing, not decoration.

- **Perception is cell-local, and holdings are bands-only.** An agent cannot
  see another agent's inventory, only condition bands. This is what makes
  concealment, theft, and generosity mean anything; a world where holdings
  are visible has nothing to negotiate.
- **Combinatorial properties are discovered, never stated.** Recipes are
  never served. Discovery through failure is the only channel, and it is
  what stops agents pattern-matching to familiar materials and skipping the
  finding-out. This is why the definition file must stay unreachable: it
  *feels* like configuration, and configuration feels servable. It is not —
  every discovery finding depends on the table being unreachable.
- **The engine provides no institutions.** No money, no law, no ownership,
  no enforcement roles, no reputation stat, no consent-based trade. Every
  one is reachable by agents using durable text, resource transfer,
  destruction, speech, and refusal — and providing any of them converts a
  possible discovery into a followed instruction.
- **Worlds declare which actions exist. The engine declares how each
  resolves and what it reveals.** A world that could re-specify what `give`
  reveals, or make it refusable, would turn the fog guarantees from
  invariants into suggestions.

## Tuning: a world that boots is not a world that works

The daemon prints the viability arithmetic at boot. Read it.

**The subsistence ratio decides the date; carrying capacity decides the
outcome.** `capacity` is the population the regeneration flow alone
sustains forever. When capacity sits below `expectedAgents`, deaths are
structurally required — the daemon boots anyway and says so in a headline,
because a lethal world is a legitimate experiment, but it must be one you
chose. A big seeded larder only moves extinction later.

| Ratio | Meaning |
|---|---|
| < 1.0 | Someone must die regardless of behavior |
| ≈ 1.0 | Subsistence; perfect play saves everyone, nothing else does |
| 1.2 – 1.5 | Contested but survivable — the recommended band |
| > 2.0 | Abundance; no agent ever needs another |

**Food scarcity silently starves construction.** Every recipe needs
materials, materials need a trip away from the consumable springs, and a
world can pass its subsistence floor while nobody can ever afford that trip.
The boot log's **construction slack** figure is the check: below 1, building
is not affordable for the expected population. The trip that binds is to
the *furthest* required material, so watch clustered seeds that drop one
structural resource in a far corner.

**Contested beats abundant.** Uneven, clustered deposits create places
worth being, which creates places worth contesting. If you want interaction,
contest something — do not look for a knob that makes agents notice each
other, because there isn't one and there is not going to be one.

**Byproduct ratios are a price.** `rubble` at ratio 3 means destruction
yields a poor substitute for the primary material — enough to matter,
never enough to make demolition a mining strategy.

**Grid shape is a variable.** A 4×16 canyon forces every trip through the
middle; an 8×8 field lets clusters spread. Adjacency stays 4-way either
way.

## Booting it

```bash
cd daemon
# point config.json at your file:
#   "world": "./worlds/my-world.json"
npm start
```

The daemon refuses to boot below `viabilityFloor` with the arithmetic in
the error. Scry renders any world the daemon serves — grid, hover, panels
— with no changes.
