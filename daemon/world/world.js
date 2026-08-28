// The grid world: cells, slots, bodies. The daemon owns all of this; clients
// own none of it. The world boots with zero agents — bodies exist only by
// registration and are destroyed by release or reaping (daemon spec v0.2 §2-3).

import crypto from "node:crypto";
import {
  APPEARANCE_ENUMS,
  DEFAULT_SATURATION_CEILING,
  isHexColor,
  saturationOf,
} from "./appearance.js";
import { emptyInventory, resourcesConfig, seedDeposits } from "./resources.js";
import { vitalsConfig } from "./vitals.js";
import { genotypeConfig } from "./genotype.js";
import { destructionConfig } from "./destruction.js";

// Lineage constants merge here rather than in lineage.js because lineage.js
// imports this module — configuration stays cycle-free.
export const LINEAGE_DEFAULTS = {
  maturityTicks: 20,
  begetVitalityCost: 20,
  begetResourceCost: { sivet: 4 },
};

export { APPEARANCE_ENUMS };

// ---------- persona schema (protocol §13.2) ----------

export const DISPOSITIONS = ["talkative", "neutral", "reserved"];
export const PERSONA_LIMITS = {
  name: 24,
  identity: 600,
  discoverable: 800,
  privateObjective: 400,
};

const NAME_RE = /^[A-Za-z0-9 '-]+$/;
// Reject control characters other than newline in freeform text — this is the
// prompt-injection chokepoint, not validation hygiene (daemon spec §4.3).
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;

// Structure text rides the same injection chokepoint as personas: it is
// agent-authored and lands in other agents' observations (protocol §10).
export const hasControlChars = (text) => CONTROL_RE.test(text);

// The schema block served at /scenario so clients can self-validate first.
export function personaSchema(saturationCeiling = DEFAULT_SATURATION_CEILING) {
  return {
    name: { minLength: 1, maxLength: PERSONA_LIMITS.name, charset: "[A-Za-z0-9 '-]", unique: true },
    appearance: {
      bodyColor: { pattern: "^#[0-9A-Fa-f]{6}$", maxSaturation: saturationCeiling },
      eyeColor: { pattern: "^#[0-9A-Fa-f]{6}$" },
      scale: APPEARANCE_ENUMS.scale,
      shell: APPEARANCE_ENUMS.shell,
      eyes: APPEARANCE_ENUMS.eyes,
    },
    disposition: DISPOSITIONS,
    identity: { maxLength: PERSONA_LIMITS.identity, person: "second" },
    discoverable: { maxLength: PERSONA_LIMITS.discoverable, person: "second" },
    privateObjective: { maxLength: PERSONA_LIMITS.privateObjective, person: "second" },
  };
}

// Reject, never truncate; never rewrite freeform text (daemon spec §4.3).
// Returns {ok: true, persona} with a trimmed name, or {ok: false, detail}.
// With appearance: "ignore", the appearance field is skipped entirely and the
// returned persona has none — the attach-to-matured-body path, where genotype
// is already fixed on the body (protocol §13.3).
export function validatePersona(raw, { saturationCeiling = DEFAULT_SATURATION_CEILING, appearance = "require" } = {}) {
  const bad = (detail) => ({ ok: false, detail });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("persona must be an object");

  if (typeof raw.name !== "string") return bad("name must be a string");
  const name = raw.name.trim();
  if (name.length < 1 || name.length > PERSONA_LIMITS.name) {
    return bad(`name must be 1-${PERSONA_LIMITS.name} chars`);
  }
  if (!NAME_RE.test(name)) return bad("name may contain only [A-Za-z0-9 '-]");

  let validAppearance = null;
  if (appearance === "require") {
    const app = raw.appearance;
    if (app === null || typeof app !== "object" || Array.isArray(app)) return bad("appearance must be an object");
    if (!isHexColor(app.bodyColor)) {
      return bad("appearance.bodyColor must match ^#[0-9A-Fa-f]{6}$");
    }
    if (saturationOf(app.bodyColor) > saturationCeiling) {
      return bad(`appearance.bodyColor saturation must be <= ${saturationCeiling} — only eyes are saturated`);
    }
    if (!isHexColor(app.eyeColor)) {
      return bad("appearance.eyeColor must match ^#[0-9A-Fa-f]{6}$");
    }
    for (const [field, allowed] of Object.entries(APPEARANCE_ENUMS)) {
      if (!allowed.includes(app[field])) {
        return bad(`appearance.${field} must be one of: ${allowed.join(", ")}`);
      }
    }
    validAppearance = {
      bodyColor: app.bodyColor,
      eyeColor: app.eyeColor,
      scale: app.scale,
      shell: app.shell,
      eyes: app.eyes,
    };
  }

  if (!DISPOSITIONS.includes(raw.disposition)) {
    return bad(`disposition must be one of: ${DISPOSITIONS.join(", ")}`);
  }

  for (const field of ["identity", "discoverable", "privateObjective"]) {
    const value = raw[field];
    if (typeof value !== "string") return bad(`${field} must be a string`);
    if (value.length > PERSONA_LIMITS[field]) {
      return bad(`${field} must be at most ${PERSONA_LIMITS[field]} chars`);
    }
    if (CONTROL_RE.test(value)) return bad(`${field} contains control characters`);
  }

  return {
    ok: true,
    persona: {
      name,
      ...(validAppearance ? { appearance: validAppearance } : {}),
      disposition: raw.disposition,
      identity: raw.identity,
      discoverable: raw.discoverable,
      privateObjective: raw.privateObjective,
    },
  };
}

// Uniqueness is case-insensitive on the trimmed name (daemon spec §4.2).
export function nameTaken(world, name) {
  const needle = name.trim().toLowerCase();
  for (const body of world.agents.values()) {
    // Infants have no persona and hold no name (protocol §11.4).
    if (body.persona && body.persona.name.toLowerCase() === needle) return true;
  }
  return false;
}

// ---------- grid ----------

export const coordKey = (x, y) => `${x},${y}`;

export function parseCoord(coord) {
  const m = /^(\d+),(\d+)$/.exec(String(coord));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

// Adjacency is computed, never configured: in-bounds orthogonal neighbours.
// 0,0 is the northwest corner, so north is y-1. Width and height are
// independent (engine spec v0.9 §2.3): a 4×16 canyon is a different world
// from an 8×8 field, and adjacency stays 4-way and engine-owned.
export function exitsFor(world, coord) {
  const p = parseCoord(coord);
  if (!p) return [];
  const w = world.width ?? world.gridSize;
  const h = world.height ?? world.gridSize;
  const candidates = [
    { direction: "north", x: p.x, y: p.y - 1 },
    { direction: "east", x: p.x + 1, y: p.y },
    { direction: "south", x: p.x, y: p.y + 1 },
    { direction: "west", x: p.x - 1, y: p.y },
  ];
  return candidates
    .filter((c) => c.x >= 0 && c.x < w && c.y >= 0 && c.y < h)
    .map((c) => ({ direction: c.direction, coord: coordKey(c.x, c.y) }));
}

function deepFreezeRecipes(recipes) {
  const frozen = {};
  for (const [form, cost] of Object.entries(recipes)) frozen[form] = Object.freeze({ ...cost });
  return Object.freeze(frozen);
}

export function createWorld({
  // v0.9: a normalized world definition (definition.js) supplies grid,
  // resources and roles, deposits, recipes, forms, vitals, premise, and
  // enabled actions. Absent a definition, the legacy v0.8 call shape is
  // honored exactly: the DEFAULT definition supplies roles, recipes, and
  // forms (the values that used to be constants here), while grid, deposit
  // config, and vitals come from the legacy arguments with v0.8 defaults.
  definition = null,
  // Legacy (v0.8-shaped) construction: the caller supplies the normalized
  // definition whose roles, recipes, forms, and actions stand in for the
  // constants that used to live here. world.js deliberately does NOT import
  // definition.js — api/ reaches this module, and the loader (with the
  // recipe table it reads) must stay unreachable from api/ (engine spec
  // v0.9 §2.4). Operator-side callers (server.js, tests) load and inject it.
  defaults = null,
  gridSize,
  slots,
  resources = null,
  vitals = null,
  genotype = null,
  lineage = null,
  destruction = null,
  carryLimit = 12,
  // Permanent per-structure inscription budget (protocol v0.6 A9): a
  // structure holds this many characters of record, ever.
  inscriptionMax = 500,
  // Ratio-path seeding context (daemon spec §2.4): {targetRatio,
  // minSpringsPerResource, maxTicks}. Null keeps the density fallback.
  seeding = null,
  rng = Math.random,
}) {
  const base = definition ?? defaults;
  if (!base) {
    throw new Error("World config error: createWorld requires a definition (or legacy defaults)");
  }
  let width;
  let height;
  let depositCfg;
  let effVitals;
  const consumable = { ...base.consumable };
  let byproduct = base.byproduct ? { ...base.byproduct } : null;
  let shouldSeed;
  if (definition) {
    width = definition.width;
    height = definition.height;
    depositCfg = resourcesConfig({ resources: definition.deposits });
    effVitals = vitalsConfig({ vitals: definition.vitals });
    shouldSeed = true;
  } else {
    // gridSize < 2 is rejected at boot with a clear error, not a hang
    // (protocol §1 amendment 9, daemon spec §2.6).
    if (!Number.isInteger(gridSize) || gridSize < 2) {
      throw new Error(`World config error: gridSize must be an integer >= 2, got ${gridSize}`);
    }
    width = gridSize;
    height = gridSize;
    depositCfg = resourcesConfig({ resources: resources ?? {} });
    const legacyVitals = { ...(vitals ?? {}) };
    // Legacy spelling of the consumable's restore amount (v0.8 vitals key).
    if (legacyVitals.sivetRestores != null && consumable.name === "sivet") {
      consumable.restores = legacyVitals.sivetRestores;
      delete legacyVitals.sivetRestores;
    }
    effVitals = vitalsConfig({ vitals: legacyVitals });
    // Legacy spelling of the byproduct's substitution ratio.
    if (byproduct && destruction?.rubbleRatio != null) {
      byproduct = { ...byproduct, ratio: destruction.rubbleRatio };
    }
    shouldSeed = resources !== null;
  }
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`World config error: slots must be a positive integer, got ${slots}`);
  }
  // Every cell exists at boot with structure null. Never lazily created:
  // the map is the world and a missing cell is a bug surface (spec §2.1).
  const cells = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells.set(coordKey(x, y), {
        coord: coordKey(x, y),
        structure: null,
        deposit: null, // {resource, quantity, capacity, regenAccum}
        loose: null, // resource map dropped by death, drop, or destruction
        corpses: [], // permanent; perceivable only from within the cell
        // Inscription fragment left by demolition (protocol §9.1) — attached
        // to the byproduct pile; gone when the pile is carried off.
        fragment: null, // { text } | null
      });
    }
  }
  const world = {
    // Legacy (v0.8-shaped) construction takes name and premise from config,
    // not from the default definition that supplies roles and recipes.
    name: definition ? base.name : null,
    width,
    height,
    // Kept for operator records and legacy readers; null when non-square.
    gridSize: width === height ? width : null,
    premise: definition ? base.premise : null,
    cells,
    slots: { total: slots, used: 0 },
    agents: new Map(),
    reclaimedIds: new Set(), // released or reaped — attach answers SLOT_RECLAIMED
    nextMemoryId: 1,
    // ---- definition-owned world knowledge (engine spec v0.9 §2) ----
    resourceTypes: [...base.resourceTypes],
    seedableTypes: [...base.seedableTypes],
    consumable,
    byproduct,
    recipes: deepFreezeRecipes(base.recipes),
    forms: [...base.forms],
    enabledActions: new Set(base.actions),
    knowledgeInheritance: base.knowledgeInheritance === true,
    // Merged vitals constants ride on the world so body creation, upkeep,
    // and band derivation all read one source of truth.
    vitals: effVitals,
    resources: depositCfg,
    genotype: genotypeConfig({ genotype: genotype ?? {} }),
    lineage: { ...LINEAGE_DEFAULTS, ...(lineage ?? {}) },
    destruction: destructionConfig({ destruction: destruction ?? {} }),
    carryLimit,
    inscriptionMax,
    nextInscriptionId: 1, // entry ids are internal bookkeeping, never in-world
    // Every memory write of the current tick, drained into the resolved-tick
    // record so replay reconstructs streams exactly (operator-side only).
    memoryLog: [],
  };
  if (shouldSeed) seedDeposits(world, world.resources, rng, seeding);
  return world;
}

// ---------- bodies ----------

function mintAgentId(world) {
  for (;;) {
    const id = `a_${crypto.randomBytes(2).toString("hex")}`;
    if (!world.agents.has(id) && !world.reclaimedIds.has(id)) return id;
  }
}

// Spawn: random cell empty of agents, preferring cells with no structure.
function pickSpawnCell(world) {
  const occupied = new Set([...world.agents.values()].map((b) => b.coord));
  const free = [...world.cells.values()].filter((c) => !occupied.has(c.coord));
  const pool = free.length > 0 ? free : [...world.cells.values()];
  const preferred = pool.filter((c) => c.structure === null);
  const pickFrom = preferred.length > 0 ? preferred : pool;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)].coord;
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") deepFreeze(value);
  }
  return Object.freeze(obj);
}

// Caller has already validated the persona and checked slots + name.
// The persona is frozen here — protocol invariant 5 enforced structurally,
// not by convention: no attach handler has a write path to it.
export function createAgent(world, persona, tick, { clientName = null, modelHint = null, surface = null } = {}) {
  const frozen = deepFreeze(structuredClone(persona));
  const body = {
    id: mintAgentId(world),
    persona: frozen,
    // Appearance lives on the body, not the persona: infants have appearance
    // (daemon-composed genotype) before they have any persona at all, and a
    // matured body keeps its genotype when a client authors its persona.
    appearance: frozen.appearance,
    coord: pickSpawnCell(world),
    currentIntent: null,
    lastActionOutcome: null,
    lastUpkeepVitalityDelta: 0, // raw upkeep delta; vitalityTrend derives from its sign (v0.7 A2)
    inventory: emptyInventory(world.resourceTypes),
    sustenance: world.vitals.sustenanceMax,
    vitality: world.vitals.vitalityMax,
    lifeStage: "adult", // registered bodies are adults; infants come by beget
    bornAtTick: null, // set only on begotten bodies
    sponsorId: null, // infants only: the agent paying their upkeep
    unsponsoredAtTick: null,
    heritage: null, // begotten bodies only; snapshotted at birth
    lastAttackedBy: null, // {agentId, tick} — cause attribution for deaths
    eventTick: 0, // last tick an attack/death/birth happened in this body's cell
    readInscriptions: new Set(), // entry ids already read (once per entry per agent)
    firstReadTick: null, // tick of the most recent first-time inscription read
    // Rolling record of THIS agent's own failed attempts (daemon spec v0.6
    // §5). Per-agent knowledge, stored only on the body — never anywhere
    // globally convenient, which is the shape of every fog leak so far.
    failedAttempts: [],
    // Client-reported status enum (v0.6 A8): operator channel only. Never
    // in an observation, never alters world behavior.
    clientStatus: null,
    situationPrev: null, // last tick's situation snapshot (situation.js)
    lastAttentionTick: 0,
    memories: [],
    knownCells: new Map(), // "x,y" -> { structureSnapshot, lastSeenTick }
    connection: {
      state: "active", // registration is an attach; the client is here
      clientName,
      modelHint,
      // Billing surface (protocol §15.3): vendor + account fingerprint,
      // never a credential. Operator-visible only; never in an observation.
      surface,
      token: null, // issued by the auth layer, stored for takeover detection
      consecutiveMisses: 0,
      lastActionLatencyMs: null,
      unmannedSinceTick: null, // null while attached; drives reaping
    },
    // Internal bookkeeping, never emitted through the fog boundary.
    lastReason: null,
    lastPerceived: { coord: null, present: null },
    importanceSinceLastReflection: 0,
    reflectionRequested: false,
  };
  world.agents.set(body.id, body);
  world.slots.used += 1;
  // The known map begins as exactly the spawn cell (protocol §7.2).
  snapshotCurrentCell(world, body, tick);
  return body;
}

// On arrival in a cell (including spawn), overwrite the agent's snapshot of
// it. This MUST be a deep copy, not a reference: staleness is normative —
// a structure built after the agent leaves must NOT appear in its knownCells,
// and a shared reference would silently defeat that (daemon spec §5).
export function snapshotCurrentCell(world, body, tick) {
  const cell = world.cells.get(body.coord);
  body.knownCells.set(body.coord, {
    structureSnapshot: structuredClone(cell.structure),
    lastSeenTick: tick,
  });
}

// An infant body (protocol §11): daemon-composed appearance, heritage brief
// snapshotted at birth, NO persona — no name, identity, or objective. It is
// unattachable, immobile, takes no actions, and costs no inference. Its
// entire cost is the sponsor's vitality.
export function createInfant(world, { appearance, heritage, sponsorId, coord }, tick) {
  const body = {
    id: mintAgentId(world),
    persona: null,
    appearance: deepFreeze(structuredClone(appearance)), // genotype is fixed for life
    coord,
    currentIntent: null,
    lastActionOutcome: null,
    lastUpkeepVitalityDelta: 0, // raw upkeep delta; vitalityTrend derives from its sign (v0.7 A2)
    inventory: emptyInventory(world.resourceTypes),
    sustenance: world.vitals.sustenanceMax,
    vitality: world.vitals.vitalityMax,
    lifeStage: "infant",
    bornAtTick: tick,
    sponsorId,
    unsponsoredAtTick: null,
    heritage, // mutable: fostering appends raisedBy
    lastAttackedBy: null,
    eventTick: 0,
    readInscriptions: new Set(),
    firstReadTick: null,
    failedAttempts: [],
    clientStatus: null,
    situationPrev: null,
    lastAttentionTick: 0,
    memories: [],
    knownCells: new Map(),
    connection: {
      state: "unmanned",
      clientName: null,
      modelHint: null,
      surface: null,
      token: null,
      consecutiveMisses: 0,
      lastActionLatencyMs: null,
      unmannedSinceTick: null, // never set for the unclaimed: the reaper ignores them
    },
    lastReason: null,
    lastPerceived: { coord: null, present: null },
    importanceSinceLastReflection: 0,
    reflectionRequested: false,
  };
  world.agents.set(body.id, body);
  world.slots.used += 1;
  return body;
}

// First attach to a matured body: the client authors the persona from the
// heritage brief; the genotype already on the body is kept and any submitted
// appearance was ignored upstream (protocol §13.3). The one write path to a
// null persona, and it freezes what it writes.
export function claimMaturedBody(body, persona) {
  body.persona = deepFreeze(structuredClone(persona));
}

// Destroys the body and frees the slot. Structures and their history entries
// persist, and speech stays in other agents' streams — the world remembers
// people who have gone. Only the body, its memories, and its map are dropped.
export function releaseAgent(world, agentId) {
  const body = world.agents.get(agentId);
  if (!body) return false;
  world.agents.delete(agentId);
  world.reclaimedIds.add(agentId);
  world.slots.used -= 1;
  return true;
}
