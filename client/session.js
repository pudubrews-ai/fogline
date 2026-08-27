// Register/attach/claim, SSE stream, act, leave (protocol v0.3 §13, §14).
// Holds the token, the server URL, and which tick it last decided — session
// bookkeeping only. World state (position, memory, map, persona) is never
// stored; everything needed to act arrives in each observation. The sole
// persistence is the identity store: agentId and token.
//
// Attach semantics (v0.3 amendment): attach is CLAIM-ONLY by default — a
// body with a live client answers NOT_ATTACHABLE, which is a normal, pollable
// condition, not an error. Displacing a live client is deliberate and takes
// `takeover: true`; the identity-file reconnect path sends it, because
// reconnecting to your own body after a crash IS a takeover of whatever
// stream state the daemon still holds.

const PROTOCOL = "0.4";

export class Session {
  constructor({ server, persona, personaProvider, clientName, modelHint, surface = null, decide, identityStore, log = console.error }) {
    this.server = server.replace(/\/$/, "");
    this.persona = persona; // supplied ONCE, at registration; the world owns it after
    // Optional hooks for the model-authored persona path (client spec v0.2 §5):
    //   create()                 -> persona, when none was supplied
    //   renameOnCollision(p)     -> persona with a new name, on NAME_TAKEN
    //   regenerate(detail)       -> fresh persona, once, on INVALID_PERSONA
    this.personaProvider = personaProvider ?? null;
    this.clientName = clientName;
    this.modelHint = modelHint;
    // Billing surface (protocol §15.3): vendor + 4-hex account fingerprint,
    // never a credential. Rides register/attach; operator-visible only.
    this.surface = surface;
    this.decide = decide; // async (observation) -> decision fields
    this.identityStore = identityStore;
    this.log = log;
    this.agentId = null;
    this.token = null;
    this.stopped = false;
    this.stopReason = null;
    this._streamController = null;
    this._lastDecidedTick = 0; // reconnect replays the current observation; don't decide twice
    this._decideInFlight = false; // at most one decide+act chain runs at a time
    this._pendingObs = null; // newest observation that arrived while a decide was in flight
  }

  async _post(path, body) {
    const res = await fetch(`${this.server}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  }

  // Attach before register: a persisted identity means this body may already
  // exist. Register is for a genuinely fresh agent. The reconnect sends
  // takeover: true — it is OUR body and we mean to displace whatever client
  // record the daemon still holds for it. NOT_ATTACHABLE here is normal
  // (the daemon still counts the old connection as live); the caller keeps
  // polling rather than treating it as fatal.
  async connect() {
    const persisted = this.identityStore.load();
    if (persisted) {
      const { ok, body } = await this._post("/attach", {
        protocol: PROTOCOL,
        agentId: persisted.agentId,
        takeover: true,
        clientName: this.clientName,
        modelHint: this.modelHint,
        surface: this.surface,
      });
      if (ok) {
        this.agentId = persisted.agentId;
        this.token = body.token;
        this.identityStore.save({ agentId: this.agentId, token: this.token });
        return { mode: "attach", agentId: this.agentId };
      }
      if (body.error === "SLOT_RECLAIMED" || body.error === "NO_SUCH_AGENT") {
        // The body is gone (reaped, released, dead, or a reset world).
        // Discard the identity and walk in fresh.
        this.log(`attach: ${body.error} — discarding persisted identity, registering fresh`);
        this.identityStore.clear();
      } else {
        // NOT_ATTACHABLE and everything else ride out on the coded error;
        // the caller decides whether to poll (NOT_ATTACHABLE) or stop.
        throw this._codedError("attach", body);
      }
    }
    return this._register();
  }

  // Claim a matured, unmanned body from /scenario.attachable (protocol
  // §13.3). Claim-only: no takeover flag — losing the race to another client
  // answers NOT_ATTACHABLE and the caller keeps polling. The persona MUST be
  // authored from the body's heritage brief and MUST omit appearance;
  // genotype is already fixed on the body.
  async claim(agentId, { nameRetried = false, personaRetried = false } = {}) {
    if (!this.persona) {
      if (!this.personaProvider?.create) throw new Error("no persona to claim with");
      this.persona = await this.personaProvider.create();
    }
    const { ok, body } = await this._post("/attach", {
      protocol: PROTOCOL,
      agentId,
      persona: this.persona,
      clientName: this.clientName,
      modelHint: this.modelHint,
      surface: this.surface,
    });
    if (!ok) {
      if (body.error === "NAME_TAKEN" && !nameRetried) {
        this.persona = this.personaProvider?.renameOnCollision
          ? await this.personaProvider.renameOnCollision(this.persona)
          : this._suffixName(this.persona);
        this.log(`claim: NAME_TAKEN — retrying once as ${this.persona.name}`);
        return this.claim(agentId, { nameRetried: true, personaRetried });
      }
      if (body.error === "INVALID_PERSONA" && !personaRetried && this.personaProvider?.regenerate) {
        this.log(`claim: INVALID_PERSONA (${body.detail ?? "?"}) — regenerating once`);
        this.persona = await this.personaProvider.regenerate(body.detail ?? null);
        return this.claim(agentId, { nameRetried, personaRetried: true });
      }
      // NOT_ATTACHABLE (lost the race, or the body matured out from under
      // the list) is normal: the caller re-polls /scenario.
      throw this._codedError("claim", body);
    }
    this.agentId = agentId;
    this.token = body.token;
    this.identityStore.save({ agentId: this.agentId, token: this.token });
    return { mode: "claim", agentId, name: this.persona.name };
  }

  async _register({ nameRetried = false, personaRetried = false } = {}) {
    if (!this.persona) {
      if (!this.personaProvider?.create) throw new Error("no persisted identity and no persona to register with");
      // The birth (client spec v0.2 §1): the model authors its own persona.
      this.persona = await this.personaProvider.create();
    }
    const { ok, body } = await this._post("/register", {
      protocol: PROTOCOL,
      persona: this.persona,
      clientName: this.clientName,
      modelHint: this.modelHint,
      surface: this.surface,
    });
    if (!ok) {
      if (body.error === "NAME_TAKEN" && !nameRetried) {
        // Regenerate the name only and retry once (client spec §9). Without a
        // provider: suffix a digit, keeping inside the 24-char name contract.
        this.persona = this.personaProvider?.renameOnCollision
          ? await this.personaProvider.renameOnCollision(this.persona)
          : this._suffixName(this.persona);
        this.log(`register: NAME_TAKEN — retrying once as ${this.persona.name}`);
        return this._register({ nameRetried: true, personaRetried });
      }
      if (body.error === "INVALID_PERSONA" && !personaRetried && this.personaProvider?.regenerate) {
        // Log the violation, regenerate once, then exit (client spec §9).
        this.log(`register: INVALID_PERSONA (${body.detail ?? "?"}) — regenerating once`);
        this.persona = await this.personaProvider.regenerate(body.detail ?? null);
        return this._register({ nameRetried, personaRetried: true });
      }
      // WORLD_FULL, VERSION_UNSUPPORTED, second failures: stop and say why.
      throw this._codedError("register", body);
    }
    this.agentId = body.agentId;
    this.token = body.token;
    this.identityStore.save({ agentId: this.agentId, token: this.token });
    return { mode: "register", agentId: this.agentId, spawnCell: body.spawnCell, name: this.persona.name };
  }

  _suffixName(persona) {
    const suffix = `-${2 + Math.floor(Math.random() * 8)}`;
    return { ...persona, name: persona.name.slice(0, 24 - suffix.length) + suffix };
  }

  // Protocol error codes ride on the Error so callers can branch on them
  // (WORLD_FULL polling, SLOT_RECLAIMED cleanup) without string matching.
  _codedError(phase, body) {
    const err = new Error(`${phase} failed: ${body.error ?? "unknown"}${body.detail ? ` (${body.detail})` : ""}`);
    err.code = body.error ?? null;
    return err;
  }

  // Runs until leave() or a fatal error (BAD_TOKEN). Reconnects the SSE
  // stream on drop with the same token — never re-attaches to recover a
  // stream; a re-attach is a takeover and would invalidate a token that is
  // still fine.
  async run() {
    let backoffMs = 500;
    while (!this.stopped) {
      this._streamController = new AbortController();
      let res;
      try {
        res = await fetch(`${this.server}/agent/stream`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: this._streamController.signal,
        });
      } catch {
        res = null; // connection refused / aborted
      }
      if (this.stopped) break;
      if (res && res.status === 403) {
        this._fatal("BAD_TOKEN", "token invalid or superseded by takeover — exiting, not re-attaching");
        break;
      }
      if (res && res.status === 200) {
        backoffMs = 500;
        await this._readStream(res);
        if (this.stopped) break;
        this.log(`[${this.agentId}] stream dropped; reconnecting with same token`);
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 5000);
    }
    return this.stopReason;
  }

  async _readStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
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
          if (!data) continue;
          if (event === "observation") this._onObservation(JSON.parse(data));
          // tick_closed needs no handling: an early close is normal (§8).
        }
      }
    } catch {
      // aborted or dropped — run() decides whether to reconnect
    }
  }

  _onObservation(obs) {
    if (obs.tick <= this._lastDecidedTick) return; // replay after reconnect
    this._lastDecidedTick = obs.tick;
    // At most one decide+act in flight (slow subprocess adapters take longer
    // than a tick). While one runs, keep only the NEWEST observation; each
    // one it displaces is logged, not silently dropped. Latest wins: acting
    // on a stale tick would only earn WRONG_TICK/TICK_CLOSED from the daemon.
    if (this._decideInFlight) {
      if (this._pendingObs) {
        this.log(`[${this.agentId}] tick ${this._pendingObs.tick}: superseded by tick ${obs.tick} — decide skipped`);
      }
      this._pendingObs = obs;
      return;
    }
    // Fire and forget: never block the stream reader on a model call.
    this._runDecideChain(obs);
  }

  // Drains observations one decide at a time. Never awaited by the stream
  // reader; the in-flight flag is set synchronously so no second chain can
  // start before the first await.
  async _runDecideChain(obs) {
    this._decideInFlight = true;
    try {
      while (obs) {
        try {
          await this._decideAndAct(obs);
        } catch (err) {
          this.log(`[${this.agentId}] tick ${obs.tick}: decide failed: ${err.message}`);
        }
        if (this.stopped) break;
        obs = this._pendingObs;
        this._pendingObs = null;
      }
    } finally {
      this._decideInFlight = false;
    }
  }

  async _decideAndAct(obs) {
    const decision = await this.decide(obs);
    if (this.stopped || !decision) return;
    await this.act({ protocol: PROTOCOL, tick: obs.tick, ...decision });
  }

  async act(action) {
    const res = await fetch(`${this.server}/agent/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(action),
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => ({}));
    switch (body.error) {
      case "WRONG_TICK":
      case "TICK_CLOSED":
        this.log(`[${this.agentId}] tick ${action.tick}: ${body.error} — discarded`);
        return false;
      case "ALREADY_ACTED":
        this.log(`[${this.agentId}] tick ${action.tick}: ALREADY_ACTED — client bug, discarded`);
        return false;
      case "INVALID_ACTION":
        this.log(
          `[${this.agentId}] tick ${action.tick}: INVALID_ACTION (${body.detail ?? "?"}) — rejected payload: ${JSON.stringify(action)}`
        );
        return false;
      case "BAD_TOKEN":
        this._fatal("BAD_TOKEN", "token superseded — exiting, not re-attaching");
        return false;
      default:
        this.log(`[${this.agentId}] act error: ${res.status} ${JSON.stringify(body)}`);
        return false;
    }
  }

  // Leave: the body remains, unmanned, slot held. Identity stays persisted so
  // a later run of this client attaches back to the same agent.
  async leave() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = "leave";
    try {
      await fetch(`${this.server}/agent/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      // daemon gone; nothing to do
    }
    this._streamController?.abort();
  }

  // Release: explicit deletion of the agent. The identity is gone for good,
  // so the persisted copy is discarded too.
  async release() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = "release";
    try {
      await fetch(`${this.server}/agent/release`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      // daemon gone; nothing to do
    }
    this.identityStore.clear();
    this._streamController?.abort();
  }

  _fatal(reason, message) {
    this.stopped = true;
    this.stopReason = reason;
    this.log(`[${this.agentId}] ${message}`);
    this._streamController?.abort();
  }
}
