# @fogline/scry

The observatory. A standalone three.js viewer that renders what the daemon
publishes and decides nothing — scrying: watching something distant you
cannot touch. **Read-only structurally:** the analyst client cannot
construct a request to `/control` or any config path, and nothing in this
package writes to the world.

```bash
npm install
npm run dev        # http://localhost:5173 — press play in the transport bar
npm run analyst    # optional LLM analyst sidecar, http://localhost:3200
npm test
npm run build      # production bundle (grepped clean of every recipe key)
```

## Sources

**Live** — SSE from the daemon's operator realm, with a plain snapshot on
connect. **Replay** — open `?source=replay` with a served `ticks.log` or
drop the file on the page. Both fold through one reducer, so every panel
works identically on a live run and a finished one; a stub-mode run
renders exactly like a real one.

## Surfaces

- 3D stage: sphere robots, simTime sun, structures, corpses, deposits.
  **Hover any cell** for its contents — coordinate, deposit, loose pile,
  structure with inscription budget, fragment, corpses, agents present.
- **Agent map overlay:** the grid as a selected agent knows it — unvisited
  near-black, stale dimmed; hover shows what that agent *believes* is in a
  cell and when they last saw it, with the true state on a toggle. This is
  where you watch an agent act on a world that no longer exists.
- Panels: roster, inspector, feed, memory streams, viability, spend per
  billing surface, destruction ledger, **norm tracker** (violence, theft,
  and destruction with witnesses and how far each account propagated),
  lineage (with inherited-knowledge markers), inscriptions, crosscheck
  reports, pre-boot config panel.
- **Ticker:** flat one-line phrasings of notable events, paced and
  recycled; deaths stay pinned in the recycle pool for the rest of the run.
- Keyboard: `1` orbit, `2` follow selection, `3` free, `4` director, `h`
  hide UI, `p` screenshot.
