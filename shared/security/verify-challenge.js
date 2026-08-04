/* ============================================================
   CED Intelligence Platform — challenge verification adapter
   ------------------------------------------------------------
   Provider-neutral. The platform has NOT chosen a challenge
   provider yet, and this file exists so that choosing one later
   is a configuration change rather than an endpoint rewrite.

   It speaks the shape both Cloudflare Turnstile and Google
   reCAPTCHA use — a form POST of secret + response, answered
   with { success, action, error-codes } — because that shape is
   near-universal. A provider that differs needs a translation
   here and nowhere else.

   Failure modes are kept distinct on purpose. "The visitor
   failed the challenge" and "we could not reach the verifier"
   are opposite outcomes: the first is permanent and the visitor
   must try again, the second is transient and the submission
   must be retried rather than discarded. Collapsing them is how
   a provider outage turns into lost assessments.

   Fails CLOSED in production. If verification is required and
   cannot be performed, the request is refused — never waved
   through.

   Secrets and tokens are never logged, never returned, and
   never placed in an error message.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* Outcome vocabulary. The endpoint maps these to status codes; keep the
     names stable, they appear in documentation and tests. */
  const OUTCOME = {
    verified: 'verified',        /* passed */
    rejected: 'rejected',        /* provider says no — permanent */
    expired: 'expired',          /* token was valid once; re-challenge needed */
    malformed: 'malformed',      /* token missing or unusable — permanent */
    unavailable: 'unavailable',  /* verifier unreachable/erroring — transient */
    skipped: 'skipped'           /* not required, or an explicit non-production bypass */
  };

  const DEFAULT_TIMEOUT_MS = 3000;

  /* Provider error codes, mapped to our vocabulary. Unknown codes fall
     through to `rejected`, which is the safe direction. */
  const EXPIRED_CODES = new Set([
    'timeout-or-duplicate', 'expired', 'challenge-expired', 'invalid-input-response-expired'
  ]);
  const MALFORMED_CODES = new Set([
    'missing-input-response', 'invalid-input-response', 'bad-request', 'invalid-widget-id'
  ]);
  /* A bad secret is our misconfiguration, not the visitor's failure. Treating
     it as `rejected` would blame every visitor for our deployment mistake. */
  const CONFIG_CODES = new Set([
    'missing-input-secret', 'invalid-input-secret', 'internal-error'
  ]);

  const truthy = value => {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'required'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return null;
  };

  const isProduction = env => String((env && env.NODE_ENV) || '').toLowerCase() === 'production';

  const outcome = (status, extra = {}) => ({
    status,
    ok: status === OUTCOME.verified || status === OUTCOME.skipped,
    ...extra
  });

  const classifyCodes = codes => {
    const list = Array.isArray(codes) ? codes.map(c => String(c).toLowerCase()) : [];
    if (list.some(c => CONFIG_CODES.has(c))) return OUTCOME.unavailable;
    if (list.some(c => EXPIRED_CODES.has(c))) return OUTCOME.expired;
    if (list.some(c => MALFORMED_CODES.has(c))) return OUTCOME.malformed;
    return OUTCOME.rejected;
  };

  /* verifyChallenge({ token, remoteAddressHash, expectedAction, env, fetchImpl, timeoutMs })

     `remoteAddressHash` is a pseudonymous hash, never a raw address — the
     provider does not need to know who the visitor is to tell us whether the
     token is good, and we do not keep addresses. Providers that require a real
     address should simply receive nothing.

     Returns { status, ok, reason?, providerAction?, retryAfterSeconds? }. */
  const verifyChallenge = async (input = {}) => {
    const {
      token = null,
      remoteAddressHash = null,
      expectedAction = null,
      env = {},
      fetchImpl = (typeof fetch === 'function' ? fetch : null),
      timeoutMs = null
    } = input;

    const required = truthy(env.CED_CHALLENGE_REQUIRED);
    const verifyUrl = env.CED_CHALLENGE_VERIFY_URL || '';
    const secret = env.CED_CHALLENGE_SECRET || '';
    const action = expectedAction || env.CED_CHALLENGE_EXPECTED_ACTION || null;
    const production = isProduction(env);

    /* Default is REQUIRED. An unset variable must not silently disable the
       protection it was added to provide. */
    const isRequired = required === null ? true : required;

    if (!isRequired) {
      return outcome(OUTCOME.skipped, { reason: 'not_required' });
    }

    if (!verifyUrl || !secret) {
      /* Fail closed in production; allow an explicit local bypass elsewhere so
         the endpoint stays runnable without a provider account. */
      if (production) {
        return outcome(OUTCOME.unavailable, { reason: 'not_configured' });
      }
      return outcome(OUTCOME.skipped, { reason: 'development_bypass' });
    }

    if (typeof token !== 'string' || token.trim().length === 0) {
      return outcome(OUTCOME.malformed, { reason: 'missing_token' });
    }
    if (token.length > 4096) {
      return outcome(OUTCOME.malformed, { reason: 'token_too_long' });
    }
    if (typeof fetchImpl !== 'function') {
      return outcome(OUTCOME.unavailable, { reason: 'no_transport' });
    }

    const budget = Number(timeoutMs || env.CED_CHALLENGE_TIMEOUT_MS) > 0
      ? Number(timeoutMs || env.CED_CHALLENGE_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let abortTimer = null;
    let raceTimer = null;

    try {
      const form = new URLSearchParams();
      form.set('secret', secret);
      form.set('response', token);
      if (remoteAddressHash) form.set('remoteip_hash', remoteAddressHash);

      const call = fetchImpl(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal: controller ? controller.signal : undefined
      });

      /* The signal is sent, but a transport that ignores it must not be able
         to hold the whole request open, so the call is raced as well. */
      const TIMED_OUT = Symbol('challenge_timeout');
      const expiry = new Promise(resolve => { raceTimer = setTimeout(() => resolve(TIMED_OUT), budget); });
      if (controller) abortTimer = setTimeout(() => controller.abort(), budget);

      const response = await Promise.race([Promise.resolve(call), expiry]);

      if (response === TIMED_OUT) {
        return outcome(OUTCOME.unavailable, { reason: 'timeout' });
      }
      if (!response || typeof response.status !== 'number') {
        return outcome(OUTCOME.unavailable, { reason: 'no_response' });
      }
      /* The verifier itself is broken — that is our problem, not the
         visitor's, so the request is retryable rather than refused. */
      if (response.status >= 500) {
        return outcome(OUTCOME.unavailable, { reason: 'provider_error', providerStatus: response.status });
      }
      if (response.status === 429) {
        return outcome(OUTCOME.unavailable, { reason: 'provider_rate_limited', providerStatus: response.status });
      }
      if (response.status >= 400) {
        return outcome(OUTCOME.unavailable, { reason: 'provider_rejected_request', providerStatus: response.status });
      }

      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!body || typeof body !== 'object') {
        return outcome(OUTCOME.unavailable, { reason: 'unreadable_response' });
      }

      if (body.success !== true) {
        return outcome(classifyCodes(body['error-codes'] || body.errorCodes), { reason: 'provider_verdict' });
      }

      /* A valid token issued for a different action is a replayed token. */
      const providerAction = typeof body.action === 'string' ? body.action : null;
      if (action && providerAction && providerAction !== action) {
        return outcome(OUTCOME.rejected, { reason: 'action_mismatch', providerAction });
      }

      return outcome(OUTCOME.verified, { providerAction });

    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      return outcome(OUTCOME.unavailable, { reason: aborted ? 'timeout' : 'transport_error' });
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (raceTimer) clearTimeout(raceTimer);
    }
  };

  const API = { OUTCOME, DEFAULT_TIMEOUT_MS, verifyChallenge, classifyCodes };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDVerifyChallenge = API;
})();
