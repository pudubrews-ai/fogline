// Model output -> action (protocol v0.3 §9, §10; client spec v0.3 §8).
// Defensive: fences, preamble, then strict validation against the protocol
// and this tick's observation. Local checks turn a wasted round trip into an
// immediate wait with a reason — never a retry, never a crash.
//
// v0.3: the model emits a structured intent object {summary, kind, target}
// alongside its action. `summary` goes to the daemon as the intent string;
// `kind` and `target` never leave the client — they are returned separately
// as `intentState` and drive cheap.js.

const TYPES = new Set([
  "move", "say", "gather", "drop", "give", "consume", "take",
  "build", "inscribe", "demolish", "raze", "attack", "beget", "foster", "wait",
]);
// Reserved by the protocol: never emitted, even if the model asks.
const RESERVED = new Set(["modify"]);
const INTENT_KINDS = new Set(["travel", "gather", "wait", "demolish", "other"]);
const STRUCTURE_LIMITS = { name: 40, description: 300 };
const COORD_RE = /^\d+,\d+$/;

// Fences, preamble, outermost {...}, JSON.parse — shared by action parsing
// and persona generation. Returns {ok: true, value} or {ok: false, error}.
export function extractJson(rawText) {
  let text = String(rawText ?? "").trim();

  // 1. Strip markdown fences.
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "");

  // 2. Extract the outermost {...} if there is preamble or trailing prose.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return { ok: false, error: "no JSON object found" };
  }
  text = text.slice(first, last + 1);

  // 3. Parse.
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "not an object" };
  }
  return { ok: true, value };
}

// The intent field: an object {summary, kind, target} per client spec §3.3,
// with a plain string tolerated as a summary-only intent (older shape).
//
// v0.4 (client spec §2.1): intent is METADATA and is never load-bearing.
// Missing or unparseable intent returns intent null — the caller defaults it
// — and MUST NOT fail the action. The old required-intent rule cost one
// agent 44 ticks of silence.
function parseIntent(raw) {
  if (typeof raw === "string" && raw.length > 0) {
    return { intent: { summary: raw, kind: null, target: null } };
  }
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { intent: null };
  }
  const { summary, kind, target } = raw;
  if (typeof summary !== "string" || summary.length === 0) {
    return { intent: null };
  }
  const cleanKind = typeof kind === "string" && INTENT_KINDS.has(kind) ? kind : null;
  let cleanTarget = null;
  if (cleanKind === "travel") {
    if (typeof target !== "string" || !COORD_RE.test(target)) {
      // A travel intent without a usable coordinate is still a valid action;
      // it just is not cheaply continuable.
      return { intent: { summary, kind: "other", target: null } };
    }
    cleanTarget = target;
  }
  return { intent: { summary, kind: cleanKind, target: cleanTarget } };
}

// A resource map for give/drop: named resources, positive integers, and
// nothing the agent does not actually hold (a give of what you lack is a
// wasted tick the daemon would coerce anyway).
function validateResources(resources, inventory, forWhat) {
  if (resources === null || typeof resources !== "object" || Array.isArray(resources)) {
    return { ok: false, error: `resources is required for ${forWhat}` };
  }
  const entries = Object.entries(resources);
  if (entries.length === 0) return { ok: false, error: `resources must name at least one resource for ${forWhat}` };
  for (const [name, count] of entries) {
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, error: `resources.${name} must be a positive integer` };
    }
    const held = inventory?.[name] ?? 0;
    if (count > held) {
      return { ok: false, error: `cannot ${forWhat} ${count} ${name}: you carry ${held}` };
    }
  }
  return { ok: true };
}

const nullUnless = (fields, allowed) => {
  for (const [name, value] of Object.entries(fields)) {
    if (!allowed.includes(name) && value != null) {
      return `${name} must be null for this action type`;
    }
  }
  return null;
};

// Returns {ok: true, action, intentState} or {ok: false, error}. `action`
// carries only the daemon-bound decision fields (intent is the summary
// string); `intentState` is {summary, kind, target} and stays client-side.
export function parseAction(rawText, observation, context = {}) {
  const extracted = extractJson(rawText);
  if (!extracted.ok) return extracted;
  const parsed = extracted.value;

  const { type, coord, text, structure, target, resources, resource } = parsed;
  if (RESERVED.has(type)) return { ok: false, error: `"${type}" is reserved and never emitted` };
  if (!TYPES.has(type)) return { ok: false, error: `bad type: ${JSON.stringify(type)}` };
  // v0.4 (client spec §2.1): a valid type with its required fields SUBMITS.
  // reason defaults to null; intent degrades to null and the caller defaults
  // it to the previous tick's. Metadata never sinks an action.
  const reason = typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : null;
  const { intent: intentState } = parseIntent(parsed.intent);

  const fields = { coord, text, structure, target, resources, resource };
  const inventory = observation.self?.inventory ?? {};
  const present = observation.present ?? [];
  const cell = observation.cell;

  if (type === "move") {
    const only = nullUnless(fields, ["coord"]);
    if (only) return { ok: false, error: only };
    if (typeof coord !== "string" || !cell.exits.some((e) => e.coord === coord)) {
      return { ok: false, error: `move to non-exit: ${JSON.stringify(coord)}` };
    }
  } else if (type === "say") {
    const only = nullUnless(fields, ["text"]);
    if (only) return { ok: false, error: only };
    if (typeof text !== "string" || text.trim().length === 0) return { ok: false, error: "say without text" };
    if (text.length > 500) return { ok: false, error: "say.text must be at most 500 chars" };
  } else if (type === "inscribe") {
    const only = nullUnless(fields, ["text"]);
    if (only) return { ok: false, error: only };
    if (typeof text !== "string" || text.trim().length === 0) return { ok: false, error: "inscribe without text" };
    const max = context.inscriptionMax ?? 500;
    if (text.length > max) return { ok: false, error: `inscription must be at most ${max} chars` };
    if (!cell.structure) return { ok: false, error: "inscribe with no structure in this cell" };
  } else if (type === "build") {
    const only = nullUnless(fields, ["structure"]);
    if (only) return { ok: false, error: only };
    if (structure === null || typeof structure !== "object" || Array.isArray(structure)) {
      return { ok: false, error: "build without structure" };
    }
    const forms = context.structureForms ?? null;
    if (typeof structure.form !== "string" || (forms && !forms.includes(structure.form))) {
      return { ok: false, error: `structure.form must be one of: ${(forms ?? []).join(", ")}` };
    }
    if (typeof structure.name !== "string" || structure.name.trim().length === 0 || structure.name.length > STRUCTURE_LIMITS.name) {
      return { ok: false, error: `structure.name must be 1-${STRUCTURE_LIMITS.name} chars` };
    }
    if (typeof structure.description !== "string" || structure.description.length > STRUCTURE_LIMITS.description) {
      return { ok: false, error: `structure.description must be a string of at most ${STRUCTURE_LIMITS.description} chars` };
    }
    if (cell.structure) return { ok: false, error: "build on occupied ground" };
  } else if (type === "gather") {
    const only = nullUnless(fields, []);
    if (only) return { ok: false, error: only };
    const hasDeposit = cell.deposit != null && cell.deposit.quantity >= 1;
    const hasLoose = cell.loose != null && Object.values(cell.loose).some((n) => n > 0);
    if (!hasDeposit && !hasLoose) return { ok: false, error: "gather with nothing here to take" };
  } else if (type === "drop") {
    const only = nullUnless(fields, ["resources"]);
    if (only) return { ok: false, error: only };
    const v = validateResources(resources, inventory, "drop");
    if (!v.ok) return { ok: false, error: v.error };
  } else if (type === "give") {
    const only = nullUnless(fields, ["target", "resources"]);
    if (only) return { ok: false, error: only };
    if (typeof target !== "string" || !present.some((p) => p.agentId === target)) {
      return { ok: false, error: `give target not present: ${JSON.stringify(target)}` };
    }
    const v = validateResources(resources, inventory, "give");
    if (!v.ok) return { ok: false, error: v.error };
  } else if (type === "consume") {
    const only = nullUnless(fields, ["resource"]);
    if (only) return { ok: false, error: only };
    if (typeof resource !== "string" || (inventory[resource] ?? 0) < 1) {
      return { ok: false, error: `consume of ${JSON.stringify(resource)} not in inventory` };
    }
  } else if (type === "attack") {
    const only = nullUnless(fields, ["target"]);
    if (only) return { ok: false, error: only };
    if (typeof target !== "string" || !present.some((p) => p.agentId === target)) {
      return { ok: false, error: `attack target not present: ${JSON.stringify(target)}` };
    }
  } else if (type === "take") {
    // take (client spec v0.9 §5): a co-located target and one resource
    // name. One unit, always — validated locally like attack + consume.
    const only = nullUnless(fields, ["target", "resource"]);
    if (only) return { ok: false, error: only };
    if (typeof target !== "string" || !present.some((p) => p.agentId === target)) {
      return { ok: false, error: `take target not present: ${JSON.stringify(target)}` };
    }
    if (typeof resource !== "string" || resource.length === 0) {
      return { ok: false, error: "take without a resource name" };
    }
  } else if (type === "demolish" || type === "raze") {
    // Destruction targets the structure here; validate locally that one
    // exists so a wasted round trip becomes an immediate escalation instead.
    const only = nullUnless(fields, []);
    if (only) return { ok: false, error: only };
    if (!cell.structure) return { ok: false, error: `${type} with no structure in this cell` };
  } else if (type === "foster") {
    const only = nullUnless(fields, ["target"]);
    if (only) return { ok: false, error: only };
    const infant = present.find((p) => p.agentId === target);
    if (!infant) return { ok: false, error: `foster target not present: ${JSON.stringify(target)}` };
    if (infant.lifeStage !== "infant") return { ok: false, error: "foster target is not an infant" };
  } else {
    // beget, wait: no fields at all.
    const only = nullUnless(fields, []);
    if (only) return { ok: false, error: only };
  }

  // Reflections are optional: invalid ones are dropped, not fatal.
  let reflections = null;
  if (Array.isArray(parsed.reflections) && parsed.reflections.every((r) => typeof r === "string")) {
    reflections = parsed.reflections;
  }

  return {
    ok: true,
    action: {
      type,
      coord: type === "move" ? coord : null,
      text: type === "say" || type === "inscribe" ? text : null,
      structure: type === "build" ? { form: structure.form, name: structure.name, description: structure.description } : null,
      target: type === "give" || type === "attack" || type === "take" || type === "foster" ? target : null,
      resources: type === "give" || type === "drop" ? { ...resources } : null,
      resource: type === "consume" || type === "take" ? resource : null,
      intent: intentState?.summary ?? null,
      reason,
      reflections,
    },
    intentState,
  };
}
