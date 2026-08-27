// THE SEAM (client spec §3). Reference adapter.
// Takes {system, user, maxTokens, signal, model?}, returns raw text. Knows
// nothing about Fogline, parses nothing, handles no deadlines, retries
// nothing. `model` is the tiering hook (client spec §3.4): the caller picks
// by situation, this line honors it.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

let client = null;

// Billing surface (client spec §4): an API key has no non-secret account
// identifier, so the fingerprint is a 4-hex hash OF the key — irreversible,
// never the credential itself. Two clients on one key collide, which is the
// visibility the field exists for.
export function surface() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "claude-api:key:0000";
  return `claude-api:key:${createHash("sha256").update(key).digest("hex").slice(0, 4)}`;
}

export async function complete({ system, user, maxTokens, signal, model }) {
  client ??= new Anthropic(); // credential from the environment (.env)
  // claude-sonnet-5 rejects non-default sampling parameters: no temperature,
  // top_p, or top_k. The signal passes straight through so budget aborts
  // actually cancel the request.
  const response = await client.messages.create(
    {
      model: model ?? "claude-sonnet-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    },
    { signal }
  );
  let text = "";
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}
