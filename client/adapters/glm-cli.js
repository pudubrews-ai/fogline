// GLM adapter — CONFIG ONLY over the subprocess base (client spec v0.7 §2).
// There is no standalone GLM CLI: the surface is Zhipu's documented Claude
// Code integration — the SAME claude binary, confirmed argv unchanged from
// claude-cli, pointed at their Anthropic-compatible endpoint by environment.
// Everything below was confirmed empirically before this file was written
// (empirically, 2026-08-25: glm-4.7 6.3s wall on a realistic prompt,
// exit 0, response alone on stdout, warnings on stderr, none tripping
// AUTH_RE).
//
// Latency: the 512s/600s-timeout crosscheck numbers were agentic-loop
// invocations. Single-response with tools stripped measured 6.3s (glm-4.7)
// and 26.6s (glm-5) — comfortably inside a 45s tick at budgetFactor 0.9.

import { createSubprocessAdapter } from "./subprocess.js";

export const defaults = {
  cmd: "claude",
  args: [
    "-p",
    "--tools", "", // tools OFF, explicitly — world text rides these prompts
    "--output-format", "text",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--settings", "{}",
    "--model", "{model}",
    "--system-prompt", "{system}",
  ],
  input: "stdin",
  // glm-4.7 serves as named; "glm-5" is served as glm-5.3 (26.6s — fits,
  // but with little slack for variance; override per run if wanted).
  model: "glm-4.7",
  cheapModel: "glm-4.7",
  richModel: "glm-4.7",
  budgetFactor: 0.9,
  surface: "glm-cli:sub",
  // The credential rides ONLY in the environment — never argv, never
  // committed, never on any stream. Source (client spec v0.9 §6):
  // FOGLINE_GLM_TOKEN if set, else the gitignored fallback file inside the
  // client directory. ANTHROPIC_API_KEY is explicitly emptied so no stray
  // key shadows the endpoint token.
  env: {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: { env: "FOGLINE_GLM_TOKEN", file: ".credentials/glm-token" },
    ANTHROPIC_API_KEY: "",
  },
  // z.ai leaves no non-secret account identifier on disk (the key is a
  // credential, and the kimi precedent rejects hashing credentials). All
  // GLM clients read as the fixed 0000 surface — correct for a single-key
  // setup; revisit if a second GLM account ever runs.
  account: null,
  // The binary that can drift underneath this invocation is claude itself.
  pinnedVersion: "2.1.246",
  versionArgs: ["--version"],
};

export const create = (overrides = {}) => createSubprocessAdapter({ ...defaults, ...overrides });
export const { complete, surface, budgetFactor } = create();
