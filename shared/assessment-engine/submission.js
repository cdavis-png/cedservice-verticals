/* ============================================================
   CED Service — Assessment Submission Adapter
   ------------------------------------------------------------
   Transport only. Knows nothing about any industry, and nothing
   about how a payload is built — it receives a finished payload
   and is responsible for getting it somewhere, or for not losing
   it when that fails.

   Guarantee: a completed assessment is never dropped silently.
   Anything undeliverable is written to a local retry queue with
   exponential backoff and re-attempted on later page loads.

   Idempotency: payload.submissionId is sent as the
   Idempotency-Key header and is preserved across every retry of
   the same completed result, so the server can collapse
   duplicates caused by timeouts.

   Local retention: queue entries expire 30 days after they were
   queued, successes are deleted immediately, and the queue is
   capped at 25 entries.

   Never queue payment data, passwords, credentials, or sensitive
   health information. The engine strips prohibited fields before
   a payload reaches this file; do not add anything here that
   would reintroduce them.

   No external service is wired up yet. With no endpoint
   configured the adapter logs the payload and reports "logged".

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const DEFAULTS = {
    endpoint: null,
    /* Must exceed the server's own operation budget, so the client gives the
       server a chance to answer instead of abandoning a request that is about
       to succeed. Ordering: challenge < database < function < client. */
    timeoutMs: 20000,
    headers: {},
    queueKey: 'ced:assessment:queue',
    maxQueue: 25,
    maxAttempts: 8,
    baseRetryMs: MINUTE,
    maxRetryMs: 6 * HOUR,
    retentionMs: 30 * DAY
  };

  /* ---------- retry classification ----------
     Status alone is not enough. HTTP 409 covers two opposite situations:

       request_in_flight       — a concurrent request holds this key.
                                 Retrying is exactly the right move.
       idempotency_key_conflict — this key was already used for different
                                 content. Retrying can never succeed.

     Classifying both as "permanent" silently discarded completed
     assessments, which is the failure this table exists to prevent. The
     structured error code decides; status is only the fallback. */

  const RETRYABLE_CODES = new Set([
    'request_in_flight',        /* concurrent holder; it will clear */
    'rate_limited',             /* by design temporary */
    'challenge_unavailable',    /* verifier outage — never the visitor's fault */
    'challenge_invalid',        /* token aged out; the server exempts old queued work */
    'ingestion_failed',
    'ingestion_timeout',
    'not_configured',           /* deployment gap, fixable without the visitor */
    'body_read_failed'
  ]);

  const PERMANENT_CODES = new Set([
    'idempotency_key_conflict', /* same key, different content — unfixable by retry */
    'challenge_rejected',       /* verified as not human */
    'origin_required',
    'origin_not_allowed',
    'unsupported_version',
    'unsupported_vertical',
    'unsupported_media_type',
    'payload_too_large',
    'payload_limit_exceeded',
    'prohibited_data',
    'results_consent_required',
    'consent_statement_missing',
    'malformed_json',
    'invalid_encoding',
    'submitted_at_too_old',
    'submitted_at_in_future',
    'idempotency_key_mismatch',
    'bir_generation_failed'
  ]);

  /* Transient statuses, used only when no code was returned. */
  const RETRYABLE_STATUS = new Set([408, 425, 429]);

  let idCounter = 0;
  const nextId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

  const classify = err => {
    if (err && err.name === 'AbortError') return 'timeout';
    if (err && err.httpStatus) return 'http';
    return 'network';
  };

  const isPermanent = err => {
    const code = err && err.errorCode;
    if (code) {
      if (RETRYABLE_CODES.has(code)) return false;
      if (PERMANENT_CODES.has(code)) return true;
    }
    const status = err && err.httpStatus;
    if (!status) return false;                       /* timeouts and network drops always retry */
    if (status >= 500) return false;
    return status >= 400 && !RETRYABLE_STATUS.has(status);
  };

  /* Doubling backoff, clamped. attempts=1 -> 1m, 2 -> 2m, 3 -> 4m … capped at 6h.
     A server-provided Retry-After wins when it asks for longer: the server
     knows when its rate-limit window resets and the client does not. */
  const backoffMs = (attempts, opts, err) => {
    const base = Math.min(opts.maxRetryMs, opts.baseRetryMs * Math.pow(2, Math.max(0, attempts - 1)));
    const advised = err && Number(err.retryAfterSeconds) > 0 ? Number(err.retryAfterSeconds) * 1000 : 0;
    return Math.min(opts.maxRetryMs, Math.max(base, advised));
  };

  const readQueue = key => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];                                     /* corrupt queue must not break submission */
    }
  };

  const writeQueue = (key, queue) => {
    try {
      localStorage.setItem(key, JSON.stringify(queue));
      return true;
    } catch (err) {
      console.error('[CED] Could not persist the submission queue.', err);
      return false;
    }
  };

  /* Drop anything past its retention window. Local storage is not an archive. */
  const purgeExpired = (queue, now) => {
    const kept = queue.filter(entry => !entry.expiresAt || Date.parse(entry.expiresAt) > now);
    const expired = queue.length - kept.length;
    if (expired) console.warn('[CED] Discarded %d queued assessment(s) past the 30-day retention limit.', expired);
    return { kept, expired };
  };

  const enqueue = (opts, payload, err) => {
    const now = Date.now();
    const queue = purgeExpired(readQueue(opts.queueKey), now).kept;
    const attempts = 1;
    const entry = {
      id: nextId(),
      submissionId: (payload && payload.submissionId) || null,
      queuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + opts.retentionMs).toISOString(),
      attempts,
      maxAttempts: opts.maxAttempts,
      nextRetryAt: new Date(now + backoffMs(attempts, opts, err)).toISOString(),
      lastAttemptAt: new Date(now).toISOString(),
      lastError: classify(err),
      httpStatus: (err && err.httpStatus) || null,
      errorCode: (err && err.errorCode) || null,
      correlationId: (err && err.correlationId) || null,
      permanent: isPermanent(err),
      exhausted: false,
      payload
    };
    queue.push(entry);
    while (queue.length > opts.maxQueue) {
      const dropped = queue.shift();
      console.error('[CED] Submission queue is full; dropped the oldest entry.', dropped.id);
    }
    writeQueue(opts.queueKey, queue);
    return entry;
  };

  /* The continuation context, resolved AT SEND TIME.

     A queued submission may be retried hours or days after it was queued,
     and the context that was current when it failed has almost certainly
     expired by then. So `continuationToken` may be a function, and a retry
     calls it on each attempt rather than carrying a value it captured once.

     It is never stored in the queue entry or in the payload. A queue lives
     in localStorage for up to thirty days; a signed, expiring credential
     written there is a credential at rest on the visitor's device, long
     after it stopped being useful for anything except replay. Resolving it
     late is what makes "the context is never persisted" true rather than
     merely intended. */
  const resolveContinuation = (opts, payload) => {
    const source = opts.continuationToken;
    if (typeof source !== 'function') return source || null;
    try {
      /* The payload is handed to the resolver so it can decide per
         SUBMISSION, not per page load. A queue may hold one business's review
         while another business's context is the current one, and the resolver
         is the only thing positioned to notice. */
      return source(payload) || null;
    } catch (err) {
      /* A context that cannot be read is a submission that does not link,
         which is a complete and correct outcome. It is never a failure. */
      console.warn('[CED] Could not read the continuation context; sending without it.', err);
      return null;
    }
  };

  /* A response may carry a REFRESHED context. Handed straight back to the
     caller, which owns the shared store; this adapter does not parse it, does
     not store it, and could not mint one. Never logged — the whole point of
     an opaque bearer value is that it does not appear in places that are
     kept. */
  const announceContinuation = (opts, body, payload) => {
    const token = body && body.continuationToken;
    if (!token || typeof opts.onContinuation !== 'function') return;
    try {
      /* The payload lets the owner preserve the contact evidence that belongs
         to THIS queued review. A retry can run on a later page load, after the
         form contains another business's details, so reading the live form
         here would pair a valid token with the wrong prefill. Existing
         one-argument callbacks remain compatible; JavaScript ignores the
         additional values. */
      opts.onContinuation(token, body, payload);
    } catch (err) {
      console.warn('[CED] A continuation context could not be stored.', err);
    }
  };

  const postJson = async (payload, opts) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const headers = Object.assign(
        { 'Content-Type': 'application/json', Accept: 'application/json' },
        opts.headers
      );
      /* Lets the server collapse duplicates from timeouts and retries. */
      if (payload && payload.submissionId) headers['Idempotency-Key'] = payload.submissionId;

      /* The continuation context travels as a HEADER, never in the body.
         A bearer credential inside the payload is a credential inside
         everything the payload becomes: the request hash, the stored
         submission, the report. Keeping it out of the JSON is what makes
         "never enters an assessment payload" a property of the transport
         rather than a promise the server has to keep by remembering to strip
         it. The server still strips a body-borne one, as a defence against a
         client that does it the old way. */
      const token = resolveContinuation(opts, payload);
      if (token) headers['X-CED-Continuation'] = token;

      const response = await fetch(opts.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        keepalive: true,                             /* survive the tab closing mid-send */
        signal: controller.signal
      });

      if (!response.ok) {
        const err = new Error(`Submission rejected with HTTP ${response.status}`);
        err.httpStatus = response.status;
        /* The structured code is what decides retryability, so it has to be
           read even on failure. A body that will not parse simply leaves the
           status-based fallback in charge. */
        let failure = null;
        try { failure = await response.json(); } catch { failure = null; }
        if (failure && failure.error) {
          err.errorCode = failure.error.code || null;
          err.correlationId = failure.error.correlationId || null;
          if (Number(failure.error.retryAfterSeconds) > 0) {
            err.retryAfterSeconds = Number(failure.error.retryAfterSeconds);
          }
        }
        const header = response.headers && typeof response.headers.get === 'function'
          ? Number(response.headers.get('retry-after')) : 0;
        if (!err.retryAfterSeconds && Number.isFinite(header) && header > 0) {
          err.retryAfterSeconds = header;
        }
        throw err;
      }
      /* The capture endpoint returns identifiers the engine can keep with the
         saved state. A body that will not parse is not a delivery failure. */
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  };

  /* Send one completed assessment.
     Resolves to { status: 'sent' | 'logged' | 'queued', ... } and never rejects,
     so a transport failure can never break the results screen. */
  const submitAssessment = async (payload, options = {}) => {
    const opts = Object.assign({}, DEFAULTS, options);

    if (!opts.endpoint) {
      console.info(
        '[CED] No submission endpoint configured — logging the assessment instead of sending it.',
        payload
      );
      return { status: 'logged', endpoint: null };
    }

    try {
      const { body } = await postJson(payload, opts);
      /* Deliberately not routed through onContinuation: a caller that
         submits directly gets the refreshed context in the return value
         below, and storing it twice under one key would let the second write
         drop the prefill the first one carried. The retry path has no return
         value to read, which is why the callback exists there. */
      return {
        status: 'sent',
        endpoint: opts.endpoint,
        submissionId: payload.submissionId || null,
        businessId: (body && body.businessId) || null,
        identityStatus: (body && body.identityStatus) || null,
        /* An opaque, server-signed, expiring context for continuing into
           another review type. Passed through untouched: this adapter does
           not parse it, does not store it, and could not mint one. See
           shared/security/continuation.js. */
        continuationToken: (body && body.continuationToken) || null,
        reviewType: (body && body.reviewType) || null,
        replayed: Boolean(body && body.replayed)
      };
    } catch (err) {
      const entry = enqueue(opts, payload, err);
      console.warn('[CED] Submission failed; the assessment was queued locally.', classify(err), err);
      return {
        status: 'queued',
        reason: classify(err),
        httpStatus: (err && err.httpStatus) || null,
        errorCode: (err && err.errorCode) || null,
        correlationId: (err && err.correlationId) || null,
        permanent: entry.permanent,
        submissionId: entry.submissionId,
        nextRetryAt: entry.nextRetryAt,
        queueId: entry.id
      };
    }
  };

  /* Re-attempt everything due in the queue. Safe to call on every page load. */
  const retryPendingSubmissions = async (options = {}) => {
    const opts = Object.assign({}, DEFAULTS, options);
    const now = Date.now();
    const purged = purgeExpired(readQueue(opts.queueKey), now);
    const queue = purged.kept;

    if (purged.expired) writeQueue(opts.queueKey, queue);
    if (!queue.length) return { attempted: 0, sent: 0, skipped: 0, expired: purged.expired, remaining: 0 };
    if (!opts.endpoint) {
      console.info('[CED] %d queued assessment(s) waiting; no endpoint configured yet.', queue.length);
      return { attempted: 0, sent: 0, skipped: queue.length, expired: purged.expired, remaining: queue.length };
    }

    let attempted = 0;
    let sent = 0;
    let skipped = 0;
    const remaining = [];

    for (const entry of queue) {
      /* Rejected for a client-side reason: keep for inspection, never retry —
         retrying a 400 forever cannot help, and discarding it would lose data. */
      if (entry.permanent || entry.exhausted) {
        skipped++;
        remaining.push(entry);
        continue;
      }
      /* Not due yet under the backoff schedule. */
      if (entry.nextRetryAt && Date.parse(entry.nextRetryAt) > now) {
        skipped++;
        remaining.push(entry);
        continue;
      }

      attempted++;
      try {
        /* The SAME payload, so the same submissionId travels, so the server
           collapses a retry of one result into a replay rather than storing
           it twice. The context is the only thing that differs between
           attempts, and it is not part of the payload. */
        const { body } = await postJson(entry.payload, opts);
        announceContinuation(opts, body, entry.payload);
        sent++;                                      /* delivered: dropped immediately */
      } catch (err) {
        const attempts = (entry.attempts || 0) + 1;
        entry.attempts = attempts;
        entry.lastError = classify(err);
        entry.httpStatus = (err && err.httpStatus) || null;
        entry.errorCode = (err && err.errorCode) || null;
        entry.correlationId = (err && err.correlationId) || null;
        entry.permanent = isPermanent(err);
        entry.exhausted = attempts >= (entry.maxAttempts || opts.maxAttempts);
        entry.lastAttemptAt = new Date(now).toISOString();
        entry.nextRetryAt = new Date(now + backoffMs(attempts, opts, err)).toISOString();
        if (entry.exhausted) {
          console.warn('[CED] Assessment %s exhausted its retry attempts; retained until it expires.', entry.submissionId || entry.id);
        }
        remaining.push(entry);
      }
    }

    writeQueue(opts.queueKey, remaining);
    if (sent) console.info('[CED] Delivered %d queued assessment(s).', sent);
    return { attempted, sent, skipped, expired: purged.expired, remaining: remaining.length };
  };

  const pendingSubmissions = (options = {}) =>
    readQueue(Object.assign({}, DEFAULTS, options).queueKey);

  /* Called by the engine's clearSavedAssessmentData(). */
  const clearQueue = (options = {}) => {
    localStorage.removeItem(Object.assign({}, DEFAULTS, options).queueKey);
    return true;
  };

  const API = {
    submitAssessment,
    retryPendingSubmissions,
    pendingSubmissions,
    clearQueue,
    /* Exposed for tests and for the retry-policy documentation. Changing a
       code's classification changes whether a completed assessment survives,
       so it is deliberately inspectable. */
    isPermanent,
    backoffMs,
    RETRYABLE_CODES,
    PERMANENT_CODES,
    DEFAULTS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.CEDSubmission = API;
})();
