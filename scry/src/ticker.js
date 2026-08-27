// The ticker (observatory spec v0.8 §5): a selective, glanceable strip of
// notable events. Pure logic here — DOM in panels/tickerbar.js — so pacing,
// recycling, phrasing, and replay sync are all testable headless.
//
// Phrasing is FLAT (§5.3). The daemon never authors motive and a ticker is
// precisely where sportscaster voice would creep in: what world state says
// happened, and nothing else. No adjectives, no drama, no inference. The
// wordlist test asserts against the same lists the client prompts use.

// §5.2: builds, inscriptions, deaths, destruction, births, gifts, attacks.
// Movement and gathering DO NOT qualify — twelve agents moving every tick is
// a firehose, and an unreadable ticker is a useless one.
const NOTABLE_TYPES = new Set(["build", "inscribe", "death", "raze", "demolish_complete", "beget", "give", "attack"]);

export const isNotable = (ev) => NOTABLE_TYPES.has(ev.type);

// Resolve a display name from reducer state; falls back to the raw id so the
// ticker never invents a name and never goes empty-handed.
function nameOf(state, agentId) {
  if (!agentId) return "someone";
  return (
    state?.agents?.get?.(agentId)?.name ??
    state?.personas?.get?.(agentId)?.name ??
    state?.departed?.get?.(agentId)?.name ??
    agentId
  );
}

function structureNameAt(state, coord) {
  return state?.cells?.get?.(coord)?.structure?.authored?.name ?? null;
}

const resourceList = (resources) =>
  Object.entries(resources ?? {})
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${r}`)
    .join(", ");

// One flat sentence per event. Anything unphraseable returns null and is
// simply not a ticker item — the ticker reports, it never improvises.
export function phrase(ev, state) {
  switch (ev.type) {
    case "build":
      return `${nameOf(state, ev.agentId)} built ${ev.structure?.name ?? ev.form} at ${ev.coord}.`;
    case "inscribe": {
      const wall = structureNameAt(state, ev.coord);
      return `${ev.authorName ?? nameOf(state, ev.agentId)} inscribed ${wall ?? `the structure at ${ev.coord}`}.`;
    }
    case "death":
      return `${ev.name ?? nameOf(state, ev.agentId)} died at ${ev.coord}.`;
    case "raze":
      return `${nameOf(state, ev.agentId)} razed ${ev.name ?? `the structure at ${ev.coord}`}.`;
    case "demolish_complete":
      return `${nameOf(state, ev.agentId)} demolished ${ev.name ?? `the structure at ${ev.coord}`}.`;
    case "beget":
      return `${nameOf(state, ev.agentId)} begot an infant at ${ev.coord}.`;
    case "give":
      return `${nameOf(state, ev.from)} gave ${resourceList(ev.resources)} to ${nameOf(state, ev.to)}.`;
    case "attack":
      return `${nameOf(state, ev.actor)} attacked ${nameOf(state, ev.target)} at ${ev.coord}.`;
    default:
      return null;
  }
}

// ---------- pacing and recycling ----------

// §5.4: cap the release rate. A tick resolving six notable events queues
// them and releases at a readable pace; the ticker is allowed to fall behind
// the world. §5.5: a quiet stretch recycles the most recent items rather
// than going blank — no filler, no "all quiet" placeholder, just the real
// last thing that happened, again.
export function createTicker({ minReleaseMs = 2500, recycleWindow = 5 } = {}) {
  const queue = [];
  const recent = []; // last released items, newest last
  let recycleIdx = 0;
  let lastReleaseAt = -Infinity;

  return {
    push(items) {
      for (const text of items) if (text) queue.push(text);
    },
    // Called on a cadence (the render loop). Returns the item to release
    // now, or null when the pace cap holds the line.
    next(nowMs) {
      if (nowMs - lastReleaseAt < minReleaseMs) return null;
      if (queue.length > 0) {
        const text = queue.shift();
        recent.push(text);
        if (recent.length > recycleWindow) recent.shift();
        recycleIdx = 0;
        lastReleaseAt = nowMs;
        return { text, recycled: false };
      }
      if (recent.length > 0) {
        const text = recent[recycleIdx % recent.length];
        recycleIdx += 1;
        lastReleaseAt = nowMs;
        return { text, recycled: true };
      }
      return null; // nothing has EVER happened — the only silent state
    },
    pending: () => queue.length,
  };
}

// ---------- replay (§5.6) ----------

// What was on the ticker around a tick: the notable events in the window
// ending at that tick, newest last. An empty window falls back to the most
// recent notable events before it — the recycle rule, applied to seeking.
export function itemsAroundTick(events, tick, state, { window = 15, max = 5 } = {}) {
  const notable = events.filter((ev) => isNotable(ev) && ev.tick != null && ev.tick <= tick);
  const inWindow = notable.filter((ev) => ev.tick > tick - window);
  const chosen = (inWindow.length > 0 ? inWindow : notable).slice(-max);
  return chosen.map((ev) => phrase(ev, state)).filter(Boolean);
}
