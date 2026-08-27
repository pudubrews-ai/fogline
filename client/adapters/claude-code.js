// SUBSCRIPTION-BILLED adapter. Same seam as claude.js: text in, text out.
// Routes each completion through the Claude Code CLI in print mode, which
// authenticates via Claude Code's own login (subscription OAuth) instead of
// Console API credits. The plain SDK adapter (claude.js) ALWAYS bills the
// organization's API credit balance — there is no subscription path for raw
// Messages API calls; this adapter exists because of that.
//
// Auth (one-time): `claude setup-token` in a terminal, then put the printed
// token in client/.env as CLAUDE_CODE_OAUTH_TOKEN=... — or just `/login`
// inside `claude` once so the CLI holds credentials itself.
//
// NOT --bare: bare mode reads auth "strictly ANTHROPIC_API_KEY" and never
// OAuth, which would defeat the entire point of this adapter. Instead the
// spawn is kept lean and sealed explicitly: --tools "" strips every tool,
// because agent-authored world text (speech, inscriptions) rides these
// prompts and must never reach a tool-bearing harness; --strict-mcp-config
// with an empty server map skips every configured MCP server; and cwd is
// the OS temp dir so CLAUDE.md auto-discovery finds nothing — the system
// prompt must be the persona and only the persona. maxTokens is accepted
// for seam compatibility but not enforced — the CLI exposes no output cap;
// the budget abort bounds runtime instead.

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { accountFingerprint } from "./subprocess.js";

// Same subscription OAuth as claude-cli: same non-secret account uuid, same
// fingerprint — two adapters on one subscription collide by design.
export function surface() {
  return `claude-code:sub:${accountFingerprint({ file: "~/.claude.json", path: "oauthAccount.accountUuid" })}`;
}

export async function complete({ system, user, maxTokens, signal, model }) {
  const args = [
    "-p",
    "--tools", "",
    "--output-format", "text",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    // Five of these spawn at once every tick; the skills scan and user
    // settings/plugins were most of the boot under contention (8.5s -> 4.8s
    // for 5 concurrent when both are skipped).
    "--disable-slash-commands",
    "--settings", "{}",
    "--model", model ?? "claude-sonnet-5",
    "--system-prompt", system,
    user,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "claude",
      args,
      { signal, maxBuffer: 4 * 1024 * 1024, env: process.env, cwd: tmpdir() },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || "").trim() || err.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}
