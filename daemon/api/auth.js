// Two realms, two middlewares, two route trees. Deliberately NOT one
// middleware with a role check: a future route mounted under the wrong tree
// should fail closed, not fall through a shared code path.

import crypto from "node:crypto";

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

export function createAuth(config) {
  if (config.operatorAuth === true && !config.operatorToken) {
    throw new Error("Config error: operatorAuth is true but no operatorToken is set");
  }

  const agentTokens = new Map(); // token -> agentId
  const tokenByAgent = new Map(); // agentId -> token

  function issueAgentToken(agentId) {
    const previous = tokenByAgent.get(agentId);
    if (previous) agentTokens.delete(previous); // takeover invalidates the old token
    const token = crypto.randomBytes(32).toString("hex");
    agentTokens.set(token, agentId);
    tokenByAgent.set(agentId, token);
    return token;
  }

  function revokeAgentToken(agentId) {
    const token = tokenByAgent.get(agentId);
    if (token) {
      agentTokens.delete(token);
      tokenByAgent.delete(agentId);
    }
  }

  function revokeAllAgentTokens() {
    agentTokens.clear();
    tokenByAgent.clear();
  }

  // Agent realm: only a live agent token gets through. An operator token is
  // just an unknown token here → 403 BAD_TOKEN.
  function agentAuth(req, res, next) {
    const token = bearerToken(req);
    const agentId = token ? agentTokens.get(token) : undefined;
    if (!agentId) {
      res.status(403).json({ error: "BAD_TOKEN" });
      return;
    }
    req.agentId = agentId;
    next();
  }

  // Operator realm: an agent token is explicitly rejected even when operator
  // auth is open on localhost — the operator channel MUST be unreachable with
  // an agent token (protocol §11).
  function operatorAuth(req, res, next) {
    const token = bearerToken(req);
    if (token && agentTokens.has(token)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    if (config.operatorAuth === true && token !== config.operatorToken) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    next();
  }

  return { issueAgentToken, revokeAgentToken, revokeAllAgentTokens, agentAuth, operatorAuth };
}
