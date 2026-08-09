/* ============================================================
   CED Intelligence Platform — staff identity-resolution route
   ------------------------------------------------------------
   The authenticated half of the API. Everything else in api/ is
   deliberately public and unauthenticated, because the people
   filling in an assessment have no account. This one is the
   opposite, and it is kept structurally separate for that reason:
   a shared handler with a "is this the staff path" branch is one
   edit away from the branch being wrong.

   WHY THIS FILE IS NOT IN api/. Vercel deploys every file under
   api/ as its own function. While the implementation lived at
   api/staff-identity-resolution.mjs the platform deployed it
   TWICE — once at /api/staff-identity-resolution, unconfigured
   and reachable, and once through the catch-all that the console
   actually calls. A second deployment of a privileged route is a
   second thing to secure for no benefit, so the implementation
   lives outside the routing surface and exactly one entrypoint
   imports it: api/staff/identity-resolution/[...path].mjs.

   Vercel Function, Web Standard Request/Response — the same
   contract api/assessments.mjs and api/analytics.mjs declare, and
   the reason the entrypoint's default export is a one-argument
   wrapper rather than handleRequest itself. handleRequest's second
   parameter is a dependency-injection seam for the tests;
   exporting it as the platform entrypoint would make the
   platform's second argument, whatever it turns out to be, look
   like injected dependencies.

   THE AUTHORIZATION CHAIN, in order, every request:

     1. HTTPS.
     2. Proof the request came from the console, and — where a
        body is sent — a JSON content type. BOTH BEFORE ANY RATE
        LIMIT. This route serves exactly one browser console on
        one origin, so a request from anywhere else is refused
        before it can cost a bucket, a body read, an Auth call or
        a database round trip. Without it, `fetch` from any page
        an operator happens to open is a CORS *simple* request —
        no preflight to fail — and although the attacker cannot
        read the answer, the request is still counted, and a few
        dozen of them lock the operator out of their own console.

        The proof is METHOD-SENSITIVE, because browsers are. An
        unsafe method carries an exact-matched Origin. A safe one
        (GET, HEAD) carries an Origin only when it is cross-origin,
        so a same-origin read is judged on Sec-Fetch-Site instead
        — same-origin or none, never same-site. See assertOrigin.
     3. A pre-authentication rate limit, by address alone. It is
        before step 5 because that is an outbound call to Supabase
        Auth, and an unauthenticated caller must not be able to
        make us issue one per request forever.
     4. Sign-in, if this is a sign-in request — under its own,
        much tighter budget, and with no bearer token involved.
        Refresh and sign-out are NOT sign-in and are counted
        separately: they present a token this server issued and
        cannot be used to guess one.
     5. A bearer access token, verified by Supabase Auth.
     6. The immutable auth user UUID taken from the verified token.
        Never the email: emails change and are reassigned, and an
        actor identifier that can be reassigned is not one.
     7. A rate limit bound to that operator.
     8. AAL2 and a LIVE staff_operators lookup, in the database,
        BEFORE any case row or stored payload is read.

   Step 8 runs before the reads, not alongside them. The mutation
   repeats it inside its own transaction, which is where the
   guarantee lives — but repeating it there is defence in depth,
   not the whole defence. Reading a submission's raw_payload with
   the server credential on behalf of somebody who turns out not
   to be an operator is a read that should never have happened,
   even though nothing about it reaches the caller.

   A JWT can say `staff` for the rest of its hour after the row
   was disabled, so a claim may decorate the interface and may
   never be the decision. Revocation has to stop the next request,
   not the next token refresh, and the only thing that can promise
   that is a lookup.

   The browser never touches an identity table and never calls a
   privileged function. The console page holds no Supabase key at
   all; the onboarding page holds the PUBLISHABLE key, which is
   the key Supabase publishes for browser clients and which grants
   nothing here — RLS is forced with no policies and no function
   is executable by `anon`. The SECRET key never leaves this
   function's environment, and no password, session token, TOTP
   code or TOTP secret is ever accepted by, returned by, or logged
   by any endpoint in this file. See the note above the route
   table for what that replaced and why.
   ============================================================ */

import { randomUUID, createHash, createHmac } from 'node:crypto';
import identity from '../shared/business-record/resolve-identity.js';
import staffNote from '../shared/security/staff-note.js';
import rateLimit from '../shared/security/rate-limit.js';
import bodyReader from '../shared/security/read-body.js';
import originPolicy from '../shared/security/origin.js';
import supabaseOriginPolicy from '../shared/security/supabase-origin.js';

const { screenResolutionNote } = staffNote;
const {
  buildRateLimitKeys, staffRateLimitPolicy, staffSignInRateLimitPolicy,
  staffSessionRateLimitPolicy, NAMESPACES
} = rateLimit;
const { readBoundedBody, parseJsonSafely, OUTCOME: BODY } = bodyReader;
const { configuredOrigins, isAllowedOrigin } = originPolicy;
const { validateSupabaseOrigin, validateLocalSupabaseOrigin } = supabaseOriginPolicy;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8192;
const MAX_NOTE = 2000;
const MIN_NOTE = 8;
const MIN_SUBSTANTIVE_NOTE = 40;

/* ---------- what onboarding does NOT come through here ----------
   An earlier version of this file carried two onboarding endpoints that
   accepted the invitation token and the new password, and returned the
   Supabase session, the TOTP secret and the otpauth URI. That was wrong, and
   it was wrong in the direction this repository is least willing to be wrong
   in: CLAUDE.md §9 says this platform never stores or transmits passwords,
   tokens or other credentials, and those endpoints did all of it.

   The reasoning that produced them — "the browser must hold no Supabase key"
   — confused two different keys. The SECRET key must never reach a browser.
   The PUBLISHABLE key is designed for exactly that: it is what every
   documented Supabase browser client uses, it carries no privilege of its
   own, and every table has RLS enabled and FORCED with no policies so it can
   read nothing. Avoiding a public key by routing private credentials through
   a CED function traded a non-problem for a real one.

   Onboarding is now done by the browser, directly with Supabase Auth, using
   the vendored supported client. The only thing this route still does for it
   is answer `GET /auth-config` with the project URL and the publishable key —
   neither of which is a credential, and neither of which is any of the seven
   values that must never touch a CED endpoint. */

const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');

/* Hosts on which CED_ALLOW_INSECURE_STAFF may be honoured at all. The switch
   exists so the console can be driven over plain http by the browser suite
   and by `npm run serve`; it must never be the reason a real deployment
   accepts an unencrypted staff request.

   Loopback only, and 0.0.0.0 is deliberately NOT here: it is the unspecified
   address, not a loopback one, and the documentation says loopback. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/* The approved vocabulary. A free-text reason would be unauditable, and
   "other" without a substantive explanation is the same as no reason. */
const OVERRIDE_REASONS = Object.freeze([
  'verified_same_business',
  'business_rebrand',
  'contact_information_changed',
  'source_information_incorrect',
  'other_verified_evidence'
]);

class StaffError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new StaffError(status, code, message); };

/* ---------- token and key material ----------
   Decoding is used for two things: reading the AAL from an access token this
   server has already had verified, and recognising a key that is obviously
   the wrong one. Neither is a trust decision on an unverified signature. */
const decodeClaims = token => {
  const parts = String(token).split('.');
  if (parts.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) || {};
  } catch { return {}; }
};

/* Supabase issues two recognisable shapes for each privilege level: the
   current `sb_secret_` / `sb_publishable_` prefixes, and legacy JWTs whose
   payload carries `role`. Both are checked, and anything unrecognised is
   left alone — a key we cannot classify is not evidence of anything. */
const looksElevated = value => {
  const v = String(value || '');
  if (!v) return false;
  if (v.startsWith('sb_secret_')) return true;
  return decodeClaims(v).role === 'service_role';
};

const looksBrowserSafe = value => {
  const v = String(value || '');
  if (!v) return false;
  if (v.startsWith('sb_publishable_')) return true;
  return decodeClaims(v).role === 'anon';
};

/* ---------- environment keys ----------
   Supabase renamed its keys: `publishable` for the low-privilege key and
   `secret` for the elevated one. The old `anon` and `service_role` names
   still work on existing projects, so both are accepted and the current
   name is preferred. Which one was used is never logged — the NAME is not
   sensitive but the habit of logging around key material is.

   The two are kept strictly apart, and the separation FAILS CLOSED in both
   directions rather than merely being separate variables. A secret key put
   in the publishable variable is not returned, so the route answers
   `auth_unavailable` instead of quietly performing token verification with
   an elevated credential; a publishable key put in the secret variable is
   not returned either. Neither mistake becomes a silent privilege change. */
const lowPrivilegeKey = env => {
  const chosen = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
  return looksElevated(chosen) ? '' : chosen;
};

const elevatedKey = env => {
  const chosen = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  return looksBrowserSafe(chosen) ? '' : chosen;
};

/* Structured, identifiers-only, same rule as the public route: no contact
   detail, no token, no identifier value, and no credential the sign-in
   endpoints were handed. The operator UUID is an internal id and is safe;
   an operator's email would not be. */
const makeLogger = (env, correlationId) => (level, event, fields = {}) => {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const configured = levels[(env.CED_LOG_LEVEL || 'info').toLowerCase()] ?? 2;
  if ((levels[level] ?? 2) > configured) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, correlationId, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const json = (status, body, correlationId, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      /* A staff surface is never cached and never framed. */
      'Cache-Control': 'no-store',
      'X-Correlation-Id': correlationId,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders
    }
  });

/* ---------- the Supabase Auth client ----------
   Built per request and never cached: it carries a signed-in session in
   memory during sign-in, and two concurrent invocations sharing one instance
   would be two operators sharing one session. `persistSession` is off for the
   same reason. */
const defaultAuthClient = async env => {
  const key = lowPrivilegeKey(env);
  if (!env.SUPABASE_URL || !key) {
    fail(503, 'auth_unavailable', 'Staff authentication is not configured.');
  }
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
};

/* ---------- token verification ----------
   Asks Supabase Auth to verify the token and hand back the user. The AAL is
   read from the verified token's own claims, which is legitimate: AAL is a
   property of the SESSION, established at sign-in, and the token is
   signature-verified before it is read. What is never read from a claim is
   whether this person may work the queue. */
const defaultVerifyToken = async (token, env, makeAuthClient) => {
  const client = await makeAuthClient(env);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data || !data.user) return null;
  const claims = decodeClaims(token);
  return {
    userId: data.user.id,
    aal: claims.aal || null,
    emailConfirmed: Boolean(data.user.email_confirmed_at || data.user.confirmed_at)
  };
};

/* Cached per resolved credential rather than globally: a process that sees a
   different URL or key must build a different client, not reuse the first
   one it happened to make. */
let cachedServiceClient = null;
const getServiceClient = async env => {
  const url = env.SUPABASE_URL || '';
  const key = elevatedKey(env);
  if (!url || !key) {
    fail(503, 'database_unavailable', 'The staff console is not configured.');
  }
  if (cachedServiceClient && cachedServiceClient.url === url && cachedServiceClient.key === key) {
    return cachedServiceClient.client;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  cachedServiceClient = { url, key, client };
  return client;
};

/* ---------- request hashing ----------
   The idempotency contract: the same request id with the same inputs is a
   retry; the same id with different inputs is a mistake, and a mistake that
   resolves a case against a different record is exactly the mistake this
   whole subsystem exists to prevent. Hash the decision, not the note's
   whitespace.

   The OPERATOR is part of the decision. A resolution is attributed to a
   person, so a second operator reusing the first one's request id must be
   refused rather than handed the first one's outcome and told they resolved
   it. The database enforces the same thing independently, against the ledger
   row's own operator column. */
const requestHash = ({ caseId, targetBusinessId, operatorUserId, overrideConflict, overrideReason }) =>
  createHash('sha256').update(JSON.stringify([
    'link_existing', caseId, targetBusinessId, operatorUserId || null,
    overrideConflict === true, overrideReason || null
  ])).digest('hex');

/* ---------- the postgrest error surface ----------
   Every refusal the mutation raises is named. Mapping them here keeps the
   status codes in one place and keeps the raw database message — which can
   name a constraint or a table — out of the response. */
const DB_ERRORS = Object.freeze({
  staff_unauthenticated:          [401, 'unauthenticated'],
  staff_aal2_required:            [403, 'aal2_required'],
  staff_not_an_operator:          [403, 'not_an_operator'],
  staff_operator_disabled:        [403, 'operator_disabled'],
  staff_insufficient_role:        [403, 'insufficient_role'],
  case_not_found:                 [404, 'case_not_found'],
  case_already_resolved:          [409, 'case_already_resolved'],
  target_not_a_candidate:         [422, 'target_not_a_candidate'],
  target_missing:                 [404, 'target_missing'],
  target_merged_away:             [409, 'target_merged_away'],
  target_not_canonical:           [409, 'target_not_canonical'],
  submission_missing:             [404, 'submission_missing'],
  submission_already_attached:    [409, 'submission_already_attached'],
  signals_payload_mismatch:       [409, 'evidence_mismatch'],
  material_conflict:              [409, 'material_conflict'],
  override_not_applicable:        [422, 'override_not_applicable'],
  override_reason_required:       [422, 'override_reason_required'],
  override_note_required:         [422, 'override_note_required'],
  resolution_note_required:       [422, 'resolution_note_required'],
  resolution_request_required:    [422, 'resolution_request_required'],
  resolution_request_conflict:    [409, 'request_conflict'],
  staff_bootstrap_already_done:   [409, 'bootstrap_already_done'],
  staff_bootstrap_user_unconfirmed: [403, 'email_unconfirmed'],
  staff_bootstrap_user_required:  [422, 'invalid_request']
});

const classifyDbError = error => {
  const raw = String(error?.message || '');
  const name = raw.split(':')[0].trim();
  const mapped = DB_ERRORS[name];
  if (mapped) return { status: mapped[0], code: mapped[1], message: raw.slice(0, 300) };
  /* Unmapped: the caller learns that it failed and nothing about the schema. */
  return { status: 500, code: 'resolution_failed', message: 'The resolution could not be completed.' };
};

/* ---------- evidence, re-derived server-side ----------
   The conflict rule needs the submission's normalized signals, and they are
   not persisted for a submission that never resolved. They are re-derived
   here from the stored raw_payload with the same committed functions
   ingestion used, and the mutation refuses them unless the payload hash
   matches the submission they claim to describe. Nothing in the request
   body contributes: a browser cannot supply, alter, or omit evidence. */
const signalsForSubmission = submission => {
  const signals = identity.persistableSignals(
    identity.extractIdentitySignals(submission.raw_payload || {}));
  return signals.map(s => ({ type: s.type, normalizedValue: s.normalizedValue }));
};

/* BOUNDED WHILE READING, not measured afterwards. `request.text()` buffers the
   whole body first, so an 8 KB limit checked after it has already been read
   limits nothing an attacker sends. readBoundedBody counts UTF-8 bytes as
   they arrive, refuses a declared Content-Length over the limit without
   opening the stream at all, and cancels the stream at the byte that crosses
   it. Same primitive, same limits, same reasoning as the public endpoint. */
/* ---------- path segments ----------
   decodeURIComponent throws a URIError on a malformed escape — `/cases/%` is
   enough — and an uncaught one lands in the generic handler as a 500, which is
   the same defect the strict UUID rule was added to fix one layer up. A
   segment that cannot be decoded is not a case id, and saying so is a 400.
   Returning null rather than the raw segment means the caller cannot
   accidentally carry an undecoded value into a database parameter. */
const decodeSegment = value => {
  try { return decodeURIComponent(value); } catch { return null; }
};

const caseIdFrom = segment => {
  const decoded = decodeSegment(segment);
  if (decoded === null || !UUID_RE.test(decoded)) {
    fail(400, 'invalid_case_id', 'A case id must be a UUID.');
  }
  return decoded;
};

const readBody = async request => {
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (read.outcome === BODY.tooLarge) {
    fail(413, 'body_too_large', 'The request body is too large.');
  }
  if (read.outcome === BODY.invalidEncoding) {
    fail(400, 'invalid_encoding', 'The request body is not valid UTF-8.');
  }
  if (read.outcome === BODY.readFailed) {
    fail(400, 'body_read_failed', 'The request body could not be read.');
  }
  if (!read.text) return {};
  const parsed = parseJsonSafely(read.text);
  /* Neither the body nor any part of it is echoed: it may be a password. */
  if (!parsed.ok) fail(400, 'invalid_json', 'The request body is not valid JSON.');
  return parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
};

/* ---------- transport ----------
   HTTPS only. This surface is exempt from the file:// rule the public pages
   follow, and the reason it is exempt is that it must be served over TLS —
   so it refuses anything else rather than inheriting the exemption without
   the condition.

   CED_ALLOW_INSECURE_STAFF is a LOCAL-DEVELOPMENT switch and fails closed
   everywhere else. An environment variable is the easiest thing in the world
   to set on the wrong project, so it is not sufficient on its own: the host
   must also be a loopback address, and NODE_ENV must not be production.
   Both conditions, so neither a stray variable nor a stray hostname is
   enough by itself. */
const insecureAllowed = (env, url) => {
  if (String(env.CED_ALLOW_INSECURE_STAFF || '') !== 'true') return false;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return LOCAL_HOSTS.has(url.hostname);
};

/* ---------- origin ----------
   The console is served from the same origin as this route, so the default
   allowlist is that origin and nothing else — a deployment needs no
   configuration to be correct, and adding CED_STAFF_ALLOWED_ORIGINS is how a
   split-host deployment states its intent explicitly.

   Deliberately NOT CED_ALLOWED_ORIGINS. That list is the marketing verticals'
   audience, and a vertical has no business reaching a staff endpoint; sharing
   the list would silently widen this one every time a vertical launched. */
const staffOrigins = (env, url, request) => {
  const configured = configuredOrigins(env, 'CED_STAFF_ALLOWED_ORIGINS');
  if (configured.length) return configured;
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return [`${proto}://${url.host}`];
};

/* The methods for which a browser omits Origin. RFC 9110 calls GET and HEAD
   safe, and they are the only two this route serves in that class. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/* The only two Sec-Fetch-Site values that mean "this came from us".

     same-origin  the console calling its own API — the queue and case reads.
     none         a user-initiated load with no initiator: a typed URL or a
                  bookmark. Not reachable by another site's script.

   `same-site` is DELIBERATELY ABSENT. It means a sibling registrable domain —
   anything under the same eTLD+1 — and a staff console that performs permanent,
   unerasable attachments must not inherit trust from whatever else is hosted
   next to it. Treating it as equivalent to same-origin would hand the queue to
   any subdomain somebody stands up later. */
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);

/* THE ORIGIN GATE, AND WHY IT IS METHOD-SENSITIVE.
   ------------------------------------------------------------
   The rule used to be "Origin is required on every request, GET included".
   That is not a rule a browser can satisfy. Per the Fetch standard, an Origin
   header is appended when a request's response tainting is `cors` OR its
   method is neither GET nor HEAD. A SAME-ORIGIN fetch keeps response tainting
   `basic`, so a same-origin GET carries NO Origin — and an Authorization
   header does not change that, because it forces a preflight only on
   cross-origin requests. Same-origin requests never preflight.

   The consequence was not subtle: the console signed in (POSTs do carry
   Origin) and then every queue listing and every case read was refused
   403 origin_required. The queue was unreachable in every standards-compliant
   browser. It passed every test only because the synthetic suites attached an
   Origin by hand and the browser suite replaced window.fetch, so no real
   request was ever made. tests/browser/staff-origin-headers.test.mjs now
   observes the real headers instead of assuming them.

   WHAT REPLACED IT, without giving anything up:

     Origin present  — exact-matched against the allowlist, whatever the
                       method. Unchanged. This is also what keeps an approved
                       non-browser client working: it states an Origin and is
                       held to it.
     Origin absent   — allowed ONLY for a safe method AND only on the evidence
                       of Fetch Metadata, which a cross-site caller cannot
                       forge: Sec-Fetch-Site is set by the browser and is
                       forbidden to script. Anything else — an unsafe method,
                       a missing header, cross-site, same-site, or a value
                       this route does not recognise — is refused.

   The property the old rule was protecting is intact. A cross-site
   `fetch('/…/cases')` is still a simple request with no preflight to fail, and
   it still cannot read the answer — but it now arrives carrying
   Sec-Fetch-Site: cross-site and is refused here, before it can spend the
   pre-authentication budget that belongs to the operator. */
const assertOrigin = (request, env, url) => {
  const origin = request.headers.get('origin');

  /* Stated, so held to it — including by a non-browser client that supplies
     one deliberately. `null` and malformed values fail isAllowedOrigin. */
  if (origin) {
    if (!isAllowedOrigin(origin, staffOrigins(env, url, request))) {
      fail(403, 'origin_not_allowed', 'Origin is not permitted to call this endpoint.');
    }
    return;
  }

  /* No Origin. An unsafe method without one is not a browser this route
     serves, and it is the shape a forged write would take. */
  if (!SAFE_METHODS.has(String(request.method || '').toUpperCase())) {
    fail(403, 'origin_required', 'This endpoint accepts staff-console requests only.');
  }

  /* A safe read, judged on Fetch Metadata alone. Exact token match: the values
     are lowercase tokens in the specification, so anything else — a list from
     two joined headers, a casing variant, an invented value — is unrecognised
     and therefore refused rather than guessed at. */
  const site = (request.headers.get('sec-fetch-site') || '').trim();
  if (site === 'cross-site' || site === 'same-site') {
    fail(403, 'origin_not_allowed', 'Origin is not permitted to call this endpoint.');
  }
  if (!SAFE_FETCH_SITES.has(site)) {
    fail(403, 'origin_required', 'This endpoint accepts staff-console requests only.');
  }
};

/* A JSON body is declared as JSON. `text/plain` is what a cross-site simple
   request uses to dodge a preflight, so refusing it removes the shape of the
   attack rather than only its consequences. A charset parameter is legitimate
   and is allowed; nothing else is. */
const assertJsonContentType = request => {
  const raw = String(request.headers.get('content-type') || '');
  const [type, ...params] = raw.split(';').map(s => s.trim());
  const ok = type.toLowerCase() === 'application/json'
    && params.every(p => /^charset=("?)utf-?8\1$/i.test(p));
  if (!ok) {
    fail(415, 'unsupported_media_type', 'A JSON request body is required.');
  }
};

/* ---------- sign-in ----------
   WHY THE SERVER PERFORMS IT.

   The console has no build step, no bundler and no module loader, so there is
   no supported way to put @supabase/supabase-js in the browser without either
   vendoring a generated bundle into the repository or loading one from a
   third-party CDN. Both were refused. What is left is the arrangement this
   repository already describes everywhere else: the browser talks to
   /api/staff/..., and the route holds the keys.

   So the supported client is used — on this side of the wire. No part of the
   Supabase Auth protocol is hand-rolled, no key of any privilege reaches the
   browser, and the publishable key never leaves the function environment.

   The cost is that a password crosses this function. It is never logged,
   never stored, never echoed, and the endpoint is behind both the
   pre-authentication address limit and its own much tighter sign-in limit. */

/* ---------- sign-out scope ----------
   ALWAYS LOCAL, EVERYWHERE, AND NEVER THE DEFAULT.

   @supabase/supabase-js signs out GLOBALLY unless told otherwise —
   `async signOut(options = { scope: 'global' })` — which revokes every refresh
   token the user holds, on every device. Three of the four calls below sit on
   the ORDINARY sign-in path, including the one that runs when a correct
   password is waiting for its code, so the default turned two facts into
   defects:

     · signing in on a laptop silently killed the session on the desktop; and
     · somebody holding only the password could POST it repeatedly and evict
       the real operator from a live aal2 session over and over — which is
       precisely the thing a second factor exists to prevent.

   Local scope revokes exactly the session this per-request client is holding
   and nothing else. It is written out at every call site rather than wrapped
   once, because a wrapper is a place the argument can quietly go missing
   again; and it is passed explicitly rather than relied upon, because the
   library's default is the wrong one. */
const SIGN_OUT_LOCAL = Object.freeze({ scope: 'local' });

/* Revokes the session the client currently holds, and only that one.
   Best effort: the caller is already refusing the request, and a sign-out that
   cannot be delivered must not turn a 401 into a 500. */
const discardLocalSession = async client => {
  try { await client.auth.signOut(SIGN_OUT_LOCAL); } catch { /* best effort */ }
};

const verifiedTotpFactor = factors => {
  const all = (factors && (factors.all || factors.totp)) || [];
  return all.find(f => f && f.status === 'verified'
    && (f.factor_type === 'totp' || f.factorType === 'totp')) || null;
};

const sessionPayload = (session, user) => {
  const accessToken = session.access_token;
  const claims = decodeClaims(accessToken);
  /* AAL2 is CONFIRMED, not assumed. A second factor that was verified but
     produced an aal1 session is not a second factor as far as this route is
     concerned, and the database would refuse it anyway. */
  if (claims.aal !== 'aal2') {
    fail(403, 'aal2_required',
      'The second factor did not raise this session to the required assurance level.');
  }
  return {
    accessToken,
    refreshToken: session.refresh_token || null,
    /* Seconds since the epoch, so the browser can refresh before expiry
       rather than discovering it through a 401 mid-resolution. */
    expiresAt: Number(session.expires_at) || (claims.exp ? Number(claims.exp) : null),
    userId: (user && user.id) || claims.sub || null
  };
};

const handleSignIn = async (body, client, log) => {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const totp = typeof body.totp === 'string' ? body.totp.trim() : '';

  if (!email || !password) {
    fail(422, 'credentials_required', 'An email address and password are required.');
  }

  const { data: signedIn, error: signInError } =
    await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn || !signedIn.session) {
    log('warn', 'staff_sign_in_rejected', { stage: 'password' });
    fail(401, 'invalid_credentials', 'Sign-in failed. Check your details and try again.');
  }

  /* PAST THIS LINE A LIVE aal1 SESSION EXISTS on this per-request client, and
     every exit that is not a completed aal2 sign-in has to revoke it. The
     `finally` is what makes that true of exits nobody enumerated — a refusal
     added later, a shape Supabase returns that this code did not expect, an
     assertion inside sessionPayload — rather than only of the four that
     happened to be written out. `issued` is the single fact it turns on. */
  let issued = null;
  try {
    const { data: factors } = await client.auth.mfa.listFactors();
    const factor = verifiedTotpFactor(factors);

    if (!factor) {
      /* An account that cannot reach aal2 can do nothing here, and a live
         token is still a live token. */
      log('warn', 'staff_sign_in_rejected', { stage: 'no_verified_factor' });
      fail(403, 'mfa_enrollment_required',
        'This account has no verified authenticator app. Ask an owner to complete '
        + 'second-factor enrollment before signing in; identity resolution cannot be '
        + 'used without one.');
    }

    if (!totp) {
      /* The password was right and a factor exists, so ask for the code. The
         aal1 session is discarded rather than parked: the second call signs in
         again from scratch, which keeps this endpoint stateless. */
      return { ok: true, needsSecondFactor: true };
    }

    const { data: verified, error: mfaError } =
      await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp });
    if (mfaError || !verified || !verified.access_token) {
      log('warn', 'staff_sign_in_rejected', { stage: 'second_factor' });
      fail(401, 'invalid_second_factor', 'That authentication code was not accepted.');
    }

    /* Throws when the verified session did not actually reach aal2. The
       session that challengeAndVerify just saved on this client is the one
       the finally below then revokes — a half-raised session is not left
       behind because it was refused for the right reason. */
    const session = sessionPayload(verified, signedIn.user);
    log('info', 'staff_sign_in', { operatorUserId: session.userId });
    issued = session;
    return { ok: true, session };
  } finally {
    if (!issued) await discardLocalSession(client);
  }
};

const handleRefresh = async (body, client, log) => {
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (!refreshToken) fail(422, 'refresh_token_required', 'A refresh token is required.');

  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data || !data.session) {
    log('warn', 'staff_refresh_rejected', {});
    fail(401, 'unauthenticated', 'This session can no longer be refreshed. Sign in again.');
  }

  /* The rotated session is live on this client from here, so the same rule as
     sign-in applies: anything short of a confirmed aal2 result revokes it
     locally rather than orphaning a token nobody will ever use again. */
  let issued = null;
  try {
    /* sessionPayload re-confirms aal2 on the NEW token, so a refresh that
       quietly came back at aal1 is refused rather than carried. */
    issued = sessionPayload(data.session, data.user);
    return { ok: true, session: issued };
  } finally {
    if (!issued) await discardLocalSession(client);
  }
};

/* Revokes THIS browser's session and no other. The client is a fresh
   per-request one, so it has to be given the session before it can revoke it —
   setSession is what populates it, and without that call signOut would have
   nothing to act on and would silently succeed at doing nothing.

   Local scope, deliberately: an operator signing out of the console is saying
   something about this browser. Signing them out of a second machine they are
   also using would be a decision they did not take, and the library's default
   would have taken it for them. */
const handleSignOut = async (body, client) => {
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
  if (refreshToken && accessToken) {
    try {
      await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      await client.auth.signOut(SIGN_OUT_LOCAL);
    } catch { /* best effort: the browser clears its own state regardless */ }
  }
  return { ok: true };
};


/* ============================================================
   handleRequest
   ============================================================ */
export async function handleRequest(request, deps = {}) {
  const env = deps.env || process.env;
  const correlationId = deps.correlationId || (deps.randomUUID || randomUUID)();
  const log = makeLogger(env, correlationId);

  try {
    const url = new URL(request.url);
    /* Matched by SUFFIX throughout. The function is reached at
       /api/staff/identity-resolution/… through filesystem routing, and the
       original path arrives intact — but a suffix match also survives any
       future rewrite that changes the prefix, and a prefix match would fail
       silently and look like a 404. */
    const path = url.pathname.replace(/\/+$/, '');

    const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
    if (proto !== 'https' && !insecureAllowed(env, url)) {
      fail(403, 'https_required', 'The staff console requires HTTPS.');
    }

    /* ---------- 2. provenance, then content type ----------
       BEFORE the rate limiter, before the body, before Supabase, before the
       operator guard and before any privileged read. A request from somewhere
       other than the console is not a request this route rations, answers, or
       spends anything on — it is one it declines.

       Method-sensitive: an exact Origin on an unsafe method, Fetch Metadata on
       a same-origin read that a browser sends no Origin for. Both refusals
       happen here, so neither costs a bucket. */
    assertOrigin(request, env, url);
    if (request.body) assertJsonContentType(request);

    /* The elevated client, built at most once per request and only when
       something actually needs it. */
    let dbPromise = null;
    const database = () => {
      if (deps.db) return Promise.resolve(deps.db);
      if (!dbPromise) dbPromise = getServiceClient(env);
      return dbPromise;
    };

    /* One rate-limit pass. Returns a Response when the caller must be
       refused, and null when they may continue. Nothing about the bucket, the
       address or the operator reaches the caller — only how long to wait. */
    const limitPass = async ({ namespace, policy, sessionId = null, includeSession, event }) => {
      const keys = buildRateLimitKeys({
        headers: request.headers, sessionId, env, hmacFn: hmac, namespace, includeSession
      });
      if (!keys.length) {
        if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
          /* No secret configured means no rate limiting at all — visible, not silent. */
          log('error', 'staff_rate_limit_not_configured', { pass: event });
        }
        return null;
      }
      const db = await database();
      const { data: limit, error: limitError } = await db.rpc('check_rate_limit', {
        p_keys: keys,
        p_window_seconds: policy.windowSeconds,
        p_max_requests: policy.maxRequests
      });
      if (limitError) {
        /* A rate limiter that cannot answer must not take the console down
           with it; every other layer still applies. */
        log('warn', 'staff_rate_limit_unavailable', { pass: event, reason: 'rpc_error' });
        return null;
      }
      if (limit && limit.allowed === false) {
        const retryAfter = Number(limit.retryAfterSeconds) > 0
          ? Math.ceil(Number(limit.retryAfterSeconds)) : policy.windowSeconds;
        log('warn', event, { retryAfter, ...(sessionId ? { operatorUserId: sessionId } : {}) });
        return json(429, {
          ok: false, code: 'rate_limited',
          message: 'Too many staff requests. Please try again shortly.'
        }, correlationId, { 'Retry-After': String(retryAfter) });
      }
      return null;
    };

    const staffPolicy = staffRateLimitPolicy(env);

    /* ---------- 3. pre-authentication, by address alone ----------
       BEFORE token verification, because verification is an outbound HTTPS
       call to Supabase Auth. Charged to its own namespace so a legitimate
       request is not also charged to the authenticated bucket below. */
    const preAuthRefusal = await limitPass({
      namespace: NAMESPACES.staffPreAuth,
      policy: staffPolicy,
      includeSession: false,
      event: 'staff_rate_limited_preauth'
    });
    if (preAuthRefusal) return preAuthRefusal;

    /* ---------- 4. the session endpoints ----------
       No bearer token, no operator, no database read.

       TWO BUDGETS, NOT ONE. /session is a credential attempt and keeps the
       tight bucket. /session/refresh and /session/signout are not: both
       present a token this server issued, neither can be used to guess one,
       and counting them as guesses meant a working console spent the budget
       its own operator needed to sign in again — while a refused refresh ends
       the session, so the tight bucket ejected the people it was protecting.
       Exactly one of the two passes runs, so a refusal in either can never
       consume the other. */
    const sessionRoute = path.match(/\/session(?:\/(refresh|signout))?$/);
    if (sessionRoute) {
      if (request.method !== 'POST') {
        return json(405, { ok: false, code: 'method_not_allowed', message: 'POST is required.' },
          correlationId, { Allow: 'POST' });
      }
      const maintenance = sessionRoute[1] === 'refresh' || sessionRoute[1] === 'signout';
      const sessionRefusal = await limitPass({
        namespace: maintenance ? NAMESPACES.staffSession : NAMESPACES.staffSignIn,
        policy: maintenance ? staffSessionRateLimitPolicy(env) : staffSignInRateLimitPolicy(env),
        includeSession: false,
        event: maintenance ? 'staff_rate_limited_session' : 'staff_rate_limited_signin'
      });
      if (sessionRefusal) return sessionRefusal;

      const body = await readBody(request);
      const makeAuthClient = deps.authClient || defaultAuthClient;
      const client = await makeAuthClient(env);

      if (sessionRoute[1] === 'refresh') {
        return json(200, await handleRefresh(body, client, log), correlationId);
      }
      if (sessionRoute[1] === 'signout') {
        return json(200, await handleSignOut(body, client), correlationId);
      }
      return json(200, await handleSignIn(body, client, log), correlationId);
    }

    /* ---------- 4a. the browser's Supabase configuration ----------
       The onboarding page talks to Supabase Auth directly, so it needs the
       project URL and the publishable key. It cannot be given them at build
       time: this repository has no build-time substitution anywhere, by
       design (CLAUDE.md §13), and inventing one to inline a value would be a
       larger change than reading it at runtime.

       NOTHING HERE IS A CREDENTIAL. The publishable key is the key Supabase
       publishes for browser clients; it grants nothing on its own, because
       every table has RLS enabled and FORCED with no policies and no execute
       grant on any function. `lowPrivilegeKey` is what reads it, so the
       cross-check applies in both directions and a SECRET key pasted into the
       publishable variable is refused rather than served to a browser.

       No body, no token, no password, no session, no secret. It is a GET, so
       a same-origin call carries no Origin and is judged on Fetch Metadata by
       the same gate as every other read. */
    if (/\/auth-config$/.test(path)) {
      if (request.method !== 'GET') {
        return json(405, { ok: false, code: 'method_not_allowed', message: 'GET is required.' },
          correlationId, { Allow: 'GET' });
      }
      /* THE SAME VALIDATOR THE BUILD USES, on the same variable, so the
         origin this hands the browser and the origin the browser is
         PERMITTED to reach by the generated connect-src cannot disagree.
         Two spellings of one host would be a blocked request at run time
         with nothing to explain it. `.origin` is returned rather than the raw
         value for the same reason: one host, one spelling. */
      let project = validateSupabaseOrigin(env.SUPABASE_URL);
      /* The local-development exception, behind the switch that already
         requires all three of the variable, a loopback request host and a
         non-production NODE_ENV. `insecureAllowed` is the same gate that
         lets this route answer over plain http at all, so a deployment
         cannot reach this branch. The BUILD has no such exception: it stays
         strict, so a published page never names a loopback origin. */
      if (!project.ok && insecureAllowed(env, url)) {
        project = validateLocalSupabaseOrigin(env.SUPABASE_URL);
      }
      const key = lowPrivilegeKey(env);
      if (!project.ok || !key) {
        /* The same refusal the Auth path gives, for the same reason and by
           the same rule: a crossed key is a misconfiguration, not a fallback.
           The reason is logged, never returned — it describes the
           deployment's configuration, not the caller's request. */
        log('error', 'staff_auth_config_unavailable', {
          reason: project.ok ? 'no_publishable_key' : project.reason
        });
        return json(503, {
          ok: false, code: 'auth_unavailable', message: 'Staff authentication is not configured.'
        }, correlationId);
      }
      return json(200, {
        ok: true, supabaseUrl: project.origin, publishableKey: key
      }, correlationId);
    }

    /* ---------- 5. the access token ---------- */
    const auth = request.headers.get('authorization') || '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!token) fail(401, 'unauthenticated', 'A staff access token is required.');

    const makeAuthClient = deps.authClient || defaultAuthClient;
    const verify = deps.verifyAccessToken || (t => defaultVerifyToken(t, env, makeAuthClient));
    const identityClaim = await verify(token);
    if (!identityClaim || !identityClaim.userId) {
      log('warn', 'staff_token_rejected', {});
      fail(401, 'unauthenticated', 'The access token is not valid.');
    }
    if (!UUID_RE.test(identityClaim.userId)) {
      fail(401, 'unauthenticated', 'The access token does not carry a usable account id.');
    }
    /* A confirmed email is a provisioning precondition, checked here so an
       unconfirmed invite cannot be used before it is accepted. */
    if (identityClaim.emailConfirmed === false) {
      fail(403, 'email_unconfirmed', 'This account has not confirmed its email address.');
    }

    const operatorUserId = identityClaim.userId;
    const aal = identityClaim.aal || null;

    /* ---------- 7. the operator-bound limit ----------
       A separate namespace from the pre-authentication pass, so one request
       is never charged twice to one bucket, and a separate namespace from the
       public endpoint, so console work and assessment submissions cannot
       consume each other's budget. */
    const authedRefusal = await limitPass({
      namespace: NAMESPACES.staff,
      policy: staffPolicy,
      sessionId: operatorUserId,
      includeSession: true,
      event: 'staff_rate_limited'
    });
    if (authedRefusal) return authedRefusal;

    const db = await database();

    /* ---------- 8. authorization, BEFORE anything is read ----------
       The authoritative guard, called directly rather than only reached
       through whichever RPC this request happens to want. A caller who is
       not a provisioned, active, AAL2 operator is refused here, so the
       privileged reads below never run on their behalf. The queue, the case
       detail and the mutation each call it again inside their own
       transaction; that repetition is deliberate and is not what this call
       is for. */
    const { error: guardError } = await db.rpc('staff_operator_guard', {
      p_user_id: operatorUserId, p_aal: aal
    });
    if (guardError) {
      const c = classifyDbError(guardError);
      log('warn', 'staff_authorization_refused', { operatorUserId, code: c.code });
      return json(c.status, { ok: false, code: c.code, message: c.message }, correlationId);
    }

    /* ---------- GET the queue ---------- */
    if (request.method === 'GET' && /\/cases$/.test(path)) {
      const limit = Number(url.searchParams.get('limit')) || 25;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const { data, error } = await db.rpc('staff_identity_queue', {
        p_operator_user_id: operatorUserId, p_aal: aal,
        p_limit: limit, p_offset: offset
      });
      if (error) {
        const c = classifyDbError(error);
        log('warn', 'staff_queue_refused', { operatorUserId, code: c.code });
        return json(c.status, { ok: false, code: c.code, message: c.message }, correlationId);
      }
      const rows = data || [];

      /* The total travels on the rows, so an empty page carries no total and
         used to report zero — telling an operator who paged past the end that
         the queue was empty. Ask for the first row instead, which is the only
         place the count is available. */
      let total = rows.length ? Number(rows[0].total_count) : 0;
      if (!rows.length && offset > 0) {
        const { data: head } = await db.rpc('staff_identity_queue', {
          p_operator_user_id: operatorUserId, p_aal: aal, p_limit: 1, p_offset: 0
        });
        total = (head && head.length) ? Number(head[0].total_count) : 0;
      }

      log('info', 'staff_queue_read', { operatorUserId, returned: rows.length });
      return json(200, {
        ok: true,
        total,
        limit, offset,
        cases: rows.map(r => ({
          caseId: r.identity_resolution_id,
          createdAt: r.created_at,
          ageSeconds: Number(r.age_seconds),
          resolutionStatus: r.resolution_status,
          recommendedAction: r.recommended_action,
          reviewType: r.review_type,
          confidence: r.confidence === null ? null : Number(r.confidence),
          candidateCount: Number(r.candidate_count),
          proposalKinds: r.proposal_kinds || [],
          agreedTypes: r.agreed_types || [],
          contradictedTypes: r.contradicted_types || [],
          escalationReason: r.escalation_reason,
          submittedLabel: r.submitted_label,
          resolvable: r.resolvable === true
        }))
      }, correlationId);
    }

    /* ---------- GET one case ----------
       The id is validated with the same strict UUID rule the body uses. A
       loose path pattern sent `------------------------------------` to a
       uuid parameter and got a PostgREST error back as a 500; a malformed id
       is a bad request and says so. */
    const detail = path.match(/\/cases\/([^/]+)$/);
    if (request.method === 'GET' && detail) {
      const caseId = caseIdFrom(detail[1]);
      const { data, error } = await db.rpc('staff_identity_case', {
        p_operator_user_id: operatorUserId, p_aal: aal, p_case_id: caseId
      });
      if (error) {
        const c = classifyDbError(error);
        return json(c.status, { ok: false, code: c.code, message: c.message }, correlationId);
      }
      log('info', 'staff_case_read', { operatorUserId, caseId });
      return json(200, { ok: true, case: data }, correlationId);
    }

    /* ---------- POST a link resolution ---------- */
    const link = path.match(/\/cases\/([^/]+)\/link$/);
    if (request.method === 'POST' && link) {
      const caseId = caseIdFrom(link[1]);
      const body = await readBody(request);

      const targetBusinessId = body.targetBusinessId;
      const resolutionRequestId = body.resolutionRequestId;
      const note = typeof body.note === 'string' ? body.note : '';
      const overrideConflict = body.overrideConflict === true;
      const overrideReason = body.overrideReason || null;

      if (!UUID_RE.test(String(targetBusinessId || ''))) {
        fail(422, 'invalid_target', 'A target Business Record id is required.');
      }
      if (!UUID_RE.test(String(resolutionRequestId || ''))) {
        fail(422, 'invalid_request_id', 'A resolution request id is required.');
      }
      if (note.trim().length < MIN_NOTE) {
        fail(422, 'resolution_note_required',
          `A resolution note of at least ${MIN_NOTE} characters is required.`);
      }
      if (note.length > MAX_NOTE) fail(422, 'note_too_long', 'The resolution note is too long.');

      /* The note is stored against the record and survives until a redaction
         runs. Screened with the same recognizers ingestion uses, and a
         refusal names the CATEGORY — never the value, which would put the
         thing we just refused to store into the response and the logs. */
      const screened = screenResolutionNote(note, identity);
      if (!screened.ok) {
        log('warn', 'staff_note_refused', { operatorUserId, caseId, category: screened.category });
        fail(422, 'note_contains_prohibited_data', screened.message);
      }

      if (overrideConflict) {
        if (!OVERRIDE_REASONS.includes(overrideReason)) {
          fail(422, 'override_reason_required', 'An approved override reason code is required.');
        }
        if (overrideReason === 'other_verified_evidence'
            && note.trim().length < MIN_SUBSTANTIVE_NOTE) {
          fail(422, 'override_note_required',
            'other_verified_evidence requires a substantive written explanation.');
        }
      } else if (overrideReason) {
        fail(422, 'override_not_applicable',
          'An override reason was supplied without an override.');
      }

      /* The submission and its stored payload, read server-side and only now
         that the operator guard above has already said yes. The browser
         supplies a case id and a target; it supplies no evidence. */
      const caseRow = (await db.from('identity_resolution_cases')
        .select('assessment_submission_id').eq('identity_resolution_id', caseId)).data?.[0];
      if (!caseRow) fail(404, 'case_not_found', 'No such identity-resolution case.');

      const { data: subs } = await db.from('assessment_submissions')
        .select('submission_id, raw_payload, payload_hash')
        .eq('submission_id', caseRow.assessment_submission_id);
      const submission = (subs || [])[0];
      if (!submission) fail(404, 'submission_missing', 'The case names a submission that no longer exists.');

      const signals = signalsForSubmission(submission);

      const { data, error } = await db.rpc('resolve_identity_case_link_existing', {
        p_operator_user_id: operatorUserId,
        p_aal: aal,
        p_case_id: caseId,
        p_target_business_id: targetBusinessId,
        p_resolution_request_id: resolutionRequestId,
        p_request_hash: requestHash({
          caseId, targetBusinessId, operatorUserId, overrideConflict, overrideReason
        }),
        p_note: note,
        p_signals: signals,
        p_payload_hash: submission.payload_hash,
        p_override_conflict: overrideConflict,
        p_override_reason: overrideReason
      });

      if (error) {
        const c = classifyDbError(error);
        log('warn', 'staff_resolution_refused',
          { operatorUserId, caseId, code: c.code, overrideConflict });
        return json(c.status, { ok: false, code: c.code, message: c.message }, correlationId);
      }

      log('info', 'staff_resolution_committed', {
        operatorUserId, caseId,
        businessId: data?.businessId || null,
        replayed: data?.replayed === true,
        conflictOverridden: data?.conflictOverridden === true,
        overrideReason: data?.overrideReason || null
      });
      return json(data?.replayed ? 200 : 201, { ok: true, resolution: data }, correlationId);
    }

    return json(404, { ok: false, code: 'not_found', message: 'No such staff endpoint.' }, correlationId);

  } catch (err) {
    if (err instanceof StaffError) {
      return json(err.status, { ok: false, code: err.code, message: err.message }, correlationId);
    }
    log('error', 'staff_route_error', { message: String(err?.message || '').slice(0, 200) });
    return json(500, { ok: false, code: 'internal_error', message: 'The request could not be completed.' },
      correlationId);
  }
}

/* Exported for tests and documentation generation.

   `defaultAuthClient` is here so the suite can exercise the PRODUCTION factory
   — the real @supabase/supabase-js client, with the real options — rather than
   only the injected stub. It is the same function handleRequest uses when
   `deps.authClient` is absent, which is always in a deployment: nothing reads
   an environment variable to decide, so there is no production-controllable
   path into the injection seam. `SIGN_OUT_LOCAL` is exported so a test pins
   the exact argument rather than restating the object and agreeing with
   itself. */
export const __testing = {
  requestHash, OVERRIDE_REASONS, classifyDbError, decodeClaims,
  lowPrivilegeKey, elevatedKey, looksElevated, looksBrowserSafe,
  insecureAllowed, LOCAL_HOSTS, verifiedTotpFactor,
  defaultAuthClient, SIGN_OUT_LOCAL, staffOrigins, decodeSegment,
  assertOrigin, SAFE_METHODS, SAFE_FETCH_SITES,
  MAX_BODY_BYTES, MAX_NOTE, MIN_NOTE, MIN_SUBSTANTIVE_NOTE
};
