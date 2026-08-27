// Inscription history panel (observatory spec v0.6 §3). Inscriptions are
// append-only as of v0.6, so this shows an entry list, not a version
// history: every entry in order with tick and author, coloured by author so
// a multi-author wall is legible at a glance, plus characters used against
// the permanent budget — a full wall can never be written on again, and
// that is marked. Run 7's ninety-seven-times-rewritten ledger was visible
// only by grepping a log file; this panel is why that never happens again.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

// A stable tint per author, so authorship reads as colour before it reads
// as text. Presentation only.
export function authorTint(author) {
  let hash = 0;
  for (const ch of String(author ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 55%, 62%)`;
}

// Pure model, tested headless: the wall at `coord` as the panel shows it.
export function inscriptionModel(state, coord) {
  const cell = state.cells.get(coord);
  const structure = cell?.structure;
  if (!structure) return null;
  const entries = structure.inscription?.entries ?? [];
  const used = structure.inscription?.charactersUsed ?? 0;
  const max = state.inscriptionMax ?? null;
  return {
    coord,
    name: structure.authored?.name ?? null,
    form: structure.form ?? null,
    entries: entries.map((e) => ({
      authorName: e.authorName ?? null,
      tick: e.tick ?? null,
      text: e.text ?? e.authored?.text ?? "",
      tint: authorTint(e.authorName),
    })),
    authors: [...new Set(entries.map((e) => e.authorName ?? "?"))],
    charactersUsed: used,
    inscriptionMax: max,
    charactersRemaining: max != null ? Math.max(0, max - used) : null,
    exhausted: max != null && used >= max,
  };
}

// Every structure carrying writing, for the panel's own selector.
export function inscribedStructures(state) {
  const out = [];
  for (const cell of state.cells.values()) {
    if (cell.structure) {
      out.push({
        coord: cell.coord,
        name: cell.structure.authored?.name ?? "?",
        entries: cell.structure.inscription?.entries?.length ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.entries - a.entries || (a.coord < b.coord ? -1 : 1));
}

export function renderInscriptions(el, state, ctx) {
  el.innerHTML = "<h3>Inscriptions</h3>";
  const structures = inscribedStructures(state);
  if (structures.length === 0) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">Nothing is built, so nothing is written.</div>`);
    return;
  }

  const select = document.createElement("select");
  select.style.cssText =
    "background:#131211;color:var(--panel-fg);border:1px solid var(--panel-line);border-radius:3px;font:inherit;padding:2px;max-width:100%;margin-bottom:8px";
  for (const s of structures) {
    const o = document.createElement("option");
    o.value = s.coord;
    o.textContent = `“${s.name}” at ${s.coord} · ${s.entries} ${s.entries === 1 ? "entry" : "entries"}`;
    if (s.coord === ctx.inscriptionCoord) o.selected = true;
    select.appendChild(o);
  }
  if (!structures.some((s) => s.coord === ctx.inscriptionCoord)) ctx.inscriptionCoord = structures[0].coord;
  select.onchange = () => {
    ctx.inscriptionCoord = select.value;
    ctx.refresh();
  };
  el.appendChild(select);

  const m = inscriptionModel(state, ctx.inscriptionCoord);
  if (!m) return;

  const budget =
    m.inscriptionMax != null
      ? `${m.charactersUsed} of ${m.inscriptionMax} characters used, permanently${
          m.exhausted ? ` — <span class="ambiguous">FULL: this wall can never be written on again</span>` : ` · ${m.charactersRemaining} remain`
        }`
      : `${m.charactersUsed} characters used (no budget on record — pre-v0.6 world)`;
  el.insertAdjacentHTML(
    "beforeend",
    `<div><b>${esc(m.name)}</b> <span class="dim">(${esc(m.form)} at ${m.coord})</span></div>
     <div class="${m.exhausted ? "" : "dim"}" style="margin:4px 0 8px">${budget}</div>
     ${
       m.inscriptionMax != null
         ? `<div style="height:6px;border:1px solid var(--panel-line);border-radius:3px;overflow:hidden;margin-bottom:10px">
              <div style="height:100%;width:${Math.min(100, (m.charactersUsed / m.inscriptionMax) * 100)}%;background:${m.exhausted ? "#c0574a" : "var(--accent)"}"></div>
            </div>`
         : ""
     }`
  );

  if (m.entries.length === 0) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">A blank wall. Anyone standing there may write on it.</div>`);
    return;
  }
  for (const [i, e] of m.entries.entries()) {
    const div = document.createElement("div");
    div.className = "row inscription-entry";
    div.style.borderLeft = `3px solid ${e.tint}`;
    div.style.paddingLeft = "6px";
    div.innerHTML = `<span style="flex:1">
        <div class="dim">#${i + 1} · <span style="color:${e.tint}">${esc(e.authorName ?? "an unnamed hand")}</span> · t${e.tick}</div>
        <div class="mono">${esc(e.text)}</div>
      </span>`;
    el.appendChild(div);
  }
  el.insertAdjacentHTML(
    "beforeend",
    `<div class="dim" style="margin-top:8px">Entries are append-only: nothing here was ever edited, and nothing can be. Only raze removes them.</div>`
  );
}
