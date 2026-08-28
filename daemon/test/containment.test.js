// Structural containment, enforced the way the fog boundary is enforced —
// by tests over the artifact, not by care (daemon spec §1, §14 tests 1 and 7).
//
// 1. Import graph: recipes.js is unreachable from anything under api/.
// 2. Response scan: no /scenario or observation payload carries any form's
//    full material cost.
// 3. Vocabulary scan: no reputation-shaped stat exists anywhere in the
//    source. What is known about a killer is only what a witness remembers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDefinition } from "../world/definition.js";
import { bootDaemon, register } from "./helpers.js";

const daemonDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sourceFiles = () => {
  const files = ["server.js"];
  for (const dir of ["api", "engine", "world"]) {
    for (const f of readdirSync(join(daemonDir, dir))) {
      if (f.endsWith(".js")) files.push(join(dir, f));
    }
  }
  return files;
};

// Static import edges: relative specifiers only (bare specifiers like
// "express" cannot lead back into world/).
function importsOf(file) {
  const src = readFileSync(join(daemonDir, file), "utf8");
  const edges = [];
  for (const m of src.matchAll(/(?:import|export)[^"'`;]*?from\s+["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? m[2];
    edges.push(resolve(join(daemonDir, dirname(file)), spec).slice(daemonDir.length + 1));
  }
  return edges;
}

// The files api/ must never reach: the recipe machinery, and — v0.9 — the
// world definition loader that now carries the recipe table (engine spec
// §2.4). A world file feels like configuration and configuration feels
// servable; the import graph says otherwise.
const CONTAINED = ["world/recipes.js", "world/definition.js"];

test("containment: recipes.js and the world definition are unreachable from anything under api/", () => {
  const graph = new Map(sourceFiles().map((f) => [f, importsOf(f)]));
  const apiFiles = [...graph.keys()].filter((f) => f.startsWith("api/"));
  assert.ok(apiFiles.length >= 3, "api/ sources found");

  for (const start of apiFiles) {
    const seen = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const contained of CONTAINED) {
        assert.ok(!file.endsWith(contained), `${start} reaches ${contained} via the import graph`);
      }
      for (const dep of graph.get(file) ?? importsOf(file)) stack.push(dep);
    }
  }
});

test("containment: no api/ source imports recipes.js or the definition, or reads worlds/", () => {
  for (const f of sourceFiles().filter((f) => f.startsWith("api/"))) {
    for (const dep of importsOf(f)) {
      for (const contained of CONTAINED) {
        assert.ok(!dep.endsWith(contained), `api file ${f} imports ${contained}`);
      }
    }
    const src = readFileSync(join(daemonDir, f), "utf8");
    assert.ok(!src.includes("worlds/"), `api file ${f} mentions the worlds/ directory`);
  }
});

// The full cost of every form, as it would appear in leaked JSON or prose.
function costSignatures() {
  const defn = defaultDefinition();
  const signatures = [];
  for (const form of defn.forms) {
    const cost = defn.recipes[form];
    assert.ok(cost, `form ${form} has a recipe`);
    signatures.push(JSON.stringify(cost));
    const prose = Object.entries(cost).map(([r, n]) => `${n} ${r}`).join(", ");
    signatures.push(`${form}: ${prose}`);
  }
  return signatures;
}

test("containment: /scenario carries resource names and forms, never costs or properties", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const body = await fetch(`${base}/scenario`).then((r) => r.json());
    const dump = JSON.stringify(body);
    for (const sig of costSignatures()) {
      assert.ok(!dump.includes(sig), `scenario leaks a recipe: ${sig}`);
    }
    assert.ok(!/recipe/i.test(dump), "the word never appears");
    // Properties are discovered by use, never stated (protocol §5.1).
    for (const word of ["edible", "restores", "structural", "binding", "consumable"]) {
      assert.ok(!dump.toLowerCase().includes(word), `scenario states a resource property: ${word}`);
    }
  } finally {
    await daemon.close();
  }
});

test("containment: an observation payload never carries any form's full cost", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const reg = (await register(base, "Scanner")).body;
    await register(base, "Bystander");
    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 30));
    const obs = daemon.engine.lastObservationFor(reg.agentId);
    assert.ok(obs, "observation built");
    const dump = JSON.stringify(obs);
    for (const sig of costSignatures()) {
      assert.ok(!dump.includes(sig), `observation leaks a recipe: ${sig}`);
    }
  } finally {
    await daemon.close();
  }
});

test("no reputation stat exists anywhere in the source", () => {
  const words = /\b(karma|reputation|notoriety|standing|infamy|crimeCount|crimes?)\b/i;
  for (const file of sourceFiles()) {
    const src = readFileSync(join(daemonDir, file), "utf8");
    const hit = src.match(words);
    assert.equal(hit, null, `${file} contains "${hit?.[0]}"`);
  }
});
