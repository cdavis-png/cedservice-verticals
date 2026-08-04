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
  const PAYLOAD_SCHEMA_VERSION = 2;

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
    disclaimer: '.results-disclaimer'
  };

  const RESULT_IDS = {
    subject: 'resultSalon',
    score: 'growthScore',
    opportunity: 'monthlyOpportunity',
    packageLabel: 'recommendedPackage',
    packageReason: 'recommendationReason',
    priorities: 'priorityList',
    status: 'submissionStatus'
  };

  /* Bot trap. Real users never see or fill this; anything in it is a bot. */
  const HONEYPOT_FIELD = 'website';

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

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const textOf = selector => {
    const el = document.querySelector(selector);
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
    const lastStep = steps.length;
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
    let sending = false;
    let session = null;

    verifyFields(config, form);

    const prohibited = findProhibitedFields(form);
    if (prohibited.length) {
      console.error(`[CED] Prohibited field(s) present and excluded from storage and submission — ${prohibited.join(', ')}. This platform must not collect payment, credential, or sensitive health data.`);
    }

    /* The only way config functions read answers. */
    const read = {
      num: name => Number(form.elements[name]?.value || 0),
      val: name => form.elements[name]?.value || ''
    };

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

    const saveState = () => {
      const data = Object.fromEntries(new FormData(form).entries());
      localStorage.setItem(config.storageKey, JSON.stringify({ data, currentStep, session }));
    };

    const loadState = () => {
      const saved = readStoredState();
      if (!saved.data && !saved.currentStep) return;
      Object.entries(saved.data || {}).forEach(([key, value]) => {
        const field = form.elements[key];
        if (!field) return;
        /* FormData omits unchecked boxes, so presence of the key means checked. */
        if (field.type === 'checkbox') field.checked = true;
        else field.value = value;
      });
      currentStep = Math.min(Math.max(Number(saved.currentStep) || 1, 1), lastStep);
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

    /* ---------- steps ---------- */

    const showStep = n => {
      steps.forEach(step => step.classList.toggle('active', Number(step.dataset.step) === n));
      progressText.textContent = `Step ${n} of ${lastStep}`;
      progressBar.style.width = `${(n / lastStep) * 100}%`;
      prevButton.style.visibility = n === 1 ? 'hidden' : 'visible';
      nextButton.style.display = n === lastStep ? 'none' : 'inline-flex';
      nextButton.textContent = n === lastStep - 1 ? LABELS.finish : LABELS.continue;
      currentStep = n;
    };

    const currentStepValid = () => {
      const active = steps[currentStep - 1];
      return [...active.querySelectorAll('[required]')].every(field => field.reportValidity());
    };

    const setStatus = state => {
      const el = document.getElementById(RESULT_IDS.status);
      if (!el) return;
      el.textContent = STATUS_COPY[state] || '';
      el.dataset.state = state;
    };

    /* ---------- results ---------- */

    /* Orchestration: the engine decides the order, the config supplies the math. */
    const calculate = () => {
      const opportunity = config.opportunity(read);
      const dimensions = config.dimensions(read);
      const score = config.overallScore(dimensions);
      const priorities = selectPriorities(config, dimensions);
      const recommendation = config.recommendPackage(read, { opportunity, score, dimensions });
      return { opportunity, dimensions, score, priorities, recommendation };
    };

    const paint = results => {
      setText(RESULT_IDS.subject, read.val(config.subjectField) || config.subjectFallback);
      setText(RESULT_IDS.score, results.score);
      setText(RESULT_IDS.opportunity, formatCurrency(results.opportunity));
      setText(RESULT_IDS.packageLabel, results.recommendation.label);
      setText(RESULT_IDS.packageReason, results.recommendation.reason);

      const list = document.getElementById(RESULT_IDS.priorities);
      if (list) {
        list.innerHTML = results.priorities
          .map((message, i) => `<div class="priority"><b>0${i + 1}</b><span>${message}</span></div>`)
          .join('');
      }
    };

    /* ---------- payload ---------- */

    const buildPayload = results => {
      const now = nowIso();
      const consentFields = consents.map(entry => entry.field);

      /* Complete raw record, minus the bot trap, the consent flags (recorded
         separately), and anything matching the prohibited-data policy. */
      const answers = Object.fromEntries(new FormData(form).entries());
      delete answers[HONEYPOT_FIELD];
      consentFields.forEach(name => { delete answers[name]; });
      prohibited.forEach(name => { delete answers[name]; });

      const contact = {};
      (meta.contactFields || []).forEach(name => { contact[name] = read.val(name); });

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
        answers,
        results: {
          opportunity: Math.round(results.opportunity * 100) / 100,
          opportunityFormatted: formatCurrency(results.opportunity),
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
             Taken from the on-page disclaimer so the two cannot drift. */
          disclaimer: textOf(SELECTORS.disclaimer)
        }
      };
    };

    /* ---------- submission ---------- */

    const lastSubmission = () => {
      try {
        return JSON.parse(localStorage.getItem(submissionKey) || 'null');
      } catch {
        return null;
      }
    };

    const recordSubmission = (signature, submissionId, status) => {
      localStorage.setItem(submissionKey, JSON.stringify({
        signature, submissionId, status, at: nowIso()
      }));
    };

    const submit = async results => {
      if (sending) return;

      /* Honeypot: render results as normal, send nothing, say nothing. */
      if (read.val(HONEYPOT_FIELD)) {
        console.warn('[CED] Honeypot field filled — submission skipped.');
        return;
      }

      const payload = buildPayload(results);
      const signature = signatureOf({ answers: payload.answers, results: payload.results });
      const previous = lastSubmission();

      /* Already delivered, or already sitting in the retry queue under its own
         submissionId. Retrying is the queue's job, not this path's. */
      if (previous && previous.signature === signature &&
          (previous.status === 'sent' || previous.status === 'queued')) {
        return;
      }

      /* A genuinely new completed result gets a new idempotency key. It travels
         inside the payload, so every retry of this result reuses it. */
      payload.submissionId = newId();

      const adapter = window.CEDSubmission;
      if (!adapter) {
        console.error('[CED] submission.js is not loaded; the completed assessment was not sent.');
        setStatus('ready');
        return;
      }

      sending = true;
      setStatus('sending');
      try {
        const outcome = await adapter.submitAssessment(payload, submissionOptions);
        recordSubmission(signature, payload.submissionId, outcome.status);
        setStatus(outcome.status === 'sent' ? 'sent' : outcome.status === 'queued' ? 'queued' : 'ready');
      } finally {
        sending = false;
      }
    };

    /* submit: true only on the transition into the results step. Resuming a
       finished review repaints without resending. */
    const renderResults = ({ submit: shouldSubmit = false } = {}) => {
      const results = calculate();
      paint(results);
      if (shouldSubmit) void submit(results);
    };

    /* ---------- modal ---------- */

    const openReview = () => {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      loadState();
      syncConsentGates();
      /* A finished review resumes on the results step, so repopulate it. */
      if (currentStep === lastStep) renderResults();
      showStep(currentStep);
    };

    const closeReview = () => {
      saveState();
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    };

    startButtons.forEach(btn => btn.addEventListener('click', openReview));
    closeButton.addEventListener('click', closeReview);
    backdrop.addEventListener('click', closeReview);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeReview();
    });

    nextButton.addEventListener('click', () => {
      if (!currentStepValid()) return;
      saveState();
      if (currentStep === lastStep - 1) renderResults({ submit: true });
      showStep(Math.min(lastStep, currentStep + 1));
      saveState(); /* persist the step just moved to, so resume lands there */
    });

    prevButton.addEventListener('click', () => {
      showStep(Math.max(1, currentStep - 1));
      saveState();
    });

    form.addEventListener('input', () => {
      syncConsentGates();
      saveState();
    });

    /* Remove everything this platform stored on this device. */
    const clearSavedAssessmentData = () => {
      localStorage.removeItem(config.storageKey);
      localStorage.removeItem(submissionKey);
      const adapter = window.CEDSubmission;
      if (adapter && adapter.clearQueue) adapter.clearQueue(submissionOptions);
      /* Start a fresh session in memory; nothing is written until the visitor
         interacts again. */
      session = newSession();
      return true;
    };

    ensureSession();
    syncConsentGates();

    window.CEDAssessment = { clearSavedAssessmentData };

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
