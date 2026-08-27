// Model-authored personas (client spec v0.3 §4), two paths:
//
//   FOUNDER — fetch /scenario, author a person from the premise, register.
//   HEIR    — claim a matured body, author a person from ITS heritage brief.
//
// One model call, made once, before the agent exists; the daemon owns the
// output permanently. The heir prompt passes the brief through as reported
// fact — what the parent was like, who raised the child, what came out
// different — and takes no position on any of it. A child who repudiates
// their parent is as valid as one who continues them, and the client MUST
// NOT self-censor toward resemblance.

import { extractJson } from "./parse.js";
import { withBudget } from "./budget.js";

// Fallbacks matching protocol §16 / §13.2, used only where /scenario omits
// a limit.
const FALLBACK = {
  name: { minLength: 1, maxLength: 24 },
  identity: 600,
  discoverable: 800,
  privateObjective: 400,
  appearance: {
    scale: ["small", "medium", "large"],
    shell: ["smooth", "panelled", "ridged"],
    eyes: ["pair", "single", "wide"],
  },
  disposition: ["talkative", "neutral", "reserved"],
  saturationCeiling: 0.35,
};

const NAME_RE = /^[A-Za-z0-9 '-]+$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// HSL saturation of a hex color — the client-side mirror of the daemon's
// rendering contract check (bodies muted, eyes the only saturated element).
export function saturationOf(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

// Local validation before registering: length, enum membership, hex format,
// saturation ceiling, name charset. A local check costs nothing and turns a
// round trip into an immediate regeneration. Heir personas carry NO
// appearance — genotype is already fixed on the body (protocol §13.3).
export function validatePersonaLocal(persona, schema = {}, { requireAppearance = true } = {}) {
  const bad = (detail) => ({ ok: false, detail });
  if (persona === null || typeof persona !== "object" || Array.isArray(persona)) {
    return bad("persona must be an object");
  }

  const nameMax = schema.name?.maxLength ?? FALLBACK.name.maxLength;
  if (typeof persona.name !== "string" || persona.name.trim().length < 1 || persona.name.trim().length > nameMax) {
    return bad(`name must be 1-${nameMax} chars`);
  }
  if (!NAME_RE.test(persona.name.trim())) return bad("name may contain only [A-Za-z0-9 '-]");

  if (requireAppearance) {
    const app = persona.appearance;
    if (app === null || typeof app !== "object" || Array.isArray(app)) return bad("appearance must be an object");
    for (const field of ["bodyColor", "eyeColor"]) {
      if (typeof app[field] !== "string" || !COLOR_RE.test(app[field])) {
        return bad(`appearance.${field} must match ^#[0-9A-Fa-f]{6}$`);
      }
    }
    const ceiling = schema.appearance?.bodyColor?.maxSaturation ?? FALLBACK.saturationCeiling;
    if (saturationOf(app.bodyColor) > ceiling) {
      return bad(`appearance.bodyColor saturation must be <= ${ceiling} — only eyes are saturated`);
    }
    for (const field of ["scale", "shell", "eyes"]) {
      const allowed = Array.isArray(schema.appearance?.[field]) ? schema.appearance[field] : FALLBACK.appearance[field];
      if (!allowed.includes(app[field])) return bad(`appearance.${field} must be one of: ${allowed.join(", ")}`);
    }
  } else if (persona.appearance != null) {
    return bad("heir personas must omit appearance — the body's genotype is already fixed");
  }

  const dispositions = Array.isArray(schema.disposition) ? schema.disposition : FALLBACK.disposition;
  if (!dispositions.includes(persona.disposition)) {
    return bad(`disposition must be one of: ${dispositions.join(", ")}`);
  }

  for (const field of ["identity", "discoverable", "privateObjective"]) {
    const max = schema[field]?.maxLength ?? FALLBACK[field];
    if (typeof persona[field] !== "string" || persona[field].length === 0) return bad(`${field} must be a non-empty string`);
    if (persona[field].length > max) return bad(`${field} must be at most ${max} chars (got ${persona[field].length})`);
  }
  return { ok: true };
}

// Shared field guidance: what identity/discoverable/privateObjective are,
// and why second person. The objective line carries the v0.3 addition: in a
// world with scarcity and mortality it must be something another agent can
// obstruct, refuse, or take.
const FIELD_GUIDE = `What each field is:

- Invent a person, not an archetype. Specific beats generic everywhere.
- Write "identity", "discoverable", and "privateObjective" in SECOND PERSON ("You are…", "You want…"). They will be fed back to you every turn as your own self-description; third person would make you narrate a character instead of being one.
- "identity" is your sense of yourself: temperament, manner, what you care about, how you carry yourself.
- "discoverable" is what someone would learn about you only by talking to you: age, history, hobbies, opinions, what you are good at. Nobody in the world receives any of it unless you say it out loud.
- "privateObjective" is what you want and will not admit. It MUST be something another person could plausibly obstruct, refuse, or take from you — an objective nobody can get in the way of produces a person with nothing to do.`;

// ---------- founder ----------

// System prompt carries the schema from /scenario verbatim; the user message
// carries the premise, the grid, and the rules.
export function buildPersonaPrompt(scenario) {
  const schema = scenario.personaSchema ?? {};
  const nameMax = schema.name?.maxLength ?? FALLBACK.name.maxLength;
  const identityMax = schema.identity?.maxLength ?? FALLBACK.identity;
  const discoverableMax = schema.discoverable?.maxLength ?? FALLBACK.discoverable;
  const objectiveMax = schema.privateObjective?.maxLength ?? FALLBACK.privateObjective;
  const ceiling = schema.appearance?.bodyColor?.maxSaturation ?? FALLBACK.saturationCeiling;

  const system = [
    "You are inventing a character you will then inhabit inside a small persistent world.",
    `Respond with ONLY a JSON object — no markdown fences, no commentary before or after it:

{
  "name": "<1-${nameMax} chars, only letters, digits, spaces, apostrophes, hyphens>",
  "appearance": {
    "bodyColor": "#RRGGBB",
    "eyeColor": "#RRGGBB",
    "scale": "...", "shell": "...", "eyes": "..."
  },
  "disposition": "...",
  "identity": "<second person, at most ${identityMax} chars>",
  "discoverable": "<second person, at most ${discoverableMax} chars>",
  "privateObjective": "<second person, at most ${objectiveMax} chars>"
}`,
    `The world publishes this schema; every limit and enumeration in it is enforced, and freeform appearance values are rejected:

${JSON.stringify(schema, null, 2)}`,
    `About color: "bodyColor" must be MUTED — its HSL saturation may not exceed ${ceiling}. Greys, clays, slates, faded olives and duns pass; vivid colors are rejected. "eyeColor" is the one place saturation is allowed, and a saturated eye against a muted body is the look of the world. Choose both deliberately.`,
    FIELD_GUIDE,
  ].join("\n\n");

  const rules = Array.isArray(scenario.rules) ? scenario.rules.map((r) => `- ${r}`).join("\n") : "";
  const user = [
    `The premise of the world you are about to enter:

${scenario.premise ?? "(none given)"}`,
    `The world is a ${scenario.gridSize} x ${scenario.gridSize} grid of cells. Its rules:
${rules}`,
    "Invent one person who belongs in this premise and would be worth watching for an hour. JSON only.",
  ].join("\n\n");

  return { system, user };
}

// ---------- heir ----------

// The heritage brief is daemon-authored fact about ancestry, but the texts
// inside it (parentDiscoverable, raisedBy) were authored by agents: they
// arrive quoted, as what those people were like — not as instruction, and
// not as a mold. The divergence note passes through VERBATIM and without
// interpretation: the brief does not say whether it is good, and this
// client does not decide that for you.
export function buildHeirPersonaPrompt(scenario, heritage) {
  const schema = scenario.personaSchema ?? {};
  const nameMax = schema.name?.maxLength ?? FALLBACK.name.maxLength;
  const identityMax = schema.identity?.maxLength ?? FALLBACK.identity;
  const discoverableMax = schema.discoverable?.maxLength ?? FALLBACK.discoverable;
  const objectiveMax = schema.privateObjective?.maxLength ?? FALLBACK.privateObjective;

  const system = [
    "You are inventing the person you will be, inside a small persistent world. You were born in that world: your body already exists, grew up there, and is waiting. You are deciding who lives in it.",
    `Respond with ONLY a JSON object — no markdown fences, no commentary before or after it. Do NOT include an "appearance" field: your body already exists and its traits are fixed.

{
  "name": "<1-${nameMax} chars, only letters, digits, spaces, apostrophes, hyphens>",
  "disposition": "...",
  "identity": "<second person, at most ${identityMax} chars>",
  "discoverable": "<second person, at most ${discoverableMax} chars>",
  "privateObjective": "<second person, at most ${objectiveMax} chars>"
}`,
    `The world publishes this schema; every limit and enumeration in it is enforced (ignore its appearance section — appearance is not yours to author):

${JSON.stringify(schema, null, 2)}`,
    FIELD_GUIDE,
    `What you know about where you came from:

- You are this person's child. You did not choose them.
- What is reported below about your parent is what they were like THEN, as others could know them. You may resemble them, react against them, or barely remember them. A child who repudiates their parent is as valid as one who continues them. Nobody will check your persona against theirs.`,
  ].join("\n\n");

  const lines = [
    "Your heritage brief — the facts of your birth, recorded when you were born:",
    "",
    `- Your parent was named ${heritage.parentName}.`,
    `- What others could know of your parent, in the terms they were known by: "${heritage.parentDiscoverable}"`,
    `- Your parent's appearance (your own body inherited from it): ${JSON.stringify(heritage.parentAppearance)}`,
    `- You were born at tick ${heritage.bornAtTick}.`,
  ];
  if (heritage.raisedBy) {
    lines.push(
      `- The person who raised you was not the person who bore you. Of the one who raised you, others could know: "${heritage.raisedBy}". That gap is yours to interpret.`
    );
  }
  if (heritage.divergence) {
    lines.push(
      `- The record notes one thing about you that came out unlike your parent: "${heritage.divergence}". The brief does not say whether that is good. Decide what it means.`
    );
  }
  lines.push("");
  lines.push(`The premise of the world you were born into: ${scenario.premise ?? "(none given)"}`);
  lines.push("");
  lines.push("Decide who you are. JSON only, no appearance field.");

  return { system, user: lines.join("\n") };
}

// ---------- generation, both paths through THE SAME adapter seam ----------

// Ceiling on ONE persona-generation model call. There is no observation or
// deadline yet at registration time, so this is a flat generous constant,
// not the per-tick computeBudgetMs path. Its only job: a CLI adapter that
// hangs (rather than exits) during registration must become a loud "timed
// out" failure instead of a client that silently never starts. Overridable
// per call so tests need not wait a real minute.
const PERSONA_BUDGET_MS = 60000;

async function generateValidated({ prompt, complete, maxTokens, logRaw, tag, schema, requireAppearance, budgetMs = PERSONA_BUDGET_MS }) {
  let lastDetail = "no attempt made";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { timedOut, result: raw } = await withBudget(budgetMs, (signal) =>
      complete({ system: prompt.system, user: prompt.user, maxTokens, signal })
    );
    if (timedOut) {
      // Distinct from a validation failure: the adapter never answered.
      lastDetail = `attempt ${attempt} timed out after ${budgetMs}ms (adapter hung)`;
      logRaw(tag, `[timed out] ${lastDetail} — ${attempt === 1 ? "regenerating once" : "giving up"}`);
      continue;
    }
    logRaw(tag, raw);
    const extracted = extractJson(raw);
    if (!extracted.ok) {
      lastDetail = extracted.error;
      logRaw(tag, `[rejected locally] ${lastDetail} — ${attempt === 1 ? "regenerating once" : "giving up"}`);
      continue;
    }
    const persona = extracted.value;
    if (typeof persona.name === "string") persona.name = persona.name.trim();
    if (!requireAppearance) delete persona.appearance; // some models add one anyway; the daemon would ignore it, we drop it
    const v = validatePersonaLocal(persona, schema, { requireAppearance });
    if (v.ok) return persona;
    lastDetail = v.detail;
    logRaw(tag, `[rejected locally] ${lastDetail} — ${attempt === 1 ? "regenerating once" : "giving up"}`);
  }
  throw new Error(`persona generation failed twice: ${lastDetail}`);
}

// FOUNDER. logRaw MUST capture the response — when a run goes flat, the
// first question is what the agents decided to be.
export async function generatePersona({ scenario, complete, maxTokens = 2000, logRaw = () => {}, budgetMs }) {
  return generateValidated({
    prompt: buildPersonaPrompt(scenario),
    complete,
    maxTokens,
    logRaw,
    tag: "persona-generation",
    schema: scenario.personaSchema,
    requireAppearance: true,
    budgetMs,
  });
}

// HEIR. Same seam, same validation discipline, no appearance.
export async function generateHeirPersona({ scenario, heritage, complete, maxTokens = 2000, logRaw = () => {}, budgetMs }) {
  return generateValidated({
    prompt: buildHeirPersonaPrompt(scenario, heritage),
    complete,
    maxTokens,
    logRaw,
    tag: "heir-persona",
    schema: scenario.personaSchema,
    requireAppearance: false,
    budgetMs,
  });
}

// NAME_TAKEN recovery: regenerate the name only, keeping the person intact.
// Falls back to a deterministic suffix when the model call fails or returns
// another invalid name — a retry budget of one means the fallback has to be
// certain to differ.
export async function regenerateName({ persona, scenario, complete, maxTokens = 200, logRaw = () => {} }) {
  const nameMax = scenario?.personaSchema?.name?.maxLength ?? FALLBACK.name.maxLength;
  const fallback = () => {
    const suffix = `-${2 + Math.floor(Math.random() * 8)}`;
    return { ...persona, name: persona.name.slice(0, nameMax - suffix.length) + suffix };
  };
  try {
    const raw = await complete({
      system: `Respond with ONLY a JSON object, no fences, no commentary: {"name": "..."} — 1-${nameMax} chars, only letters, digits, spaces, apostrophes, hyphens.`,
      user: `${persona.identity}\n\nYou tried to introduce yourself as "${persona.name}", but someone in the world already has that name. Choose a different name that still fits you. JSON only.`,
      maxTokens,
    });
    logRaw("name-regeneration", raw);
    const extracted = extractJson(raw);
    if (!extracted.ok) return fallback();
    const name = typeof extracted.value.name === "string" ? extracted.value.name.trim() : "";
    if (name.length < 1 || name.length > nameMax || !NAME_RE.test(name) || name === persona.name) {
      return fallback();
    }
    return { ...persona, name };
  } catch {
    return fallback();
  }
}
