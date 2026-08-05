/* ============================================================
   CED Service — Shared Assessment Engine
   ------------------------------------------------------------
   Generic behavior for every vertical's self-paced review:
   modal open/close, step navigation, validation, save/resume,
   progress, session identity, attribution, consent capture,
   result orchestration, result rendering, and building the
   submission payload.

   This file must stay industry-agnostic. Questions, weights,
   opportunity formulas, priority copy, package thresholds, and
   consent wording belong in the vertical's assessment.config.js,
   which sets window.CED_ASSESSMENT_CONFIG before this loads.

   Transport lives in submission.js. The engine builds the
   payload and hands it over; it never knows where it goes.

   Deliberately a classic script, not an ES module: these pages
   must open directly from file:// with no build step, and
   browsers block module loading on file:// origins.
   ============================================================ */

(() => {
  'use strict';

  /* v2: session/submission identity, split consent records, and
     first/latest-touch attribution replaced the flat v1 shape. */
  /* 3 adds the `integrity` envelope (honeypot indicator, challenge token).
     4 adds `intelligence` (the nine deterministic dimensions) and `branching`
     (which questions were shown, which were skipped, and why).
     5 adds `assessmentStage` (which stage of the progressive review this
     submission completed, and which submission it continues) and the visible
     opportunity RANGE alongside the point figure.
     The endpoint still accepts older versions during the migration window so
     assessments already queued by an older page are not lost — see
     docs/PRODUCTION_HARDENING.md, "Version compatibility". */
  const PAYLOAD_SCHEMA_VERSION = 5;

  /* Shared markup contract. Every vertical's index.html uses these hooks. */
  const SELECTORS = {
    modal: '.review-modal',
    open: '.js-start-review',
    close: '.modal-close',
    backdrop: '.modal-backdrop',
    form: '#growthReview',
    step: '.review-step',
    next: '#nextStep',
    prev: '#prevStep',
    progressText: '#progressText',
    progressBar: '#progressBar',
    disclaimer: '.results-disclaimer',
    /* Wraps one conditional question. The engine hides, disables, and clears
       everything inside; the vertical decides when via config.branching. */
    question: '[data-question]',
    /* Polite announcements when the remaining-question count changes, so a
       screen-reader user is not silently given a different form. */
    liveRegion: '#reviewLive',

    /* ---- progressive profiling ----
       A step declares which stage it belongs to. A step that also carries
       data-results-for is that stage's results screen and always terminates
       it, however the branching went. */
    stageLabel: '[data-stage-label]',
    stageAction: '[data-stage-action]',
    stageNote: '[data-stage-note]',
    /* A consent whose availability depends on another answer. Owned by
       syncConsentGates, never by stage or branch logic. */
    consentGate: '[data-consent-gate]',
    /* Any control worth counting. Handled by ONE delegated listener, so a
       vertical adds a measurement by adding an attribute. */
    analyticsAction: '[data-analytics-event]'
  };

  /* Result hooks are looked up INSIDE the results step being painted, because
     there is one results screen per stage and an id may only appear once in a
     document. */
  const RESULT_HOOKS = {
    subject: '[data-result="subject"]',
    score: '[data-result="score"]',
    opportunity: '[data-result="opportunity"]',
    packageLabel: '[data-result="package-label"]',
    packageReason: '[data-result="package-reason"]',
    priorities: '[data-result="priorities"]',
    status: '[data-result="status"]',
    assumptions: '[data-result="assumptions"]',
    evidenceNote: '[data-result="evidence-note"]'
  };

  /* Bot trap. Real users never see or fill this; anything in it is a bot.

     Named `contactFax` rather than `website`: the identity roadmap collects a
     real business website, and a trap sharing that name would turn bot noise
     into identity evidence the moment the legitimate field ships.

     The value is never transmitted. Only a boolean reaches the server, so the
     trap cannot become a channel for smuggling data into storage. */
  const HONEYPOT_FIELD = 'contactFax';

  /* The name of the hidden challenge input, when a provider is wired up. No
     provider is configured yet; the field is optional and absent today. */
  const CHALLENGE_FIELD = 'cedChallengeToken';

  const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  /* Categories this platform must never persist or transmit. Enforced, not just
     documented, because medical/dental is a planned vertical family. */
  const PROHIBITED_FIELD_PATTERN =
    /(password|passwd|pwd|secret|token|apikey|api_key|credential|ssn|socialsecurity|cvv|cvc|cardnum|card_number|cardholder|creditcard|iban|routing|accountnumber|account_number|diagnosis|medication|prescription|symptom|medicalrecord|patientid|healthcondition)/i;

  /* Platform-level UI copy. These change with step position or delivery state,
     so they cannot live in the markup. Industry copy belongs in the vertical. */
  const LABELS = {
    continue: 'Continue',
    finish: 'See My Results'
  };

  const STATUS_COPY = {
    sending: 'Sending your results…',
    sent: 'Results sent.',
    queued: 'Saved on this device. Sending will retry automatically.',
    ready: 'Results ready.'
  };

  /* Why a later stage opened. Deliberately not called another assessment —
     it is the same review, continued. */
  const STAGE_NOTE_COPY = {
    see_recommended_system: 'To confirm the best fit and setup path, answer a few final questions.',
    improve_recommendation: 'A few more answers let us narrow the estimate and confirm the recommendation.',
    requested: 'A few more answers let us confirm the best fit and setup path.'
  };

  /* COMPLIANCE. Every figure this platform shows is a diagnostic estimate, and
     capacity evidence may only ever REDUCE one. Neither sentence below may be
     reworded into anything that suggests we will supply demand — see
     CLAUDE.md section 4. */
  const OPPORTUNITY_COPY = {
    capacityKnown: perMonth =>
      `Based on the answers you gave, and held to about ${perMonth} additional appointments a month — the amount you told us you could comfortably take on. Recovering appointments you had already booked is not held to that limit.`,
    /* "held to about 0 additional appointments" is arithmetically right and
       reads like a mistake. A salon with no room is not being told it has no
       opportunity; it is being told which part of it is reachable today. */
    capacityNone:
      'Based on the answers you gave. You told us you have no room for additional appointments right now, so this covers only what could be recovered from appointments you had already booked.',
    capacityUnsure:
      'Based on the answers you gave. You told us you are not sure how much additional work you could take on, so this range is not limited by available capacity. What you can actually take on could change it.',
    capacityUnknown:
      'Based on the answers you gave. This range is not limited by available capacity. What you can actually take on could change it.'
  };

  const CONFIDENCE_WORD = { low: 'lower', medium: 'moderate', high: 'higher' };

  const EVIDENCE_NOTE = {
    preliminary: word =>
      `This is a preliminary review of how your salon runs today. Confidence in the estimate is ${word}. We have not yet asked about fit, timing, budget, or setup, so the recommended starting point may change.`,
    full: word => `Confidence in the estimate is ${word}. Your review is complete.`
  };

  const DEFAULT_PRIORITY_COUNT = 3;

  const nowIso = () => new Date().toISOString();

  /* crypto.randomUUID is the intended source. The fallbacks exist because these
     pages must also work from file:// and on older Safari. */
  const newId = () => {
    const c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map(x => x.toString(16).padStart(2, '0'));
      return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
    }
    console.warn('[CED] crypto unavailable; generated a non-cryptographic id.');
    return `fallback-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  };

  const formatCurrency = amount =>
    amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /* A range, not a promise. Collapses to one figure only when the two ends
     round to the same dollar amount. */
  const formatRange = ({ low, high }) => {
    const a = formatCurrency(low);
    const b = formatCurrency(high);
    return a === b ? a : `${a} – ${b}`;
  };

  const textOf = selector => {
    const el = document.querySelector(selector);
    return el ? el.textContent.trim() : null;
  };

  const textIn = (root, selector) => {
    const el = root && root.querySelector(selector);
    return el ? el.textContent.trim() : null;
  };

  const readUtm = () => {
    const params = new URLSearchParams(window.location.search || '');
    const utm = {};
    UTM_KEYS.forEach(key => {
      const value = params.get(key);
      if (value) utm[key] = value;
    });
    return utm;
  };

  /* One attribution snapshot of the current page view. */
  const touchNow = () => ({
    url: window.location.href,
    referrer: document.referrer || null,
    utm: readUtm(),
    occurredAt: nowIso()
  });

  /* Stable fingerprint of what was submitted, used to suppress local duplicates.
     Deliberately excludes ids and timestamps so it describes content only. */
  const signatureOf = value => {
    const json = JSON.stringify(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) {
      hash ^= json.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
  };

  const selectPriorities = (config, dimensions) => {
    const count = config.priorityCount || DEFAULT_PRIORITY_COUNT;
    const picked = config.priorities.filter(rule => rule.when(dimensions)).map(rule => rule.message);
    while (picked.length < count) picked.push(config.priorityFallback);
    return picked.slice(0, count);
  };

  /* Cloning a vertical most often breaks scoring by renaming a form field.
     Surface that immediately instead of silently scoring the field as zero. */
  const verifyFields = (config, form) => {
    if (!config.fields) return;
    const missing = config.fields.filter(name => !form.elements[name]);
    if (missing.length) {
      console.warn(`CED assessment engine: config references form fields missing from the markup — ${missing.join(', ')}`);
    }
  };

  const findProhibitedFields = form =>
    Object.keys(form.elements || {}).filter(name => PROHIBITED_FIELD_PATTERN.test(name));

  const init = config => {
    const modal = document.querySelector(SELECTORS.modal);
    const form = document.querySelector(SELECTORS.form);
    if (!modal || !form) return;

    const steps = [...modal.querySelectorAll(SELECTORS.step)];

    /* ---------- stages ----------
       A step's data-stage says which stage it belongs to; a step's
       data-results-for marks it as that stage's results screen. A vertical
       that declares neither is a single-stage review and behaves exactly as
       it did before progressive profiling. */
    const stepNumberOf = node => Number(node.dataset.step);
    const stageOf = node => Number(node.dataset.stage || 1);

    const stages = [...new Set(steps.map(stageOf))].sort((a, b) => a - b);
    const firstStage = stages[0];
    const finalStage = stages[stages.length - 1];

    const stepNodeOf = number => steps.find(node => stepNumberOf(node) === number) || null;
    const stepsInStage = stage => steps.filter(node => stageOf(node) === stage);
    const resultsNodeOf = stage =>
      steps.find(node => Number(node.dataset.resultsFor) === stage) || null;
    /* A stage with no declared results screen ends on its last step. */
    const resultsStepOf = stage => {
      const node = resultsNodeOf(stage);
      if (node) return stepNumberOf(node);
      const inStage = stepsInStage(stage);
      return inStage.length ? stepNumberOf(inStage[inStage.length - 1]) : null;
    };

    const startButtons = document.querySelectorAll(SELECTORS.open);
    const closeButton = modal.querySelector(SELECTORS.close);
    const backdrop = modal.querySelector(SELECTORS.backdrop);
    const nextButton = modal.querySelector(SELECTORS.next);
    const prevButton = modal.querySelector(SELECTORS.prev);
    const progressText = modal.querySelector(SELECTORS.progressText);
    const progressBar = modal.querySelector(SELECTORS.progressBar);

    const meta = config.meta || {};
    const consents = meta.consents || [];
    const submissionOptions = config.submission || {};
    const submissionKey = `${config.storageKey}:submission`;

    let currentStep = 1;
    let currentStage = firstStage;
    /* The furthest stage this device has opened. Steps beyond it are disabled
       so their fields never reach a payload; steps at or below it stay enabled
       even when the visitor navigates back, so no answer is ever lost by
       moving between stages. */
    let maxStageReached = firstStage;
    let sending = false;
    let session = null;

    /* Timestamps and links between the stages, persisted with the answers. */
    let stageState = {
      stage1CompletedAt: null,
      stage2StartedAt: null,
      stage2CompletedAt: null,
      stage1SubmissionId: null,
      trigger: null
    };

    verifyFields(config, form);

    const prohibited = findProhibitedFields(form);
    if (prohibited.length) {
      console.error(`[CED] Prohibited field(s) present and excluded from storage and submission — ${prohibited.join(', ')}. This platform must not collect payment, credential, or sensitive health data.`);
    }

    /* The only way config functions read answers.

       A disabled control reads as empty, which keeps `read` in step with
       FormData and therefore with the payload. Without this a question the
       visitor was never shown would still hand its default value to scoring,
       and "not asked" would be indistinguishable from "chose the default". */
    const readable = name => {
      const field = form.elements[name];
      return field && !field.disabled ? field : null;
    };
    const read = {
      num: name => Number(readable(name)?.value || 0),
      val: name => readable(name)?.value || ''
    };

    /* ---------- analytics ----------

       A thin adapter over window.CEDAnalytics. Every call goes through it and
       every call is optional: a page that does not load the analytics client
       behaves exactly as it did before, and a client that throws cannot reach
       the assessment.

       ANALYTICS NEVER PARTICIPATES IN THE ASSESSMENT. Nothing below reads a
       value back into scoring, branching, the payload, or the report. If a
       future edit needs an analytics call's return value for anything the
       visitor can see, that is the signal it belongs somewhere else. */

    const analytics = (() => {
      const client = () => (typeof window !== 'undefined' ? window.CEDAnalytics : null);
      const call = (method, ...args) => {
        const api = client();
        if (!api || typeof api[method] !== 'function') return undefined;
        try {
          return api[method](...args);
        } catch {
          return undefined;
        }
      };
      return {
        available: () => Boolean(client()),
        track: (name, fields) => call('track', name, fields),
        configure: options => call('configure', options),
        setSession: id => call('setSession', id),
        identify: ids => call('identify', ids),
        setStage: stage => call('setStage', stage),
        setStep: stepId => call('setStep', stepId),
        markStarted: () => call('markStarted'),
        markResumed: () => call('markResumed'),
        markFirstAnswer: () => call('markFirstAnswer'),
        markStage1Complete: () => call('markStage1Complete'),
        markResultsViewed: () => call('markResultsViewed'),
        sinceMark: mark => call('sinceMark', mark),
        flush: reason => call('flush', reason),
        reset: () => call('reset')
      };
    })();

    /* Steps whose view has already been recorded, so returning to a step by
       Back does not inflate the step-view count. A stage change clears it,
       because entering Stage 2 is a new pass over a new set of steps. */
    let viewedSteps = new Set();
    /* Questions already counted as answered, so a select fired twice by the
       browser is one interaction. */
    const answeredQuestions = new Set();

    /* ---------- session identity and first-touch attribution ---------- */

    const readStoredState = () => {
      try {
        return JSON.parse(localStorage.getItem(config.storageKey) || 'null') || {};
      } catch {
        return {};
      }
    };

    const newSession = () => ({
      assessmentSessionId: newId(),
      /* Captured once, on the first page view of this assessment, and never
         rewritten. Resuming must not relabel where the lead came from. */
      firstTouch: touchNow()
    });

    /* Runs on page load so first touch really is the first visit, not the
       moment the modal happened to be opened. */
    const ensureSession = () => {
      const state = readStoredState();
      if (state.session && state.session.assessmentSessionId) {
        session = state.session;
        return;
      }
      session = newSession();
      localStorage.setItem(config.storageKey, JSON.stringify({
        data: state.data || {},
        currentStep: state.currentStep || 1,
        session
      }));
    };

    /* FormData omits disabled controls, which is exactly right: a branched-away
       answer has been cleared, and a stage the visitor has not opened was never
       asked. Nothing needs merging forward, because availability is keyed to
       maxStageReached and that never decreases — once a field is enabled it
       stays enabled, so navigating back to Stage 1 cannot lose Stage 2 work. */
    const saveState = () => {
      const data = Object.fromEntries(new FormData(form).entries());
      localStorage.setItem(config.storageKey, JSON.stringify({
        data, currentStep, currentStage, maxStageReached, stageState, session
      }));
    };

    const loadState = () => {
      const saved = readStoredState();
      if (!saved.data && !saved.currentStep) return;
      maxStageReached = Math.min(Math.max(Number(saved.maxStageReached) || firstStage, firstStage), finalStage);
      currentStage = Math.min(Math.max(Number(saved.currentStage) || firstStage, firstStage), maxStageReached);
      stageState = { ...stageState, ...(saved.stageState || {}) };
      /* Values are restored before anything is disabled, so a stage the
         visitor has opened comes back intact. */
      syncStageAvailability();
      Object.entries(saved.data || {}).forEach(([key, value]) => {
        const field = form.elements[key];
        if (!field) return;
        /* FormData omits unchecked boxes, so presence of the key means checked. */
        if (field.type === 'checkbox') field.checked = true;
        else field.value = value;
      });
      const last = resultsStepOf(currentStage) || steps.length;
      currentStep = Math.min(Math.max(Number(saved.currentStep) || 1, 1), last);
    };

    /* ---------- consent ---------- */

    /* A consent that depends on another field (SMS needs a mobile number) stays
       hidden and unchecked until that field has a value. */
    const syncConsentGates = () => {
      consents.filter(entry => entry.requiresField).forEach(entry => {
        const available = Boolean(read.val(entry.requiresField).trim());
        const box = form.elements[entry.field];
        const row = document.querySelector(`[data-consent-gate="${entry.field}"]`);
        if (row) row.hidden = !available;
        if (box) {
          box.disabled = !available;
          if (!available) box.checked = false;
        }
      });
    };

    const consentRecords = recordedAt => {
      const records = {};
      consents.forEach(entry => {
        const box = form.elements[entry.field];
        const available = entry.requiresField
          ? Boolean(read.val(entry.requiresField).trim())
          : true;
        records[entry.key] = {
          field: entry.field,
          granted: Boolean(available && box && box.checked),
          available,
          /* Read from the DOM so the stored wording is exactly what was shown. */
          statement: textOf(`[data-consent-for="${entry.field}"]`),
          recordedAt
        };
      });
      return records;
    };

    /* ---------- branching ----------
       Generic and config-driven. The engine knows how to hide a question; it
       knows nothing about which questions a nail salon should see.

       Hiding disables the inputs, which is what actually removes them from
       FormData and from constraint validation — `hidden` alone would leave a
       required field blocking submission from a step nobody can see.

       A hidden answer is CLEARED, not retained. Keeping it would let a
       question the visitor can no longer see go on feeding scoring, and a
       later branch change could resurrect an answer to a question they were
       never really asked. Every clear is recorded so the report can tell
       "never applicable" from "answered then withdrawn". */

    const branching = config.branching || {};
    const questionNodes = [...form.querySelectorAll(SELECTORS.question)];
    const liveRegion = document.querySelector(SELECTORS.liveRegion);

    /* Fields cleared because their question stopped applying. Reported in the
       payload; never silently discarded. */
    const staleCleared = new Map();

    const inputsIn = node => [...node.querySelectorAll('input, select, textarea')];

    const questionVisible = node => {
      const name = node.dataset.question;
      const rule = branching.questions && branching.questions[name];
      if (typeof rule !== 'function') return true;
      try {
        return Boolean(rule(read));
      } catch (err) {
        /* A broken predicate must not strand the visitor on a blank step. */
        console.error(`[CED] branching predicate for "${name}" threw; showing the question.`, err);
        return true;
      }
    };

    const stepVisible = stepNumber => {
      const rule = branching.steps && branching.steps[stepNumber];
      if (typeof rule === 'function') {
        try {
          if (!rule(read)) return false;
        } catch (err) {
          console.error(`[CED] branching predicate for step ${stepNumber} threw; showing it.`, err);
          return true;
        }
      }
      /* A step whose every question branched away is an empty step. Skip it
         rather than showing a heading with nothing under it.

         "Empty" means no unconditional content AND no visible conditional
         question. A step mixing the two is never empty, which is the common
         case and was worth getting wrong once to find. */
      const node = stepNodeOf(stepNumber);
      if (!node) return true;
      const questions = [...node.querySelectorAll(SELECTORS.question)];
      if (!questions.length) return true;
      const hasUnconditional = [...node.querySelectorAll('input, select, textarea')]
        .some(input => !input.closest(SELECTORS.question));
      if (hasUnconditional) return true;
      return questions.some(questionVisible);
    };

    let visibleSteps = [];

    /* A field belonging to a stage the visitor has not opened yet is disabled,
       so it is absent from FormData and therefore from the payload. A Stage 1
       submission carries Stage 1 answers and nothing else — an empty string
       for a question nobody was shown is not an answer, and storing one would
       make "not asked" indistinguishable from "left blank".

       Availability is by maxStageReached, not by currentStage: navigating BACK
       from Stage 2 must never disable answers already given, or the next save
       would drop them. */
    const stageAvailable = node => {
      const step = node.closest(SELECTORS.step);
      return !step || stageOf(step) <= maxStageReached;
    };

    /* Unconditional, ungated fields only. A field inside a [data-question] is
       owned by the branching pass below, which applies both rules at once; a
       field inside a [data-consent-gate] is owned by syncConsentGates, and
       re-enabling it here would offer SMS consent with no mobile number. */
    const syncStageAvailability = () => {
      steps.forEach(node => {
        const available = stageOf(node) <= maxStageReached;
        inputsIn(node).forEach(input => {
          if (input.closest(SELECTORS.question)) return;
          if (available && input.closest(SELECTORS.consentGate)) return;
          input.disabled = !available;
        });
      });
    };

    /* Recomputes visibility from the current answers. Runs on every input, on
       resume, and before navigation — so the visible set can never lag behind
       the answer that changed it. */
    const syncBranching = () => {
      syncStageAvailability();
      questionNodes.forEach(node => {
        const available = stageAvailable(node);
        const show = questionVisible(node) && available;
        node.hidden = !show;
        inputsIn(node).forEach(input => {
          input.disabled = !show;
          /* A question in a stage that has not opened yet was never asked, so
             there is nothing to clear and nothing stale to report. */
          if (show || !available) return;
          const hadValue = input.type === 'checkbox' || input.type === 'radio'
            ? input.checked
            : String(input.value || '').trim() !== '';
          if (!hadValue) return;
          staleCleared.set(input.name, {
            field: input.name,
            clearedAt: nowIso(),
            reason: 'question_no_longer_applies'
          });
          if (input.type === 'checkbox' || input.type === 'radio') input.checked = false;
          else input.value = '';
        });
        /* A question that came back is no longer stale. */
        if (show) inputsIn(node).forEach(input => staleCleared.delete(input.name));
      });

      /* Only the current stage is navigable. Its results screen always
         terminates it, however the branching went. */
      const stageLast = resultsStepOf(currentStage);
      visibleSteps = stepsInStage(currentStage)
        .map(stepNumberOf)
        .filter(n => n === stageLast || stepVisible(n));
      if (stageLast !== null && !visibleSteps.includes(stageLast)) visibleSteps.push(stageLast);
      visibleSteps.sort((a, b) => a - b);
    };

    /* A field on a step that branched away was not shown either, even though
       nothing about the field itself is conditional. Reporting it as visible
       makes the report call it unanswered when it was never applicable, and
       those mean opposite things.

       Computed from stepVisible rather than from visibleSteps, because
       visibleSteps covers only the current stage and a completed earlier stage
       is still perfectly visible. */
    const branchedAwaySteps = () => new Set(
      steps.map(stepNumberOf).filter(n => !stepVisible(n)));

    /* Questions that did not apply on this path. A question on a branched-away
       step counts, for the same reason. Questions in a stage the visitor never
       opened do NOT: they were not skipped, they were not yet offered. */
    const skippedQuestionNames = () => {
      const hiddenSteps = branchedAwaySteps();
      return questionNodes
        .filter(node => stageAvailable(node))
        .filter(node => {
          const step = node.closest(SELECTORS.step);
          return node.hidden || (step && hiddenSteps.has(stepNumberOf(step)));
        })
        .map(node => node.dataset.question);
    };

    /* Which stage a field belongs to. A field outside every step — the bot
       trap — belongs to none and is never stage-filtered. */
    const stageOfField = el => {
      const step = el && el.closest ? el.closest(SELECTORS.step) : null;
      return step ? stageOf(step) : null;
    };

    /* A Stage N submission carries Stage N answers, by construction rather
       than by accident. Once a later stage has been opened its fields are
       enabled, and without this they would leak backwards into an earlier
       stage that is re-finished — changing what that stage claimed, and
       making an unchanged result look like a new one. */
    const withinStage = (el, stage) => {
      const owner = stageOfField(el);
      return owner === null || owner <= stage;
    };

    const visibleFieldNames = (stage = finalStage) => {
      const names = [];
      const hiddenSteps = branchedAwaySteps();
      const onHiddenStep = el => {
        const step = el.closest(SELECTORS.step);
        return Boolean(step && hiddenSteps.has(stepNumberOf(step)));
      };

      questionNodes.forEach(node => {
        if (node.hidden || onHiddenStep(node) || !withinStage(node, stage)) return;
        inputsIn(node).forEach(input => { if (input.name) names.push(input.name); });
      });
      /* Fields not wrapped in a [data-question] are unconditional. */
      [...form.elements].forEach(el => {
        if (!el.name || el.disabled) return;
        if (el.closest(SELECTORS.question)) return;
        if (onHiddenStep(el) || !withinStage(el, stage)) return;
        if (!names.includes(el.name)) names.push(el.name);
      });
      return names;
    };

    /* ---------- steps ---------- */

    let announcedTotal = null;
    const stageLabelNodes = [...modal.querySelectorAll(SELECTORS.stageLabel)];

    const stageNameOf = stage => {
      const node = stepsInStage(stage)[0];
      return (node && node.dataset.stageName) || null;
    };

    const showStep = n => {
      syncBranching();
      /* Landing on a step that has branched away — by resume or by a changed
         answer — snaps to the nearest visible step at or before it, never
         forward past a question the visitor has not seen. */
      let target = n;
      if (!visibleSteps.includes(target)) {
        const earlier = visibleSteps.filter(s => s < target);
        target = earlier.length ? earlier[earlier.length - 1] : visibleSteps[0];
      }

      steps.forEach(step => {
        const number = stepNumberOf(step);
        step.classList.toggle('active', number === target);
        step.hidden = !visibleSteps.includes(number);
      });

      const position = visibleSteps.indexOf(target) + 1;
      const total = visibleSteps.length;
      const stageLast = resultsStepOf(currentStage);
      progressText.textContent = `Step ${position} of ${total}`;
      progressBar.style.width = `${(position / total) * 100}%`;

      const name = stageNameOf(currentStage);
      stageLabelNodes.forEach(node => {
        node.textContent = name || '';
        node.hidden = !name || stages.length < 2;
      });

      /* One step_viewed per step per stage pass. Back-and-forth navigation is
         real behaviour and is reported as a resume, not as another view. */
      const viewKey = `${currentStage}:${target}`;
      analytics.setStage(currentStage);
      analytics.setStep(target);
      if (!viewedSteps.has(viewKey)) {
        viewedSteps.add(viewKey);
        analytics.track('assessment.step_viewed', {
          stepId: String(target),
          metadata: {
            position,
            stepsInStage: total,
            isResultsStep: target === stageLast,
            stepName: stepNodeOf(target) ? stepNodeOf(target).dataset.stepName || null : null
          }
        });
      }

      /* Back is available across a stage boundary: the previous stage's
         results screen is where it leads, and that screen is not resubmitted. */
      const isFirst = position === 1 && currentStage === firstStage;
      const isLast = target === stageLast;
      const isFinalQuestion = visibleSteps[total - 2] === target;
      const resultsNode = resultsNodeOf(currentStage);

      prevButton.style.visibility = isFirst ? 'hidden' : 'visible';
      nextButton.style.display = isLast ? 'none' : 'inline-flex';
      nextButton.textContent = isFinalQuestion
        ? ((resultsNode && resultsNode.dataset.finishLabel) || LABELS.finish)
        : LABELS.continue;
      currentStep = target;

      /* Only speak when the total actually moved. Announcing every step would
         be noise; announcing none would hide the form changing shape. */
      if (liveRegion && announcedTotal !== null && announcedTotal !== total) {
        liveRegion.textContent =
          `The remaining questions changed. This review now has ${total} steps.`;
      }
      announcedTotal = total;
    };

    const currentStepValid = () => {
      const active = stepNodeOf(currentStep);
      if (!active) return true;
      /* Disabled fields are skipped by the browser and must be skipped here
         too — a required question on a hidden branch is not a real blocker. */
      return [...active.querySelectorAll('[required]')]
        .filter(field => !field.disabled && !field.closest('[hidden]'))
        .every(field => field.reportValidity());
    };

    const setStatus = (state, stage = currentStage) => {
      const root = resultsNodeOf(stage);
      const el = root && root.querySelector(RESULT_HOOKS.status);
      if (!el) return;
      el.textContent = STATUS_COPY[state] || '';
      el.dataset.state = state;
    };

    /* ---------- results ---------- */

    /* Orchestration: the engine decides the order, the config supplies the math.

       The RANGE is not the config's business. It is produced by the same
       functions the Business Intelligence Report uses, from the same answers,
       so the figure on screen and the figure in the report cannot drift apart.
       If those modules are not loaded the page falls back to the point figure
       it has always shown. */
    const reportEngine = () => window.CEDGenerateBir || null;

    const calculate = () => {
      const opportunity = config.opportunity(read);
      const dimensions = config.dimensions(read);
      const score = config.overallScore(dimensions);
      const priorities = selectPriorities(config, dimensions);
      const recommendation = config.recommendPackage(read, { opportunity, score, dimensions });

      const answers = Object.fromEntries(new FormData(form).entries());
      const bir = reportEngine();
      let range = null;
      if (bir && typeof bir.visibleOpportunityRange === 'function') {
        try {
          range = bir.visibleOpportunityRange({ point: opportunity, answers });
        } catch (err) {
          console.error('[CED] the opportunity range could not be computed.', err);
        }
      }
      if (!range) {
        range = {
          low: Math.round(opportunity * 100) / 100,
          point: Math.round(opportunity * 100) / 100,
          high: Math.round(opportunity * 100) / 100,
          unconstrainedPoint: Math.round(opportunity * 100) / 100,
          capacityKnown: false, capacityBand: null, capacityPerMonth: null,
          clampApplied: false, confidenceBand: null
        };
      }

      return { opportunity, dimensions, score, priorities, recommendation, range };
    };

    const assumptionCopy = range => {
      if (range.capacityKnown && range.capacityPerMonth !== null) {
        const perMonth = Math.round(range.capacityPerMonth);
        return perMonth === 0
          ? OPPORTUNITY_COPY.capacityNone
          : OPPORTUNITY_COPY.capacityKnown(perMonth);
      }
      return range.capacityBand === 'unsure'
        ? OPPORTUNITY_COPY.capacityUnsure
        : OPPORTUNITY_COPY.capacityUnknown;
    };

    const paint = (results, stage) => {
      const root = resultsNodeOf(stage);
      if (!root) return;
      const put = (hook, value) => {
        const el = root.querySelector(RESULT_HOOKS[hook]);
        if (el) el.textContent = value;
      };

      put('subject', read.val(config.subjectField) || config.subjectFallback);
      put('score', results.score);
      /* A range, never a bare point figure, and never larger than the report
         considers realistically capturable. */
      put('opportunity', formatRange(results.range));
      put('assumptions', assumptionCopy(results.range));
      put('packageLabel', results.recommendation.label);
      put('packageReason', results.recommendation.reason);

      const word = CONFIDENCE_WORD[results.range.confidenceBand] || 'limited';
      put('evidenceNote', stage === finalStage
        ? EVIDENCE_NOTE.full(word)
        : EVIDENCE_NOTE.preliminary(word));

      const list = root.querySelector(RESULT_HOOKS.priorities);
      if (list) {
        list.innerHTML = results.priorities
          .map((message, i) => `<div class="priority"><b>0${i + 1}</b><span>${message}</span></div>`)
          .join('');
      }
    };

    /* ---------- payload ---------- */

    const buildPayload = (results, stage) => {
      const now = nowIso();
      const consentFields = consents.map(entry => entry.field);

      /* Complete raw record, minus the bot trap, the consent flags (recorded
         separately), and anything matching the prohibited-data policy. */
      const answers = Object.fromEntries(new FormData(form).entries());
      delete answers[HONEYPOT_FIELD];
      delete answers[CHALLENGE_FIELD];
      consentFields.forEach(name => { delete answers[name]; });
      prohibited.forEach(name => { delete answers[name]; });
      /* Answers belonging to a later stage never travel with an earlier one. */
      Object.keys(answers).forEach(name => {
        if (!withinStage(form.elements[name], stage)) delete answers[name];
      });

      const inStage = name => withinStage(form.elements[name], stage);

      const contact = {};
      (meta.contactFields || []).forEach(name => {
        contact[name] = inStage(name) ? read.val(name) : '';
      });

      /* Optional identity evidence. Visitor-supplied and therefore unverified:
         it can improve candidate ranking, and it can never link a record on
         its own. See shared/business-record/resolve-identity.js. */
      (meta.identityFields || []).forEach(name => {
        if (!inStage(name)) return;
        const value = read.val(name).trim();
        if (value) contact[name] = value;
      });

      const visible = visibleFieldNames(stage);
      const engine = window.CEDIntelligence;
      if (!engine) {
        console.error('[CED] intelligence.js is not loaded; the submission will carry no dimensions.');
      }
      const intelligence = engine ? engine.computeDimensions(answers) : null;

      const packageMeta = (meta.packages || [])
        .find(entry => entry.id === results.recommendation.id) || null;

      return {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        assessmentVersion: meta.assessmentVersion || null,
        /* Stable for the life of this device's assessment. */
        assessmentSessionId: session ? session.assessmentSessionId : null,
        /* Assigned per genuinely new completed result; the server's idempotency key. */
        submissionId: null,
        vertical: { id: meta.verticalId || null, name: meta.verticalName || null },
        submittedAt: now,
        attribution: {
          firstTouch: session ? session.firstTouch : null,
          latestTouch: touchNow()
        },
        contact,
        consent: consentRecords(now),
        /* Anti-abuse envelope. The honeypot's VALUE never travels — only
           whether it was touched — and the server, not this file, decides
           what that means. A page that has been tampered with to remove this
           block simply looks like an older schema version to the endpoint. */
        integrity: {
          honeypotFilled: Boolean(read.val(HONEYPOT_FIELD)),
          challengeToken: read.val(CHALLENGE_FIELD) || null
        },
        /* Which stage of the review this submission completed, and which
           submission it continues. A Stage 2 submission never replaces the
           Stage 1 one: both are stored, and the report generated from this one
           supersedes the preliminary report while both stay readable. */
        assessmentStage: {
          stage,
          stageId: `stage${stage}`,
          stageName: stageNameOf(stage),
          totalStages: stages.length,
          stage1CompletedAt: stageState.stage1CompletedAt,
          stage2StartedAt: stage > firstStage ? stageState.stage2StartedAt : null,
          stage2CompletedAt: stage === finalStage && stages.length > 1
            ? stageState.stage2CompletedAt : null,
          /* Null on a Stage 1 submission — there is nothing before it. */
          supersedesSubmissionId: stage > firstStage ? stageState.stage1SubmissionId : null,
          trigger: stage > firstStage ? stageState.trigger : 'stage1_complete'
        },
        /* Which questions this visitor actually saw. Without it the report
           cannot tell a question that did not apply from one that was skipped,
           and those mean opposite things. */
        branching: {
          stage,
          visibleSteps: visibleSteps.slice(),
          totalSteps: steps.length,
          stageSteps: stepsInStage(stage).map(stepNumberOf),
          visibleFields: visible,
          skippedFields: skippedQuestionNames().filter(name =>
            withinStage(form.elements[name], stage)),
          staleClearedFields: [...staleCleared.values()],
          questionSetVersion: meta.questionSetVersion || null
        },
        /* Deterministic, separate from the Growth Score, and recomputed
           server-side from these same answers by the same module. */
        intelligence,
        answers,
        results: {
          opportunity: Math.round(results.opportunity * 100) / 100,
          opportunityFormatted: formatCurrency(results.opportunity),
          /* What the visitor actually saw: the capacity-aware range, with the
             assumptions stated beside it. Carried so a CRM can never show the
             figure without the context it was shown in. */
          opportunityRange: {
            low: results.range.low,
            point: results.range.point,
            high: results.range.high,
            formatted: formatRange(results.range),
            capacityKnown: results.range.capacityKnown,
            clampApplied: results.range.clampApplied,
            assumptions: assumptionCopy(results.range)
          },
          score: results.score,
          dimensions: results.dimensions,
          priorities: results.priorities,
          recommendedPackage: {
            id: results.recommendation.id || null,
            label: results.recommendation.label,
            reason: results.recommendation.reason,
            name: packageMeta ? packageMeta.name : null,
            price: packageMeta ? packageMeta.price : null,
            currency: packageMeta ? packageMeta.currency : null,
            interval: packageMeta ? packageMeta.interval : null
          },
          /* Compliance: the figure above is diagnostic, never a projection.
             Taken from the disclaimer on the results screen THIS stage showed,
             so a stage can never ship a figure with another stage's wording. */
          disclaimer: textIn(resultsNodeOf(stage), SELECTORS.disclaimer) ||
                      textOf(SELECTORS.disclaimer)
        }
      };
    };

    /* ---------- submission ---------- */

    const submissionLog = () => {
      try {
        return JSON.parse(localStorage.getItem(submissionKey) || 'null') || {};
      } catch {
        return {};
      }
    };

    /* One record PER STAGE. A single record would let the Stage 2 entry
       displace the Stage 1 one, after which stepping back to the preliminary
       results and forward again would look like new content and send a
       duplicate. A record written before staging is flat and describes the
       whole review, so it is read as the first stage's. */
    const lastSubmission = stage => {
      const log = submissionLog();
      if (log.signature) return stage === firstStage ? log : null;
      return log[`stage${stage}`] || null;
    };

    /* businessId, when the capture endpoint returns one, is kept beside the
       saved state so a later reassessment from this browser can be recognised
       as the same business. It is an opaque identifier, never a credential. */
    const recordSubmission = (stage, signature, submissionId, status, extra = {}) => {
      const previous = submissionLog();
      const log = previous.signature ? {} : { ...previous };
      log[`stage${stage}`] = {
        signature, submissionId, status, stage, at: nowIso(),
        businessId: extra.businessId || null,
        identityStatus: extra.identityStatus || null
      };
      /* The business is not a property of a stage, so it stays at the top. */
      log.businessId = extra.businessId || log.businessId || null;
      localStorage.setItem(submissionKey, JSON.stringify(log));
    };

    const submit = async (results, stage) => {
      if (sending) return;

      /* The honeypot is NOT enforced here. A bot that posts directly never
         runs this code, so a browser-side check protects nothing; the
         indicator travels in the payload and the server decides. Results
         still render either way — the visitor's screen is unaffected. */
      const payload = buildPayload(results, stage);
      if (payload.integrity.honeypotFilled) {
        console.warn('[CED] Honeypot field filled — the server will refuse this submission.');
      }
      /* The stage is part of the content. A Stage 2 submission whose answers
         happened to be unchanged is still a different result — it completes a
         different claim — and must not be suppressed as a duplicate of the
         preliminary one. */
      const signature = signatureOf({ stage, answers: payload.answers, results: payload.results });
      const previous = lastSubmission(stage);

      /* Already delivered, or already sitting in the retry queue under its own
         submissionId. Retrying is the queue's job, not this path's. */
      if (previous && previous.signature === signature &&
          (previous.status === 'sent' || previous.status === 'queued')) {
        return;
      }

      /* A genuinely new completed result gets a new idempotency key. It travels
         inside the payload, so every retry of this result reuses it. */
      payload.submissionId = newId();
      /* Remembered so the Stage 2 submission can name the preliminary one it
         continues, without ever reusing its key. */
      if (stage === firstStage) {
        stageState.stage1SubmissionId = payload.submissionId;
        saveState();
      }
      /* Late-bound so a funnel row can be joined to a submission. Analytics
         never mints an id and never resolves identity; it only learns the ones
         the assessment already produced. */
      analytics.identify({ submissionId: payload.submissionId });

      const adapter = window.CEDSubmission;
      if (!adapter) {
        console.error('[CED] submission.js is not loaded; the completed assessment was not sent.');
        setStatus('ready', stage);
        return;
      }

      sending = true;
      setStatus('sending', stage);
      try {
        const outcome = await adapter.submitAssessment(payload, submissionOptions);
        recordSubmission(stage, signature, payload.submissionId, outcome.status, outcome);
        if (outcome && outcome.businessId) analytics.identify({ businessId: outcome.businessId });
        setStatus(outcome.status === 'sent' ? 'sent' : outcome.status === 'queued' ? 'queued' : 'ready', stage);
      } finally {
        sending = false;
      }
    };

    /* submit: true only on the transition into a stage's results step.
       Resuming a finished stage, or stepping back to it from the next stage,
       repaints without resending. */
    const renderResults = ({ submit: shouldSubmit = false, stage = currentStage } = {}) => {
      const results = calculate();
      paint(results, stage);

      /* The results screen being painted IS the result being viewed. Recorded
         on every paint, including a repaint on resume, because "came back to
         look at their results again" is a real and interesting behaviour.
         Only the FIRST view sets the mark the later timings measure from. */
      analytics.markResultsViewed();
      analytics.track(stage === finalStage && stages.length > 1
        ? 'assessment.full_results_viewed'
        : 'assessment.preliminary_results_viewed', {
        assessmentStage: stage,
        metadata: {
          repaint: !shouldSubmit,
          /* Band and score are OUR figures about the visitor's operation, not
             personal data, and without them a funnel cannot answer "do people
             with low scores drop out more?". */
          growthScore: results.score,
          recommendedPackageId: results.recommendation.id || null,
          capacityKnown: results.range.capacityKnown,
          clampApplied: results.range.clampApplied
        }
      });

      if (shouldSubmit) void submit(results, stage);
    };

    /* ---------- stage transitions ---------- */

    const stageNoteNodes = () => [...modal.querySelectorAll(SELECTORS.stageNote)];

    const showStageNote = trigger => {
      const text = STAGE_NOTE_COPY[trigger] || STAGE_NOTE_COPY.requested;
      stageNoteNodes().forEach(node => {
        node.textContent = text;
        node.hidden = false;
      });
    };

    /* Records that a stage finished. The timestamp is written once: a visitor
       who steps back to a results screen has not completed it a second time. */
    const markStageComplete = stage => {
      const at = nowIso();
      const firstTime = stage === firstStage
        ? !stageState.stage1CompletedAt
        : !stageState.stage2CompletedAt;
      if (stage === firstStage) stageState.stage1CompletedAt ||= at;
      if (stage === finalStage && stages.length > 1) stageState.stage2CompletedAt ||= at;

      if (!firstTime) return;
      if (stage === firstStage) {
        analytics.markStage1Complete();
        analytics.track('assessment.stage1_completed', {
          assessmentStage: 1,
          metadata: { stepsCompleted: visibleSteps.length - 1 }
        });
      } else if (stages.length > 1) {
        analytics.track('assessment.stage2_completed', {
          assessmentStage: 2,
          metadata: {
            stepsCompleted: visibleSteps.length - 1,
            /* Active time from the preliminary result to finishing the fit
               review. Null when the marks were never set. */
            activeMsSinceStage1: analytics.sinceMark('stage1CompletedAt') ?? null
          }
        });
      }
    };

    /* Opens the next stage. Optional by design: nothing here runs unless the
       visitor asks for it, and the preliminary results stay exactly as they
       were shown. */
    const openNextStage = (trigger = 'requested') => {
      const next = stages[stages.indexOf(currentStage) + 1];
      if (next === undefined) return false;

      stageState.stage2StartedAt ||= nowIso();
      stageState.trigger = trigger;
      currentStage = next;
      maxStageReached = Math.max(maxStageReached, next);
      showStageNote(trigger);

      /* A new stage is a new pass over a new set of steps. */
      viewedSteps = new Set();
      analytics.setStage(next);
      analytics.track('assessment.stage2_started', {
        assessmentStage: next,
        metadata: {
          trigger,
          /* How long the visitor spent with their preliminary results before
             deciding to continue — the single most useful number this
             milestone produces about the two-stage split. */
          activeMsSinceResultsViewed: analytics.sinceMark('resultsViewedAt') ?? null,
          activeMsSinceStage1: analytics.sinceMark('stage1CompletedAt') ?? null
        }
      });
      /* A stage boundary is a natural flush point: the visitor has reached a
         milestone worth having on the server even if they leave next. */
      analytics.flush('stage_boundary');

      /* The step total changes on purpose here, so the "the questions changed"
         announcement would be misleading. The stage label carries the news. */
      announcedTotal = null;
      syncBranching();
      if (liveRegion) {
        const name = stageNameOf(next);
        liveRegion.textContent = name
          ? `${name} started. ${visibleSteps.length} steps remaining.`
          : `${visibleSteps.length} steps remaining.`;
      }
      showStep(visibleSteps[0]);
      saveState();
      return true;
    };

    /* ---------- modal ---------- */

    const openReview = () => {
      /* Read BEFORE loadState, which is what tells started from resumed:
         once loadState has run there is always saved state.

         Keys, not truthiness. ensureSession writes `data: {}` on the very
         first page view so the session id is durable, so an empty object is
         the NORMAL state of someone who has never answered anything — and
         testing it for truthiness reported every first-time visitor as a
         returning one. */
      const hadSavedState = Object.keys(readStoredState().data || {}).length > 0;

      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      loadState();
      syncConsentGates();
      /* Resume order matters: answers are restored, THEN branching is
         recomputed from them, and only then is a step chosen. Resuming into a
         step that no longer applies is corrected by showStep. */
      syncBranching();

      /* Started or resumed, decided before anything else is emitted so the
         session's first event is the right one. */
      analytics.setStage(currentStage);
      if (hadSavedState) {
        analytics.markResumed();
        analytics.track('assessment.resumed', {
          assessmentStage: currentStage,
          stepId: String(currentStep),
          metadata: { resumedAtStep: currentStep, maxStageReached }
        });
      } else {
        analytics.markStarted();
        analytics.track('assessment.started', {
          assessmentStage: currentStage,
          metadata: { entryStep: currentStep }
        });
      }
      /* Either way the visitor is now working, which is what the abandonment
         inference needs to know. */
      analytics.markStarted();

      /* A finished stage resumes on its results step, so repopulate it —
         without resubmitting. */
      if (currentStep === resultsStepOf(currentStage)) {
        renderResults({ submit: false, stage: currentStage });
      }
      showStep(currentStep);
    };

    const closeReview = () => {
      saveState();
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      /* Closing the modal is a pause, not an exit — the visitor is still on
         the page and their work is saved. Worth getting to the server, worth
         NOT calling abandonment. */
      analytics.flush('modal_closed');
    };

    startButtons.forEach(btn => btn.addEventListener('click', openReview));
    closeButton.addEventListener('click', closeReview);
    backdrop.addEventListener('click', closeReview);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeReview();
    });

    /* Navigation walks the visible set, so a branch that removes the next step
       is skipped rather than shown empty. Recomputed on every move because the
       answer just given may have changed what comes next. */
    const stepAfter = from => {
      syncBranching();
      const later = visibleSteps.filter(s => s > from);
      return later.length ? later[0] : resultsStepOf(currentStage);
    };

    const stepBefore = from => {
      syncBranching();
      const earlier = visibleSteps.filter(s => s < from);
      return earlier.length ? earlier[earlier.length - 1] : visibleSteps[0];
    };

    nextButton.addEventListener('click', () => {
      /* There is nothing after a results screen. The button is hidden there,
         but a hidden button is a presentation detail and this is the rule:
         without it, Continue on the results screen would re-enter the same
         step and produce the result a second time. */
      if (currentStep === resultsStepOf(currentStage)) return;
      if (!currentStepValid()) {
        /* Which question stopped them, never what they typed. A rising rate on
           one field is a question that reads badly, not a careless visitor. */
        const active = stepNodeOf(currentStep);
        const blocking = active
          ? [...active.querySelectorAll('[required]')]
              .filter(field => !field.disabled && !field.closest('[hidden]'))
              .filter(field => !field.reportValidity())
              .map(field => field.name)
              .filter(Boolean)
          : [];
        analytics.track('assessment.validation_failed', {
          stepId: String(currentStep),
          questionId: blocking[0] || null,
          metadata: { blockingFields: blocking.slice(0, 6), blockingCount: blocking.length }
        });
        return;
      }
      const completedStep = currentStep;
      saveState();
      const next = stepAfter(currentStep);
      analytics.track('assessment.step_completed', {
        stepId: String(completedStep),
        metadata: { nextStepId: next === null ? null : String(next) }
      });
      /* Results are produced on the transition INTO this stage's results step,
         whichever visible step happened to precede it. */
      if (next === resultsStepOf(currentStage)) {
        markStageComplete(currentStage);
        renderResults({ submit: true, stage: currentStage });
      }
      showStep(next);
      saveState(); /* persist the step just moved to, so resume lands there */
    });

    prevButton.addEventListener('click', () => {
      /* Stepping back off the first question of a later stage returns to the
         previous stage's results screen. It is repainted, never resubmitted:
         the preliminary result the visitor was shown is not produced twice. */
      if (currentStep === visibleSteps[0] && currentStage > firstStage) {
        currentStage = stages[stages.indexOf(currentStage) - 1];
        announcedTotal = null;
        syncBranching();
        renderResults({ submit: false, stage: currentStage });
        showStep(resultsStepOf(currentStage));
        saveState();
        return;
      }
      showStep(stepBefore(currentStep));
      saveState();
    });

    /* The three paths offered after a stage's results. Two continue the
       review; anything else on the screen is an ordinary link and is left
       alone. */
    const STAGE_ACTION_EVENT = {
      improve_recommendation: 'assessment.improve_recommendation_clicked',
      see_recommended_system: 'assessment.recommended_system_clicked',
      checkout_intent: 'assessment.checkout_intent'
    };

    modal.querySelectorAll(SELECTORS.stageAction).forEach(node => {
      node.addEventListener('click', event => {
        const trigger = node.dataset.stageAction;
        if (!trigger || trigger === 'none') return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        /* The click is recorded BEFORE the stage opens, so the two events are
           in the order they happened even when they land in one batch. */
        analytics.track(STAGE_ACTION_EVENT[trigger] || 'assessment.checkout_intent', {
          metadata: {
            trigger,
            activeMsSinceResultsViewed: analytics.sinceMark('resultsViewedAt') ?? null
          }
        });
        openNextStage(trigger);
      });
    });

    /* Everything else worth counting is marked in the markup and handled by a
       single delegated listener. One listener, any number of controls, and a
       vertical adds a measurement by adding an attribute rather than by
       editing this file. */
    modal.addEventListener('click', event => {
      const target = event && event.target;
      const node = target && typeof target.closest === 'function'
        ? target.closest(SELECTORS.analyticsAction) : null;
      if (!node) return;
      const name = node.dataset.analyticsEvent;
      if (!name) return;
      analytics.track(name, {
        metadata: {
          control: node.dataset.analyticsLabel || null,
          activeMsSinceResultsViewed: analytics.sinceMark('resultsViewedAt') ?? null
        }
      });
      /* These are ordinary links and buttons. Nothing is prevented; the
         visitor goes where they were going. */
      analytics.flush('cta_click');
    });

    /* One delegated listener for every question, present and future. A
       per-question listener would be 58 listeners today and a maintenance
       trap the moment a vertical adds a field. */
    const recordAnswer = event => {
      const field = event && event.target;
      const name = field && field.name;
      if (!name) return;
      if (name === HONEYPOT_FIELD || name === CHALLENGE_FIELD) return;
      if (consents.some(entry => entry.field === name)) return;
      if (answeredQuestions.has(name)) return;

      const value = field.type === 'checkbox' || field.type === 'radio'
        ? field.checked : String(field.value || '').trim();
      if (value === '' || value === false) return;
      answeredQuestions.add(name);

      const first = analytics.markFirstAnswer();
      const engine = window.CEDAnalyticsEvents;
      analytics.track('assessment.question_answered', {
        stepId: String(currentStep),
        questionId: name,
        metadata: {
          /* The VALUE only when the shared allowlist names the question, and
             never otherwise. See shared/analytics/events.js. */
          value: engine && engine.mayRecordValue(name) ? String(field.value || '').slice(0, 40) : null,
          answeredCount: answeredQuestions.size,
          isFirstAnswer: first !== null && first !== undefined
        }
      });
    };

    form.addEventListener('input', event => {
      syncConsentGates();
      /* An answer can change which questions apply, so visibility and progress
         are recomputed immediately rather than at the next navigation. */
      const before = visibleSteps.length;
      syncBranching();
      if (visibleSteps.length !== before) showStep(currentStep);
      saveState();
      recordAnswer(event);
    });

    form.addEventListener('change', event => {
      syncConsentGates();
      const before = visibleSteps.length;
      syncBranching();
      if (visibleSteps.length !== before) showStep(currentStep);
      saveState();
      recordAnswer(event);
    });

    /* Remove everything this platform stored on this device. */
    const clearSavedAssessmentData = () => {
      /* Recorded and flushed BEFORE the analytics queue is cleared, because a
         deletion nobody can see is a deletion nobody can audit — and after
         this the client has nothing left to send it with. */
      analytics.track('assessment.clear_saved_data', {
        metadata: { requestedAtStep: currentStep, stage: currentStage }
      });
      analytics.flush('data_cleared');

      localStorage.removeItem(config.storageKey);
      localStorage.removeItem(submissionKey);
      const adapter = window.CEDSubmission;
      if (adapter && adapter.clearQueue) adapter.clearQueue(submissionOptions);
      analytics.reset();
      /* Start a fresh session in memory; nothing is written until the visitor
         interacts again. */
      session = newSession();
      return true;
    };

    ensureSession();
    syncConsentGates();
    syncBranching();

    /* ---------- analytics start-up ----------
       After the session exists, because every event is keyed to it, and after
       the first branching pass, because the question counts come from it. */

    /* Fields the visitor is actually asked. Excludes the bot trap and the
       consent checkboxes: consent is a permission, not a question, and
       counting it would make the completion rate look better than it is. */
    const questionFieldNames = () => {
      const consentFields = consents.map(entry => entry.field);
      return visibleFieldNames(currentStage)
        .filter(name => name !== HONEYPOT_FIELD && name !== CHALLENGE_FIELD)
        .filter(name => !consentFields.includes(name));
    };

    const analyticsContext = () => {
      const names = questionFieldNames();
      return {
        verticalId: meta.verticalId || null,
        assessmentVersion: meta.assessmentVersion || null,
        questionSetVersion: meta.questionSetVersion || null,
        attribution: {
          firstTouch: session ? session.firstTouch : null,
          latestTouch: touchNow()
        },
        visibleQuestionCount: names.length,
        completedQuestionCount: names.filter(name => {
          const field = form.elements[name];
          if (!field) return false;
          if (field.type === 'checkbox' || field.type === 'radio') return field.checked === true;
          return String(field.value || '').trim() !== '';
        }).length
      };
    };

    if (analytics.available()) {
      const options = config.analytics || {};
      analytics.configure({
        ...options,
        /* Same rule as the submission endpoint: same-origin over http(s),
           and nothing at all from file://, where the page must keep working
           with no server to talk to. */
        endpoint: options.endpoint !== undefined ? options.endpoint
          : (window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')
              ? '/api/analytics' : null),
        verticalId: meta.verticalId || null,
        assessmentSessionId: session ? session.assessmentSessionId : null,
        context: analyticsContext
      });

      /* A previously stored businessId lets a funnel row be joined to a
         Business Record without analytics ever resolving identity itself. */
      const previous = lastSubmission(firstStage) || lastSubmission(finalStage);
      if (previous) analytics.identify({ businessId: previous.businessId || null });

      analytics.setStage(null);
      analytics.track('assessment.page_viewed', {
        metadata: { resumable: Object.keys(readStoredState().data || {}).length > 0 }
      });
    }

    window.CEDAssessment = {
      clearSavedAssessmentData,
      /* The programmatic way into the next stage, for a checkout, proposal, or
         detailed-report control anywhere on the page. Returns false when there
         is no further stage, so a caller can fall back to its own path. */
      requestFitReview: (trigger = 'requested') => openNextStage(trigger),
      /* Exposed for tests and for verifying a vertical's branching by hand. */
      inspect: () => ({
        currentStep,
        currentStage,
        maxStageReached,
        stages: stages.slice(),
        stageState: { ...stageState },
        visibleSteps: visibleSteps.slice(),
        visibleFields: visibleFieldNames(),
        skippedFields: questionNodes
          .filter(n => n.hidden && stageAvailable(n))
          .map(n => n.dataset.question),
        staleCleared: [...staleCleared.values()]
      })
    };

    /* Anything stranded by an earlier failure gets another chance on load. */
    if (window.CEDSubmission) {
      Promise.resolve(window.CEDSubmission.retryPendingSubmissions(submissionOptions))
        .catch(err => console.warn('[CED] Retry sweep failed.', err));
    }
  };

  const boot = () => {
    const config = window.CED_ASSESSMENT_CONFIG;
    if (!config) {
      console.error('CED assessment engine: no config found. Load the vertical assessment.config.js before engine.js.');
      return;
    }
    init(config);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
