/* ============================================================
   CED Intelligence Platform — rate-limit key derivation
   ------------------------------------------------------------
   Decides WHAT is counted and under WHICH pseudonymous key. The
   counting itself happens in Postgres (check_rate_limit, added
   in migration 0003), because a serverless function has no
   memory between invocations to count with.

   Raw IP addresses are never stored and never leave this file.
   An address is reduced to a keyed HMAC using a server-only
   secret, so the stored bucket key is useless to anyone who
   obtains the database without also obtaining the secret, and
   rotating the secret invalidates every historical key.

   Two scopes, deliberately different in purpose:

     · address — the blunt instrument against a script hammering
       the endpoint from one host.
     · session — catches a single browser resubmitting in a loop
       even from a shifting address.

   Neither is a substitute for a challenge. Both are cheap.

   Proxy trust is a DEPLOYMENT question, not a code question:
   the left-most X-Forwarded-For entry is client-controlled
   unless a trusted proxy overwrites it. See
   docs/PRODUCTION_HARDENING.md before relying on it.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const DEFAULTS = {
    windowSeconds: 900,      /* 15 minutes */
    maxRequests: 20
  };

  const SCOPES = ['address', 'session'];

  /* Header order matters. Vercel sets x-real-ip and x-forwarded-for; the
     first entry of x-forwarded-for is the client as reported by the edge.
     Everything here is advisory until proxy behaviour is verified. */
  const ADDRESS_HEADERS = ['x-real-ip', 'x-forwarded-for', 'cf-connecting-ip', 'true-client-ip'];

  const readAddress = headers => {
    if (!headers || typeof headers.get !== 'function') return null;
    for (const name of ADDRESS_HEADERS) {
      const raw = headers.get(name);
      if (!raw) continue;
      const first = String(raw).split(',')[0].trim();
      if (first) return first;
    }
    return null;
  };

  /* hmacFn is injected so this file stays free of any runtime-specific crypto
     import and remains loadable as a classic script. */
  const deriveKey = (hmacFn, secret, scope, value) => {
    if (!value || !secret) return null;
    return hmacFn(secret, `${scope}:${value}`);
  };

  /* Builds the bucket keys for one request. Returns [] when no secret is
     configured — the caller decides whether that is fatal. */
  const buildRateLimitKeys = ({ headers, sessionId = null, env = {}, hmacFn } = {}) => {
    const secret = env.CED_RATE_LIMIT_SECRET || '';
    if (!secret || typeof hmacFn !== 'function') return [];

    const keys = [];
    const address = readAddress(headers);
    const addressKey = deriveKey(hmacFn, secret, 'address', address);
    if (addressKey) keys.push({ scope: 'address', key: addressKey });

    const sessionKey = deriveKey(hmacFn, secret, 'session', sessionId);
    if (sessionKey) keys.push({ scope: 'session', key: sessionKey });

    return keys;
  };

  const rateLimitPolicy = (env = {}) => {
    const windowSeconds = Number(env.CED_RATE_LIMIT_WINDOW_SECONDS) > 0
      ? Math.floor(Number(env.CED_RATE_LIMIT_WINDOW_SECONDS))
      : DEFAULTS.windowSeconds;
    const maxRequests = Number(env.CED_RATE_LIMIT_MAX_REQUESTS) > 0
      ? Math.floor(Number(env.CED_RATE_LIMIT_MAX_REQUESTS))
      : DEFAULTS.maxRequests;
    return { windowSeconds, maxRequests };
  };

  const API = { DEFAULTS, SCOPES, ADDRESS_HEADERS, readAddress, buildRateLimitKeys, rateLimitPolicy };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDRateLimit = API;
})();
