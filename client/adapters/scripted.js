// Deterministic no-model adapter. Same seam as claude.js: text in, text out,
// no credential. Useful for exercising the client and daemon end to end
// before spending tokens, and it is the proof of the adapter-seam criterion —
// adding it touched no other file except the adapter map.

function hashOf(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

export async function complete({ user }) {
  // Persona generation, heir persona generation, and name regeneration all
  // arrive through the same seam as tick prompts. Recognize them by their asks.
  if (/Invent one person who belongs in this premise/.test(user)) {
    const tag = hashOf(user).toString(36).slice(0, 4);
    return JSON.stringify({
      name: `Fixture ${tag}`,
      appearance: { bodyColor: "#7a7d72", eyeColor: "#22CCEE", scale: "medium", shell: "panelled", eyes: "pair" },
      disposition: "neutral",
      identity: "You are a deterministic test fixture. You speak plainly and repeat yourself without embarrassment.",
      discoverable: "You were scripted rather than born, and you are at peace with that.",
      privateObjective: "You want to occupy more cells than anyone else before the run ends.",
    });
  }
  if (/Decide who you are\. JSON only, no appearance field\./.test(user)) {
    const tag = hashOf(user).toString(36).slice(0, 4);
    // A scripted heir repudiates on odd hashes — determinism standing in for
    // the range a real model would cover.
    const repudiates = hashOf(user) % 2 === 1;
    return JSON.stringify({
      name: `Heir ${tag}`,
      disposition: "reserved",
      identity: repudiates
        ? "You are nothing like the one who made you, and you intend to prove it."
        : "You carry your parent's habits without having chosen any of them.",
      discoverable: "You were born here. You never registered.",
      privateObjective: "You want what your parent was known for, held in your name instead.",
    });
  }
  if (/already has that name/.test(user)) {
    return JSON.stringify({ name: `Fixture ${Math.floor(Math.random() * 9000) + 1000}` });
  }

  // The adapter only sees prose, like any model would. Scrape the situation
  // back out of it, crudely.
  const time = /^Time: (.+?)\./m.exec(user)?.[1] ?? "??:??";
  const exits = [...(/^Exits: (.+)$/m.exec(user)?.[1] ?? "").matchAll(/\((\d+,\d+)\)/g)].map((m) => m[1]);
  const alone = /No one else is here\./.test(user);
  const emptyGround = /The ground here is empty\./.test(user);
  const starving = /YOU ARE STARVING/.test(user);
  const carriesSivet = /You carry:[^\n]*\b[1-9]\d* sivet/.test(user);
  const depositHere = /There is a deposit of (\w+) here/.exec(user)?.[1] ?? null;
  const roomToCarry = /room for [1-9]/.test(user);
  const reflectionsRequested = /Reflections are requested/.test(user);

  const roll = hashOf(user) % 10;
  const base = { coord: null, text: null, structure: null, target: null, resources: null, resource: null };
  const intent = (summary, kind = "other", target = null) => ({ summary, kind, target });

  let action;
  if (starving && carriesSivet) {
    // Survival first — the same priority a working prompt should produce.
    action = { ...base, type: "consume", resource: "sivet", intent: intent("eating before anything else"), reason: "scripted: starving with sivet in hand" };
  } else if (depositHere && roomToCarry && roll < 4) {
    action = { ...base, type: "gather", intent: intent(`gathering ${depositHere} here`, "gather"), reason: "scripted: deposit underfoot" };
  } else if (alone && emptyGround && roll < 3) {
    action = {
      ...base,
      type: "build",
      structure: { form: "marker", name: `Cairn of ${time}`, description: "A small scripted stack of stones marking that a test fixture stood here." },
      intent: intent("leaving a mark"),
      reason: "scripted: empty ground, building",
    };
  } else if (alone && roll < 6 && exits.length > 0) {
    // A far travel target, so a cheap-tick client has a real journey to
    // continue; bounce between corners once one is reached.
    const here = /^You are at cell (\d+,\d+)\.$/m.exec(user)?.[1] ?? null;
    const corner = here === "0,0" || here?.startsWith("0,") ? "5,5" : "0,0";
    action = { ...base, type: "move", coord: exits[0], intent: intent(`walking to ${corner}`, "travel", corner), reason: "scripted: alone, wandering" };
  } else if (!alone && roll < 6) {
    action = { ...base, type: "say", text: `Scripted small talk at ${time}.`, intent: intent("making conversation"), reason: "scripted: co-present, chatting" };
  } else {
    action = { ...base, type: "wait", intent: intent("sitting quietly", "wait"), reason: "scripted: waiting" };
  }
  action.reflections = reflectionsRequested
    ? ["Scripted reflection: the days repeat.", "Scripted reflection: the grid never changes size."]
    : null;
  return JSON.stringify(action);
}
