// Agent map overlay (observatory spec §8.4): the panel that makes fog
// legible. With an agent selected, the 3D grid redraws as THAT agent knows
// it — unvisited cells near-black, visited cells from the agent's snapshot,
// stale snapshots marked, and the true state of a stale cell on toggle.
// The 3D treatment is applied through ground.setOverlay + a snapshot ghost
// list; this panel is the control surface and the cell-by-cell readout.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderAgentMap(el, state, ctx) {
  const agent = state.agents.get(ctx.selectedId);
  el.innerHTML = "<h3>Agent map</h3>";
  if (!agent) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">Select an agent to redraw the grid as they know it.</div>`);
    ctx.setMapOverlay(null);
    return;
  }

  const toggle = document.createElement("label");
  toggle.innerHTML = `<input type="checkbox" ${ctx.showTruth ? "checked" : ""}/> show true state of stale cells`;
  toggle.querySelector("input").onchange = (e) => {
    ctx.showTruth = e.target.checked;
    ctx.refresh();
  };
  el.appendChild(toggle);

  const known = new Map();
  const rows = [];
  let staleCount = 0;
  for (const [coord, k] of agent.knownCells) {
    const trueCell = state.cells.get(coord);
    const snapName = k.structure?.authored?.name ?? null;
    const trueName = trueCell?.structure?.authored?.name ?? null;
    // v0.6: inscriptions are entry lists; compare their texts in order so a
    // wall appended-to since the visit reads as stale.
    const entryTexts = (s) => (s?.inscription?.entries ?? []).map((e) => e.text ?? e.authored?.text ?? "").join("\n") || null;
    const snapInscription = entryTexts(k.structure);
    const trueInscription = entryTexts(trueCell?.structure);
    const stale = snapName !== trueName || snapInscription !== trueInscription;
    if (stale) staleCount += 1;
    known.set(coord, stale ? "stale" : "known");
    rows.push({ coord, k, stale, snapName, trueName, snapInscription, trueInscription });
  }
  ctx.setMapOverlay(known);

  el.insertAdjacentHTML(
    "beforeend",
    `<div class="dim">${agent.knownCells.size} of ${state.gridSize * state.gridSize} cells ever entered · ${staleCount} stale</div>`
  );

  rows.sort((a, b) => (a.coord < b.coord ? -1 : 1));
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "row";
    const snap = r.snapName ? `${esc(r.snapName)}${r.snapInscription ? " ✎" : ""}` : "empty ground";
    let truth = "";
    if (r.stale) {
      truth = ctx.showTruth
        ? `<div class="ambiguous">actually: ${r.trueName ? esc(r.trueName) + (r.trueInscription ? " ✎" : "") : "empty ground"}</div>`
        : `<div class="ambiguous">stale</div>`;
    }
    div.innerHTML = `<span style="flex:1"><b>${r.coord}</b> <span class="dim">seen t${r.k.lastSeenTick}</span><div>${snap}</div>${truth}</span>`;
    el.appendChild(div);
  }
  el.insertAdjacentHTML(
    "beforeend",
    `<div class="dim" style="margin-top:8px">This is where you see an agent acting on a world that no longer exists.</div>`
  );
}
