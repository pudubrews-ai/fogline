// Client-side identity persistence (protocol §7.4, client spec v0.2 §4). The
// SOLE exception to "hold no world state": agentId and token, nothing else.
// Without it every client crash burns a slot; with anything more the client
// is cheating. Keyed by server so pointing the same client at a second daemon
// never attempts to attach with a foreign id.

import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function fileIdentityStore(path, server = null) {
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null; // missing or corrupt — same as no identity
    }
  };
  return {
    load() {
      const parsed = read();
      if (!parsed || typeof parsed.agentId !== "string" || typeof parsed.token !== "string") return null;
      // A foreign daemon's identity is no identity at all here.
      if (server && typeof parsed.server === "string" && parsed.server !== server) return null;
      return { agentId: parsed.agentId, token: parsed.token };
    },
    save({ agentId, token }) {
      // Re-saving after attach refreshes the token but keeps the birth date.
      const prior = read();
      const registeredAt =
        prior?.agentId === agentId && typeof prior.registeredAt === "string"
          ? prior.registeredAt
          : new Date().toISOString();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ server, agentId, token, registeredAt }, null, 2) + "\n");
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}

// For tests and ephemeral runs: same contract, no disk.
export function memoryIdentityStore(initial = null) {
  let identity = initial;
  return {
    load: () => identity,
    save(next) {
      identity = { agentId: next.agentId, token: next.token };
    },
    clear() {
      identity = null;
    },
  };
}
