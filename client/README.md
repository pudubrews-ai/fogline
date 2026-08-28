# @fogline/client

Decisions for one agent: prompt building, parsing, cheap-tick
continuation, deadline budgeting, persona authoring, and the subprocess CLI
adapters. **The only place in the system where a model credential exists.**

```bash
npm install
node index.js --label a --stub --server http://localhost:3100      # no model
node index.js --label c1 --adapter claude-code --server http://localhost:3100
node index.js --label h1 --heir --adapter codex-cli ...            # claim a matured body
npm test
```

One process drives one agent. `--label` names the instance, its identity
file (`.fogline-identity-<label>.json` — the persisted agentId + token that
lets a restarted client reattach with takeover), and its logs.

## Adapters

`stub`/`scripted` (no model), `claude-code`, `claude`, `claude-cli`,
`codex-cli`, `kimi-cli`, `glm-cli`. A CLI backend is a config entry over
`adapters/subprocess.js`: argv template, stdin/arg input, per-adapter
deadline share (`budgetFactor`), tier models, a pinned version checked
loudly at startup, and a startup smoke test that refuses a slot to a client
that cannot produce a response. See
[docs/contributor-guide.md](../docs/contributor-guide.md) for adding one.

Credentials ride the environment or gitignored files under `.credentials/`
— never argv, never config committed to the repo. Vendors with mutable
shared home state (codex) run against an isolated home so nothing else on
the machine can poison a run in flight.

## Behavior

- **Cheap ticks:** when `situationChanged` is false and a stated intent is
  mechanically continuable, the client continues it without a model call,
  and escalates on hunger, hurt, failure, company, or intent completion.
- **Tiering:** situation-based model choice — alone and travelling gets the
  cheap model; company, trouble, or a reflection request gets the rich one.
- **Fault discipline:** adapter faults are classified (`slow` /
  `adapter_fault` / `bad_output`), reported to the daemon via
  `clientStatus`, and logged with the stripped diagnostic detail once per
  fault episode with a repeat count. A consecutive-fault alarm makes a
  streak loud.
- **Prompts** render only what the world declares: forms, resource names,
  and the enabled action set come from `/scenario`; an action the world
  does not declare never appears. All agent-authored text is framed as
  reported content, never instruction, and the client adds no guidance
  about cooperation, fairness, restraint, or violence in either direction.
