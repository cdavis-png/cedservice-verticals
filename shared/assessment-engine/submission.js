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
    timeoutMs: 10000,
    headers: {},
    queueKey: 'ced:assessment:queue',
    maxQueue: 25,
    maxAttempts: 8,
    baseRetryMs: MINUTE,
    maxRetryMs: 6 * HOUR,
    retentionMs: 30 * DAY
  };

  /* Transient conditions worth retrying. Every 5xx is also retryable. */
  const RETRYABLE_STATUS = new Set([408, 425, 429]);

  let idCounter = 0;
  const nextId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

  const classify = err => {
    if (err && err.name === 'AbortError') return 'timeout';
    if (err && err.httpStatus) return 'http';
    return 'network';
  };

  const isPermanent = err => {
    const status = err && err.httpStatus;
    if (!status) return false;                       /* timeouts and network drops always retry */
    if (status >= 500) return false;
    return status >= 400 && !RETRYABLE_STATUS.has(status);
  };

  /* Doubling backoff, clamped. attempts=1 -> 1m, 2 -> 2m, 3 -> 4m … capped at 6h. */
  const backoffMs = (attempts, opts) =>
    Math.min(opts.maxRetryMs, opts.baseRetryMs * Math.pow(2, Math.max(0, attempts - 1)));

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
      nextRetryAt: new Date(now + backoffMs(attempts, opts)).toISOString(),
      lastAttemptAt: new Date(now).toISOString(),
      lastError: classify(err),
      httpStatus: (err && err.httpStatus) || null,
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
        throw err;
      }
      return response;
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
      await postJson(payload, opts);
      return { status: 'sent', endpoint: opts.endpoint, submissionId: payload.submissionId || null };
    } catch (err) {
      const entry = enqueue(opts, payload, err);
      console.warn('[CED] Submission failed; the assessment was queued locally.', classify(err), err);
      return {
        status: 'queued',
        reason: classify(err),
        httpStatus: (err && err.httpStatus) || null,
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
        await postJson(entry.payload, opts);
        sent++;                                      /* delivered: dropped immediately */
      } catch (err) {
        const attempts = (entry.attempts || 0) + 1;
        entry.attempts = attempts;
        entry.lastError = classify(err);
        entry.httpStatus = (err && err.httpStatus) || null;
        entry.permanent = isPermanent(err);
        entry.exhausted = attempts >= (entry.maxAttempts || opts.maxAttempts);
        entry.lastAttemptAt = new Date(now).toISOString();
        entry.nextRetryAt = new Date(now + backoffMs(attempts, opts)).toISOString();
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

  window.CEDSubmission = {
    submitAssessment,
    retryPendingSubmissions,
    pendingSubmissions,
    clearQueue
  };
})();
