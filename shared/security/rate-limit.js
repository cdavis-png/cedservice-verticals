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

  /* The staff console is an INTERACTIVE surface and the public form is a
     one-shot one. Working a single identity-resolution case costs three
     requests — the case detail, the resolution, and the queue refetch behind
     the panel — so the public form's budget of 20 locked an operator out
     after roughly six cases. These are separate numbers for that reason, and
     raising one no longer raises the other. */
  const STAFF_DEFAULTS = {
    windowSeconds: 900,
    maxRequests: 240         /* ~80 cases in a 15-minute window */
  };

  /* Sign-in is the one staff request an unauthenticated caller can make, so it
     gets its own, much tighter budget. It is deliberately not the pre-auth
     number: that one exists to cap outbound work, this one exists to make
     password guessing pointless.

     THIRTY, NOT TEN, AND THE ARITHMETIC MATTERS. One completed sign-in is TWO
     posts to /session, because the form is two steps: email and password, then
     the code. A budget of ten therefore bought five sign-ins per address per
     window, and operators share an address whenever they share an office. Ten
     COMPLETE two-step attempts is twenty posts, so thirty leaves room for a
     mistyped code without locking the office out. Thirty password guesses per
     fifteen minutes per address is still nowhere near enough to guess one, and
     the second factor is behind it regardless. */
  const STAFF_SIGNIN_DEFAULTS = {
    windowSeconds: 900,
    maxRequests: 30
  };

  /* Refreshing and revoking a token are NOT credential attempts: both present
     a token the server already issued, and neither can be used to guess one.
     Sharing the sign-in bucket with them meant a long console session spent
     the budget an operator needed to sign in again, and a refused refresh
     ends the session — so the tight bucket was ejecting the very people it
     was meant to protect. Separate namespace, separate budget, and a refusal
     in one cannot consume the other. */
  const STAFF_SESSION_DEFAULTS = {
    windowSeconds: 900,
    maxRequests: 60
  };

  const SCOPES = ['address', 'session'];

  /* WHY THE SEPARATION LIVES IN THE KEY AND NOT IN THE SCOPE COLUMN.

     `rate_limit_buckets.scope` carries `check (scope in ('address','session'))`
     from migration 0003, which is committed and is not edited. The scope column
     therefore keeps its original meaning — WHAT is being counted — and the
     namespace goes where the scope string already goes: into the keyed HMAC.

     Two callers using different namespaces derive different bucket_key values,
     so they land on different rows and cannot consume each other's budget.
     That is the whole requirement; the column name is not part of it. */
  const NAMESPACES = {
    public: '',                        /* unchanged: existing buckets keep their keys */
    staffPreAuth: 'staff_preauth:',
    staffSignIn: 'staff_signin:',
    staffSession: 'staff_session:',    /* refresh and sign-out: not credential attempts */
    staff: 'staff:',
    /* The sales surfaces. Separate namespaces so a burst of promotions
       cannot eject an operator from the identity-resolution queue, and so a
       CRM outage that makes callers retry the promotion route does not spend
       the console's budget. Same reasoning as the staff split above: the
       separation lives inside the keyed HMAC, never in the database's
       `scope` column. */
    salesPreAuth: 'sales_preauth:',
    sales: 'sales:',
    /* The webhook receiver is UNAUTHENTICATED by necessity — HighLevel holds
       no operator session — so it is metered by address alone and gets its
       own bucket rather than sharing one with a surface a person uses. */
    crmWebhook: 'crm_webhook:'
  };

  /* Header order matters, and `x-vercel-forwarded-for` is FIRST deliberately.

     It is set by Vercel's own edge for a request arriving directly at the
     platform, and unlike the generic headers it cannot be appended to by an
     intermediary the deployment does not control. The generic headers keep
     their existing order and meaning behind it, so an explicitly supported
     proxy in front of Vercel still works exactly as before — this only
     changes which value WINS when the platform supplied one.

     Everything here remains advisory until proxy behaviour is verified
     against a real deployment. */
  const ADDRESS_HEADERS = [
    'x-vercel-forwarded-for',
    'x-real-ip', 'x-forwarded-for', 'cf-connecting-ip', 'true-client-ip'
  ];

  /* Is this a usable caller identifier at all?

     A rate-limit bucket keyed on garbage is a bucket nobody shares, which is
     the same as no limit. Length-bounded and charset-bounded rather than
     parsed as an IP: the value may legitimately be IPv4, IPv6, or IPv6 with a
     zone, and this only has to reject what cannot be an address — empty,
     whitespace, control characters, a header injection, or something long
     enough to be a payload rather than an identifier.

     Exported so a CALLER can decide what to do about an unusable value. This
     module does not decide policy: buildRateLimitKeys keeps its existing
     behaviour of simply deriving no key, and the staff route treats that as a
     refusal. */
  const MAX_ADDRESS_LENGTH = 64;
  /* Letters generally, not just hex: an IPv6 zone identifier is an interface
     name — `fe80::1%eth0` — and rejecting it would refuse a legitimate
     caller. What stays out is everything an address never contains:
     whitespace, quotes, semicolons, commas, slashes, angle brackets and
     control characters. */
  const ADDRESS_SHAPE = /^[0-9A-Za-z:.%_-]+$/;

  const isUsableAddress = value => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ADDRESS_LENGTH) return false;
    if (trimmed !== value) return false;          /* readAddress already trimmed */
    return ADDRESS_SHAPE.test(trimmed);
  };

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
     configured — the caller decides whether that is fatal.

     `namespace` prefixes the HMAC input so one caller's traffic cannot be
     charged to another caller's bucket. Omitted, it is the empty string, which
     is what the public endpoint has always derived — its keys are unchanged.

     `includeSession: false` builds an address-only key set, which is what a
     pre-authentication pass has to use: there is no session or operator to
     count against until a token has been verified. */
  const buildRateLimitKeys = ({
    headers, sessionId = null, env = {}, hmacFn,
    namespace = NAMESPACES.public, includeSession = true
  } = {}) => {
    const secret = env.CED_RATE_LIMIT_SECRET || '';
    if (!secret || typeof hmacFn !== 'function') return [];

    const keys = [];
    const address = readAddress(headers);
    const addressKey = deriveKey(hmacFn, secret, 'address', address && `${namespace}${address}`);
    if (addressKey) keys.push({ scope: 'address', key: addressKey });

    if (includeSession) {
      const sessionKey = deriveKey(hmacFn, secret, 'session', sessionId && `${namespace}${sessionId}`);
      if (sessionKey) keys.push({ scope: 'session', key: sessionKey });
    }

    return keys;
  };

  /* `names` names the two environment variables to read, so one function
     serves the public policy and the staff policies without any of them
     being able to read another's number. */
  const policyFrom = (env, names, defaults) => {
    const windowSeconds = Number(env[names.window]) > 0
      ? Math.floor(Number(env[names.window]))
      : defaults.windowSeconds;
    const maxRequests = Number(env[names.max]) > 0
      ? Math.floor(Number(env[names.max]))
      : defaults.maxRequests;
    return { windowSeconds, maxRequests };
  };

  const rateLimitPolicy = (env = {}) => policyFrom(env, {
    window: 'CED_RATE_LIMIT_WINDOW_SECONDS',
    max: 'CED_RATE_LIMIT_MAX_REQUESTS'
  }, DEFAULTS);

  const staffRateLimitPolicy = (env = {}) => policyFrom(env, {
    window: 'CED_STAFF_RATE_LIMIT_WINDOW_SECONDS',
    max: 'CED_STAFF_RATE_LIMIT_MAX_REQUESTS'
  }, STAFF_DEFAULTS);

  const staffSignInRateLimitPolicy = (env = {}) => policyFrom(env, {
    window: 'CED_STAFF_SIGNIN_RATE_LIMIT_WINDOW_SECONDS',
    max: 'CED_STAFF_SIGNIN_RATE_LIMIT_MAX_REQUESTS'
  }, STAFF_SIGNIN_DEFAULTS);

  const staffSessionRateLimitPolicy = (env = {}) => policyFrom(env, {
    window: 'CED_STAFF_SESSION_RATE_LIMIT_WINDOW_SECONDS',
    max: 'CED_STAFF_SESSION_RATE_LIMIT_MAX_REQUESTS'
  }, STAFF_SESSION_DEFAULTS);

  const API = {
    DEFAULTS, STAFF_DEFAULTS, STAFF_SIGNIN_DEFAULTS, STAFF_SESSION_DEFAULTS,
    SCOPES, NAMESPACES,
    ADDRESS_HEADERS, readAddress, isUsableAddress, MAX_ADDRESS_LENGTH,
    buildRateLimitKeys,
    rateLimitPolicy, staffRateLimitPolicy, staffSignInRateLimitPolicy,
    staffSessionRateLimitPolicy
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDRateLimit = API;
})();
