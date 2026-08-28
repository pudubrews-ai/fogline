# Operator guide

Running real worlds with real models. Most of what follows is not derivable
from the code; it is what twelve archived runs taught.

## Configuring adapters

Each client process drives one agent through one adapter. Vendor CLIs vary
enormously in startup cost and latency, so two knobs are per-adapter, set in
`client/config.json` under `adapters`:

- **`budgetFactor`** — the share of the tick deadline the adapter may spend
  before the client gives up and submits a `wait` classified `slow`. A CLI
  with its own agentic loop needs a longer leash (0.85–0.9); a plain SDK
  call can run tighter (0.75). A too-small factor reads in-world as a
  permanently pensive agent.
- **Tier models** — `cheapModel`/`richModel` are per-adapter for subprocess
  vendors: handing one vendor's model id to another's CLI is a hard exit 1
  on every call.

CLI-backed clients check a pinned CLI version at startup (drift warns
loudly, never refuses) and run a smoke test (a client that cannot produce a
response does not take a slot). The codex adapter runs against its own
isolated `CODEX_HOME` under `client/.credentials/` so no other codex
installation on the machine can poison its caches mid-run.

Run clients with distinct `--label` values; the label names the identity
file and the log files.

## Reading the viability figures

The daemon prints them at boot and archives them per run.

- **`ratio`** (supply/demand) decides the *date* — how long the seeded
  stock plus regeneration covers perfect-play subsistence.
- **`capacity`** decides the *outcome* — the population the regeneration
  flow alone sustains forever. `capacityMargin` and `deathsRequired` are
  the headline: capacity below expected population means deaths are
  structurally required no matter how well anyone plays. The daemon boots
  such worlds, announced. Make sure you meant it.
- **`optimalSurvivors`** is the closed-form baseline: efficient solitary
  foragers with perfect knowledge, bounded by `expectedAgents`. The gap
  between it and actual survivors is the behavioral tax — the cost of being
  a society instead of a forager set.
- **`constructionSlack`** below 1 means building is unaffordable for the
  expected population even when nobody starves.

Set `expectedAgents` to the number of clients you will actually run. Demand
computes over it, not over slots — a world with thirteen slots and five
clients is not feeding thirteen bodies.

## Reading a death

Every death record carries `foodAtDeath`: `inventory` (died holding food),
`nearby` (food within reach), or `none` (famine). The distinctions matter:

- **`none`** — famine. Check the boot arithmetic; this death may have been
  structurally required.
- **`nearby`** — inattention or a decision. Read the agent's last intents
  and reasons in the archive; this is where the behavioral findings live.
- **`inventory`** — almost always infrastructure. An agent that starves
  holding food was probably not reaching its model. Check the client log
  for `adapter_fault` streaks before drawing any behavioral conclusion —
  five of run 13's seven deaths were exactly this.

## Diagnosing a stalled client

`adapter_fault` is not slowness. The roster distinguishes three states:

- **slow** — the model ran past the budget; the client submitted a `wait`.
  Raise `budgetFactor` or use a faster tier.
- **adapter_fault** — the CLI exited non-zero, printed auth text, or
  produced nothing. The client log records the stripped diagnostic (~500
  chars) once per episode with a repeat count; the console raises an
  `[ADAPTER ALARM]` after consecutive faults. Read the recorded reason —
  quota, auth expiry, and a poisoned CLI cache all look identical from
  in-world, and all read as "a pensive agent" if you only watch the world.
- **stalled** — a connected client missed several consecutive deadlines.
  `unmanned` (no client attached) never transitions to stalled.

## Cost

Cheap ticks (`situationChanged` gating) save you in quiet travel and
evaporate in crisis: measured rates run ~0.05 calls per tick for a solitary
traveller and 85–90% during crisis stretches, because starvation and band
crossings are non-negotiable escalation triggers. Scarce worlds park agents
near band edges chronically. **A crisis-heavy run costs near baseline** —
that is the honest number to budget with. Every client reports `calls` per
tick, aggregated per billing surface on the operator stream and Scry's
spend panel, so concentration on one account shows on the roster rather
than on the invoice.

## The archive, and reading a run afterward

Each run writes `daemon/archive/<runId>/record.json` — config verbatim,
boot viability, the run header, outcome (survivors, deaths with
`foodAtDeath`, structures by form, inscriptions), and crosscheck status —
plus a derived `index.json` that rebuilds byte-identically from the
records. A run killed mid-flight stays indexed as incomplete.

`ticks.log` is the replay: one consolidated record per tick — every action,
outcome, event, memory write, and non-empty cell. Drop it onto Scry and
scrub. **It carries every private objective and memory; it is
operator-only material and never leaves the machine.**

Set `archive.clientLogs` (globs allowed, e.g. `"../client/client-*.log"`)
so the post-run crosscheck gets the client-vs-world axis; with it unset,
that comparison silently cannot be performed.

## When to trust a crosscheck

The post-run crosscheck hands a scoped extract (world events minus
reflections, client-log windows around deaths and first-of-kind events, a
death appendix) to several vendors and files their reports. Read it as a
panel, not an oracle:

- **Disagreement is the signal.** Vendors that disagree are pointing at the
  part of the record worth your attention. Uniform agreement mostly means
  the extract was legible.
- A vendor timeout is a labelled fault in the report, not a hung run. The
  extract refuses above a byte ceiling rather than truncating — latency
  tracks input size; rescope rather than raising the timeout.
- The crosscheck authenticates with its own CLI OAuth, like any client. The
  daemon still holds no credential.
