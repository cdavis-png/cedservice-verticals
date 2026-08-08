/* ============================================================
   CED Intelligence Platform — canonical Origin validation
   ------------------------------------------------------------
   One definition of "is this browser allowed to call us".

   The rule, unchanged from the one api/assessments.mjs has
   always applied and stated in CLAUDE.md section 3: an Origin is
   REQUIRED and EXACT-MATCHED. No wildcard, no suffix match, no
   reflection of whatever arrived, and `null` is refused rather
   than treated as absent.

   An Origin is a scheme, a host and a port and nothing else.
   Anything carrying a path, a query, a fragment or credentials
   is malformed, and a malformed Origin is refused rather than
   normalised — normalising it would mean deciding what the
   sender meant, which is the one thing an allowlist may not do.

   WHY THIS FILE EXISTS. The staff route is the third server
   surface that needs the rule. Two copies were already one too
   many; a third written by hand would be the point at which they
   start to drift, and a drifted allowlist fails open on exactly
   one of them. api/assessments.mjs and api/analytics.mjs still
   carry their own copies — they are committed, they are not part
   of this change, and folding them in belongs in its own commit.
   This is the canonical implementation they should both move to.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* A comma-separated allowlist read from one named variable. The NAME is a
     parameter so a surface with its own audience — the staff console has
     nothing to do with the marketing verticals — configures itself
     independently instead of inheriting a list assembled for someone else. */
  const configuredOrigins = (env, name) =>
    String((env && env[name]) || '').split(',').map(s => s.trim()).filter(Boolean);

  /* Shape only. Whether the value is PERMITTED is a separate question, asked
     by isAllowedOrigin against a list. */
  const isWellFormedOrigin = origin => {
    if (typeof origin !== 'string' || origin.length === 0) return false;
    if (origin === 'null' || origin === '*') return false;
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
    if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
    /* A browser sends exactly the serialised origin — scheme, host, and port
       only when it is not the default. Requiring the round trip to be exact
       means `https://x:443` and `https://x/` are refused rather than quietly
       treated as `https://x`, so one origin has one spelling in the list. */
    return parsed.origin === origin;
  };

  /* Exact membership of an explicit list. */
  const isAllowedOrigin = (origin, allowed) =>
    isWellFormedOrigin(origin) && Array.isArray(allowed) && allowed.includes(origin);

  const API = { configuredOrigins, isWellFormedOrigin, isAllowedOrigin };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDOrigin = API;
})();
