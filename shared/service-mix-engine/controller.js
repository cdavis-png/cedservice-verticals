/* ============================================================
   CED Intelligence Platform — Quick Service Mix Review controller
   ------------------------------------------------------------
   The browser side of SM-1. Owns the offering list, save and
   resume, payload construction, submission, and analytics.

   It reuses the platform rather than reimplementing it:

     · shared/assessment-engine/submission.js for transport,
       retry, offline queueing, and idempotency — unchanged
     · shared/analytics/analytics-client.js for measurement,
       through a wrapper that swallows everything
     · shared/service-mix-engine/* for every calculation

   Nothing here scores, prices, or recommends. The report is
   generated server-side; this file shows what the engine
   computed and never computes a second opinion.

   Analytics never affects the review: not the offerings, not the
   payload, not the results. Every call goes through `track`,
   which cannot throw.

   Classic script on purpose — see the note in
   shared/assessment-engine/engine.js.
   ============================================================ */

(() => {
  'use strict';

  const PAYLOAD_SCHEMA_VERSION = 6;
  const REVIEW_TYPE = 'service_mix';

  const values = typeof window !== 'undefined' ? window.CEDServiceMixValue : null;
  const offeringSchema = typeof window !== 'undefined' ? window.CEDServiceMixOffering : null;
  const calculate = typeof window !== 'undefined' ? window.CEDServiceMixCalculate : null;
  const classify = typeof window !== 'undefined' ? window.CEDServiceMixClassify : null;

  const nowIso = () => new Date().toISOString();

  /* How many offerings, as a band. Never an exact count: two to five is a
     small range, and an exact count plus a vertical plus a timestamp starts
     to identify a session. */
  const countBand = n => {
    const events = (typeof window !== 'undefined') ? window.CEDAnalyticsEvents : null;
    return events ? events.offeringCountBand(n) : null;
  };

  const newId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return offeringSchema.newId();
  };

  /* ---------- analytics ----------
     Every call swallowed. A failed measurement must never cost the visitor
     their work — the same wrapper the assessment engine uses. */
  const analytics = (() => {
    const client = () => (typeof window !== 'undefined' ? window.CEDAnalytics : null);
    const call = (method, ...args) => {
      const api = client();
      if (!api || typeof api[method] !== 'function') return undefined;
      try { return api[method](...args); } catch { return undefined; }
    };
    return {
      available: () => Boolean(client()),
      track: (name, fields) => call('track', name, fields),
      configure: options => call('configure', options),
      setSession: id => call('setSession', id),
      identify: ids => call('identify', ids),
      setStep: step => call('setStep', step),
      markStarted: () => call('markStarted'),
      markResumed: () => call('markResumed'),
      flush: () => call('flush')
    };
  })();

  /* ---------- attribution ---------- */

  const readUtm = () => {
    const utm = {};
    try {
      const params = new URLSearchParams(window.location.search);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
        .forEach(key => { const v = params.get(key); if (v) utm[key] = v; });
    } catch { /* a URL we cannot parse is not a reason to stop */ }
    return utm;
  };

  const touchNow = () => ({
    url: typeof window !== 'undefined' ? window.location.href : null,
    referrer: typeof document !== 'undefined' ? document.referrer || null : null,
    utm: readUtm(),
    occurredAt: nowIso()
  });

  /* ---------- controller ---------- */

  const init = (config = {}) => {
    if (!values || !offeringSchema || !calculate || !classify) {
      console.error('[CED] The Service Mix engine is not fully loaded; the review cannot start.');
      return null;
    }

    const meta = config.meta || {};
    const storageKey = config.storageKey || 'cedServiceMixReview';
    const limits = offeringSchema.OFFERING_LIMITS;

    let state = {
      assessmentSessionId: null,
      firstTouch: null,
      offerings: [],
      coverage: '',
      contact: {},
      consent: {},
      /* One submission id per genuinely new completed RESULT, kept across
         every retry of that result and reused for an unchanged
         resubmission. `submissionFingerprint` is what "unchanged" means. */
      submissionId: null,
      submissionFingerprint: null,
      startedAt: null,
      completedAt: null,
      /* Field NAMES the visitor did not have to retype, for the report's
         relatedGrowthReview.prefilledFields. Never values. */
      prefilledFields: []
    };

    /* The continuation context is NOT part of `state` and is never written to
       this review's storage key. It lives under the platform's shared
       continuation store, so whichever review runs first leaves it and
       whichever runs second finds it — and so it can never be serialised into
       a payload by a `save()` that forgot it was there. */
    const continuation = () =>
      (typeof window !== 'undefined' && window.CEDContinuation) ? window.CEDContinuation : null;

    /* Both read through a guard. A continuation context is an optimisation —
       it saves the visitor retyping their name and links two reviews to one
       Business Record — and a review that cannot read one is a complete,
       correct, standalone review. A storage failure must cost the link, never
       the review. */
    const readStored = () => {
      const store = continuation();
      if (!store) return { token: null, prefill: {} };
      try {
        return store.readContinuation() || { token: null, prefill: {} };
      } catch (err) {
        console.warn('[CED] Could not read the continuation context.', err);
        return { token: null, prefill: {} };
      }
    };

    const continuationToken = () => readStored().token || null;
    const continuationPrefill = () => readStored().prefill || {};

    /* ---------- persistence ----------
       Save and resume through localStorage, the same mechanism and the same
       retention rules the assessment uses. */

    const read = () => {
      try { return JSON.parse(localStorage.getItem(storageKey) || 'null') || {}; }
      catch { return {}; }
    };

    const save = () => {
      try { localStorage.setItem(storageKey, JSON.stringify(state)); }
      catch (err) { console.warn('[CED] Could not save the Service Mix review.', err); }
    };

    /* Runs on page load so first touch really is the first visit. Never
       rewritten on resume: that is how a QR card gets credit weeks later. */
    const ensureSession = () => {
      const saved = read();
      if (saved.assessmentSessionId) {
        state = { ...state, ...saved };
        /* A saved review with offerings already in it is a resume, not a
           start. Checked on keys rather than truthiness: an empty array is
           still an empty review. */
        return Array.isArray(saved.offerings) && saved.offerings.length > 0;
      }
      state.assessmentSessionId = newId();
      state.firstTouch = touchNow();
      save();
      return false;
    };

    /* ---------- offerings ---------- */

    const offerings = () => state.offerings.slice();

    const canAdd = () => state.offerings.length < limits.max;
    const canRemove = () => state.offerings.length > limits.min;

    const addOffering = ({ name = '', category = 'other', source = 'custom' } = {}) => {
      if (!canAdd()) return null;
      const offering = offeringSchema.createOffering({ name, category, source });
      state.offerings.push(offering);
      save();
      analytics.track('service_mix.offering_added', {
        metadata: {
          /* Starter or custom, and how many there are now as a band. Never
             which starter, never what it is called. */
          offeringSource: offering.source,
          offeringCountBand: countBand(state.offerings.length)
        }
      });
      return offering;
    };

    /* Removal BEFORE submission leaves no permanent history — the offering
       never happened. The analytics event records that a removal occurred,
       which is a fact about the form, not about the business. */
    const removeOffering = offeringId => {
      const index = state.offerings.findIndex(o => o.offeringId === offeringId);
      if (index < 0) return false;
      const removed = state.offerings[index];
      state.offerings.splice(index, 1);
      save();
      analytics.track('service_mix.offering_removed', {
        metadata: {
          offeringSource: removed.source,
          offeringCountBand: countBand(state.offerings.length)
        }
      });
      return true;
    };

    /* Renaming keeps the offeringId. Routed through the schema so the rule is
       a call site rather than a convention someone can forget. */
    const renameOffering = (offeringId, name) => {
      const index = state.offerings.findIndex(o => o.offeringId === offeringId);
      if (index < 0) return false;
      state.offerings[index] = offeringSchema.renameOffering(state.offerings[index], name);
      save();
      return true;
    };

    /* Replacement mints a new offeringId and records what it replaced. */
    const replaceOffering = (offeringId, details) => {
      const index = state.offerings.findIndex(o => o.offeringId === offeringId);
      if (index < 0) return null;
      const next = offeringSchema.replaceOffering(state.offerings[index], details);
      state.offerings[index] = next;
      save();
      return next;
    };

    const setMeasure = (offeringId, measure, kind, numbers) => {
      const offering = state.offerings.find(o => o.offeringId === offeringId);
      if (!offering || !offeringSchema.STAGE1_MEASURES.includes(measure)) return false;
      offering[measure] = values.measured(kind, numbers || {});
      save();
      return true;
    };

    const setField = (offeringId, field, value) => {
      const offering = state.offerings.find(o => o.offeringId === offeringId);
      if (!offering) return false;
      if (field === 'category' && offeringSchema.CATEGORIES.includes(value)) offering.category = value;
      else if (field === 'demand' && offeringSchema.DEMAND_LEVELS.includes(value)) offering.demand = value;
      else if (field === 'role' && offeringSchema.ROLES.includes(value)) offering.role = value;
      else return false;
      save();
      return true;
    };

    const setCoverage = coverage => {
      if (!offeringSchema.COVERAGE_DECLARATIONS.includes(coverage)) return false;
      state.coverage = coverage;
      save();
      return true;
    };

    const setContact = contact => {
      const incoming = contact || {};

      /* A field the visitor typed over is no longer a field they did not have
         to retype, so it stops counting as prefilled — that is what
         relatedGrowthReview.prefilledFields claims about the journey.

         And when the field they typed over is identity-bearing, the borrowed
         context goes with it: continuing to send another business's token
         because the form still holds it would be the page deciding something
         the visitor just decided differently. See startNewBusiness. */
      let dropContext = false;
      Object.keys(incoming).forEach(field => {
        if (!state.prefilledFields.includes(field)) return;
        const previous = state.contact[field];
        const changed = typeof previous === 'string' &&
          previous.trim() !== String(incoming[field] ?? '').trim();
        if (!changed) return;
        if (contextDroppedByEdit(field, incoming[field])) dropContext = true;
        state.prefilledFields = state.prefilledFields.filter(f => f !== field);
      });

      state.contact = { ...state.contact, ...incoming };

      if (dropContext) {
        /* Typing a different business over a prefilled identity field gets
           EXACTLY what the button gets, session included. A silent path that
           protected less than the explicit one would be the path everybody
           actually takes. */
        const typed = { ...state.contact };
        rotateJourney();
        state.contact = typed;
        save();
        analytics.track('service_mix.continuation_rejected', {
          metadata: { reviewType: REVIEW_TYPE, trigger: 'standalone' }
        });
        return;
      }

      save();
    };

    const setConsent = consent => {
      state.consent = { ...state.consent, ...(consent || {}) };
      save();
    };

    /* ---------- reassessment ----------

       Previous offerings are PRESENTED for confirmation, never silently
       matched. An owner confirms, renames, replaces, or removes each one —
       because silent matching would quietly rewrite what a previous report
       meant. */
    const offerPriorOfferings = prior =>
      (prior || []).map(previous => ({
        previous,
        /* Nothing is applied until the owner acts on it. */
        confirm: () => {
          if (!canAdd()) return null;
          const restored = { ...previous, offeringSnapshotId: null };
          state.offerings.push(restored);
          save();
          return restored;
        },
        replace: details => {
          if (!canAdd()) return null;
          const next = offeringSchema.replaceOffering(previous, details);
          state.offerings.push(next);
          save();
          return next;
        },
        skip: () => true
      }));

    /* ---------- local preview ----------

       The page shows what the engine computed. This is the SAME module the
       server runs, so a preview and the stored report cannot disagree — and
       it is a preview, not an authority: the persisted report is generated
       server-side from the submitted payload. */
    const preview = () => {
      const portfolio = calculate.calculatePortfolio({
        offerings: state.offerings,
        coverage: state.coverage || 'unknown'
      });
      return { portfolio, classified: classify.classifyPortfolio(portfolio) };
    };

    /* ---------- validation ---------- */

    const validate = () => {
      const snapshotted = state.offerings.map(offeringSchema.snapshotOffering);
      return offeringSchema.validateServiceMix({
        offerings: snapshotted,
        coverage: state.coverage
      });
    };

    /* ---------- payload ---------- */

    const buildPayload = () => {
      /* A new snapshot id per submitted version. Two submissions six months
         apart are two snapshots of one offeringId. */
      const snapshotted = state.offerings.map(offeringSchema.snapshotOffering);
      const submittedAt = nowIso();

      return {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        reviewType: REVIEW_TYPE,
        assessmentVersion: meta.assessmentVersion || null,
        assessmentSessionId: state.assessmentSessionId,
        submissionId: null,          /* assigned by submit(), the idempotency key */
        vertical: { id: meta.verticalId || null, name: meta.verticalName || null },
        submittedAt,
        attribution: {
          firstTouch: state.firstTouch,
          latestTouch: touchNow()
        },
        contact: { ...state.contact },
        consent: state.consent,
        /* NO continuation block. The context travels as a request header, so
           it never enters the payload, never enters the request hash, and
           never reaches the stored submission or the report. */
        integrity: {
          honeypotFilled: Boolean(config.honeypotValue && config.honeypotValue()),
          challengeToken: config.challengeToken ? config.challengeToken() : null
        },
        serviceMix: {
          coverage: state.coverage,
          offerings: snapshotted,
          offeringCount: snapshotted.length,
          minimum: limits.min,
          maximum: limits.max,
          recommended: limits.recommended,
          /* Field NAMES the connected review did not have to ask for again.
             Carried into relatedGrowthReview.prefilledFields by the database.
             Names only — the values are in `contact`, where they belong. */
          prefilledFields: state.prefilledFields.slice()
        },
        results: {
          /* The figure's context travels with it, always. */
          disclaimer: config.disclaimer ? config.disclaimer() : null
        }
      };
    };

    /* ---------- submit ----------

       Three rules about the submission id, and they pull in different
       directions, so they are stated together:

         · one id per genuinely new completed RESULT
         · the SAME id for every retry of that result — that is what lets the
           server collapse a timeout into a replay instead of a duplicate
         · a NEW id only after the answers materially changed

       The fingerprint is what distinguishes "the same result again" from "a
       different result". It covers the offerings, their figures and the
       coverage declaration — the things the report is computed from — and
       deliberately not the submission timestamp or the snapshot ids, which
       change on every build and would make every resubmission look new. */

    let sending = false;

    const materialFingerprint = () => {
      const material = {
        coverage: state.coverage,
        offerings: state.offerings.map(o => ({
          offeringId: o.offeringId,
          replacesOfferingId: o.replacesOfferingId || null,
          name: o.name,
          category: o.category,
          demand: o.demand,
          role: o.role,
          sellingPrice: o.sellingPrice,
          durationMinutes: o.durationMinutes,
          monthlyVolume: o.monthlyVolume
        })),
        contact: state.contact,
        consent: Object.keys(state.consent || {}).sort()
          .map(k => [k, Boolean(state.consent[k] && state.consent[k].granted)])
      };
      const stable = value => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
      };
      return stable(material);
    };

    const submit = async () => {
      /* A double click, or a second Enter on a slow connection, must not
         become two submissions. Guarded here rather than only in the page,
         because the page is not the only caller. */
      if (sending) return { status: 'in_flight' };

      const check = validate();
      if (!check.valid) return { status: 'invalid', errors: check.errors };

      const fingerprint = materialFingerprint();
      const unchanged = state.submissionId !== null &&
        state.submissionFingerprint === fingerprint;

      const payload = buildPayload();
      payload.submissionId = unchanged ? state.submissionId : newId();

      state.submissionId = payload.submissionId;
      state.submissionFingerprint = fingerprint;
      state.completedAt = payload.submittedAt;
      save();

      /* A resubmission of an unchanged result is the same completion, not a
         second one. Measuring it twice would inflate the completion rate for
         anyone who reloads. */
      if (!unchanged) {
        analytics.track('service_mix.stage1_completed', {
          submissionId: payload.submissionId,
          metadata: {
            offeringCountBand: countBand(payload.serviceMix.offerings.length),
            resultKind: 'preliminary',
            trigger: entryTrigger()
          }
        });
      }

      const transport = window.CEDSubmission;
      if (!transport) {
        console.error('[CED] submission.js is not loaded; the review cannot be sent.');
        return { status: 'logged', payload, submissionReused: unchanged };
      }

      sending = true;
      let result;
      try {
        result = await transport.submitAssessment(payload, {
          ...(config.submission || {}),
          /* Sent as a header by the transport, never in the body. Passed as a
             FUNCTION so it is read when the request is actually made, and the
             SAME function the retry sweep uses, so a live send and a retry
             cannot disagree about which context is current or about whether
             it belongs to the submission being sent. */
          continuationToken: continuationTokenFor
        });
      } finally {
        sending = false;
      }

      /* A fresh context for whatever the visitor does next, stored under the
         shared key with the contact fields THIS visitor just typed, so a
         later Growth Review does not have to ask for them again.

         `result.businessId` is deliberately not read: the endpoint does not
         return one for a Service Mix review, and nothing here would be
         allowed to do anything with it if it did. */
      const store = continuation();
      if (store && result && result.continuationToken) {
        store.storeContinuation({
          token: result.continuationToken,
          prefill: {
            salonName: state.contact.salonName,
            ownerName: state.contact.ownerName,
            email: state.contact.email
          }
        });
      }

      /* The submission id is the only identifier attached to later events.
         It is the visitor's own idempotency key, not a Business Record id. */
      analytics.identify({ submissionId: payload.submissionId });

      return { status: result.status, result, payload, submissionReused: unchanged };
    };

    /* ---------- lifecycle ----------

       ORDER MATTERS HERE.

       The continuation context is resolved BEFORE the first event is
       emitted. `service_mix.review_viewed` carries the trigger — whether
       this visitor arrived cold or came from a Growth Review — and reading
       the context afterwards would file every connected visit as
       `standalone`, which is precisely the number the funnel exists to
       measure. */

    const resumed = ensureSession();

    /* Resolved once, now, and reused by every event this page emits. */
    const arrivedWithContext = Boolean(continuationToken());
    const entryTrigger = () => resumed
      ? 'resumed'
      : (arrivedWithContext ? 'after_growth_review' : 'standalone');

    /* Contact the visitor already gave another review on this device. Only
       names and an email, only from the shared store, and only when a
       context is actually present — a prefill with no context is contact
       data sitting in storage for no reason. */
    if (arrivedWithContext && !Object.keys(state.contact).length) {
      const prefill = continuationPrefill();
      const taken = Object.keys(prefill);
      if (taken.length) {
        state.contact = { ...prefill };
        state.prefilledFields = taken;
        save();
      }
    }

    analytics.configure({
      endpoint: config.analyticsEndpoint || null,
      verticalId: meta.verticalId || null,
      reviewType: REVIEW_TYPE,
      assessmentSessionId: state.assessmentSessionId,
      context: () => ({
        verticalId: meta.verticalId || null,
        assessmentVersion: meta.assessmentVersion || null,
        reviewType: REVIEW_TYPE,
        attribution: { firstTouch: state.firstTouch, latestTouch: touchNow() }
      })
    });

    /* `trigger` already distinguishes a review entered after a Growth Review
       from a standalone one, which is the same question a `prefilled` flag
       was answering less precisely — and it is on the approved allowlist,
       which that flag is not. */
    analytics.track('service_mix.review_viewed', {
      metadata: { trigger: entryTrigger() }
    });

    if (resumed) analytics.markResumed();

    /* ---------- the queued-submission sweep ----------

       A review that could not be sent is saved on this device and retried.
       Before this existed, nothing retried it on THIS page: the queue was
       swept by the Growth Review's engine, and a visitor who only ever
       opened the Service Mix page had their completed review sit in
       localStorage until it expired thirty days later, unsent.

       Three things make the connected case work:

         · the context is resolved when the retry is made, not when the
           review was queued — the one that was current then has expired
         · it travels as a header, so it is never in the queued payload and
           never written to the queue entry beside it
         · the response may carry a REFRESHED context, which is stored back
           under the shared key, with the prefill it already had preserved

       And one thing makes it SAFE.

       Resolving the context late is what keeps a retry working days after it
       was queued, but it also means the context current at retry time may
       belong to a business the queued review is not about: Salon A's review
       sits in the queue while Salon B completes a Growth Review on the same
       device, and now Salon B's token is the current one.

       Sending it anyway would have been an invitation to file Salon A's
       report under Salon B. The server refuses that — rule B0 compares the
       submitted identity with what the record holds and sets a contradicted
       context aside — so the guarantee does not depend on the browser. But a
       submission that arrives with a token that cannot apply gets queued for
       human review rather than resolving cleanly, so the browser does not
       send one it can already tell is wrong: the context is offered only
       when the queued payload's own contact evidence matches the prefill
       stored beside the token.

       Never awaited. A retry sweep is housekeeping and must not delay the
       first paint or the first event; a failure costs nothing, because the
       entry stays queued for the next load. */

    /* Does the stored context plausibly belong to the business this queued
       payload is about? Compared on the identity-bearing contact fields the
       prefill actually carries — the same fields the server compares, and the
       only ones the browser has.

       Absent evidence is not a mismatch: a context stored without prefill
       (an older page, or one the visitor cleared and re-entered) says nothing
       either way, and the server is the authority regardless. */
    const contextFitsPayload = payload => {
      const prefill = continuationPrefill();
      const contact = (payload && payload.contact) || {};
      const comparable = ['salonName', 'businessName', 'email']
        .filter(field => typeof prefill[field] === 'string' && prefill[field].trim() &&
                         typeof contact[field] === 'string' && contact[field].trim());
      if (!comparable.length) return true;
      return comparable.every(field =>
        prefill[field].trim().toLowerCase() === contact[field].trim().toLowerCase());
    };

    /* The resolver the transport calls, for a live send and for a retry
       alike, so the two cannot disagree about which context is current or
       about whether it belongs to this submission. */
    const continuationTokenFor = payload =>
      (contextFitsPayload(payload) ? continuationToken() : null);
    const sweepQueuedSubmissions = () => {
      const transport = typeof window !== 'undefined' ? window.CEDSubmission : null;
      if (!transport || typeof transport.retryPendingSubmissions !== 'function') return null;

      return Promise.resolve()
        .then(() => transport.retryPendingSubmissions({
          ...(config.submission || {}),
          continuationToken: continuationTokenFor,
          onContinuation: token => {
            const store = continuation();
            if (!store) return;
            /* The prefill is carried over deliberately: storeContinuation
               replaces the record, and a refreshed token written without it
               would silently discard the contact fields a later review would
               otherwise not have to ask for. */
            try {
              store.storeContinuation({ token, prefill: continuationPrefill() });
            } catch (err) {
              console.warn('[CED] Could not store the refreshed continuation context.', err);
            }
          }
        }))
        .catch(err => {
          console.warn('[CED] The queued-submission sweep failed; entries stay queued.', err);
          return null;
        });
    };

    const queueSweep = sweepQueuedSubmissions();

    const start = () => {
      if (!state.startedAt) {
        state.startedAt = nowIso();
        save();
      }
      analytics.markStarted();
      analytics.track('service_mix.review_started', { metadata: { trigger: entryTrigger() } });
    };

    /* One step finished. `stepId` names which; the page passes it. */
    const completeStep = stepId => {
      analytics.setStep(stepId);
      analytics.track('assessment.step_completed', {
        stepId, metadata: { reviewType: REVIEW_TYPE, stage: 1, trigger: entryTrigger() }
      });
    };

    const viewStep = stepId => {
      analytics.setStep(stepId);
      analytics.track('assessment.step_viewed', {
        stepId, metadata: { reviewType: REVIEW_TYPE, stage: 1 }
      });
    };

    const failValidation = stepId =>
      analytics.track('assessment.validation_failed', {
        stepId, metadata: { reviewType: REVIEW_TYPE, stage: 1 }
      });

    const viewResults = () =>
      analytics.track('service_mix.results_viewed', {
        metadata: {
          reviewType: REVIEW_TYPE,
          resultKind: 'preliminary',
          offeringCountBand: countBand(state.offerings.length)
        }
      });

    /* The named intents. Each is a fact about what the visitor chose to do
       with their results — never about the business. */
    const trackIntent = (name, metadata = {}) =>
      analytics.track(name, { metadata: { reviewType: REVIEW_TYPE, ...metadata } });

    /* Accepts a context the page found wherever another review left it.
       An opaque string and nothing else: anything shaped like a businessId is
       refused here as well as at the endpoint. Stored under the SHARED key,
       never in this review's own state, so either review can precede the
       other and neither can serialise it into a payload. */
    const acceptContinuationToken = token => {
      const store = continuation();
      if (!store) return false;
      return store.storeContinuation({ token });
    };

    /* ---------- "this is not my business" ----------

       The visitor's own way of saying the context is wrong.

       Someone finishes a Growth Review for one salon and hands the laptop to
       a friend, or an owner reviews a second location, or a consultant works
       through two clients on one machine. The prefilled name and email are
       then not merely stale — they belong to a DIFFERENT business, and every
       one of them is identity evidence that would travel with this
       submission.

       The server refuses to link a contradicted proposal (rule B0), so this
       control is not the safety mechanism; it is how a visitor gets a clean
       result instead of a queued review. Clearing here means the submission
       arrives carrying nothing borrowed, and resolves on its own evidence.

       THREE things are borrowed, not one, and an earlier version cleared only
       the first two:

         · the continuation token
         · the prefilled contact
         · the ASSESSMENT SESSION ID

       The session id is the one that mattered. It is a client-supplied
       journey identifier, and the server had already resolved it to the
       previous business — so a "start fresh" that kept it produced a
       submission proposing the very record the visitor had just said was not
       theirs. The button said one thing and the payload said another.

       So starting another business starts another journey: a new session id,
       and every trace of the completed one. The submission id and its
       fingerprint go too — keeping them would let a submission for the new
       business replay under the old one's idempotency key, or supersede its
       report. The OFFERINGS stay: they are the work the visitor has done,
       they carry no identity, and throwing them away would punish someone for
       correcting us. */
    const IDENTITY_BEARING_FIELDS = ['salonName', 'businessName', 'email'];

    /* Everything that ties this browser to a business, cleared together.
       Called by the button and by the silent edit path, so the two cannot
       diverge — a partial reset is worse than none, because it looks done. */
    const rotateJourney = () => {
      const store = continuation();
      if (store) {
        try { store.clearContinuation(); }
        catch (err) { console.warn('[CED] Could not clear the continuation context.', err); }
      }

      state.assessmentSessionId = newId();
      state.firstTouch = touchNow();
      state.contact = {};
      state.prefilledFields = [];
      /* Completed-submission state. A new journey has completed nothing. */
      state.submissionId = null;
      state.submissionFingerprint = null;
      state.completedAt = null;

      /* Saved BEFORE anything can submit, so a crash between here and the
         next click cannot resume the old journey. */
      save();

      /* The measurement session follows the review session. Leaving analytics
         on the old id would attribute this visitor's remaining events to the
         previous business's funnel. */
      analytics.setSession(state.assessmentSessionId);
      analytics.identify({ submissionId: null });
    };

    const startNewBusiness = () => {
      rotateJourney();
      analytics.track('service_mix.continuation_rejected', {
        metadata: { reviewType: REVIEW_TYPE, trigger: 'standalone' }
      });
      return true;
    };

    /* A visitor who simply TYPES over the prefilled name or email is saying
       the same thing more quietly, and a form that kept using the old context
       there would be deciding on their behalf. Editing an identity-bearing
       prefilled field therefore drops the context too.

       Only identity-bearing fields: correcting a misspelled owner name is a
       correction, not a different business. And only fields that were
       actually PREFILLED — typing your own name into an empty form says
       nothing about anybody's context. */
    const contextDroppedByEdit = (field, value) => {
      if (!state.prefilledFields.includes(field)) return false;
      if (!IDENTITY_BEARING_FIELDS.includes(field)) return false;
      const previous = state.contact[field];
      return typeof previous === 'string' && previous.trim() !== String(value ?? '').trim();
    };

    /* Wired to any user-facing "delete my data" control, exactly as the
       assessment's equivalent is. */
    const clearSavedData = () => {
      try { localStorage.removeItem(storageKey); } catch { /* nothing to clear */ }
      /* The continuation context is a bearer token, and it is shared with
         whatever review left it here. "Delete my data" must not leave one
         behind for the next page to pick up — nor the prefill stored with
         it, which is contact data. */
      const store = continuation();
      if (store) store.clearContinuation();
      if (window.CEDSubmission) window.CEDSubmission.clearQueue(config.submission || {});
      analytics.track('assessment.clear_saved_data', { metadata: { reviewType: REVIEW_TYPE } });
      return true;
    };

    return {
      REVIEW_TYPE,
      PAYLOAD_SCHEMA_VERSION,
      limits,
      state: () => ({ ...state }),
      resumed: () => resumed,
      start,
      offerings,
      canAdd,
      canRemove,
      addOffering,
      removeOffering,
      renameOffering,
      replaceOffering,
      setMeasure,
      setField,
      setCoverage,
      setContact,
      setConsent,
      offerPriorOfferings,
      acceptContinuationToken,
      /* "This is not my business." */
      startNewBusiness,
      IDENTITY_BEARING_FIELDS,
      /* Read-only views. The token itself is never exposed as a value the
         page could put anywhere. */
      hasContinuationContext: () => Boolean(continuationToken()),
      prefilledFields: () => state.prefilledFields.slice(),
      entryTrigger,
      preview,
      validate,
      buildPayload,
      submit,
      isSending: () => sending,
      /* The load-time sweep, exposed so a test can await it. The page never
         does: it is fire-and-forget housekeeping. */
      queueSweep: () => queueSweep,
      /* And a sweep on demand, for a caller that wants to try again without
         a reload. */
      retryQueuedSubmissions: () => sweepQueuedSubmissions(),
      /* Instrumentation the page calls. Every one of them goes through the
         swallowing wrapper, so a broken analytics client cannot break a
         review. */
      viewStep,
      completeStep,
      failValidation,
      viewResults,
      trackIntent,
      clearSavedData,
      track: analytics.track
    };
  };

  const API = { init, PAYLOAD_SCHEMA_VERSION, REVIEW_TYPE };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDServiceMixController = API;
})();
