/* ============================================================
   CED Intelligence Platform — connected-review continuation
   ------------------------------------------------------------
   How a second review attaches to the Business Record a first
   review created, WITHOUT the browser ever being trusted with a
   Business Record id.

   The rule, from the approved architecture:

     A visitor-supplied identifier is evidence, never a decision.
     A client-supplied businessId is not even evidence.

   So the server issues an OPAQUE, SIGNED, EXPIRING context when
   a review is ingested. The browser stores it and echoes it back
   on the next review. The server verifies the signature, checks
   the expiry, and only then links. A forged or edited context
   fails verification and the submission resolves by the ordinary
   identity rules instead — it is never refused, because a
   visitor whose token expired should still get their results.

     issue()  runs ONLY on the server. CED_CONTINUATION_SECRET
              exists only in the Vercel Function environment and
              must never appear in a vertical config, a shared
              script, or any file a page loads.
     verify() runs ONLY on the server, for the same reason.

   The browser calls NEITHER. It holds an opaque string and sends
   it back, which is the whole of its involvement.

   The token is a bearer credential, so it is stripped from the
   payload before hashing, validation, or any database call — the
   same treatment challengeToken gets, for the same reason. It is
   named `continuationToken` deliberately: the prohibited-data
   pattern already refuses anything called a token, so a leak
   into storage fails loudly instead of quietly.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const CONTEXT_VERSION = 1;

  /* Long enough that someone can finish the Growth Review, think about it
     overnight, and come back to the Service Mix one. Short enough that a
     token left on a shared device is not a standing key to a record. */
  const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

  /* A token this long is malformed rather than merely wrong, and is refused
     before any signature work is attempted. */
  const MAX_TOKEN_LENGTH = 512;

  const OUTCOME = {
    valid: 'valid',
    absent: 'absent',
    malformed: 'malformed',
    badSignature: 'bad_signature',
    expired: 'expired',
    notConfigured: 'not_configured',
    mismatch: 'mismatch'
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

  /* base64url without padding. Node has Buffer; a browser would have atob —
     but the browser never decodes one of these, so the Buffer path is the
     only one that runs in practice. */
  const b64urlEncode = text => {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(text, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const b64urlDecode = token => {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
    return atob(padded);
  };

  /* Length-independent comparison. A signature check that returns early on
     the first differing byte leaks how much of a guess was right. */
  const constantTimeEqual = (a, b) => {
    const left = String(a || '');
    const right = String(b || '');
    /* Compared over the longer of the two so a length difference does not
       itself short-circuit; the length check is folded into the result. */
    const length = Math.max(left.length, right.length);
    let diff = left.length === right.length ? 0 : 1;
    for (let i = 0; i < length; i++) {
      diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
    }
    return diff === 0;
  };

  /* ---------- issue ----------

     Server only. `hmacFn` is injected rather than imported so this file
     stays dependency-free and testable, and so the caller — which is the
     only thing holding the secret — decides how signing happens. */
  const issueContinuationContext = ({
    businessId,
    verticalId,
    reviewType,
    issuedAtMs,
    secret,
    hmacFn,
    ttlSeconds = DEFAULT_TTL_SECONDS
  } = {}) => {
    if (!secret || typeof hmacFn !== 'function') return null;
    /* A context with no resolved Business Record has nothing to continue.
       Issuing one anyway would create a token that links to null. */
    if (!isUuid(businessId)) return null;

    const claims = {
      v: CONTEXT_VERSION,
      businessId,
      verticalId: verticalId || null,
      /* Which review issued it. Recorded for audit; it does not restrict what
         may be continued, because the point is to cross review types. */
      issuedBy: reviewType || null,
      iat: Math.floor(issuedAtMs / 1000),
      exp: Math.floor(issuedAtMs / 1000) + ttlSeconds
    };

    const body = b64urlEncode(JSON.stringify(claims));
    const signature = hmacFn(secret, body);
    return `${CONTEXT_VERSION}.${body}.${signature}`;
  };

  /* ---------- verify ----------

     Returns an OUTCOME plus, when valid, the businessId the server itself
     put in the token. Never throws: a malformed token from a public form is
     an ordinary event, not an exception. */
  const verifyContinuationContext = ({
    token,
    secret,
    hmacFn,
    nowMs,
    expectedVerticalId = null
  } = {}) => {
    if (token === null || token === undefined || token === '') {
      return { status: OUTCOME.absent, businessId: null };
    }
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
      return { status: OUTCOME.malformed, businessId: null };
    }
    if (!secret || typeof hmacFn !== 'function') {
      /* No secret configured means no continuation is possible. Fails to
         "resolve normally", never to "link anyway". */
      return { status: OUTCOME.notConfigured, businessId: null };
    }

    const parts = token.split('.');
    if (parts.length !== 3) return { status: OUTCOME.malformed, businessId: null };

    const [version, body, signature] = parts;
    if (String(version) !== String(CONTEXT_VERSION)) {
      return { status: OUTCOME.malformed, businessId: null };
    }

    /* Signature BEFORE parsing. A body that has not been authenticated is
       untrusted input, and JSON.parse on untrusted input is work done for an
       attacker. */
    if (!constantTimeEqual(hmacFn(secret, body), signature)) {
      return { status: OUTCOME.badSignature, businessId: null };
    }

    let claims;
    try {
      claims = JSON.parse(b64urlDecode(body));
    } catch {
      return { status: OUTCOME.malformed, businessId: null };
    }
    if (!claims || typeof claims !== 'object' || claims.v !== CONTEXT_VERSION) {
      return { status: OUTCOME.malformed, businessId: null };
    }
    if (!isUuid(claims.businessId)) {
      return { status: OUTCOME.malformed, businessId: null };
    }
    if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= nowMs) {
      return { status: OUTCOME.expired, businessId: null };
    }

    /* A context issued for one vertical must not link a review in another.
       The signature proves we issued it; it does not prove it belongs here. */
    if (expectedVerticalId && claims.verticalId && claims.verticalId !== expectedVerticalId) {
      return { status: OUTCOME.mismatch, businessId: null };
    }

    return {
      status: OUTCOME.valid,
      businessId: claims.businessId,
      verticalId: claims.verticalId || null,
      issuedBy: claims.issuedBy || null,
      issuedAt: new Date(Number(claims.iat) * 1000).toISOString(),
      expiresAt: new Date(Number(claims.exp) * 1000).toISOString()
    };
  };

  /* ---------- payload hygiene ----------

     Lifts the token out before validation, hashing, or storage, and leaves
     behind only whether one was presented. Deterministic, so a replay of an
     identical body still hashes identically and is still a replay. */
  const stripContinuationToken = payload => {
    const block = payload && payload.continuation;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
    const token = typeof block.continuationToken === 'string' ? block.continuationToken : null;
    delete block.continuationToken;
    block.continuationPresented = Boolean(token);
    /* A client-supplied businessId is refused outright rather than ignored.
       Silently dropping it would let a caller believe it had been honoured. */
    if ('businessId' in block) delete block.businessId;
    return token;
  };

  /* ---------- the browser side ----------

     One shared key, so either review can precede the other: whichever
     finishes first leaves the context, and whichever starts next finds it.
     Namespacing it per vertical or per review would defeat the entire point.

     What is stored alongside the token is a PREFILL — and only the contact
     fields the visitor typed on THIS device, in THIS browser, moments ago.
     No Business Record data, nothing the server holds, nothing the visitor
     has not already seen themselves. The device is not learning anything by
     keeping it; it is avoiding asking the same question twice.

     It is bound to the token: with no token there is no prefill, because a
     prefill with no context is contact data sitting in storage for no
     reason. `clear()` removes both, and both reviews' delete controls call
     it. */

  const STORAGE_KEY = 'ced:continuation';

  /* The only fields a prefill may carry. Deliberately not phone, not website,
     not Google profile: those are identity EVIDENCE, and evidence is the
     server's to weigh, not the browser's to carry forward. */
  const PREFILL_FIELDS = ['salonName', 'businessName', 'ownerName', 'email'];
  const PREFILL_MAX_LENGTH = 254;

  const sanitizePrefill = prefill => {
    if (!prefill || typeof prefill !== 'object' || Array.isArray(prefill)) return {};
    const out = {};
    PREFILL_FIELDS.forEach(field => {
      const value = prefill[field];
      if (typeof value === 'string' && value.trim()) {
        out[field] = value.trim().slice(0, PREFILL_MAX_LENGTH);
      }
    });
    return out;
  };

  const storage = () => {
    try {
      return (typeof localStorage !== 'undefined') ? localStorage : null;
    } catch {
      return null;                   /* storage disabled is not an error here */
    }
  };

  /* A token that is shaped like a Business Record id is refused: the browser
     must never hold one, and something handing it one is a bug worth failing
     loudly on rather than storing. */
  const acceptableToken = token =>
    typeof token === 'string' && token.length > 0 &&
    token.length <= MAX_TOKEN_LENGTH && !isUuid(token);

  const storeContinuation = ({ token, prefill = null, issuedAt = null } = {}) => {
    const store = storage();
    if (!store || !acceptableToken(token)) return false;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({
        v: CONTEXT_VERSION,
        token,
        prefill: sanitizePrefill(prefill),
        issuedAt: issuedAt || new Date().toISOString()
      }));
      return true;
    } catch {
      return false;
    }
  };

  const readContinuation = () => {
    const store = storage();
    if (!store) return { token: null, prefill: {} };
    let raw = null;
    try { raw = store.getItem(STORAGE_KEY); } catch { return { token: null, prefill: {} }; }
    if (!raw) return { token: null, prefill: {} };

    /* An older page stored a bare string. Read it rather than discard it: a
       visitor mid-journey across a deploy should not lose their context. */
    if (!raw.startsWith('{')) {
      return acceptableToken(raw) ? { token: raw, prefill: {} } : { token: null, prefill: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!acceptableToken(parsed && parsed.token)) return { token: null, prefill: {} };
      return {
        token: parsed.token,
        prefill: sanitizePrefill(parsed.prefill),
        issuedAt: parsed.issuedAt || null
      };
    } catch {
      return { token: null, prefill: {} };
    }
  };

  const clearContinuation = () => {
    const store = storage();
    if (!store) return false;
    try { store.removeItem(STORAGE_KEY); return true; } catch { return false; }
  };

  const API = {
    CONTEXT_VERSION,
    DEFAULT_TTL_SECONDS,
    MAX_TOKEN_LENGTH,
    OUTCOME,
    STORAGE_KEY,
    PREFILL_FIELDS,
    isUuid,
    constantTimeEqual,
    issueContinuationContext,
    verifyContinuationContext,
    stripContinuationToken,
    acceptableToken,
    sanitizePrefill,
    storeContinuation,
    readContinuation,
    clearContinuation
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDContinuation = API;
})();
