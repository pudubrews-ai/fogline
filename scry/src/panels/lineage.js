// Lineage (observatory spec §8.5): the family tree from lineage.edges,
// nodes as appearance thumbnails — genotype inheritance makes resemblance
// visible. Fostering is a second edge in a different style: who bore a
// child and who raised it are different facts.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

function swatch(appearance, name) {
  const body = appearance?.bodyColor ?? "#555";
  const eye = appearance?.eyeColor ?? "#888";
  return `<span class="swatch" title="${esc(name)}" style="background:${body};border-color:${eye}"></span>`;
}

export function renderLineage(el, state, ctx) {
  el.innerHTML = "<h3>Lineage</h3>";
  const edges = state.lineage.edges;
  if (edges.length === 0) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">No births yet.</div>`);
    return;
  }

  const nameOf = (id) => state.agents.get(id)?.name ?? state.departed.get(id)?.name ?? id;
  const lookOf = (id) => state.agents.get(id)?.appearance ?? state.departed.get(id)?.appearance ?? null;

  // Roots: parents that are nobody's child.
  const children = new Set(edges.map((e) => e.child));
  const roots = [...new Set(edges.map((e) => e.parent))].filter((p) => !children.has(p));

  const renderNode = (id, depth) => {
    const agent = state.agents.get(id);
    const dead = state.departed.get(id);
    const div = document.createElement("div");
    div.className = "row";
    div.style.marginLeft = `${depth * 18}px`;
    div.innerHTML = `${swatch(lookOf(id), nameOf(id))}<span>${esc(nameOf(id))}${dead?.diedAtTick != null ? ` <span class="dim">† t${dead.diedAtTick}</span>` : ""}${agent?.lifeStage === "infant" ? ` <span class="dim">infant</span>` : ""}</span>`;
    div.onclick = () => state.agents.has(id) && ctx.select(id);
    el.appendChild(div);
    for (const e of edges.filter((e) => e.parent === id)) {
      const meta = document.createElement("div");
      meta.className = "dim";
      meta.style.marginLeft = `${(depth + 1) * 18}px`;
      meta.textContent = `└ born t${e.bornAtTick}${e.inherited ? " · inherited knowledge" : ""}${e.fosteredBy ? ` · raised by ${nameOf(e.fosteredBy)}` : ""}`;
      el.appendChild(meta);
      renderNode(e.child, depth + 1);
    }
  };

  for (const root of roots) renderNode(root, 0);

  // Fostering edges called out separately — a different kind of line.
  const fostered = edges.filter((e) => e.fosteredBy);
  if (fostered.length > 0) {
    el.insertAdjacentHTML("beforeend", "<h3>Fostering</h3>");
    for (const e of fostered) {
      el.insertAdjacentHTML(
        "beforeend",
        `<div class="row">${swatch(lookOf(e.fosteredBy), nameOf(e.fosteredBy))}<span>${esc(nameOf(e.fosteredBy))} <span class="dim">raised</span> ${esc(nameOf(e.child))}</span></div>`
      );
    }
  }
}
