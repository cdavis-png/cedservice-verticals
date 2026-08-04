/* ============================================================
   CED Service — Shared Assessment Engine
   ------------------------------------------------------------
   Generic behavior for every vertical's self-paced review:
   modal open/close, step navigation, validation, save/resume,
   progress, result orchestration, and result rendering.

   This file must stay industry-agnostic. Questions, weights,
   opportunity formulas, priority copy, and package thresholds
   belong in the vertical's assessment.config.js, which sets
   window.CED_ASSESSMENT_CONFIG before this file loads.

   Deliberately a classic script, not an ES module: these pages
   must open directly from file:// with no build step, and
   browsers block module loading on file:// origins.
   ============================================================ */

(() => {
  'use strict';

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
    progressBar: '#progressBar'
  };

  const RESULT_IDS = {
    subject: 'resultSalon',
    score: 'growthScore',
    opportunity: 'monthlyOpportunity',
    packageLabel: 'recommendedPackage',
    packageReason: 'recommendationReason',
    priorities: 'priorityList'
  };

  /* Platform-level UI copy. These change with step position, so they cannot
     live in the markup. Industry copy belongs in the vertical, not here. */
  const LABELS = {
    continue: 'Continue',
    finish: 'See My Results'
  };

  const DEFAULT_PRIORITY_COUNT = 3;

  const formatCurrency = amount =>
    amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  /* Apply the config's priority rules in declaration order, pad with the
     fallback, and trim to the configured count. */
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

    let currentStep = 1;

    verifyFields(config, form);

    /* The only way config functions read answers. */
    const read = {
      num: name => Number(form.elements[name]?.value || 0),
      val: name => form.elements[name]?.value || ''
    };

    const saveState = () => {
      const data = Object.fromEntries(new FormData(form).entries());
      localStorage.setItem(config.storageKey, JSON.stringify({ data, currentStep }));
    };

    const loadState = () => {
      const saved = JSON.parse(localStorage.getItem(config.storageKey) || 'null');
      if (!saved) return;
      Object.entries(saved.data || {}).forEach(([key, value]) => {
        const field = form.elements[key];
        if (field) field.value = value;
      });
      /* Resume anywhere in the review, including the results step. The previous
         implementation clamped to lastStep - 1, which forced a returning user
         who had already finished back onto the final question. */
      currentStep = Math.min(Math.max(Number(saved.currentStep) || 1, 1), lastStep);
    };

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

    /* Orchestration: the engine decides the order, the config supplies the math. */
    const renderResults = () => {
      const opportunity = config.opportunity(read);
      const dimensions = config.dimensions(read);
      const score = config.overallScore(dimensions);
      const priorities = selectPriorities(config, dimensions);
      const recommendation = config.recommendPackage(read, { opportunity, score, dimensions });

      setText(RESULT_IDS.subject, read.val(config.subjectField) || config.subjectFallback);
      setText(RESULT_IDS.score, score);
      setText(RESULT_IDS.opportunity, formatCurrency(opportunity));
      setText(RESULT_IDS.packageLabel, recommendation.label);
      setText(RESULT_IDS.packageReason, recommendation.reason);

      const list = document.getElementById(RESULT_IDS.priorities);
      if (list) {
        list.innerHTML = priorities
          .map((message, i) => `<div class="priority"><b>0${i + 1}</b><span>${message}</span></div>`)
          .join('');
      }
    };

    const openReview = () => {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      loadState();
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
      if (currentStep === lastStep - 1) renderResults();
      showStep(Math.min(lastStep, currentStep + 1));
      saveState(); /* persist the step just moved to, so resume lands there */
    });

    prevButton.addEventListener('click', () => {
      showStep(Math.max(1, currentStep - 1));
      saveState();
    });

    form.addEventListener('input', saveState);
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
