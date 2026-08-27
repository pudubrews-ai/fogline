// Pre-boot configuration panel logic (observatory spec v0.8 §3), kept pure
// so the freeze rule, the exposure whitelist, and the diff are testable
// headless. The UI half lives in panels/configpanel.js.
//
// The panel writes a CONFIG FILE; the config remains the artifact (§3.1).
// Nothing here mutates live daemon state, and there is no route it could
// use to try: committing produces a named JSON file for the daemon's next
// boot, with the same discipline as editing config.json by hand.

// §3.4 — exposed: knobs. Everything not listed here rides through a commit
// UNTOUCHED from the base config. recipes.js, resource properties, fog
// rules, and retrieval parameters are world semantics, not knobs: they are
// not exposed, not listed, and (asserted by the bundle grep) not present.
export const EXPOSED_FIELDS = [
  { path: "gridSize", label: "grid size", min: 2, step: 1 },
  { path: "slots", label: "slots", min: 1, step: 1 },
  { path: "expectedAgents", label: "expected agents", min: 1, step: 1 },
  { path: "maxTicks", label: "max ticks", min: 1, step: 1 },
  { path: "reapAfterTicks", label: "reap after ticks", min: 1, step: 1 },
  { path: "actionDeadlineMs", label: "action deadline (ms)", min: 1000, step: 1000 },
  { path: "viability.targetRatio", label: "target ratio", min: 0.1, step: 0.05 },
  { path: "viability.viabilityFloor", label: "viability floor", min: 0, step: 0.05 },
  { path: "viability.minSpringsPerResource", label: "min springs per resource", min: 1, step: 1 },
  { path: "vitals.sustenanceMax", label: "sustenance max", min: 1, step: 5 },
  { path: "vitals.sustenanceDecayPerTick", label: "sustenance decay / tick", min: 0, step: 1 },
  { path: "vitals.sivetRestores", label: "sivet restores", min: 1, step: 1 },
  { path: "vitals.vitalityMax", label: "vitality max", min: 1, step: 5 },
  { path: "vitals.starvationDamagePerTick", label: "starvation damage / tick", min: 0, step: 1 },
  { path: "vitals.regenThreshold", label: "regen threshold", min: 0, step: 5 },
  { path: "vitals.regenPerTick", label: "vitality regen / tick", min: 0, step: 1 },
  { path: "vitals.attackDamage", label: "attack damage", min: 0, step: 1 },
  { path: "vitals.attackCost", label: "attack cost", min: 0, step: 1 },
  { path: "vitals.sponsorDrainPerTick", label: "sponsor drain / tick", min: 0, step: 1 },
  { path: "vitals.orphanDamagePerTick", label: "orphan damage / tick", min: 0, step: 1 },
  { path: "destruction.demolishTicks", label: "demolish ticks", min: 1, step: 1 },
  { path: "destruction.razeCost", label: "raze cost", min: 0, step: 1 },
  { path: "destruction.rubbleYieldDemolish", label: "rubble yield (demolish)", min: 0, step: 1 },
  { path: "destruction.rubbleYieldRaze", label: "rubble yield (raze)", min: 0, step: 1 },
  { path: "destruction.rubbleRatio", label: "rubble ratio", min: 1, step: 1 },
  { path: "resources.seedDensity", label: "seed density", min: 0, step: 0.01 },
  { path: "resources.regenPerTick", label: "deposit regen / tick", min: 0, step: 0.01 },
];

export const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function setPath(obj, path, value) {
  const keys = path.split(".");
  const out = structuredClone(obj ?? {});
  let node = out;
  for (const k of keys.slice(0, -1)) {
    node[k] = node[k] == null ? {} : structuredClone(node[k]);
    node = node[k];
  }
  node[keys[keys.length - 1]] = value;
  return out;
}

// §3.5: what changed since the last committed config — twelve runs in, the
// most frequent question there is. Compares every key either side carries,
// not only the exposed ones, so a hand edit shows too.
export function diffConfigs(prev, next, prefix = "") {
  if (prev == null && next == null) return [];
  const out = [];
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const key of [...keys].sort()) {
    const a = prev?.[key];
    const b = next?.[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      out.push(...diffConfigs(a, b, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path, from: a === undefined ? null : a, to: b === undefined ? null : b });
    }
  }
  return out;
}

// §3.3 — frozen at tick 1: once the first tick opens, the config is fixed
// and the panel refuses to commit. Mid-run tuning is the operator becoming
// a participant, the same boundary that keeps the analyst read-only.
export function canCommit(state) {
  if (state && state.runId && state.tick >= 1) {
    return {
      ok: false,
      why: `run ${state.runId} opened tick 1 — its config is frozen. Commit before boot, or after this run stops and the daemon is rebooted.`,
    };
  }
  return { ok: true, why: null };
}

// The commit artifact: the full config (unexposed keys untouched) with the
// panel's name on it. The name lands in the archive with the run (§3.1).
export function commitPayload(config, name) {
  const clean = String(name ?? "").trim();
  const named = { ...config, configName: clean || null };
  const slug = (clean || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    config: named,
    filename: `fogline-config-${slug || "untitled"}.json`,
    text: JSON.stringify(named, null, 2) + "\n",
  };
}
