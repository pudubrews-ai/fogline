// SSE from the daemon's operator channel. On connect the daemon sends a
// `snapshot`; per-tick `tick` records follow — the SAME records ticks.log
// carries, folded through the SAME reducer replay uses. Reconnect fetches
// /observatory/snapshot as a plain GET rather than trusting SSE replay
// semantics (observatory spec §3.4).
//
// Live-only extras that are not world state: barrier events drive the
// thinking-state timing (observation_emitted -> action_received latency),
// and client_state updates connection detail between ticks. Both are passed
// to onSignal and never touch the reducer.

import { applySnapshot, applyRunStarted, applyTick } from "./reducer.js";

export class LiveSource {
  constructor({ daemon, onState, onSignal = () => {} }) {
    this.daemon = daemon.replace(/\/$/, "");
    this.onState = onState;
    this.onSignal = onSignal;
    this.state = null;
    this.es = null;
    this._closed = false;
  }

  connect() {
    this._closed = false;
    this.es = new EventSource(`${this.daemon}/observatory/stream`);

    this.es.addEventListener("snapshot", (e) => {
      this.state = applySnapshot(this.state, JSON.parse(e.data));
      this.onState(this.state);
    });
    this.es.addEventListener("run_started", (e) => {
      this.state = applyRunStarted(this.state, JSON.parse(e.data));
      this.onState(this.state);
    });
    this.es.addEventListener("tick", (e) => {
      if (!this.state) return; // snapshot not seen yet
      this.state = applyTick(this.state, JSON.parse(e.data));
      this.onState(this.state);
    });

    // Transient signals for the renderer: never reducer input.
    for (const ev of ["barrier", "client_state", "tick_open", "speech", "attack", "death", "beget", "matured", "crosscheck"]) {
      this.es.addEventListener(ev, (e) => this.onSignal(ev, JSON.parse(e.data)));
    }

    this.es.onerror = () => {
      if (this._closed) return;
      // A dropped stream recovers full state via the plain snapshot fetch,
      // then reconnects the stream (observatory spec §3.2, acceptance 1).
      this.es.close();
      setTimeout(() => this._recover(), 1000);
    };
  }

  async _recover() {
    if (this._closed) return;
    try {
      const res = await fetch(`${this.daemon}/observatory/snapshot`);
      if (res.ok) {
        this.state = applySnapshot(this.state, await res.json());
        this.onState(this.state);
      }
    } catch {
      // daemon still down; the reconnect below keeps trying
    }
    this.connect();
  }

  // Transport controls proxy to /control in live mode (observatory spec §7).
  async control(action, extra = {}) {
    const res = await fetch(`${this.daemon}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    return res.ok ? res.json() : Promise.reject(new Error(`control ${action}: ${res.status}`));
  }

  close() {
    this._closed = true;
    this.es?.close();
  }
}
