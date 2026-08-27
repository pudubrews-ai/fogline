// Append-only inscriptions (protocol v0.6 amendment A9, daemon spec v0.6 §9).
// An inscription is an ordered list of entries, each carrying its author's
// name and the tick it was written — attribution is IN-WORLD, a deliberate
// exception to the project's opacity: entries are speech that persists, and
// speech already names its speaker. `authorId` stays operator-side.
//
// `inscriptionMax` is a PERMANENT per-structure budget, not a per-write cap.
// There is no compaction, no eviction, and no reclamation anywhere in this
// file or elsewhere: a full wall stays full forever. That is the mechanic,
// not a leak — do not add a cleanup path.

// The blank slate every new structure gets.
export const emptyInscription = () => ({ entries: [], charactersUsed: 0 });

// Append an entry, or refuse. Refusal reports the shortfall and writes
// NOTHING — reject, never truncate, consistent with every other guard.
//
// There is deliberately NO ownership check here: anyone in the cell may
// append, including to a structure they did not build, and an agent can
// exhaust another's wall with junk. No repair, no recourse, no rate limit.
// This vandalism hole is by design (amendment A9.5) — it is the first form
// of vandalism the world offers, it requires no violence, and providing a
// defense would be providing an institution. Do not "fix" it.
export function appendEntry(world, structure, { agentId, authorName, tick, text }) {
  const inscription = structure.inscription;
  const remaining = world.inscriptionMax - inscription.charactersUsed;
  if (text.length > remaining) {
    return { ok: false, remaining };
  }
  const entry = {
    id: `e${world.nextInscriptionId++}`,
    authorId: agentId, // operator-side only; never crosses the fog boundary
    authorName,
    tick,
    text,
  };
  inscription.entries.push(entry);
  inscription.charactersUsed += text.length;
  return { ok: true, entry };
}

// The fog-side view of an entry: authorName and tick are in-world (A9.3);
// authorId and the internal entry id are not.
const entryView = (e) => ({ authorName: e.authorName, tick: e.tick, authored: { text: e.text } });

// Observation shape (A9.4): entries in order, plus the budget state. An
// agent can see a wall is nearly full before spending its last words.
export function inscriptionView(structure, inscriptionMax) {
  const inscription = structure.inscription ?? emptyInscription();
  return {
    entries: inscription.entries.map(entryView),
    charactersUsed: inscription.charactersUsed,
    charactersRemaining: Math.max(0, inscriptionMax - inscription.charactersUsed),
  };
}

// A demolition fragment preserves the entries with attribution intact.
export function fragmentView(fragment) {
  return { entries: (fragment.entries ?? []).map(entryView) };
}
