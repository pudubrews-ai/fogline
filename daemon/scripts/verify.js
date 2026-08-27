// Engine verification: 20 ticks, no clients connected. The v0.2 world boots
// empty, so the script first registers two agents over HTTP and detaches
// them (leave). Every agent must then resolve to wait, miss counters must
// climb, agents must stay unmanned the whole run (stalled is reserved for
// attached clients), and barrier.log must show clean open/close/resolve
// cycles. If this is clean, the engine is correct and any later fault is in
// a client.

import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../server.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const TICKS = 20;

rmSync(join(baseDir, "barrier.log"), { force: true });
rmSync(join(baseDir, "world.log"), { force: true });

const daemon = createDaemon({
  startPaused: true, // held until both bodies are registered AND detached
  actionDeadlineMs: 100, // nobody is coming; don't wait 20s per tick
  maxTicks: TICKS,
  minAgents: 2,
  reapAfterTicks: TICKS + 10, // nobody gets reaped inside this run
});

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const persona = (name, bodyColor) => ({
  name,
  appearance: { bodyColor, eyeColor: "#FF4400", scale: "medium", shell: "smooth", eyes: "pair" },
  disposition: "neutral",
  identity: `You are ${name}, a verification fixture.`,
  discoverable: "You exist to prove the engine honest.",
  privateObjective: "You want a clean barrier log.",
});

daemon.engine.on("operator", ({ event, data }) => {
  if (event !== "barrier" || data.event !== "run_complete") return;

  // Give the log stream a beat to flush, then inspect everything.
  setTimeout(() => {
    const lines = readFileSync(join(baseDir, "barrier.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const byEvent = (e) => lines.filter((l) => l.event === e);
    const opens = byEvent("tick_open").map((l) => l.tick);
    const closes = byEvent("tick_closed").map((l) => l.tick);
    const resolves = byEvent("tick_resolved").map((l) => l.tick);
    const expected = Array.from({ length: TICKS }, (_, i) => i + 1);

    check(JSON.stringify(opens) === JSON.stringify(expected), `barrier.log: ${TICKS} tick_open, in order`);
    check(JSON.stringify(closes) === JSON.stringify(expected), `barrier.log: ${TICKS} tick_closed, in order`);
    check(JSON.stringify(resolves) === JSON.stringify(expected), `barrier.log: ${TICKS} tick_resolved, in order`);
    const agentIds = [...daemon.engine.world.agents.keys()];
    const N = agentIds.length;
    check(N === 2, "both registered bodies survived the run (nobody reaped)");
    check(byEvent("action_received").length === 0, "no actions received (nothing attached)");
    check(byEvent("observation_emitted").length === TICKS * N, `${N} observations emitted per tick`);

    const waits = byEvent("tick_resolved").every((l) => l.summary.wait === N && l.summary.say === 0 && l.summary.move === 0 && l.summary.build === 0);
    check(waits, `every tick resolved to wait for all ${N} agents`);

    const misses = byEvent("action_missed");
    check(misses.length === TICKS * N, `miss counters climbed every tick (${misses.length} misses logged)`);

    for (const id of agentIds) {
      const body = daemon.engine.world.agents.get(id);
      check(body.connection.consecutiveMisses === TICKS, `${id}: consecutiveMisses === ${TICKS}`);
      check(body.connection.state === "unmanned", `${id}: stayed unmanned (never stalled — nothing was attached)`);
      const wrongState = misses.find((l) => l.agentId === id && l.state !== "unmanned");
      check(!wrongState, `${id}: every miss logged with state unmanned`);
    }
    check(
      byEvent("tick_closed").every((l) => l.reason === "deadline"),
      "no early closes with zero submissions"
    );

    check(daemon.engine.stopped === true, `engine holds state after maxTicks (${TICKS}) without exiting`);

    console.log(failures === 0 ? "\nVERIFY OK — engine is clean; any later fault is in a client." : `\nVERIFY FAILED: ${failures} check(s)`);
    daemon.close().then(() => process.exit(failures === 0 ? 0 : 1));
  }, 150);
});

const server = daemon.listen(0);
server.once("listening", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  // Register two bodies, then detach both: the run proceeds unmanned.
  for (const [name, color] of [["Verity", "#8A7F74"], ["Probe", "#6E7B84"]]) {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "0.2", persona: persona(name, color), clientName: "verify" }),
    }).then((r) => r.json());
    if (!reg.token) {
      console.error("FAIL  registration during setup:", JSON.stringify(reg));
      process.exit(1);
    }
    await fetch(`${base}/agent/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reg.token}` },
    });
  }
  console.log(`Running ${TICKS} ticks with two unmanned bodies and no clients connected…\n`);
  daemon.engine.play(); // both bodies are detached; now let the clock run
});
