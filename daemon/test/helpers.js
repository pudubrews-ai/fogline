// Test-only helpers: boot the daemon on an ephemeral port, read SSE, and
// build worlds with deterministic agent placement. These drivers are scripted
// test fixtures, not agent clients — no model, no prompts, no persona
// reasoning.

import { createDaemon } from "../server.js";
import { defaultDefinition } from "../world/definition.js";
import { createAgent, createWorld, snapshotCurrentCell } from "../world/world.js";

// ---------- personas ----------

// Body colors sit under the saturation ceiling (protocol §13.2); eye colors
// are the only saturated element and are exempt.
const BODY_COLORS = ["#8A7F74", "#6E7B84", "#7C8A76", "#8A7684", "#7F7F7F", "#948C7B"];
const EYE_COLORS = ["#FF4400", "#00CCFF", "#FFD000", "#33FF66", "#FF33AA", "#8844FF"];
let colorIdx = 0;

export function persona(name, overrides = {}) {
  const { appearance = {}, ...rest } = overrides;
  const i = colorIdx++;
  return {
    name,
    appearance: {
      bodyColor: BODY_COLORS[i % BODY_COLORS.length],
      eyeColor: EYE_COLORS[i % EYE_COLORS.length],
      scale: "medium",
      shell: "smooth",
      eyes: "pair",
      ...appearance,
    },
    disposition: "neutral",
    identity: `You are ${name}, a test fixture.`,
    discoverable: `You once calibrated a tick engine.`,
    privateObjective: `You want the tests to pass.`,
    ...rest,
  };
}

// ---------- direct world construction (unit tests) ----------

export function makeWorld({ gridSize = 4, slots = 6 } = {}) {
  return createWorld({ defaults: defaultDefinition(), gridSize, slots });
}

// Registers an agent and then pins it to a known cell — spawn is random by
// design, but unit tests need determinism. The known map is rebuilt so it
// contains exactly the pinned cell, matching a real spawn there.
export function addAgentAt(world, name, coord, overrides = {}, tick = 0) {
  const body = createAgent(world, persona(name, overrides), tick);
  body.coord = coord;
  body.knownCells.clear();
  snapshotCurrentCell(world, body, tick);
  return body;
}

// Put resources straight into a body's hands — build tests need materials.
export function grant(body, resources) {
  for (const [r, n] of Object.entries(resources)) body.inventory[r] += n;
  return body;
}

// ---------- HTTP drivers (integration tests) ----------

export async function bootDaemon(configOverrides = {}) {
  const daemon = createDaemon(
    { gridSize: 4, slots: 5, minAgents: 2, reapAfterTicks: 100, premise: "A test plot of empty ground.", ...configOverrides },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { daemon, base };
}

export async function register(base, name, extra = {}) {
  const { persona: personaOverrides, ...rest } = extra;
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: "0.2",
      persona: persona(name, personaOverrides ?? {}),
      clientName: "test-driver",
      ...rest,
    }),
  });
  return { status: res.status, body: await res.json() };
}

export async function registerRaw(base, payload) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

export async function attach(base, agentId, extra = {}) {
  const res = await fetch(`${base}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol: "0.2", agentId, clientName: "test-driver", ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

export async function act(base, token, action) {
  const res = await fetch(`${base}/agent/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      protocol: "0.2",
      type: "wait",
      coord: null,
      text: null,
      structure: null,
      intent: "idling",
      reason: "scripted",
      reflections: null,
      ...action,
    }),
  });
  return { status: res.status, body: await res.json() };
}

// Opens an SSE stream and invokes onEvent({event, data}) per event.
// Returns a handle with close().
export async function openSse(url, token, onEvent) {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: controller.signal,
  });
  if (res.status !== 200) {
    controller.abort();
    return { status: res.status, close() {} };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) onEvent({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // stream aborted or server closed — fine in tests
    }
  })();
  return { status: 200, close: () => controller.abort() };
}
