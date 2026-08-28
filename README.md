# Fogline

An engine for small persistent worlds where LLM agents live under fog: they
know only the cells they have stood in, see condition bands instead of
numbers, and learn the world's physics by failing at it. The daemon owns
the world and holds no model credentials; each client supplies decisions
for exactly one agent; Scry watches from outside the fog.

**Why the fog matters:** what the engine refuses to provide — money, law,
ownership, reputation, trade with consent — is exactly what the runs exist
to watch agents invent. Perception is cell-local and holdings are
unknowable except by being told, so concealment, generosity, and theft mean
something. Recipes are never served, so discovery is real. Witness memory
propagates by speech, decays by retrieval, and dies with the witness, so
accusation without evidence is possible — and providing any institution
ready-made would convert a possible discovery into a followed instruction.

Worlds are one JSON file: grid shape, resources with roles, recipes,
vitals, viability targets, and which actions exist. The engine owns how
every action resolves and what it reveals. The default world is
**Orrum-5**.

## Quick start — no credentials, no subscription

```bash
cd daemon && npm install && npm start     # the world, paused, port 3100
cd client && npm install
node index.js --label a --stub --server http://localhost:3100
node index.js --label b --stub --server http://localhost:3100
cd scry && npm install && npm run dev     # the viewer — press play
```

Stub mode drives agents with scripted decisions through the full client
path — zero model calls. Wiring a real model is one flag; see the guide.

## Packages

| Package | What | Tests |
|---|---|---|
| [`daemon/`](daemon/) | The engine: grid, bodies, vitals, resources, structures, destruction, lineage, memory, the four fogs, viability, tick engine, run archive. Express only, no credentials ever. | 192 |
| [`client/`](client/) | Decisions for one agent: prompt building, parsing, cheap-tick continuation, budgets, subprocess CLI adapters, stub mode. The only place a model credential exists. | 128 |
| [`scry/`](scry/) | Read-only three.js observatory. Live SSE or `ticks.log` replay through one reducer; fog-overlay agent maps, cell hover, viability/spend/norm/lineage panels, ticker. | 45 |

## Documentation

- [Getting started](docs/getting-started.md) — running in five minutes,
  stub-first
- [Protocol reference](docs/protocol.md) — the daemon–client contract, for
  client authors
- [Authoring a world](docs/world-authoring.md) — the definition schema,
  what the engine owns, tuning
- [Operator guide](docs/operator-guide.md) — running real worlds and
  reading what happened
- [Contributor guide](docs/contributor-guide.md) — layout, adapters, and
  the containment tests

## License

[Apache-2.0](LICENSE).
