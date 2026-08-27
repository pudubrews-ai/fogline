// Claude Code CLI adapter — CONFIG ONLY over the subprocess base.
// Every flag below was confirmed empirically before this file was written
// (CLI-FINDINGS.md, claude 2.1.241: 2.9s wall, exit 0, pure JSON on stdout).
// Subscription-billed via Claude Code's own OAuth login; never --bare, which
// reads only ANTHROPIC_API_KEY and would defeat the point.

import { createSubprocessAdapter } from "./subprocess.js";

export const defaults = {
  cmd: "claude",
  args: [
    "-p",
    "--tools", "", // tools OFF, explicitly — world text rides these prompts
    "--output-format", "text",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", // skip the skills scan (5 spawn per tick)
    "--settings", "{}", // skip user settings/plugins
    "--model", "{model}",
    "--system-prompt", "{system}",
  ],
  input: "stdin",
  model: "claude-sonnet-5",
  // Situation tiering (client spec §3.4) is vendor-specific: these ids are
  // meaningful only to this CLI. Other vendors omit them and run on their
  // own defaults — a claude model id in codex's -m flag is an exit 1 on
  // every tick, indistinguishable from a logged-out CLI on the roster.
  cheapModel: "claude-haiku-4-5-20251001",
  richModel: "claude-sonnet-5",
  budgetFactor: 0.75,
  surface: "claude-cli:sub",
  // Version pin (client spec v0.7 §3.1, CLI-FINDINGS.md): 2.1.241 confirmed
  // at v0.5; drifted to 2.1.246 by the v0.7 pin, re-confirmed live.
  pinnedVersion: "2.1.246",
  versionArgs: ["--version"],
  // Non-secret, stable: the OAuth account uuid, not any token.
  account: { file: "~/.claude.json", path: "oauthAccount.accountUuid" },
};

export const create = (overrides = {}) => createSubprocessAdapter({ ...defaults, ...overrides });
export const { complete, surface, budgetFactor } = create();
