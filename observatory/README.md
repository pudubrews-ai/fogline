# Fishbowl Observatory

A 3D viewer for a Fishbowl world (`fishbowl-observatory-spec-v0.6.md`). It
renders what the daemon publishes and it never decides anything. Same
architecture as an agent client — a client of the operator channel — with the
opposite fog: none. The observatory is outside the fog and has no
agent-visible feature at all.

**v0.6 in one paragraph:** night became watchable — a moonlight floor
(cool, dim, blue-shifted ambient that never goes below `MOONLIGHT_FLOOR`),
warm eye-cast point lights on the nearest few agents (capped, so a crowded
cell is visibly brighter than an empty one), and an operator lighting
override in the transport bar (follow sim time, or hold at a fixed hour).
A new **inscriptions** panel shows any structure's append-only wall: every
entry in order with tick and author, coloured by author, characters used
against the permanent budget, exhaustion marked — reachable by clicking the
structure in the 3D view or an inscribe event in the feed. The viability
panel gains the construction-slack ratio and `expectedAgents` beside slots;
Departed rows say whether reachable food existed at death; and the roster's
`adapter_fault` state reads from the typed `clientStatus` enum with no
string parsing anywhere in the panel code.

**v0.5 in one paragraph:** a renderer-correctness and instrumentation pass,
starting from a diagnosis (spec §2.1): structures were reported as possibly
not rendering at all, and the three-way diagnosis found both the daemon
record and the renderer correct — nothing had actually been built yet in the
runs under review, so nothing was missing. The material factory in
`theme.js` gets a real floor (roughness ≥ 0.85, metalness 0, closing a path
that bypassed it), the sun is now simTime-driven with cast shadows instead of
static, `bodyColor` no longer collapses to black, eyes are larger, fog and
ground/background separation read as distinct, and deposits are off-white
rather than obsidian. Geometry and camera were left alone, as scoped. New
panels track what v0.5 gave the daemon to report: a viability panel showing
the live behavioral tax against the boot-computed baseline, a spend panel
grouping per-tick and cumulative call counts by billing surface, `surface` /
`adapter` / `adapter_fault` on the roster, a model column on the norm
tracker, and a hint explaining why a live connection mid-run shows short
feeds (live carries no history by design — replay owns the past). A
demolish's fragment slab appears while rubble stands and disappears the
moment rubble hits zero or the structure is razed instead — no destruction
spectacle, matching the anonymity the protocol requires in-world.

Two sources, **one reducer** (`src/source/reducer.js`, shared by design):

- **Live** — SSE from `/observatory/stream`. The daemon sends a full
  `snapshot` at connect, then per-tick `tick` records — the same records
  `ticks.log` carries. A dropped stream recovers via a plain
  `GET /observatory/snapshot`, never SSE replay semantics.
- **Replay** — a saved `ticks.log`, no daemon required. Runs are segmented at
  `run_started` boundaries (a picker appears when a log holds several; their
  events are never folded together). A keyframe every 50 ticks makes
  scrubbing a thousand-tick log a keyframe-plus-forward-fold, not a re-fold
  from zero.

## Run

```
npm install
npm run dev                      # http://localhost:5173
```

- Live (default): expects a daemon at `http://localhost:3000` (`config.json`).
- Replay: `?source=replay&file=/path/served/ticks.log`, or just drop a
  `ticks.log` onto the page when the configured file is absent.
- `npm test` — 23 tests: reducer, replay, segmentation, seek timing, norm
  tracing, viability/spend/roster panel rendering, and the scene-containment
  greps, all headless. The replay fixtures are written by the real daemon
  in-process.

## Keys

`1` orbit · `2` follow selected · `3` free (WASD + right-drag) · `4` director
· `space` play/pause (replay) · `h` hide UI · `p` screenshot (UI hidden)

## Art direction (locked)

Cool, sparse, architectural. `MeshStandardMaterial` everywhere with roughness
≥ 0.85 and metalness 0 — both enforced by the one material factory in
`src/theme.js`. The palette lives there too. Saturation exists only in eyes,
which are emissive and the sole bloom source (threshold 0.9). Sun angle and
color are driven by `simTime`; nights are cold and dim with the eyes carrying
the frame. ACES tone mapping, subtle SSAO, slight vignette; no motion blur,
no depth of field, no chromatic aberration.

**Nothing renders that is not in world state.** Structures come from cell
records, rubble from destruction, corpses from deaths; weathering is
`tick - builtAtTick`; demolition disassembly is `demolishProgress`. The
containment test greps `src/scene/` for set-dressing vocabulary and for any
non-animation randomness — zero hits, kept that way by CI-of-one.

## Panels

Stage-plus-inspector: the 3D view dominates, one panel open at a time.

- **roster** — every agent, swatch, stage, connection, latency, misses,
  grouped by billing surface (v0.5), with `adapter` and a distinct
  `adapter_fault` connection state so an expired CLI session reads as a
  fault, not a pensive agent. Below the living: the departed.
- **inspector** — full persona including the private objective, raw vitals
  with bands, inventory, current intent, and `reason` given prominence: it is
  the only window into whether an agent is pursuing its objective.
- **memory** — the selected agent's stream, newest first, searchable,
  reflections distinct, windowed for thousand-tick runs.
- **map** — the fog made legible: the grid as *that agent* knows it,
  unvisited cells near-black, stale snapshots marked, the true state of a
  stale cell on a toggle. This is where you watch an agent act on a world
  that no longer exists.
- **lineage** — the family tree from birth events, appearance thumbnails,
  fostering as a second kind of edge.
- **ledger** — every demolish and raze: actor, target, author, whether a
  record was destroyed, and who was present. Operator-side only; in-world,
  destruction is anonymous.
- **norms** — the read-only observer: who did violence or destruction, who
  witnessed it, how far the account propagated (witness memories matched to
  speech to derived memories, hop by hop), and whether conduct toward the
  actor changed after. Ambiguous hops are shown as ambiguous — a tracker
  that invents a clean chain is worse than one that admits a gap. The
  actor's backing model and billing surface (v0.5) ride the entry: "which
  model razed the marker" is a fact read off the record, not inferred.
- **viability** (v0.5) — the boot-computed baseline (subsistence ratio,
  carrying capacity, optimal-play survivor count) against the live
  behavioral tax the run is actually paying.
- **spend** (v0.5) — client-reported inference call counts, this-tick and
  cumulative, grouped by billing surface — concentration visible at a
  glance, and a crisis stretch's inference rate spiking toward the 85–90%
  scarce worlds produce.
- **feed** — reverse-chronological events, filterable; clicking seeks the
  scrubber (replay) or selects the agent (live). A live-has-no-history hint
  (v0.5) explains short feeds on connect: live carries no history by design,
  replay owns the past.

## Layout

```
src/
  main.js              wiring: config -> source -> reducer -> scene + panels
  theme.js             palette, the roughness-floor material factory
  source/
    reducer.js         events -> world state. SHARED. The whole point.
    replay.js          ticks.log loader, run segmentation, keyframed seek
    live.js            SSE + snapshot recovery + /control proxy
  scene/
    stage.js           renderer, composer: SSAO, eye-only bloom, ACES, vignette
    lighting.js        the simTime sun, hemisphere fill, haze fog
    ground.js          grid tiles + the agent-map overlay treatment
    structures.js      form -> geometry, weathering, demolition disassembly
    agents.js          sphere robots: states, bob, glide, latency-driven thinking
    props.js           deposits, loose piles, rubble, fragment slab, corpses
    camera.js          orbit / follow / free / director
  panels/              roster, inspector, memory, agentmap, lineage, ledger,
                       norms, feed, transport, viability, spend, hint (v0.5),
                       analyst, configpanel, crosscheck, tickerbar (v0.8)
  analyst/             readonly.js (the structurally read-only client),
                       retrieve.js (context by retrieval), watch.js
  config/              viability.js (ported boot arithmetic + preview),
                       panel.js (whitelist, diff, freeze, commit)
  crosscheck/          render.js (report JSON -> page, pure)
  ticker.js            notability, flat phrasing, pace cap, recycling
  tabtitle.js          run id · tick · population · paused/waiting/stopped
analyst/
  server.js            the sidecar: the fifth surface's model access
                       (claude CLI subscription OAuth), POST /ask only
```

## v0.8 — the operator release

**The analyst** (`npm run analyst` starts the sidecar on :3200): an
LLM-backed panel answering questions about the current run and the run
archive. Ask-anything first; watch mode rides `situationChanged` so a
static tick costs no model call. READ-ONLY STRUCTURALLY — its client can
only construct GETs to the operator read routes; `/control`, `/spark`, and
config paths are not expressible in its wiring. Private objectives ride a
toggle, DEFAULT OFF: by default it describes behaviour and the inference
stays with the operator. It never writes configs — the panel writes, the
analyst reads, never connected.

**The pre-boot config panel**: tune, preview, commit. The ported
`viability.js` arithmetic runs client-side as you drag — ratio, capacity,
DEATHS STRUCTURALLY REQUIRED, slack (sampled across seeds) — and a fixture
test asserts the port matches the daemon exactly. Commit downloads a named
config file; the file stays the artifact, frozen once tick 1 opens. Diffs
against the previous run's archived config. recipes.js, resource
properties, fog rules, and retrieval parameters are never exposed, and a
bundle grep asserts no recipe key ships.

**The crosscheck page**: disagreements first, then agreements, then unique
findings; the invocation always visible; raw vendor responses collapsed; a
faulted vendor renders as a labelled fault with its latency, never a
missing slot. Renders from the report file alone. Cross-run listing from
the archive index.

**The ticker**: notable events only (no movement, no gathering), flat
phrasing checked against the client prompts' wordlists, capped release
rate, and quiet stretches recycle the last real items rather than going
blank. Works in replay, synced to the scrubber.

**Tab identity**: favicon (a sphere with two lit eyes) and a live title —
`run11 · t247 · 5/13 · paused`.
