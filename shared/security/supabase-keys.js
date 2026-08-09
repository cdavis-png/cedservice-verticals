/* ============================================================
   CED Intelligence Platform — Supabase key selection
   ------------------------------------------------------------
   ONE DEFINITION OF "WHICH KEY, AND IS IT THE RIGHT KIND".

   SERVER-ONLY. This module classifies credentials. It is not in
   tools/static-manifest.mjs, it is named in that file's
   SERVER_ONLY_SECURITY_MODULES, and
   tests/static-output-contract.test.mjs asserts its absence from
   the published output by name. Do not add it to the manifest.

   WHY THIS FILE EXISTS

   Supabase renamed its keys: `publishable` for the low-privilege
   key and `secret` for the elevated one. The old `anon` and
   `service_role` names still work on existing projects, so both
   are accepted and the current name is preferred.

   The staff route implemented that preference. api/assessments.mjs
   and api/analytics.mjs did not — both read
   `SUPABASE_SERVICE_ROLE_KEY` and nothing else. That is a SPLIT
   CONFIGURATION, and it fails in the worst available direction:
   an operator following current Supabase documentation sets only
   `SUPABASE_SECRET_KEY`, the staff console comes up because it
   prefers that variable, and assessment ingestion and analytics
   answer `503 not_configured` because they never look at it. The
   authenticated, privileged surface works and the public capture
   path — the one the whole product exists to feed — is silently
   dark. Nothing logs a cause, because from each route's own point
   of view nothing is wrong.

   Three copies of a credential rule is also how the rule drifts.
   shared/security/origin.js exists for the same reason and says
   so.

   WHAT IS NOT DECIDED HERE

   This module answers "which value, and is it of the right
   kind". It does not create clients, cache them, or decide what
   a route does when no key is available — assessments fail the
   request, analytics degrades to a no-op, and the staff route
   answers `auth_unavailable`. Those are route decisions and they
   stay in the routes.

   NOTHING HERE LOGS, RETURNS OR ECHOES A REJECTED VALUE. A caller
   learns only that no usable key exists.
   ============================================================ */

(() => {
  'use strict';

  /* ---------- what a key looks like ----------

     THE OPAQUE KEYS ARE MATCHED AGAINST THEIR DOCUMENTED FORMAT, WHOLE.

     Supabase publishes the platform format as a prefix, a 22-character random
     section, an underscore, and an 8-character checksum:

       sb_publishable_<22 random>_<8 checksum>
       sb_secret_<22 random>_<8 checksum>

     A previous version required only "a non-empty URL-safe suffix", which
     accepted `sb_publishable_x` and `sb_secret_abc` — values Supabase does not
     issue and never will. Anchoring the whole string to the documented shape
     costs nothing and turns a truncated or hand-typed key into a refusal at
     configuration time rather than a 401 from Supabase later.

     The character class is URL-safe base64: anything with whitespace, a quote,
     a semicolon or other punctuation is a paste accident rather than a key.

     ONE HONEST LIMIT. `_` is inside the class, so the 8-character checksum may
     itself contain an underscore; a value with an extra separator is refused
     only when that changes the total length. The anchored length is what does
     the work here, and it is the documented format rather than an invented
     stricter one. */
  const PUBLISHABLE_KEY_FORMAT = /^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/;
  const SECRET_KEY_FORMAT = /^sb_secret_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/;

  /* A JWT this server never verifies — it only reads `role` to classify the
     key's privilege. Requiring three non-empty parts and a decodable payload
     means a truncated or hand-mangled token is refused rather than silently
     decoding to `{}` and comparing against nothing.

     `Buffer` is Node-only, which is one more reason this module is server-only
     and asserted absent from the browser output. */
  const legacyKeyRole = value => {
    const parts = String(value).split('.');
    if (parts.length !== 3 || parts.some(p => p.length === 0)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { return null; }
    if (!claims || typeof claims !== 'object') return null;
    return typeof claims.role === 'string' ? claims.role : null;
  };

  const classifyKey = value => {
    if (typeof value !== 'string') return null;
    /* NOT trimmed. A key with surrounding whitespace is a value somebody pasted
       badly, and quietly repairing it hides the mistake in the one place a
       mistake is most expensive. */
    if (value.length === 0) return null;

    /* The prefix decides WHICH format applies, and the format then decides
       whether the value is a key at all. Checking the prefix first means a
       malformed publishable key is refused as a publishable key rather than
       falling through to be tried as a JWT. */
    if (value.startsWith('sb_publishable_')) {
      return PUBLISHABLE_KEY_FORMAT.test(value) ? 'browser' : null;
    }
    if (value.startsWith('sb_secret_')) {
      return SECRET_KEY_FORMAT.test(value) ? 'elevated' : null;
    }

    const role = legacyKeyRole(value);
    if (role === 'anon') return 'browser';
    if (role === 'service_role') return 'elevated';

    /* Unrecognised. Not "probably fine". */
    return null;
  };

  const looksElevated = value => classifyKey(value) === 'elevated';
  const looksBrowserSafe = value => classifyKey(value) === 'browser';

  /* ---------- choosing between the two variable names ----------

     The two privilege levels are kept strictly apart, and the separation FAILS
     CLOSED in both directions rather than merely being separate variables. A
     secret key put in the publishable variable is not returned, so a route
     answers `auth_unavailable` instead of quietly performing token
     verification with an elevated credential; a publishable key put in the
     secret variable is not returned either. Neither mistake becomes a silent
     privilege change.

     EACH RETURNS A VALUE ONLY WHEN THE KEY IS POSITIVELY OF ITS OWN TYPE. The
     old rule — "return it unless it looks like the other one" — meant an
     unclassifiable value was served as a publishable key. It is now refused.

     AN INVALID PREFERRED VARIABLE DOES NOT FALL THROUGH TO THE LEGACY ONE.
     `A || B` would have done exactly that: set `SUPABASE_SECRET_KEY` to a typo
     and the deployment would silently use `SUPABASE_SERVICE_ROLE_KEY` instead,
     so it runs on a key nobody thinks is in use and the typo is invisible
     until the day the legacy variable is removed. If the preferred variable is
     SET AT ALL it is the one that decides, and a bad value there is a
     misconfiguration to fix rather than a fallback to take. */
  const selectKey = (preferred, legacy, wanted) => {
    /* "Set at all" is presence, not validity — an empty string is unset. */
    const chosen = (typeof preferred === 'string' && preferred.length > 0)
      ? preferred
      : ((typeof legacy === 'string' && legacy.length > 0) ? legacy : '');
    if (!chosen) return '';
    return classifyKey(chosen) === wanted ? chosen : '';
  };

  /* The elevated credential: `service_role`, bypasses RLS, reaches every
     table and every granted function. Every server surface that performs a
     privileged RPC reads it through here and nowhere else.

     Returns '' when nothing usable is configured. A caller must treat '' as
     "not configured" — never as a key. */
  const elevatedKey = env =>
    selectKey(env.SUPABASE_SECRET_KEY, env.SUPABASE_SERVICE_ROLE_KEY, 'elevated');

  /* The browser-safe credential. Used by the staff route for Auth calls and
     handed to the onboarding page by `GET /auth-config`; it grants nothing,
     which tests/migration/0007-anon-grants.test.mjs proves as a catalog
     fact. */
  const lowPrivilegeKey = env =>
    selectKey(env.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_ANON_KEY, 'browser');

  const API = {
    PUBLISHABLE_KEY_FORMAT, SECRET_KEY_FORMAT,
    legacyKeyRole, classifyKey, looksElevated, looksBrowserSafe,
    selectKey, elevatedKey, lowPrivilegeKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDSupabaseKeys = API;
})();
