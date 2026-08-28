// The world definition loader (engine spec v0.9 §2). A definition owns:
// grid shape, resources and their roles, deposit distribution, recipes,
// structure forms, vitals constants, viability targets, the premise, and
// which actions exist. The ENGINE owns everything else — perception and the
// four fogs, the tick barrier, resolution order, mortality, the protocol,
// inheritance and sponsorship mechanics, destruction semantics, memory and
// retrieval. Nothing in a definition can widen what an action reveals.
//
// CONTAINMENT (engine spec §2.4): a definition is OPERATOR-ONLY. This module
// and the worlds/ directory are never importable from api/, never served at
// /scenario or any agent route, and never bundled into Scry. The definition
// inherits recipes.js's rule in full: it holds the recipe table, and the
// import-graph test follows it here. A world file feels like configuration,
// and configuration feels servable. It is not.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = new Set(["consumable", "structural", "byproduct"]);

// Engine-side capability names. A definition may only enable actions the
// engine knows how to resolve — worlds declare WHICH, the engine owns HOW.
export const ENGINE_ACTION_TYPES = new Set([
  "move", "say", "build", "wait", "attack", "take",
  "gather", "drop", "give", "consume", "inscribe", "beget", "foster",
  "demolish", "raze",
]);

const fail = (detail) => {
  throw new Error(`World definition error: ${detail}`);
};

// Validate and normalize a raw definition object into the shape the engine
// consumes. Values pass through verbatim — normalization adds derived views
// (type lists, role lookups), never rewrites a number.
export function normalizeDefinition(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("definition must be an object");
  if (typeof raw.name !== "string" || raw.name.length === 0) fail("name is required");

  const grid = raw.grid;
  if (grid === null || typeof grid !== "object") fail("grid is required");
  const { width, height } = grid;
  if (!Number.isInteger(width) || width < 2) fail(`grid.width must be an integer >= 2, got ${width}`);
  if (!Number.isInteger(height) || height < 2) fail(`grid.height must be an integer >= 2, got ${height}`);

  if (typeof raw.premise !== "string") fail("premise is required");

  // Resources declare ROLES, not wired-in names (engine spec §2.2).
  if (!Array.isArray(raw.resources) || raw.resources.length === 0) fail("resources must be a non-empty array");
  const resourceTypes = [];
  const consumables = [];
  const byproducts = [];
  const structurals = [];
  for (const r of raw.resources) {
    if (typeof r.name !== "string" || r.name.length === 0) fail("every resource needs a name");
    if (resourceTypes.includes(r.name)) fail(`duplicate resource "${r.name}"`);
    if (!ROLES.has(r.role)) fail(`resource "${r.name}" role must be one of: ${[...ROLES].join(", ")}`);
    resourceTypes.push(r.name);
    if (r.role === "consumable") {
      // A consumable declares which need it satisfies and how much it
      // restores (protocol §3: consumable knowledge is given to agents).
      if (r.need !== "sustenance") fail(`consumable "${r.name}" must declare need: "sustenance"`);
      if (!Number.isFinite(r.restores) || r.restores <= 0) fail(`consumable "${r.name}" must declare restores > 0`);
      consumables.push({ name: r.name, need: r.need, restores: r.restores });
    } else if (r.role === "byproduct") {
      // Never seeded; produced by an engine mechanic (destruction). Declares
      // what it substitutes for and at what ratio.
      if (typeof r.substitutesFor !== "string") fail(`byproduct "${r.name}" must declare substitutesFor`);
      if (!Number.isFinite(r.ratio) || r.ratio <= 0) fail(`byproduct "${r.name}" must declare ratio > 0`);
      byproducts.push({ name: r.name, substitutesFor: r.substitutesFor, ratio: r.ratio });
    } else {
      structurals.push(r.name);
    }
  }
  if (consumables.length !== 1) fail(`exactly one consumable resource is required, got ${consumables.length}`);
  if (byproducts.length > 1) fail(`at most one byproduct resource is supported, got ${byproducts.length}`);
  for (const b of byproducts) {
    if (!resourceTypes.includes(b.substitutesFor)) fail(`byproduct "${b.name}" substitutes for unknown resource "${b.substitutesFor}"`);
  }

  if (raw.deposits === null || typeof raw.deposits !== "object") fail("deposits is required");

  // Recipes live here now — recipes.js's containment rule moved with them.
  if (raw.recipes === null || typeof raw.recipes !== "object") fail("recipes is required");
  if (!Array.isArray(raw.forms) || raw.forms.length === 0) fail("forms must be a non-empty array");
  for (const form of raw.forms) {
    const cost = raw.recipes[form];
    if (cost === null || typeof cost !== "object") fail(`form "${form}" has no recipe`);
    for (const [res, n] of Object.entries(cost)) {
      if (!resourceTypes.includes(res)) fail(`recipe for "${form}" names unknown resource "${res}"`);
      if (!Number.isInteger(n) || n < 1) fail(`recipe for "${form}": ${res} must be a positive integer`);
    }
  }

  if (raw.vitals === null || typeof raw.vitals !== "object") fail("vitals is required");
  if (raw.viability === null || typeof raw.viability !== "object") fail("viability is required");

  // Action toggles (engine spec §3): worlds declare WHICH actions exist.
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) fail("actions must be a non-empty array");
  for (const a of raw.actions) {
    if (!ENGINE_ACTION_TYPES.has(a)) fail(`unknown action "${a}" — the engine declares how, and it knows no such action`);
  }
  const actions = new Set(raw.actions);
  actions.add("wait"); // wait always exists: it is what everything else coerces to

  return {
    name: raw.name,
    width,
    height,
    premise: raw.premise,
    resourceTypes,
    // Seeding draws only from non-byproduct resources: a byproduct exists
    // only as the product of an engine mechanic (engine spec §2.2).
    seedableTypes: resourceTypes.filter((n) => !byproducts.some((b) => b.name === n)),
    consumable: consumables[0],
    byproduct: byproducts[0] ?? null,
    deposits: { ...raw.deposits },
    recipes: Object.fromEntries(raw.forms.map((f) => [f, { ...raw.recipes[f] }])),
    forms: [...raw.forms],
    vitals: { ...raw.vitals },
    viability: { ...raw.viability },
    actions,
    knowledgeInheritance: raw.knowledgeInheritance === true,
  };
}

export function loadDefinition(path) {
  return normalizeDefinition(JSON.parse(readFileSync(path, "utf8")));
}

// The default world. Loaded lazily and cached; tests and the daemon both
// resolve it relative to this file so the cwd never matters.
const worldsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "worlds");
let cachedDefault = null;

export function defaultDefinition() {
  if (!cachedDefault) cachedDefault = loadDefinition(join(worldsDir, "orrum-5.json"));
  return cachedDefault;
}

export function resolveWorldPath(spec, baseDir) {
  return resolve(baseDir, spec);
}
