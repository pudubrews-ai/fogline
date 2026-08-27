// Viability panel (observatory spec §3.3): the boot arithmetic from
// /scenario.viability (live snapshot) or the run_started record (replay),
// against the LIVE population. Carrying capacity against population is the
// prominent number: when population exceeds capacity the world is spending
// down a larder and the run has a countdown — that must be legible before
// tick 180, because last time it was not.

// Pure model, tested headless. Population counts every living body —
// infants drain a sponsor's vitals, so they weigh on the same arithmetic.
export function viabilityModel(state) {
  const v = state.viability;
  if (!v) return null;
  const population = state.agents.size;
  return {
    ratio: v.ratio,
    supply: v.supply,
    demand: v.demand,
    seededSivet: v.seededSivet,
    sivetSprings: v.sivetSprings,
    regenSupply: v.regenSupply,
    capacity: v.capacity,
    population,
    overCapacity: population > v.capacity,
    optimalSurvivors: v.optimalSurvivors,
    // The behavioral tax (protocol §6.6): optimal-play survivors minus
    // actual survivors, live. The cost of being a society rather than a
    // set of efficient foragers.
    behavioralTax: v.optimalSurvivors - population,
    // v0.6: demand computes over the expected population, not slots — show
    // both — and construction slack sits beside subsistence, because a
    // world can be viable and still unable to build anything.
    expectedAgents: v.expectedAgents ?? null,
    slots: v.slots ?? null,
    constructionSlack: state.constructionSlack?.slack ?? null,
    slackDetail: state.constructionSlack ?? null,
  };
}

const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : "?");

export function renderViability(el, state) {
  el.innerHTML = "<h3>Viability</h3>";
  const m = viabilityModel(state);
  if (!m) {
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="dim">No viability record. This world booted before v0.5 computed the arithmetic.</div>`
    );
    return;
  }
  const capacityTone = m.overCapacity ? "ambiguous" : "dim";
  el.insertAdjacentHTML(
    "beforeend",
    `
    <div style="font-size:1.15em;margin-bottom:8px">
      capacity <b>${fmt(m.capacity)}</b> · population <b>${m.population}</b>
      ${m.overCapacity ? `<div class="ambiguous">population exceeds the steady-state flow — the larder is being spent down and this run has a countdown</div>` : `<div class="dim">the regeneration flow alone can hold this population</div>`}
    </div>
    <div><b>subsistence ratio ${fmt(m.ratio)}</b></div>
    <div class="dim">supply ${fmt(m.supply, 1)} = ${m.seededSivet} seeded sivet + ${m.sivetSprings} springs regenerating ${fmt(m.regenSupply, 1)} over the run</div>
    <div class="dim">demand ${fmt(m.demand, 1)} — perfect-play subsistence for ${m.expectedAgents ?? "?"} expected agents${m.slots != null ? ` (${m.slots} slots)` : ""}</div>
    ${
      m.constructionSlack != null
        ? `<div style="margin-top:6px"><b>construction slack ${fmt(m.constructionSlack)}</b></div>
           <div class="${m.constructionSlack < 1 ? "ambiguous" : "dim"}">${
             m.constructionSlack < 1
               ? "viable, but building is not affordable — the upper half of the world is starved"
               : "surplus exists to leave the springs and gather material"
           }</div>`
        : `<div class="dim" style="margin-top:6px">no construction-slack record (pre-v0.6 world)</div>`
    }
    <div style="margin-top:10px"><b>optimal-play baseline ${fmt(m.optimalSurvivors, 1)}</b> survivors</div>
    <div class="${capacityTone}">behavioral tax, live: <b>${fmt(m.behavioralTax, 1)}</b> — optimal survivors minus the ${m.population} actually alive</div>
    <div class="dim" style="margin-top:8px">Under abundance the tax is invisible. Under contested scarcity it is the whole story.</div>`
  );
}
