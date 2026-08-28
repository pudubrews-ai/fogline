// Cell hover (scry spec v0.9 §3). Hovering a grid cell shows what is in it —
// minimum the coordinate, in full everything the reducer already holds:
// deposit and quantity, loose pile, structure name and form, inscription
// entry count and budget state, fragment, corpses, agents present. Cheap by
// construction: a read of current reducer state, no computation, no fetch.
//
// §3.1: with a per-agent map overlay active, hover shows what THAT AGENT
// believes is there — the snapshot from when they last stood in the cell,
// marked stale where the world has moved on. The true state stays on the
// existing toggle. Both, never merged.

const list = (resources) =>
  Object.entries(resources ?? {})
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${r}`)
    .join(", ");

// The true state of a cell, one line per fact, coordinate first. An empty
// cell renders its coordinate alone.
export function cellHoverLines(state, coord) {
  const lines = [coord];
  const cell = state.cells.get(coord);
  if (!cell) return lines;
  if (cell.deposit && cell.deposit.quantity >= 1) {
    lines.push(`${cell.deposit.resource} deposit — ${cell.deposit.quantity}`);
  }
  const loose = list(cell.loose);
  if (loose) lines.push(`loose: ${loose}`);
  if (cell.structure) {
    const s = cell.structure;
    const entries = s.inscription?.entries?.length ?? 0;
    const used = s.inscription?.charactersUsed ?? 0;
    const max = state.inscriptionMax;
    const budget =
      entries > 0 || used > 0
        ? max != null
          ? used >= max
            ? `, ${entries} inscription${entries === 1 ? "" : "s"}, budget full`
            : `, ${entries} inscription${entries === 1 ? "" : "s"}, ${max - used} chars left`
          : `, ${entries} inscription${entries === 1 ? "" : "s"}`
        : "";
    lines.push(`${s.form ?? "structure"} "${s.authored?.name ?? ""}"${budget}`);
  }
  if (cell.fragment) {
    const n = cell.fragment.entries?.length ?? 0;
    lines.push(`fragment — ${n} surviving entr${n === 1 ? "y" : "ies"}`);
  }
  if (cell.corpses?.length > 0) {
    const named = cell.corpses.map((c) => c.authored?.name ?? "an unnamed body").join(", ");
    lines.push(`corpse${cell.corpses.length === 1 ? "" : "s"}: ${named}`);
  }
  const present = [...state.agents.values()].filter((a) => a.coord === coord).map((a) => a.name ?? a.agentId);
  if (present.length > 0) lines.push(`here: ${present.join(", ")}`);
  return lines;
}

// The believed state under an agent-map overlay: the snapshot, its tick,
// marked stale when the snapshot no longer matches the true cell. Never
// merged with truth — the true state stays on the existing toggle.
export function believedHoverLines(state, coord, agentId) {
  const agent = state.agents.get(agentId);
  const name = agent?.name ?? agentId;
  const lines = [coord];
  const known = agent?.knownCells?.get?.(coord);
  if (!known) {
    lines.push(`${name} has never stood here.`);
    return lines;
  }
  const t = known.lastSeenTick;
  const facts = [];
  if (known.deposit && known.deposit.quantity >= 1) {
    facts.push(`${name} last saw a ${known.deposit.resource} deposit here (${known.deposit.quantity}) at tick ${t}.`);
  }
  const loose = list(known.loose);
  if (loose) facts.push(`${name} last saw ${loose} loose here at tick ${t}.`);
  if (known.structure) {
    facts.push(`${name} last saw ${known.structure.form ?? "a structure"} "${known.structure.authored?.name ?? ""}" here at tick ${t}.`);
  }
  if (facts.length === 0) facts.push(`${name} last saw empty ground here at tick ${t}.`);
  lines.push(...facts);

  // Stale: the belief no longer matches the world. Compared on the same
  // facts the snapshot holds — structure identity/inscriptions, deposit,
  // loose — so an appended-to wall reads stale exactly as the map panel says.
  const cell = state.cells.get(coord);
  const entryTexts = (s) => (s?.inscription?.entries ?? []).map((e) => e.text ?? e.authored?.text ?? "").join("\n") || null;
  const depositSig = (d) => (d && d.quantity >= 1 ? `${d.resource}:${d.quantity}` : null);
  const stale =
    (known.structure?.authored?.name ?? null) !== (cell?.structure?.authored?.name ?? null) ||
    entryTexts(known.structure) !== entryTexts(cell?.structure) ||
    depositSig(known.deposit) !== depositSig(cell?.deposit) ||
    (list(known.loose) || null) !== (list(cell?.loose) || null);
  if (stale) lines.push("(stale — the world has changed since)");
  return lines;
}
