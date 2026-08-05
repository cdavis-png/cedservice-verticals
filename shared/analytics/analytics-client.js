/* ============================================================
   CED Intelligence Platform — analytics client
   ------------------------------------------------------------
   Dependency-free, first-party, no vendor. Emits the events
   defined in events.js, batches them, and gets them to our own
   endpoint without ever being able to break the thing it is
   measuring.

   ------------------------------------------------------------
   THE GOVERNING RULE

   ANALYTICS MUST NEVER AFFECT THE ASSESSMENT.

   Every public method is wrapped so that nothing thrown in here
   can escape into the engine. A failed flush, a full queue, a
   corrupt localStorage entry, a missing endpoint — all of them
   degrade to "we lose some measurements", never to "the visitor
   loses their work". If you are editing this file and find
   yourself removing a try/catch, stop.

   ------------------------------------------------------------
   TIMING

   Two clocks, because they answer different questions:

     · totalElapsedMs  — wall time since the session began.
                         Includes the night the tab sat open.
     · activeElapsedMs — time the visitor was plausibly present:
                         page visible, tab focused, and some
                         input within the idle threshold.

   "This step takes four minutes" is only true of the second. A
   tab left open overnight must not become eight hours of
   assessment time, so the active clock pauses on hide, on blur,
   and on idle, and resumes on real input.

   ------------------------------------------------------------
   SAMPLING

   Decided ONCE per session, not per event. A funnel built from
   per-event sampling is nonsense: the same visitor would appear
   at step 3 and vanish at step 4 for no reason. A session is
   either wholly measured or wholly absent.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const events = (typeof module !== 'undefined' && module.exports)
    ? require('./events.js')
    : (typeof window !== 'undefined' ? window.CEDAnalyticsEvents : null);

  const DEFAULTS = {
    endpoint: null,              /* null → development console mode */
    verticalId: null,
    /* Batching. Small enough that a lost batch loses little, large enough
       that a 15-step assessment is not 60 requests. */
    batchSize: 12,
    flushIntervalMs: 15000,
    maxQueueSize: 200,
    /* A queued event older than this describes a session nobody is analysing
       any more. Dropped rather than delivered late and misleading. */
    eventTtlMs: 24 * 60 * 60 * 1000,
    maxAttempts: 5,
    retryBaseMs: 2000,
    retryMaxMs: 5 * 60 * 1000,
    requestTimeoutMs: 8000,
    /* 1 = measure everyone. Lower it under load; the decision is per session. */
    sampleRate: 1,
    /* No input for this long and the visitor is not working on the assessment. */
    idleThresholdMs: 60 * 1000,
    /* Inactive for this long with an incomplete assessment: likely abandoned. */
    abandonThresholdMs: 30 * 60 * 1000,
    consentStatus: 'product_allowed',
    storageKey: 'cedAnalyticsQueue',
    debug: false
  };

  const noop = () => {};

  /* Nothing in this file may throw into the engine. */
  const guard = (fn, label) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      if (state && state.config && state.config.debug) {
        console.warn(`[CED analytics] ${label} failed and was ignored.`, err);
      }
      return undefined;
    }
  };

  /* The clock is injectable. Every timing rule in this file — idle, pause,
     abandonment, backoff — is a statement about elapsed time, and a test that
     has to wait thirty real minutes to check the abandonment threshold is a
     test nobody runs. Production never passes this. */
  let timeSource = () => Date.now();
  const nowMs = () => timeSource();
  const nowIso = () => new Date(nowMs()).toISOString();

  const newId = () => {
    const c = typeof window !== 'undefined' ? window.crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map(x => x.toString(16).padStart(2, '0'));
      return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
    }
    return null;   /* no id, no event — never a guessable one */
  };

  /* ---------- state ---------- */

  let state = null;

  const freshState = config => ({
    config,
    sessionId: null,
    submissionId: null,
    businessId: null,
    stage: null,
    stepId: null,
    contextProvider: null,

    queue: [],
    sending: false,
    sampledIn: true,
    flushTimer: null,
    retryAt: 0,
    attempts: 0,

    /* clocks */
    sessionStart: nowMs(),
    stepStart: nowMs(),
    activeMs: 0,
    stepActiveMs: 0,
    activeSince: nowMs(),      /* null while paused */
    lastActivity: nowMs(),
    idleTimer: null,
    firstAnswerAt: null,
    stage1CompletedAt: null,
    resultsViewedAt: null,

    /* suppression */
    emittedOnce: new Set(),
    lastAbandonState: null,
    seenEventIds: new Set(),
    resumedCount: 0,
    started: false,
    installed: false
  });

  /* ---------- storage ---------- */

  const readStored = () => {
    try {
      const raw = window.localStorage.getItem(state.config.storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeStored = queue => {
    try {
      window.localStorage.setItem(state.config.storageKey, JSON.stringify(queue));
    } catch {
      /* Storage full or blocked. The in-memory queue still works for this
         page view; durability across a reload is the thing we lose. */
    }
  };

  const clearStored = () => {
    try { window.localStorage.removeItem(state.config.storageKey); } catch { /* ignore */ }
  };

  /* ---------- clocks ---------- */

  const accrue = () => {
    if (state.activeSince === null) return;
    const delta = nowMs() - state.activeSince;
    if (delta > 0) {
      state.activeMs += delta;
      state.stepActiveMs += delta;
    }
    state.activeSince = nowMs();
  };

  const pauseClock = reason => {
    accrue();
    state.activeSince = null;
    if (state.config.debug) console.log(`[CED analytics] active clock paused (${reason}).`);
  };

  const resumeClock = () => {
    if (state.activeSince !== null) return;
    state.activeSince = nowMs();
    if (state.config.debug) console.log('[CED analytics] active clock resumed.');
  };

  const timings = () => {
    accrue();
    return {
      activeElapsedMs: Math.round(state.activeMs),
      totalElapsedMs: Math.round(nowMs() - state.sessionStart),
      stepElapsedMs: Math.round(state.stepActiveMs)
    };
  };

  const markActivity = () => {
    state.lastActivity = nowMs();
    resumeClock();
  };

  /* Idle is checked on a timer rather than computed at read time, so that the
     clock stops at the moment the visitor went idle rather than being
     retroactively corrected when they come back. */
  const startIdleWatch = () => {
    if (state.idleTimer) return;
    const tick = () => {
      try {
        const quietFor = nowMs() - state.lastActivity;
        if (state.activeSince !== null && quietFor >= state.config.idleThresholdMs) {
          pauseClock('idle');
        }
        maybeInferAbandonment(quietFor);
      } catch { /* never let the watchdog throw */ }
    };
    state.idleTimer = setInterval(tick, Math.max(1000, Math.floor(state.config.idleThresholdMs / 4)));
    if (state.idleTimer && typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
  };

  /* ---------- context ---------- */

  const context = () => {
    let supplied = {};
    try {
      supplied = state.contextProvider ? (state.contextProvider() || {}) : {};
    } catch {
      supplied = {};
    }
    return supplied;
  };

  const deviceInfo = () => {
    try {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const coarse = typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)').matches
        : undefined;
      return {
        deviceClass: events.classifyDevice({ width: w, height: h, coarsePointer: coarse }),
        viewportWidth: events.bucketViewport(w),
        viewportHeight: events.bucketViewport(h)
      };
    } catch {
      return { deviceClass: 'unknown', viewportWidth: null, viewportHeight: null };
    }
  };

  /* ---------- emitting ---------- */

  const buildEvent = (eventName, fields) => {
    const definition = events.EVENTS[eventName];
    if (!definition) return null;

    const eventId = newId();
    if (!eventId) return null;

    const ctx = context();
    const t = timings();
    const attribution = events.sanitizeAttribution(ctx.attribution);
    const { metadata } = events.scrubMetadata(fields.metadata);

    return {
      eventId,
      eventName,
      eventVersion: definition.version,
      schemaVersion: events.ANALYTICS_SCHEMA_VERSION,
      category: definition.category,
      occurredAt: nowIso(),

      assessmentSessionId: state.sessionId,
      submissionId: fields.submissionId ?? state.submissionId ?? null,
      businessId: fields.businessId ?? state.businessId ?? null,

      verticalId: ctx.verticalId || state.config.verticalId || null,
      assessmentVersion: ctx.assessmentVersion || null,
      questionSetVersion: ctx.questionSetVersion || null,

      assessmentStage: fields.assessmentStage ?? state.stage ?? null,
      stepId: fields.stepId ?? state.stepId ?? null,
      questionId: fields.questionId ?? null,

      attribution,
      device: deviceInfo(),

      activeElapsedMs: t.activeElapsedMs,
      totalElapsedMs: t.totalElapsedMs,
      stepElapsedMs: fields.stepElapsedMs ?? t.stepElapsedMs,

      visibleQuestionCount: ctx.visibleQuestionCount ?? null,
      completedQuestionCount: ctx.completedQuestionCount ?? null,

      consentStatus: state.config.consentStatus,
      metadata
    };
  };

  const enqueue = event => {
    /* Idempotent by construction, and defended anyway: a double-fired listener
       must not produce two rows. */
    if (state.seenEventIds.has(event.eventId)) return;
    state.seenEventIds.add(event.eventId);

    state.queue.push({ event, queuedAt: nowMs(), attempts: 0 });

    /* Overflow drops the OLDEST, because the newest events describe where the
       visitor actually is and are the ones a funnel needs most. */
    if (state.queue.length > state.config.maxQueueSize) {
      const dropped = state.queue.length - state.config.maxQueueSize;
      state.queue.splice(0, dropped);
      if (state.config.debug) console.warn(`[CED analytics] queue full; dropped ${dropped} oldest event(s).`);
    }

    writeStored(state.queue);
    if (state.queue.length >= state.config.batchSize) void flush('batch_full');
  };

  const track = (eventName, fields = {}) => {
    if (!state || !state.installed) return;
    const definition = events.EVENTS[eventName];
    if (!definition) {
      if (state.config.debug) console.warn(`[CED analytics] unknown event ignored: ${eventName}`);
      return;
    }
    if (!state.sampledIn) return;
    if (!events.categoryPermitted(definition.category, state.config.consentStatus)) return;
    if (!state.sessionId) return;

    /* Once-per-session events are suppressed here as well as being unique in
       the database, because the cheapest duplicate is the one never sent. */
    if (definition.once === 'session') {
      if (state.emittedOnce.has(eventName)) return;
      state.emittedOnce.add(eventName);
    }

    const event = buildEvent(eventName, fields);
    if (!event) return;

    const check = events.validateEvent(event);
    if (!check.valid) {
      /* An invalid event is a bug in the instrumentation, not something to
         push at the endpoint until it complains. */
      if (state.config.debug) {
        console.warn(`[CED analytics] ${eventName} failed local validation and was dropped.`,
          check.errors.map(e => e.code));
      }
      return;
    }

    enqueue(event);
  };

  /* ---------- transport ---------- */

  const drainable = () => {
    const cutoff = nowMs() - state.config.eventTtlMs;
    const before = state.queue.length;
    state.queue = state.queue.filter(entry => entry.queuedAt >= cutoff);
    if (state.config.debug && state.queue.length !== before) {
      console.warn(`[CED analytics] expired ${before - state.queue.length} event(s).`);
    }
    return state.queue.slice(0, events.LIMITS.maxEventsPerBatch);
  };

  const post = async (batch, { beacon = false } = {}) => {
    const body = JSON.stringify({
      schemaVersion: events.ANALYTICS_SCHEMA_VERSION,
      sentAt: nowIso(),
      events: batch.map(entry => entry.event)
    });

    if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      /* sendBeacon survives the page going away, which is exactly the moment
         the most interesting event — the exit — is produced. It reports only
         whether the payload was accepted for transfer, so a true here means
         "handed to the browser", not "stored". */
      const blob = typeof Blob === 'function'
        ? new Blob([body], { type: 'application/json' })
        : body;
      return navigator.sendBeacon(state.config.endpoint, blob) ? { ok: true, beacon: true } : { ok: false };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      if (controller) {
        timer = setTimeout(() => controller.abort(), state.config.requestTimeoutMs);
      }
      const response = await fetch(state.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        signal: controller ? controller.signal : undefined
      });
      return { ok: response.ok, status: response.status };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const flush = async (reason = 'manual', options = {}) => {
    if (!state || !state.installed || !state.sampledIn) return { sent: 0, reason: 'inactive' };
    if (state.sending && !options.beacon) return { sent: 0, reason: 'in_flight' };
    if (nowMs() < state.retryAt && !options.beacon) return { sent: 0, reason: 'backoff' };

    const batch = drainable();
    if (!batch.length) {
      writeStored(state.queue);
      return { sent: 0, reason: 'empty' };
    }

    /* Development mode: no endpoint, so nothing leaves the device. The page
       opened from file:// behaves exactly as it always has. */
    if (!state.config.endpoint) {
      if (state.config.debug) {
        console.log(`[CED analytics] ${batch.length} event(s) (${reason}) — console mode, not sent:`,
          batch.map(e => e.event.eventName));
      }
      state.queue = state.queue.slice(batch.length);
      writeStored(state.queue);
      return { sent: batch.length, reason: 'console' };
    }

    state.sending = true;
    try {
      const result = await post(batch, options);
      if (result && result.ok) {
        const ids = new Set(batch.map(entry => entry.event.eventId));
        state.queue = state.queue.filter(entry => !ids.has(entry.event.eventId));
        state.attempts = 0;
        state.retryAt = 0;
        writeStored(state.queue);
        return { sent: batch.length, reason };
      }
      /* A 4xx that is not a rate limit means these events will never be
         accepted; retrying forever would be a loop with no exit. */
      if (result && result.status >= 400 && result.status < 500 && result.status !== 429) {
        const ids = new Set(batch.map(entry => entry.event.eventId));
        state.queue = state.queue.filter(entry => !ids.has(entry.event.eventId));
        writeStored(state.queue);
        if (state.config.debug) {
          console.warn(`[CED analytics] endpoint refused ${batch.length} event(s) with ${result.status}; discarded.`);
        }
        return { sent: 0, reason: 'rejected' };
      }
      throw new Error(`analytics endpoint returned ${result && result.status}`);
    } catch (err) {
      batch.forEach(entry => { entry.attempts += 1; });
      const exhausted = new Set(
        batch.filter(entry => entry.attempts >= state.config.maxAttempts)
             .map(entry => entry.event.eventId));
      if (exhausted.size) {
        state.queue = state.queue.filter(entry => !exhausted.has(entry.event.eventId));
      }
      state.attempts += 1;
      const backoff = Math.min(
        state.config.retryBaseMs * Math.pow(2, state.attempts - 1),
        state.config.retryMaxMs);
      state.retryAt = nowMs() + backoff;
      writeStored(state.queue);
      if (state.config.debug) {
        console.warn(`[CED analytics] flush failed (${reason}); retrying in ${backoff}ms.`, err && err.message);
      }
      return { sent: 0, reason: 'failed', retryInMs: backoff };
    } finally {
      state.sending = false;
    }
  };

  /* ---------- abandonment ----------

     Inferred, never observed, and deliberately reluctant. Three conditions,
     all of which must hold:

       1. the visitor started and has not finished the stage they are in
       2. they have been inactive past the threshold, or the page is going away
       3. we have not already said this about this exact state

     A pause is not an abandonment: someone who comes back produces
     assessment.resumed in the same session, and the reporting layer treats a
     later event as evidence the session continued. That is why the event
     carries `provisional` — the analysis retracts it rather than the client
     trying to guess in the moment. */

  const abandonmentState = () => `${state.stage ?? 'none'}:${state.stepId ?? 'none'}`;

  const inferAbandonment = (trigger, quietForMs) => {
    if (!state.started) return;
    if (state.emittedOnce.has('assessment.stage2_completed')) return;
    if (state.stage === 1 && state.emittedOnce.has('assessment.stage1_completed')) {
      /* Stage 1 is finished and Stage 2 was never opened. That is a complete,
         successful outcome — not an abandonment. */
      return;
    }
    const key = `${trigger}:${abandonmentState()}`;
    if (state.lastAbandonState === key) return;
    state.lastAbandonState = key;

    track('assessment.abandoned', {
      metadata: {
        trigger,
        provisional: true,
        quietForMs: Math.round(quietForMs || 0),
        resumedCount: state.resumedCount,
        reachedStage1: state.emittedOnce.has('assessment.stage1_completed'),
        reachedStage2: state.emittedOnce.has('assessment.stage2_started')
      }
    });
  };

  const maybeInferAbandonment = quietForMs => {
    if (quietForMs >= state.config.abandonThresholdMs) inferAbandonment('idle', quietForMs);
  };

  /* ---------- lifecycle wiring ---------- */

  const install = () => {
    if (state.installed || typeof window === 'undefined' || typeof document === 'undefined') return;
    state.installed = true;

    const onActivity = guard(() => markActivity(), 'activity');
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(type => {
      try { window.addEventListener(type, onActivity, { passive: true }); } catch { /* ignore */ }
    });

    try {
      document.addEventListener('visibilitychange', guard(() => {
        if (document.visibilityState === 'hidden') {
          pauseClock('hidden');
          inferAbandonment('page_hidden', nowMs() - state.lastActivity);
          void flush('page_hidden', { beacon: true });
        } else {
          markActivity();
        }
      }, 'visibilitychange'));
    } catch { /* ignore */ }

    try {
      window.addEventListener('blur', guard(() => pauseClock('blur'), 'blur'));
      window.addEventListener('focus', guard(() => markActivity(), 'focus'));
    } catch { /* ignore */ }

    /* pagehide rather than unload: unload is unreliable on mobile Safari and
       blocks the back/forward cache. */
    try {
      window.addEventListener('pagehide', guard(() => {
        pauseClock('pagehide');
        inferAbandonment('page_exit', nowMs() - state.lastActivity);
        void flush('pagehide', { beacon: true });
      }, 'pagehide'));
    } catch { /* ignore */ }

    startIdleWatch();

    if (state.config.flushIntervalMs > 0) {
      state.flushTimer = setInterval(guard(() => void flush('interval'), 'interval flush'),
        state.config.flushIntervalMs);
      if (state.flushTimer && typeof state.flushTimer.unref === 'function') state.flushTimer.unref();
    }
  };

  /* ---------- public API ---------- */

  const configure = options => {
    const config = { ...DEFAULTS, ...(options || {}) };
    if (typeof config.now === 'function') timeSource = config.now;
    const previousQueue = state ? state.queue : null;
    state = freshState(config);

    /* Anything left by an earlier page view is picked up and retried. */
    const restored = previousQueue || readStored();
    state.queue = restored.filter(entry =>
      entry && entry.event && entry.event.eventId &&
      nowMs() - (entry.queuedAt || 0) < config.eventTtlMs);
    state.queue.forEach(entry => state.seenEventIds.add(entry.event.eventId));

    state.sessionId = options && options.assessmentSessionId ? options.assessmentSessionId : null;
    state.contextProvider = options && typeof options.context === 'function' ? options.context : null;

    /* One decision, for the whole session. */
    state.sampledIn = config.sampleRate >= 1 ? true
      : config.sampleRate <= 0 ? false
      : Math.random() < config.sampleRate;

    install();
    return API;
  };

  const setSession = sessionId => {
    if (!state) return;
    state.sessionId = sessionId || null;
  };

  const identify = ({ submissionId = null, businessId = null } = {}) => {
    if (!state) return;
    if (submissionId) state.submissionId = submissionId;
    if (businessId) state.businessId = businessId;
  };

  const setStage = stage => {
    if (!state) return;
    state.stage = stage === 1 || stage === 2 ? stage : null;
  };

  /* Starting a step resets the per-step clock. Called by the engine on every
     step view, including a revisit — "time on step 4" is time in this visit,
     and the reporting layer sums visits when it wants the total. */
  const setStep = stepId => {
    if (!state) return;
    accrue();
    state.stepId = stepId === null || stepId === undefined ? null : String(stepId);
    state.stepStart = nowMs();
    state.stepActiveMs = 0;
  };

  const markStarted = () => {
    if (!state) return;
    state.started = true;
    state.lastAbandonState = null;
  };

  const markResumed = () => {
    if (!state) return;
    state.resumedCount += 1;
    /* Coming back clears the abandonment suppression, so a later, genuine
       exit is recorded rather than swallowed by the earlier guess. */
    state.lastAbandonState = null;
    markActivity();
  };

  const markFirstAnswer = () => {
    if (!state || state.firstAnswerAt !== null) return null;
    accrue();
    state.firstAnswerAt = state.activeMs;
    return state.firstAnswerAt;
  };

  const markStage1Complete = () => {
    if (!state) return;
    accrue();
    state.stage1CompletedAt = state.activeMs;
  };

  const markResultsViewed = () => {
    if (!state) return;
    accrue();
    state.resultsViewedAt = state.activeMs;
  };

  /* Active milliseconds between two marks. Returns null when the earlier mark
     never happened, rather than a zero that would read as "instant". */
  const sinceMark = mark => {
    if (!state) return null;
    const from = state[mark];
    if (from === null || from === undefined) return null;
    accrue();
    return Math.round(state.activeMs - from);
  };

  const status = () => {
    if (!state) return { installed: false };
    const t = timings();
    return {
      installed: state.installed,
      sampledIn: state.sampledIn,
      consentStatus: state.config.consentStatus,
      endpointConfigured: Boolean(state.config.endpoint),
      sessionId: state.sessionId,
      stage: state.stage,
      stepId: state.stepId,
      queued: state.queue.length,
      queuedNames: state.queue.map(entry => entry.event.eventName),
      clockRunning: state.activeSince !== null,
      resumedCount: state.resumedCount,
      ...t,
      firstAnswerAfterMs: state.firstAnswerAt,
      stage1CompletedAfterMs: state.stage1CompletedAt,
      resultsViewedAfterMs: state.resultsViewedAt
    };
  };

  /* Removes everything analytics stored on this device. Wired to the same
     control as the assessment's own data deletion. */
  const reset = () => {
    if (!state) return;
    state.queue = [];
    state.seenEventIds = new Set();
    state.emittedOnce = new Set();
    state.lastAbandonState = null;
    clearStored();
  };

  const API = {
    DEFAULTS,
    configure: guard(configure, 'configure'),
    track: guard(track, 'track'),
    flush: guard(flush, 'flush'),
    setSession: guard(setSession, 'setSession'),
    identify: guard(identify, 'identify'),
    setStage: guard(setStage, 'setStage'),
    setStep: guard(setStep, 'setStep'),
    markStarted: guard(markStarted, 'markStarted'),
    markResumed: guard(markResumed, 'markResumed'),
    markActivity: guard(markActivity, 'markActivity'),
    markFirstAnswer: guard(markFirstAnswer, 'markFirstAnswer'),
    markStage1Complete: guard(markStage1Complete, 'markStage1Complete'),
    markResultsViewed: guard(markResultsViewed, 'markResultsViewed'),
    sinceMark: guard(sinceMark, 'sinceMark'),
    status: guard(status, 'status'),
    reset: guard(reset, 'reset'),
    /* Exposed for tests and for driving the clocks deterministically. */
    _internal: {
      pauseClock: guard(pauseClock, 'pauseClock'),
      resumeClock: guard(resumeClock, 'resumeClock'),
      inferAbandonment: guard(inferAbandonment, 'inferAbandonment'),
      queue: () => (state ? state.queue.map(entry => entry.event) : []),
      teardown: () => {
        if (!state) return;
        if (state.flushTimer) clearInterval(state.flushTimer);
        if (state.idleTimer) clearInterval(state.idleTimer);
        state.flushTimer = null;
        state.idleTimer = null;
        state.installed = false;
      }
    }
  };

  /* A page that never calls configure() gets a client that does nothing at
     all, rather than one that throws on first use. */
  API.track = API.track || noop;

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.CEDAnalytics = API;
})();
