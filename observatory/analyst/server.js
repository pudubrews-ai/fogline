// The analyst sidecar (observatory spec v0.8 §2): the observatory's ONE
// model access. Runs beside the Vite app (`npm run analyst`), holds the
// FIFTH surface's credential — the `claude` CLI's own subscription OAuth,
// exactly the arrangement every agent client uses — and answers POST /ask
// from the analyst panel. The daemon still holds no credential, and this
// process holds no daemon write route: it talks to the model, not to the
// world. Calls are counted and reported so the fifth surface shows up
// honestly beside the other four.
//
// Subscription-only, like everything else here: the CLI's OAuth login, never
// a pay-per-token API key. No .env is read.

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const PORT = Number(process.env.ANALYST_PORT ?? 3200);
const SURFACE = "analyst:claude-cli";
const CALL_TIMEOUT_MS = 120_000;

let callsTotal = 0;

const SYSTEM_FRAME =
  "You are the analyst panel of an observatory watching a small simulated world of LLM-driven agents. " +
  "Answer the operator's question from the supplied context only. Be concrete: cite ticks, agents, and " +
  "coordinates from the context. If the context cannot answer the question, say what is missing. " +
  "Do not invent events.";

function askModel(prompt) {
  return new Promise((resolve, reject) => {
    // Same non-interactive shape the client adapters confirmed empirically:
    // -p, text output, prompt on stdin, ambient CLI OAuth. detached so a
    // timeout kills the process GROUP — the run-8 orphan lesson applies to
    // every subprocess in this project.
    const child = spawn("claude", ["-p", "--output-format", "text"], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      reject(new Error(`analyst call timed out after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      killGroup();
      if (code !== 0) reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
      else resolve(out.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ surface: SURFACE, callsTotal }));
    return;
  }
  if (req.method === "POST" && req.url === "/ask") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { question, context } = JSON.parse(body || "{}");
        if (typeof question !== "string" || question.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "question is required" }));
          return;
        }
        callsTotal += 1;
        const prompt = `${SYSTEM_FRAME}\n\n${context ?? ""}\n\nOperator question: ${question}`;
        const answer = await askModel(prompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer, surface: SURFACE, callsTotal }));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message ?? e), surface: SURFACE, callsTotal }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "POST /ask or GET /status" }));
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(PORT, () => {
    console.log(`fishbowl-analyst listening on http://localhost:${PORT} (surface ${SURFACE})`);
    console.log("model access: claude CLI subscription OAuth — no API key, no .env, no daemon write routes");
  });
}

export { server, askModel };
