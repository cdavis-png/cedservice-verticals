/* ============================================================
   CED Intelligence Platform — the Supabase project origin
   ------------------------------------------------------------
   ONE VALIDATOR, TWO CALLERS, SO THEY CANNOT DIVERGE.

   The onboarding page talks to Supabase Auth directly, so the
   exact project origin has to appear in two places at once:

     · the generated `connect-src` in the built onboarding page
       (tools/build-static.mjs), and
     · the `supabaseUrl` that `GET /auth-config` hands the browser
       (server/staff-identity-resolution.mjs).

   If those two ever disagreed the page would be configured to
   call one host and permitted to reach another, and the failure
   would be a blocked request at run time with nothing to explain
   it. They read the SAME variable through the SAME function here,
   and a test asserts a single value produces both.

   WHY A VALIDATOR AND NOT `new URL(...).origin`. This value ends
   up inside a Content-Security-Policy. A CSP source is not a URL:
   a stray path, a query, a wildcard or a second host silently
   changes what the policy permits, and `URL` happily accepts all
   of them. Everything that is not an exact scheme-host-port is
   refused here rather than normalised, because normalising means
   deciding what somebody meant, which is the one thing a security
   allowlist may not do.

   FAILS CLOSED, ALWAYS. Every refusal returns a reason and no
   origin. The build turns that into a failed build; the route
   turns it into `503 auth_unavailable`. Neither falls back to a
   default, and there is no default to fall back to.

   Classic script on purpose — see the note in engine.js. It is
   SERVER-ONLY and is asserted absent from the published output by
   name: the browser is TOLD the origin by /auth-config and has no
   use for the validator.
   ============================================================ */

(() => {
  'use strict';

  /* A Supabase project host is `<ref>.supabase.co` — exactly one label in
     front of the registrable domain.

     THE LABEL IS WHY THIS IS A REGEX AND NOT `endsWith('.supabase.co')`.
     `evil.com/x.supabase.co` is not a host; `a.b.supabase.co` is a nested
     subdomain nobody provisioned; `*.supabase.co` is a wildcard and the whole
     point is that it is refused. Lowercase alphanumeric only, no dots, no
     hyphens: project refs are generated, not chosen, and accepting shapes
     Supabase does not issue only widens what a mistyped variable can reach.

     The length range is deliberately wider than today's 20 characters so a
     future ref format does not need a code change to deploy, and deliberately
     bounded so it stays a project ref rather than any label at all. */
  const PROJECT_HOST = /^[a-z0-9]{16,40}\.supabase\.co$/;

  /* Recognisably a credential. A key does not belong in a URL variable at
     all, and one pasted there must never reach a CSP or a browser — so it is
     refused by name rather than merely failing the URL parse. */
  const looksLikeKey = value =>
    /sb_(secret|publishable)_/.test(value)
    || /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)
    || /service_role/.test(value);

  /* Returns { ok: true, origin } or { ok: false, reason }. `reason` is a
     short machine token, never the offending value: the caller decides how
     loudly to fail, and neither caller should ever echo the input. */
  const validateSupabaseOrigin = raw => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { ok: false, reason: 'missing' };
    if (looksLikeKey(value)) return { ok: false, reason: 'looks_like_a_key' };

    /* A CSP source list is whitespace-separated. A value containing
       whitespace would inject a second source, so it is refused before it is
       parsed rather than after. Same for the separators a policy uses. */
    if (/[\s;,'"]/.test(value)) return { ok: false, reason: 'not_a_single_source' };

    let url;
    try { url = new URL(value); } catch { return { ok: false, reason: 'not_a_url' }; }

    if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
    if (url.username || url.password) return { ok: false, reason: 'carries_credentials' };
    if (url.search) return { ok: false, reason: 'carries_a_query' };
    if (url.hash) return { ok: false, reason: 'carries_a_fragment' };
    /* `/` is what `new URL('https://host')` produces and is the only path an
       origin may have. Anything else is a URL, not an origin. */
    if (url.pathname !== '/') return { ok: false, reason: 'carries_a_path' };
    if (url.port) return { ok: false, reason: 'carries_a_port' };
    if (!PROJECT_HOST.test(url.hostname)) return { ok: false, reason: 'not_a_supabase_project_host' };

    /* `url.origin` is the serialised scheme-host-port and is what both
       callers use. Returning it rather than the input means the two callers
       agree on spelling as well as on value — `https://x.supabase.co/` and
       `https://x.supabase.co` cannot become two different CSP sources. */
    return { ok: true, origin: url.origin };
  };

  /* The message a human should see, per reason. Kept here so the build and
     the route explain a misconfiguration the same way. */
  const ORIGIN_FAILURE = Object.freeze({
    missing: 'SUPABASE_URL is not set.',
    looks_like_a_key: 'SUPABASE_URL contains something shaped like a Supabase key, not a URL.',
    not_a_single_source: 'SUPABASE_URL must be one origin with no whitespace or punctuation.',
    not_a_url: 'SUPABASE_URL is not a valid absolute URL.',
    not_https: 'SUPABASE_URL must use https.',
    carries_credentials: 'SUPABASE_URL must not contain a username or password.',
    carries_a_query: 'SUPABASE_URL must not contain a query string.',
    carries_a_fragment: 'SUPABASE_URL must not contain a fragment.',
    carries_a_path: 'SUPABASE_URL must be an origin only, with no path.',
    carries_a_port: 'SUPABASE_URL must not specify a port.',
    not_a_supabase_project_host:
      'SUPABASE_URL must be an exact Supabase project host, e.g. https://abcdefghijklmnopqrst.supabase.co'
  });

  const describeOriginFailure = reason =>
    ORIGIN_FAILURE[reason] || 'SUPABASE_URL is not a usable Supabase project origin.';

  /* ---------- the local-development exception ----------
     A developer machine and the browser suite point SUPABASE_URL at a
     loopback stub, which is not a Supabase project host and never can be. The
     strict validator above must not learn about that: it is what the BUILD
     uses, and a build that accepted a loopback origin could publish a page
     permitted to reach nothing useful.

     So this is a SEPARATE function, called only by the staff route and only
     behind the switch that already exists for exactly this — the one that
     needs CED_ALLOW_INSECURE_STAFF set, a loopback request host, AND a
     NODE_ENV that is not production. All three, so neither a stray variable
     nor a stray hostname is enough by itself, and nothing here can loosen a
     real deployment.

     `http` is permitted because the whole point is a local server with no
     TLS. Everything else is checked exactly as strictly as above. */
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

  const validateLocalSupabaseOrigin = raw => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { ok: false, reason: 'missing' };
    if (looksLikeKey(value)) return { ok: false, reason: 'looks_like_a_key' };
    if (/[\s;,'"]/.test(value)) return { ok: false, reason: 'not_a_single_source' };

    let url;
    try { url = new URL(value); } catch { return { ok: false, reason: 'not_a_url' }; }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'not_https' };
    }
    if (url.username || url.password) return { ok: false, reason: 'carries_credentials' };
    if (url.search) return { ok: false, reason: 'carries_a_query' };
    if (url.hash) return { ok: false, reason: 'carries_a_fragment' };
    if (url.pathname !== '/') return { ok: false, reason: 'carries_a_path' };
    if (!LOOPBACK.has(url.hostname)) return { ok: false, reason: 'not_a_supabase_project_host' };

    return { ok: true, origin: url.origin };
  };

  const API = {
    validateSupabaseOrigin, validateLocalSupabaseOrigin,
    describeOriginFailure, PROJECT_HOST, LOOPBACK, ORIGIN_FAILURE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDSupabaseOrigin = API;
})();
