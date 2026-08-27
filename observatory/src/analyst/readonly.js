// The analyst's ONLY path to the daemon (observatory spec v0.8 §2.3):
// read-only, STRUCTURALLY. This module is the wiring that enforces it — the
// analyst's client cannot construct a request to /control, /spark, or any
// config path, because no such request is expressible here:
//
//   - every route is an entry in the frozen READ_ROUTES table below;
//   - every fetch is issued with method GET, hardcoded;
//   - parameters are URI-component-encoded, so no parameter can smuggle a
//     path segment ("../control" arrives as %2E%2E%2Fcontrol, a runId);
//   - there is no generic request(path) surface to hand a model.
//
// An analyst that can pause the world or inject a rumour is a participant,
// and given what this project measures that boundary is not a convention.
// It is enforced in this wiring, not by instructing a model.
//
// It never writes configs either: the config panel writes, the analyst
// reads, and the two do not connect (§2.3) — this module is the proof.

const READ_ROUTES = Object.freeze({
  snapshot: () => "/observatory/snapshot",
  agent: (id) => `/observatory/agent/${encodeURIComponent(String(id))}`,
  archiveIndex: () => "/observatory/archive/index",
  archiveRecord: (runId) => `/observatory/archive/${encodeURIComponent(String(runId))}`,
  crosscheckReport: (runId) => `/observatory/archive/${encodeURIComponent(String(runId))}/crosscheck`,
});

export const READONLY_KINDS = Object.freeze(Object.keys(READ_ROUTES));

export function buildReadUrl(kind, ...params) {
  const build = READ_ROUTES[kind];
  if (!build) {
    throw new Error(`analyst client: no read route "${kind}" — this client constructs no other request`);
  }
  return build(...params);
}

export function createReadonlyClient(baseUrl, fetchImpl = globalThis.fetch) {
  const base = String(baseUrl).replace(/\/$/, "");
  async function get(kind, ...params) {
    const res = await fetchImpl(`${base}${buildReadUrl(kind, ...params)}`, { method: "GET" });
    if (!res.ok) throw new Error(`analyst read ${kind}: ${res.status}`);
    return res.json();
  }
  return {
    kinds: READONLY_KINDS,
    snapshot: () => get("snapshot"),
    agent: (id) => get("agent", id),
    archiveIndex: () => get("archiveIndex"),
    archiveRecord: (runId) => get("archiveRecord", runId),
    crosscheckReport: (runId) => get("crosscheckReport", runId),
  };
}
