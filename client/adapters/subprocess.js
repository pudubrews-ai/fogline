// The subprocess base adapter (client spec §3). One implementation of the
// fragile parts — spawn, prompt delivery, abort, PROCESS-GROUP cleanup,
// preamble stripping, JSON extraction, fault classification — with per-vendor
// config supplying the command. A new CLI backend is a config entry.
//
// The seam is unchanged: complete({system, user, maxTokens, signal}) -> string.
// maxTokens is accepted for seam compatibility but unenforced — no CLI
// exposes an output cap; the budget abort bounds runtime instead.
//
// Vendor config (empirically confirmed per vendor BEFORE being written —
// see CLI-FINDINGS.md):
//   cmd            executable name
//   args           argv template; tokens: {system} (native system-prompt
//                  flag), {model} (model id; the token AND its preceding
//                  flag are dropped when no model resolves), {prompt}
//                  (prompt as an argument, for input: "arg")
//   input          "stdin" | "arg"
//   model          default model id, overridable per call (tiering)
//   budgetFactor   per-adapter deadline share (client spec §3.2) — process
//                  startup and each CLI's agentic loop vary enormously
//   surface        vendor prefix, e.g. "claude-cli:sub"
//   account        {file, path?} — where the stable, NON-SECRET account
//                  identifier lives; hashed to the 4-hex fingerprint.
//                  path is a dot path into JSON; omitted = whole file.
//   env            per-vendor environment overrides layered onto
//                  process.env at spawn. Values are literal strings, or
//                  {file} to read a credential from a file at spawn time —
//                  the credential never appears in argv, in config values
//                  committed to the repo, or on any stream. Added for the
//                  GLM surface (client spec v0.7 §2): the same claude
//                  binary against a different endpoint IS a config entry.
//   pinnedVersion  the confirmed-working CLI version (client spec v0.7
//                  §3.1, recorded in CLI-FINDINGS.md); checked at startup,
//                  a mismatch warns loudly and never refuses
//   versionArgs    argv that makes the CLI print its version (default
//                  ["--version"])

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Auth failure is the classification that matters: an expired session must
// not read in-world as a pensive agent for two hundred ticks. Tight enough
// not to trip on banners ("provider: openai", session-resume hints).
const AUTH_RE =
  /not logged in|login required|please (run|use) [^\n]{0,40}log ?in|unauthorized|authentication (failed|required|error)|invalid api key|token (has )?expired|\b401\b/i;

const firstLine = (text) => String(text ?? "").trim().split("\n")[0].slice(0, 200);

// Classified fault detail (client spec v0.9 §3). The old diagnostic path
// kept exactly the line the extraction path discards: stderr line ONE — for
// codex its version banner, for run 8's kimi failure the same shape — so the
// classification fired correctly twice while the reason was thrown away.
// Strip the banner, keep the remainder, cap at ~500 chars rather than
// truncating to one line: quota and auth messages are one or two sentences
// and they are precisely what is needed.
const FAULT_DETAIL_MAX = 500;
const SEMVER_RE = /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/;
const DIAGNOSTIC_RE = /error|fail|denied|exceed|quota|limit|invalid|expired|unauthorized|forbidden|not logged in|login|timeout|refused/i;

// A banner line: short, carries a bare version stamp, says nothing
// diagnostic. "kimi version 0.38.0" and a codex version banner both match;
// "token expired (client v1.2.3)" does not.
function isBannerLine(line) {
  const t = line.trim();
  if (t.length === 0) return true; // leading blank lines strip with the banner
  if (t.length > 100) return false;
  if (!SEMVER_RE.test(t)) return false;
  return !DIAGNOSTIC_RE.test(t);
}

// The stripped, capped diagnostic remainder — or null when nothing survives,
// which the caller records EXPLICITLY: "non-zero exit, no diagnostic output"
// is a fact worth recording rather than a blank.
export function faultDetail(stderr, stdout) {
  const raw = String((stderr ?? "").trim() ? stderr : (stdout ?? "")).trim();
  if (raw.length === 0) return null;
  const lines = raw.split("\n");
  let start = 0;
  while (start < lines.length && isBannerLine(lines[start])) start += 1;
  const rest = lines.slice(start).join("\n").trim();
  if (rest.length === 0) return null;
  return rest.length > FAULT_DETAIL_MAX ? rest.slice(0, FAULT_DETAIL_MAX) : rest;
}

// Balanced-brace scan honoring JSON strings: the outermost {...} starting at
// `start`, or null if never closed.
function balancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Strip fences and CLI preamble, extract the outermost JSON object. CLIs
// print things API calls do not — banners, bullets, sign-offs. When no
// parseable object exists, the trimmed raw text goes back as-is: the
// caller's parse failure IS the "bad output" classification, logged raw and
// never retried.
export function extractResponse(rawText) {
  let text = String(rawText ?? "").trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "");
  let at = text.indexOf("{");
  while (at !== -1) {
    const candidate = balancedObject(text, at);
    if (candidate) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // fall through: try the next opening brace
      }
    }
    at = text.indexOf("{", at + 1);
  }
  return text;
}

// The 4-hex account fingerprint (client spec §4): a hash of a stable,
// non-secret identifier — NEVER a credential, and never reversible to one.
export function accountFingerprint(account) {
  try {
    const file = account.file.replace(/^~(?=\/|$)/, homedir());
    const raw = readFileSync(file, "utf8");
    let value;
    if (account.path) {
      let node = JSON.parse(raw);
      for (const key of account.path.split(".")) node = node?.[key];
      value = node;
    } else {
      value = raw.trim();
    }
    if (typeof value !== "string" || value.length === 0) return "0000";
    return createHash("sha256").update(value).digest("hex").slice(0, 4);
  } catch {
    return "0000"; // not logged in yet — visible as such on the roster
  }
}

// Resolve a vendor env map: literal strings pass through; {env, file}
// values resolve at spawn time so credentials stay out of argv and config.
// Precedence (client spec v0.9 §6): the named environment variable if set,
// else the fallback file — resolved against the CLIENT directory when
// relative, so the gitignored fallback lives inside the package rather than
// defaulting to somebody's Downloads folder. Not a secrecy fix — a
// usability tell, closed before it ships this way.
const clientDir = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function resolveVendorEnv(envSpec) {
  if (!envSpec) return null;
  const resolved = {};
  for (const [name, value] of Object.entries(envSpec)) {
    if (value !== null && typeof value === "object" && (value.env || value.file)) {
      if (value.env && process.env[value.env]) {
        resolved[name] = process.env[value.env].trim();
        continue;
      }
      if (!value.file) {
        throw new Error(`env ${name}: ${value.env} is unset and no fallback file is declared`);
      }
      const expanded = value.file.replace(/^~(?=\/|$)/, homedir());
      const file = resolvePath(clientDir, expanded);
      resolved[name] = readFileSync(file, "utf8").trim();
    } else {
      resolved[name] = String(value);
    }
  }
  return resolved;
}

// Version pin check (client spec v0.7 §3.1). Run 8's kimi failed 53
// consecutive ticks in the shape of a CLI that updated underneath a working
// invocation; this makes the drift loud at startup instead. Never fatal —
// a newer CLI usually still works (claude 2.1.241 → 2.1.246 did), and the
// smoke test is what decides whether the client may take a slot.
export function checkVersionPin(vendor) {
  return new Promise((resolve) => {
    if (!vendor.pinnedVersion) return resolve({ pinned: null, actual: null, matches: true });
    const child = spawn(vendor.cmd, vendor.versionArgs ?? ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ pinned: vendor.pinnedVersion, actual: null, matches: false }));
    child.on("close", () => {
      const actual = out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      resolve({ pinned: vendor.pinnedVersion, actual, matches: actual === vendor.pinnedVersion });
    });
  });
}

export function createSubprocessAdapter(vendor) {
  async function complete({ system, user, maxTokens, signal, model }) {
    const chosenModel = model ?? vendor.model ?? null;
    const nativeSystem = vendor.args.some((a) => a.includes("{system}"));
    // No system flag -> the system text rides ahead of the user prompt.
    const promptText = nativeSystem ? user : `${system}\n\n${user}`;

    const args = [];
    for (const template of vendor.args) {
      if (template === "{model}") {
        if (chosenModel == null) args.pop(); // drop the preceding flag too
        else args.push(chosenModel);
        continue;
      }
      if (template === "{prompt}") {
        args.push(promptText);
        continue;
      }
      args.push(template.replaceAll("{system}", system));
    }

    // A fresh EMPTY temp dir, never the repo: these are agentic coding
    // tools, and a tool-using CLI must find nothing (client spec §3.4).
    const cwd = mkdtempSync(join(tmpdir(), "fogline-"));

    // Resolved before spawn so a missing credential file is a classified
    // adapter fault, not an anonymous rejection.
    let spawnEnv = process.env;
    if (vendor.env) {
      try {
        spawnEnv = { ...process.env, ...resolveVendorEnv(vendor.env) };
      } catch (err) {
        rmSync(cwd, { recursive: true, force: true });
        const fail = new Error(`vendor env unresolvable: ${err.message}`);
        fail.classification = "adapter_fault";
        return Promise.reject(fail);
      }
    }

    return new Promise((resolve, reject) => {
      // detached: the child leads its own process group, so cleanup can
      // kill the GROUP. CLIs spawn children; killing only the pid left five
      // orphans behind after the v0.4 extinction run.
      const child = spawn(vendor.cmd, args, {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnEnv,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const killGroup = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", killGroup);
        killGroup(); // reap stragglers even after a clean leader exit
        rmSync(cwd, { recursive: true, force: true });
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const fault = (detail) => {
        const err = new Error(detail);
        err.classification = "adapter_fault";
        settle(reject, err);
      };

      if (signal) {
        if (signal.aborted) killGroup();
        else signal.addEventListener("abort", killGroup, { once: true });
      }

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.on("error", () => {}); // EPIPE from an early death; close decides
      child.on("error", (err) => fault(`adapter process failed to start: ${err.message}`));
      child.on("close", (code) => {
        if (signal?.aborted) {
          // The budget fired: withBudget turns this into {timedOut} — SLOW,
          // the normal classification, answered with an explicit wait.
          settle(reject, new Error("aborted by budget"));
          return;
        }
        // ADAPTER FAULT (client spec §3.3): non-zero exit, auth text on
        // stderr, or no output at all without a timeout. An expired session
        // hangs or errors oddly rather than failing cleanly.
        if (AUTH_RE.test(stderr)) {
          fault(`auth failure: ${faultDetail(stderr, stdout) ?? firstLine(stderr)}`);
          return;
        }
        if (code !== 0) {
          const detail = faultDetail(stderr, stdout);
          fault(`exit ${code}: ${detail ?? "non-zero exit, no diagnostic output"}`);
          return;
        }
        if (stdout.trim().length === 0) {
          fault("no output with exit 0");
          return;
        }
        settle(resolve, extractResponse(stdout));
      });

      if (vendor.input === "stdin") child.stdin.end(promptText);
      else child.stdin.end();
    });
  }

  return {
    complete,
    config: vendor,
    budgetFactor: vendor.budgetFactor,
    // vendor prefix + account fingerprint, e.g. "claude-cli:sub:a3f9".
    // Two clients on one subscription produce the same fingerprint — which
    // is exactly the visibility this exists for.
    surface: () => `${vendor.surface}:${vendor.account ? accountFingerprint(vendor.account) : "0000"}`,
  };
}
