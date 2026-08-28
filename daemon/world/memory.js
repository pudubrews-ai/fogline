// Memory streams, deterministic importance, keyword retrieval.
// There is no model call anywhere in this file, and there never will be:
// importance is a fixed table (daemon spec §5), relevance is word overlap.

export const IMPORTANCE = {
  CELL_CHANGE: 2, // moved to (or spawned in) a cell
  PRESENCE_CHANGE: 4, // someone arrived or left
  SPEECH_HEARD: 5,
  SPEECH_SPOKEN: 4, // by self
  BUILD_OWN: 5, // you built something (own stream only — builds are silent)
  REFLECTION: 7,
  INSCRIPTION_READ: 6, // first reading of durable text (daemon spec §7)
  GIFT_RECEIVED: 5, // someone put resources in your hands
  BIRTH_WITNESS: 5, // an infant appeared in your cell
  ATTACK_WITNESS: 7, // violence seen from inside the cell
  DEATH_WITNESS: 8, // a death seen from inside the cell
  DESTRUCTION_WITNESS: 7, // a structure destroyed before your eyes — no actor named
};

const STOPWORDS = new Set(
  ("a an the and or but if then is are was were be been being am i you he she it we they " +
    "me him her us them my your his its our their this that these those to of in on at by " +
    "for with from as into about not no so do does did have has had will would can could " +
    "should just now here there what who when where why how").split(" ")
);

export const nameOf = (body) => body.persona?.name ?? "an unnamed infant";

export function tokenize(text) {
  const out = new Set();
  for (const word of String(text ?? "").toLowerCase().split(/[^a-z0-9']+/)) {
    if (word && !STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

export function addMemory(world, body, { tick, simTime, type, text, importance, speaker = null, speakerName = null, source = null, author = null }) {
  const entry = {
    id: `m${world.nextMemoryId++}`,
    tick,
    simTime,
    type, // "observation" | "speech" | "reflection" | "inscription"
    text,
    importance, // 1-10
    lastAccessedTick: tick,
    speaker, // speech only: agentId of the speaker
    speakerName, // speech only: display name
    source, // inscription only: the structure's authored name
    author, // inscription only: the entry's authorName — in-world (v0.6 A9.3)
  };
  body.memories.push(entry);
  body.importanceSinceLastReflection += importance;
  // Operator-side replay material: every write of the tick, drained into the
  // resolved-tick record by the engine. Never crosses the fog boundary.
  world.memoryLog?.push({ agentId: body.id, ...entry });
  return entry;
}

// How a memory reads when surfaced in `recalled`. Speech and inscriptions
// are agent-authored: the framing marks them as reported, never the world's
// own voice.
export function displayText(entry, selfId) {
  if (entry.type === "speech") {
    return entry.speaker === selfId
      ? `You said: "${entry.text}"`
      : `${entry.speakerName} said: "${entry.text}"`;
  }
  if (entry.type === "inscription") {
    // Entries carry their author's name in-world (v0.6 A9.3) — still
    // reported content, never the world's own voice.
    return entry.author
      ? `${entry.author} wrote on "${entry.source}": "${entry.text}"`
      : `The inscription on "${entry.source}" reads: "${entry.text}"`;
  }
  return entry.text;
}

export function scoreMemory(entry, queryTokens, currentTick) {
  const recency = Math.pow(0.99, currentTick - entry.lastAccessedTick);
  const importanceNorm = entry.importance / 10;
  const memText = entry.type === "speech" ? `${entry.speakerName ?? ""} ${entry.text}` : entry.text;
  const memTokens = tokenize(memText);
  let intersection = 0;
  for (const t of memTokens) if (queryTokens.has(t)) intersection += 1;
  const unionSize = memTokens.size + queryTokens.size - intersection;
  const relevance = unionSize === 0 ? 0 : intersection / unionSize;
  return recency + importanceNorm + relevance;
}

export function retrieve(body, queryText, currentTick, k, { excludeIds = new Set() } = {}) {
  const queryTokens = tokenize(queryText);
  const scored = [];
  for (const entry of body.memories) {
    if (excludeIds.has(entry.id)) continue;
    scored.push({ entry, score: scoreMemory(entry, queryTokens, currentTick) });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.tick - a.entry.tick);
  const top = scored.slice(0, k).map((s) => s.entry);
  // Load-bearing for continuity: recently-recalled memories stay recallable.
  for (const entry of top) entry.lastAccessedTick = currentTick;
  return top;
}

// Write path 1 of 3: perception, at tick OPEN. Write on change, not on state.
// Structures are deliberately NOT written into perception memories: the agent
// perceives its own cell live via the observation's `cell`, and keeping
// agent-authored structure text out of world-authored memory lines keeps
// provenance clean (protocol §5.3).
export function writePerceptions(world, tick, simTime) {
  for (const body of world.agents.values()) {
    const present = [];
    for (const other of world.agents.values()) {
      if (other !== body && other.coord === body.coord) present.push(other);
    }
    const presentIds = new Set(present.map((p) => p.id));
    const prev = body.lastPerceived;

    if (prev.coord === null) {
      // First tick here: spawn cell and initial co-presence count as changes.
      addMemory(world, body, { tick, simTime, type: "observation", text: `You are at ${body.coord}.`, importance: IMPORTANCE.CELL_CHANGE });
      for (const p of present) {
        addMemory(world, body, { tick, simTime, type: "observation", text: `${nameOf(p)} is here.`, importance: IMPORTANCE.PRESENCE_CHANGE });
      }
    } else if (prev.coord !== body.coord) {
      addMemory(world, body, { tick, simTime, type: "observation", text: `You moved to ${body.coord}.`, importance: IMPORTANCE.CELL_CHANGE });
      for (const p of present) {
        addMemory(world, body, { tick, simTime, type: "observation", text: `${nameOf(p)} is here.`, importance: IMPORTANCE.PRESENCE_CHANGE });
      }
    } else {
      for (const p of present) {
        if (!prev.present.has(p.id)) {
          addMemory(world, body, { tick, simTime, type: "observation", text: `${nameOf(p)} arrived.`, importance: IMPORTANCE.PRESENCE_CHANGE });
        }
      }
      for (const goneId of prev.present) {
        if (!presentIds.has(goneId)) {
          // The departed body may itself be gone (released/reaped); the world
          // still remembers the departure, just without a name to hang on it.
          const gone = world.agents.get(goneId);
          const name = gone ? nameOf(gone) : "Someone";
          addMemory(world, body, { tick, simTime, type: "observation", text: `${name} left.`, importance: IMPORTANCE.PRESENCE_CHANGE });
        }
      }
    }
    body.lastPerceived = { coord: body.coord, present: presentIds };

    // Reading is automatic, once per ENTRY per agent (v0.6 A9.4): each
    // unread entry on the structure here writes one memory, then never
    // again. Entry identity survives demolition, so an entry read on the
    // wall is not re-read from the fragment. Infants do not read.
    if (body.lifeStage !== "infant") {
      const cell = world.cells.get(body.coord);
      const readEntries = (entries, source) => {
        for (const entry of entries) {
          if (body.readInscriptions.has(entry.id)) continue;
          body.readInscriptions.add(entry.id);
          body.firstReadTick = tick;
          addMemory(world, body, {
            tick,
            simTime,
            type: "inscription",
            text: entry.text,
            source,
            author: entry.authorName,
            importance: IMPORTANCE.INSCRIPTION_READ,
          });
        }
      };
      if (cell.structure) {
        readEntries(cell.structure.inscription?.entries ?? [], cell.structure.authored.name);
      }
      // A demolition fragment (protocol §9.1) reads the same way. The pile
      // it rides is the world's byproduct, named by the definition.
      if (cell.fragment) {
        readEntries(cell.fragment.entries ?? [], `a broken fragment in the ${world.byproduct?.name ?? "debris"}`);
      }
    }
  }
}
