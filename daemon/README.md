# @fogline/daemon

The world half of the Fogline protocol: grid, bodies, vitals, resources,
structures, destruction, lineage, memory, the four fogs, viability
arithmetic, the tick engine, the operator channel, the run archive, and
crosscheck supervision. Express only. **No model credentials, ever.**

```bash
npm install
npm start            # config.json → http://localhost:3100, paused
npm test             # node --test, no network beyond localhost
node server.js config.lean.json   # boot an alternate config file
```

## Configuration

`config.json` holds the **run parameters**: port, slots, `minAgents`,
`expectedAgents`, tick timing, deadlines, `maxTicks`, retrieval, reaping,
archive and crosscheck settings, and the world to boot:

```jsonc
"world": "./worlds/orrum-5.json"
```

The **world definition** owns grid shape (width/height), resources and
their roles, deposit distribution, recipes, structure forms, vitals,
viability targets, the premise, and which actions exist — see
[docs/world-authoring.md](../docs/world-authoring.md). The daemon refuses
to boot a world below its viability floor, with the arithmetic in the
error. A legacy v0.8-style config carrying `gridSize`/`resources`/`vitals`
directly still boots on the legacy path.

## Layout

```
server.js            wiring, routes, boot, viability refusal
worlds/              world definitions (operator-only data)
world/
  definition.js      definition loader/validator (unreachable from api/)
  world.js           cells, bodies, personas, adjacency
  resources.js       seeding, regeneration, loose piles, inventories
  recipes.js         shortfall/substitution machinery over world.recipes
  vitals.js          decay, damage, regeneration, condition bands
  viability.js       subsistence ratio, capacity, baseline, slack
  observe.js         THE FOG BOUNDARY — the only observation builder
  memory.js          streams, retrieval, perception writes
  lineage.js         beget, heritage, fostering, maturation, inheritance
  destruction.js     demolish, raze, byproduct yield, fragments
  inscription.js     append-only entries with a permanent budget
  situation.js       situationChanged, attention budget
api/
  agent.js           /scenario /register /attach /agent/* (the contract)
  operator.js        /observatory/* /control (omniscient, operator realm)
  auth.js            two token realms, never crossing
engine/
  tick.js            the lifecycle state machine and validation
  resolve.js         resolution in protocol order
run/
  archive.js         per-run record.json + derived index
  recorder.js        folds the operator stream into records
  extract.js         the scoped crosscheck extract (refuses, never trims)
  crosscheck.js      supervised post-run crosscheck (own OAuth, own group)
```

## Invariants worth knowing before touching anything

- `world/observe.js` is the access-control boundary; adding a field to an
  observation is a security decision.
- `world/recipes.js`, `world/definition.js`, and `worlds/` are unreachable
  from `api/` — enforced by `test/containment.test.js`, which must not be
  relaxed.
- The operator record (`ticks.log`, the operator stream) carries the whole
  world without fog and is reachable from no agent route.
- Worlds declare WHICH actions exist; the engine owns HOW each resolves.
  Test 1 in `test/v09.test.js` asserts the default world reproduces its
  pre-refactor state byte-for-byte from the same seed.

The full contract lives in [docs/protocol.md](../docs/protocol.md).
