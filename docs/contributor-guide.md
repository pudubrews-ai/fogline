# Contributor guide

## Repo layout

```
daemon/     the engine: world state, tick barrier, resolution, the four
            fogs, viability, run archive, crosscheck supervision. Express
            only. Holds no model credential, ever.
  worlds/   world definitions (operator-only data; see containment below)
  world/    world modules — definition loader, resources, recipes
            machinery, vitals, viability, observe (the fog boundary)
  engine/   tick lifecycle and action resolution
  api/      the HTTP surface: agent realm and operator realm
  run/      archive, recorder, extract, crosscheck supervisor
client/     decisions for one agent: prompts, parsing, budgets, adapters.
            The only place a model credential exists.
  adapters/ one subprocess base + per-vendor config entries
scry/       the read-only three.js viewer. Live SSE or ticks.log replay,
            one reducer for both.
docs/       what you are reading
```

Each package is independent: its own `package.json`, installed and tested
separately.

## Running the tests — no model calls needed

```bash
cd daemon && npm test    # node --test, no network beyond localhost
cd client && npm test    # adapter tests use `node -e` and `sh` as fake CLIs
cd scry   && npm test
```

Two client test files exercise real vendor CLIs and spend a handful of
model calls: `test/gate.live.test.js` (Claude, via the logged-in CLI) and
the GLM gate inside `test/v07.test.js` (needs `FOGLINE_GLM_TOKEN` or the
fallback file). Without those credentials, run everything else:

```bash
cd client && node --test test/units.test.js test/v04.units.test.js \
  test/v05.test.js test/v06.test.js test/v071.test.js test/v09.test.js \
  test/integration.test.js test/session.race.test.js test/startup.timing.test.js
```

Everything in that list — including full end-to-end runs — drives fake CLIs
(`node -e`, `sh`) or the stub adapter and costs nothing.

## Adding a vendor adapter

A new CLI backend is a **config entry over the subprocess base**
(`client/adapters/subprocess.js`), not a new function:

1. Confirm the CLI's behavior empirically first — flags, exit codes, where
   the response lands, what stderr carries, single-shot latency against a
   45s tick. Write down what you measured in the adapter file's header
   comment. Config written before confirmation is how a run dies at tick
   140.
2. Create `client/adapters/<vendor>-cli.js` exporting `defaults` (cmd,
   argv template, `input`, `budgetFactor`, `surface`, `pinnedVersion`) and
   the standard `create`/`complete` pair. Tokens available in argv
   templates: `{system}`, `{model}`, `{prompt}`.
3. `account` names a stable **non-secret** identifier file for the 4-hex
   billing fingerprint — never a credential, never reversible to one.
4. Credentials ride the environment: literal strings, or
   `{ env: "VAR", file: ".credentials/<name>" }` — the env var wins, the
   gitignored fallback file lives inside the client package.
5. If the CLI keeps mutable shared state in its home directory, declare
   `isolatedHome` so each client owns its caches (see `codex-cli.js`).
6. Register it in the `ADAPTERS` map in `client/index.js`.

Every adapter runs in a fresh empty temp directory with its process group
killed on completion — agentic CLIs must find nothing and leave nothing.

## What the import-graph tests protect

`daemon/test/containment.test.js` proves, structurally:

- `world/recipes.js` and `world/definition.js` are unreachable from
  anything under `api/`, and no `api/` source mentions `worlds/`.
- No `/scenario` or observation payload carries any form's full cost, the
  word "recipe", or any resource property or role.
- No reputation-shaped stat exists anywhere in the source.

Scry's build test greps the production bundle for every recipe key: zero
hits.

**These tests must not be relaxed.** The whole experimental value of the
system rests on agents discovering combinatorial properties through
failure; one convenient import from the api layer, or one "helpful" field
in a served payload, and every discovery finding after that moment is
unattributable. If a change trips a containment test, the change is wrong —
find another route.

The same discipline applies to the fog boundary
(`daemon/world/observe.js`): adding a field to an observation is a security
decision, and the string-scan tests (surface isolation, trend containment,
failed-attempt containment) are the enforcement.
