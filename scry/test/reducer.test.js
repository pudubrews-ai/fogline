// Reducer + replay acceptance (observatory spec §11: 2, 3, 4, 14) against a
// REAL ticks.log written by the real daemon — no hand-authored fixtures for
// the happy path, so any daemon record drift breaks here first.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../../daemon/server.js";
import { persona } from "../../daemon/test/helpers.js";
import { parseLog, ReplayRun, KEYFRAME_EVERY } from "../src/source/replay.js";
import { applyRunStarted, applyTick, applySnapshot, cloneState, serializeState } from "../src/source/reducer.js";

let logDir;
let logText;
let snapshotAtEnd;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(daemon, actions = new Map()) {
  const engine = daemon.engine;
  const from = engine.tick;
  engine.step();
  await wait(25);
  for (const [agentId, payload] of actions) {
    const result = engine.submitAction(agentId, { protocol: "0.4", tick: engine.tick, intent: null, reason: null, ...payload });
    assert.equal(result.ok, true, `${payload.type} accepted: ${result.code ?? ""} ${result.detail ?? ""}`);
  }
  while (engine.tick === from || engine.phase !== "RESOLVED") await wait(15);
}

async function registerTwo(base) {
  const ids = [];
  for (const name of [`Aster${Math.floor(Math.random() * 999)}`, `Brill${Math.floor(Math.random() * 999)}`]) {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "0.4", persona: persona(name), clientName: "obs-test" }),
    });
    assert.equal(res.status, 200);
    ids.push((await res.json()).agentId);
  }
  return ids;
}

before(async () => {
  logDir = mkdtempSync(join(tmpdir(), "fogline-obs-"));
  const daemon = createDaemon(
    {
      gridSize: 4,
      slots: 5,
      minAgents: 2,
      actionDeadlineMs: 2000,
      maxTicks: 30,
      startPaused: true,
      reapAfterTicks: 100,
      resources: { seedDensity: 0.2, quantityRange: [6, 9], regenPerTick: 0, distribution: "clustered" },
    },
    { logDir }
  );
  const server = daemon.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const [a, b] = await registerTwo(base);
  const bodyA = daemon.engine.world.agents.get(a);
  bodyA.inventory.orrum += 2; // enough for a marker, directly granted

  // Run 1, eight ticks: speech, a build, an inscription, three consecutive
  // demolish ticks that bring it down, then a quiet tick.
  await step(daemon, new Map([[a, { type: "say", text: "the ground is ours" }], [b, { type: "wait" }]]));
  await step(daemon, new Map([[a, { type: "build", structure: { form: "marker", name: "First Stone", description: "a start" } }], [b, { type: "wait" }]]));
  await step(daemon, new Map([[a, { type: "inscribe", text: "Aster raised this" }], [b, { type: "wait" }]]));
  await step(daemon, new Map([[a, { type: "demolish" }], [b, { type: "wait" }]]));
  await step(daemon, new Map([[a, { type: "demolish" }], [b, { type: "wait" }]]));
  await step(daemon, new Map([[a, { type: "demolish" }], [b, { type: "wait" }]]));
  await step(daemon, new Map([[a, { type: "wait" }], [b, { type: "gather" }]]));
  await step(daemon, new Map([[a, { type: "wait" }], [b, { type: "wait" }]]));

  snapshotAtEnd = await fetch(`${base}/observatory/snapshot`).then((r) => r.json());

  // Reset: a fresh run boundary. Register again (reset empties the world),
  // two quiet ticks.
  daemon.engine.reset();
  const [c, d] = await registerTwo(base);
  await step(daemon, new Map([[c, { type: "wait" }], [d, { type: "wait" }]]));
  await step(daemon, new Map([[c, { type: "say", text: "second run" }], [d, { type: "wait" }]]));

  await daemon.close();
  logText = readFileSync(join(logDir, "ticks.log"), "utf8");
});

after(() => rmSync(logDir, { recursive: true, force: true }));

// ---------- acceptance 14: run segmentation ----------

test("a ticks.log with two runs segments at run_started and never folds them together", () => {
  const { runs, badLines } = parseLog(logText);
  assert.equal(badLines, 0);
  assert.equal(runs.length, 2, "two runs found");
  assert.notEqual(runs[0].runId, runs[1].runId, "distinct run ids");
  assert.equal(runs[0].records.length, 8);
  assert.equal(runs[1].records.length, 2);

  const run2 = new ReplayRun(runs[1]);
  const flat = serializeState(run2.finalState);
  assert.ok(!flat.includes("First Stone"), "nothing from run 1 leaked into run 2's state");
  assert.ok(flat.includes("second run"), "run 2's own speech is there");
});

// ---------- acceptance 2: replay opens the log with no daemon running ----------

test("replay folds the real run: structures rise, inscriptions land, demolition leaves rubble and a fragment", () => {
  const { runs } = parseLog(logText);
  const run = new ReplayRun(runs[0]);
  assert.equal(run.lastTick, 8);
  assert.equal(run.finalState.agents.size, 2);

  // Tick 2: the marker stands. Tick 3: inscribed. Tick 6: gone, rubble and a
  // fragment in its place.
  const at2 = run.stateAtTick(2);
  const builtCell = [...at2.cells.values()].find((c) => c.structure);
  assert.ok(builtCell, "marker built by tick 2");
  assert.equal(builtCell.structure.authored.name, "First Stone");
  assert.equal(builtCell.structure.builtAtTick, 2);

  const at3 = run.stateAtTick(3);
  const entries3 = at3.cells.get(builtCell.coord).structure.inscription.entries;
  assert.equal(entries3.length, 1);
  assert.equal(entries3[0].text, "Aster raised this");

  const at5 = run.stateAtTick(5);
  const midProgress = at5.cells.get(builtCell.coord).structure.demolishProgress;
  assert.deepEqual({ ticks: midProgress.ticks, required: midProgress.required }, { ticks: 2, required: 3 });

  const at6 = run.stateAtTick(6);
  const razedCell = at6.cells.get(builtCell.coord);
  assert.equal(razedCell.structure, null, "down after the third consecutive demolish");
  assert.equal(razedCell.loose.rubble, 6);
  assert.equal(razedCell.fragment.entries[0].text, "Aster raised this", "the inscription survives as a fragment");
  assert.ok(razedCell.fragment.entries[0].authorName, "with its attribution intact (v0.6 A9)");

  // Speech landed in the reconstructed memory streams of exactly the agents
  // the daemon wrote it to (the speaker's cell at OPEN — the two spawns are
  // usually apart, so at minimum the speaker's own stream holds it).
  const at1 = run.stateAtTick(1);
  const holders = [...at1.agents.values()].filter((a) => a.memories.some((m) => m.type === "speech" && m.text === "the ground is ours"));
  assert.ok(holders.length >= 1, "the speaker holds their own words");
  for (const h of holders) {
    const speakerCell = [...at1.agents.values()].find((a) => a.memories.some((m) => m.type === "speech" && m.speaker === a.agentId));
    if (speakerCell) assert.equal(h.coord, speakerCell.coord, "only co-located agents hold the speech");
  }

  // The feed's raw material and the scrubber's markers.
  assert.ok(run.finalState.events.some((e) => e.type === "build"));
  assert.ok(run.finalState.events.some((e) => e.type === "demolish_complete"));
  assert.ok(run.markers().some((m) => m.kind === "destruction"));
  assert.ok(run.markers().some((m) => m.kind === "inscription"));
});

// ---------- acceptance 3: live and replay agree at the same tick ----------

test("live-style incremental folding and replay seek produce byte-identical state at every tick", () => {
  const { runs } = parseLog(logText);
  const run = new ReplayRun(runs[0]);

  // The live path: run_started, then each tick record as it would arrive on
  // the operator stream, folded incrementally with no keyframes or seeks.
  let live = applyRunStarted(null, runs[0].started);
  for (const rec of runs[0].records) {
    live = applyTick(live, rec);
    const replayed = run.stateAtTick(rec.tick);
    assert.equal(serializeState(replayed), serializeState(live), `states agree at tick ${rec.tick}`);
  }
});

test("a mid-run live connect via /observatory/snapshot agrees with replay on world facts at the same tick", () => {
  const { runs } = parseLog(logText);
  const run = new ReplayRun(runs[0]);
  const live = applySnapshot(null, snapshotAtEnd);
  const replayed = run.stateAtTick(live.tick);

  assert.equal(live.tick, 8);
  for (const [coord, cell] of replayed.cells) {
    assert.deepEqual(live.cells.get(coord), cell, `cell ${coord} agrees`);
  }
  for (const [id, agent] of replayed.agents) {
    const l = live.agents.get(id);
    assert.ok(l, `${id} present in the snapshot fold`);
    for (const key of ["coord", "vitality", "sustenance", "lifeStage", "name", "currentIntent"]) {
      assert.deepEqual(l[key], agent[key], `${id}.${key} agrees`);
    }
    assert.deepEqual(l.inventory, agent.inventory);
    // knownCells: the snapshot carries the daemon's own map; replay
    // reconstructs by the same rule. Same coords, same staleness shape.
    assert.deepEqual([...l.knownCells.keys()].sort(), [...agent.knownCells.keys()].sort(), `${id} knownCells coords agree`);
  }
});

// ---------- acceptance 4: keyframed seek under 200ms on a 1000-tick log ----------

function syntheticLog(ticks) {
  const lines = [
    JSON.stringify({
      event: "run_started",
      runId: "r_synthetic",
      gridSize: 8,
      premise: "synthetic",
      startSimTime: "09:00",
      deposits: [{ coord: "3,3", resource: "orrum", quantity: 12 }],
    }),
  ];
  for (let t = 1; t <= ticks; t++) {
    const x = t % 8;
    lines.push(
      JSON.stringify({
        tick: t,
        simTime: "09:15",
        summary: { move: 1 },
        events: [{ type: "move", agentId: "a_x", from: `${(x + 7) % 8},4`, to: `${x},4` }],
        memories: [{ agentId: "a_x", id: `m${t}`, tick: t, simTime: "09:15", type: "observation", text: `step ${t}`, importance: 2 }],
        actions: [{ agentId: "a_x", type: "move", assigned: false, coerced: null, latencyMs: 40, outcome: { type: "move", result: "ok", why: null } }],
        bodies: [
          {
            agentId: "a_x",
            name: "Walker",
            coord: `${x},4`,
            lifeStage: "adult",
            vitality: 100,
            sustenance: 100 - (t % 50),
            inventory: { sivet: 0, orrum: 0, khal: 0, rubble: 0 },
            appearance: { bodyColor: "#777777", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
            connectionState: "active",
            currentIntent: "walk",
            lastReason: null,
            sponsorId: null,
            bornAtTick: null,
            unsponsoredAtTick: null,
            heritage: null,
          },
        ],
        cells: [{ coord: "3,3", deposit: { resource: "orrum", quantity: 12 }, loose: null, structure: null, corpses: [], fragment: null }],
      })
    );
  }
  return lines.join("\n");
}

test("scrubbing a 1000-tick log seeks from keyframes in under 200ms, and seek equals straight fold", () => {
  const { runs } = parseLog(syntheticLog(1000));
  const run = new ReplayRun(runs[0]);
  assert.ok(run.keyframes.size >= Math.floor(1000 / KEYFRAME_EVERY) - 1, "keyframes exist");

  // Straight fold to 777 for ground truth.
  let truth = applyRunStarted(null, runs[0].started);
  for (const rec of runs[0].records) {
    if (rec.tick > 777) break;
    truth = applyTick(truth, rec);
  }

  const t0 = performance.now();
  const sought = run.stateAtTick(777);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 200, `seek took ${elapsed.toFixed(1)}ms`);
  assert.equal(serializeState(sought), serializeState(truth), "keyframed seek equals the straight fold");

  // Scrub backward too: an earlier tick, after the later one, stays correct.
  const early = run.stateAtTick(3);
  assert.equal(early.tick, 3);
  assert.equal(early.agents.get("a_x").coord, "3,4");
});
