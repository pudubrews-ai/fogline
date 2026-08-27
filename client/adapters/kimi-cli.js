// Kimi Code CLI adapter — CONFIG ONLY over the subprocess base.
// Flags confirmed empirically before this file was written (CLI-FINDINGS.md,
// kimi 0.38.0: 8.2s wall, exit 0, response bullet-prefixed on stdout —
// the base adapter's preamble stripping is load-bearing here).
//
// No stdin mode: the prompt travels as the -p argument ({prompt}). No
// tools-off flag: the default permission mode asks before tool calls, which
// in -p mode hangs and classifies as slow — never pass -y/--auto. No
// system-prompt flag: combined prompt. Sessions persist per invocation with
// no opt-out; noted in the findings.

import { createSubprocessAdapter } from "./subprocess.js";

export const defaults = {
  cmd: "kimi",
  args: [
    "-p", "{prompt}",
    "--output-format", "text",
    "-m", "{model}",
  ],
  input: "arg",
  model: null, // vendor default (config.toml alias) unless overridden
  budgetFactor: 0.6,
  surface: "kimi-cli:sub",
  // Version pin (client spec v0.7 §3.1): run 8 died on exactly this drift —
  // 53 consecutive `exit 1: kimi version 0.38.0` ticks.
  pinnedVersion: "0.38.0",
  versionArgs: ["--version"],
  // Kimi keeps no non-secret ACCOUNT id on disk (tokens only), so the
  // fingerprint hashes the non-secret device id: same account + same
  // machine collide correctly; the same account on two machines reads as
  // two surfaces. Chosen over hashing a token — the identifier must not
  // be a credential.
  account: { file: "~/.kimi-code/device_id" },
};

export const create = (overrides = {}) => createSubprocessAdapter({ ...defaults, ...overrides });
export const { complete, surface, budgetFactor } = create();
