// Codex CLI adapter — CONFIG ONLY over the subprocess base.
// Flags confirmed empirically before this file was written (CLI-FINDINGS.md,
// codex-cli 0.147.0: 4.3s wall, exit 0, banner on stderr, final message
// alone on stdout). ChatGPT-subscription OAuth.
//
// Codex has no tools-off switch: containment is the read-only sandbox plus
// the empty temp cwd. --skip-git-repo-check is REQUIRED — the temp cwd is
// not a git repo and codex refuses to run there without it. --ephemeral
// keeps 200-tick runs from leaving a session file per call. No system-prompt
// flag: the base adapter rides the system text ahead of the user prompt.
// The trailing "-" reads the prompt from stdin.

import { createSubprocessAdapter } from "./subprocess.js";

export const defaults = {
  cmd: "codex",
  args: [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "-s", "read-only",
    "-m", "{model}",
    "-",
  ],
  input: "stdin",
  model: null, // vendor default (user config) unless overridden
  budgetFactor: 0.6,
  surface: "codex-cli:sub",
  // Version pin (client spec v0.7 §3.1, CLI-FINDINGS.md).
  pinnedVersion: "0.147.0",
  versionArgs: ["--version"],
  // Non-secret, stable: the account id field — never the tokens beside it.
  account: { file: "~/.codex/auth.json", path: "tokens.account_id" },
};

export const create = (overrides = {}) => createSubprocessAdapter({ ...defaults, ...overrides });
export const { complete, surface, budgetFactor } = create();
