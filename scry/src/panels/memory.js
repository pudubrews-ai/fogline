// Memory stream (observatory spec §8.3): the selected agent's memories,
// newest first, importance and type shown, reflections visually distinct,
// searchable. Virtualised by simple windowing — a thousand-tick run has a
// lot of entries.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const WINDOW = 200;

export function renderMemory(el, state, ctx) {
  const agent = state.agents.get(ctx.selectedId);
  el.innerHTML = "<h3>Memory stream</h3>";
  if (!agent) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">Select an agent.</div>`);
    return;
  }
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = `search ${agent.memories.length} memories…`;
  search.value = ctx.memoryQuery ?? "";
  search.oninput = () => {
    ctx.memoryQuery = search.value;
    ctx.refresh();
  };
  el.appendChild(search);

  const q = (ctx.memoryQuery ?? "").toLowerCase();
  const filtered = agent.memories.filter((m) => !q || (m.text ?? "").toLowerCase().includes(q) || m.type.includes(q));
  const list = document.createElement("div");
  const shown = filtered.slice(-WINDOW).reverse(); // newest first
  for (const m of shown) {
    const div = document.createElement("div");
    div.className = `memory${m.type === "reflection" ? " reflection" : ""}`;
    const who = m.type === "speech" && m.speakerName ? ` — ${esc(m.speakerName)}` : "";
    div.innerHTML = `<div class="dim">t${m.tick} ${m.simTime ?? ""} · ${m.type}${who} · imp ${m.importance}</div><div class="mono">${esc(m.text)}</div>`;
    list.appendChild(div);
  }
  if (filtered.length > WINDOW) {
    list.insertAdjacentHTML("beforeend", `<div class="dim">…${filtered.length - WINDOW} older entries (search to narrow)</div>`);
  }
  if (filtered.length === 0) list.innerHTML = `<div class="dim">nothing${q ? " matching" : " yet"}</div>`;
  el.appendChild(list);
}
