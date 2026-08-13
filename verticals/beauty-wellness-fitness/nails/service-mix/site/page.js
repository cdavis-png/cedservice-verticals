/* ============================================================
   CED Service — Quick Service Mix Review page wiring
   ------------------------------------------------------------
   The nail-salon page's own DOM code. Everything it decides is
   presentation; every calculation, rule, and threshold comes
   from shared/service-mix-engine/.

   Deliberately thin. If something here starts to look like a
   rule, it belongs in the shared engine instead — the second
   vertical will need it too.

   Classic script on purpose.
   ============================================================ */

(() => {
  'use strict';

  const config = window.CED_SERVICE_MIX_CONFIG;
  if (!config) {
    console.error('[CED] service-mix.config.js is not loaded.');
    return;
  }

  const offeringSchema = window.CEDServiceMixOffering;
  const values = window.CEDServiceMixValue;
  const labels = config.labels;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const on = (el, event, handler) => { if (el) el.addEventListener(event, handler); };

  const controller = window.CEDServiceMixController.init({
    storageKey: config.storageKey,
    meta: config.meta,
    submission: config.submission,
    analyticsEndpoint: config.analyticsEndpoint,
    disclaimer: () => config.disclaimer,
    honeypotValue: () => {
      const field = document.getElementById('contactFax');
      return field ? field.value : '';
    }
  });
  if (!controller) return;

  /* The continuation context is read by the controller from the platform's
     shared store, BEFORE it emits its first event — so an after-Growth entry
     is recorded as one. Nothing here needs to touch it. */

  /* ---------- step navigation ---------- */

  const steps = $$('[data-step]');
  const showStep = id => {
    steps.forEach(section => {
      section.hidden = section.dataset.stepId !== id;
    });
    const active = steps.find(s => s.dataset.stepId === id);
    if (active) {
      /* Focus moves to the step so a screen reader announces where it is,
         and the visitor is not left at the top of a page that changed. */
      active.setAttribute('tabindex', '-1');
      active.focus({ preventScroll: false });
      controller.viewStep(id);
    }
  };

  const showError = (node, message) => {
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  };

  /* ---------- step 1: choosing offerings ---------- */

  const starterGrid = $('[data-starter-grid]');
  const offeringList = $('[data-offering-list]');
  const offeringCount = $('[data-offering-count]');
  const offeringError = $('[data-offering-error]');

  const renderStarters = () => {
    starterGrid.innerHTML = '';
    config.starters.forEach(starter => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'starter';
      button.textContent = starter.name;
      /* Words, never colour alone: the state is in the label and in ARIA. */
      button.setAttribute('aria-pressed', 'false');
      button.dataset.starterName = starter.name;
      button.dataset.starterCategory = starter.category;
      starterGrid.appendChild(button);
    });
  };

  const syncStarters = () => {
    const chosen = new Set(controller.offerings().map(o => o.name));
    $$('.starter').forEach(button => {
      const added = chosen.has(button.dataset.starterName);
      button.setAttribute('aria-pressed', added ? 'true' : 'false');
      button.classList.toggle('is-added', added);
      button.disabled = !added && !controller.canAdd();
    });
  };

  const renderOfferingList = () => {
    const list = controller.offerings();
    offeringList.innerHTML = '';
    list.forEach(offering => {
      const item = document.createElement('li');

      const label = document.createElement('input');
      label.type = 'text';
      label.value = offering.name;
      label.maxLength = offeringSchema.OFFERING_LIMITS.nameMaxLength;
      label.setAttribute('aria-label', `Name for ${offering.name}`);
      /* Renaming keeps the offeringId — the rule lives in the schema, and
         this is simply the call site. */
      label.addEventListener('change', () => {
        controller.renameOffering(offering.offeringId, label.value);
        renderAll();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-link';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${offering.name}`);
      remove.disabled = !controller.canRemove();
      remove.addEventListener('click', () => {
        controller.removeOffering(offering.offeringId);
        renderAll();
      });

      item.appendChild(label);
      item.appendChild(remove);
      offeringList.appendChild(item);
    });

    offeringCount.textContent = String(list.length);
    syncStarters();
  };

  on(starterGrid, 'click', event => {
    const button = event.target.closest('.starter');
    if (!button) return;
    const name = button.dataset.starterName;
    const existing = controller.offerings().find(o => o.name === name);
    if (existing) {
      controller.removeOffering(existing.offeringId);
    } else {
      controller.addOffering({
        name, category: button.dataset.starterCategory, source: 'starter'
      });
    }
    showError(offeringError, '');
    renderAll();
  });

  on($('[data-action="add-custom"]'), 'click', () => {
    const input = document.getElementById('custom-offering-name');
    const name = input.value.trim();
    if (!name) {
      showError(offeringError, 'Give it a name first.');
      return;
    }
    if (!controller.canAdd()) {
      showError(offeringError, `You can review up to ${offeringSchema.OFFERING_LIMITS.max} at a time.`);
      return;
    }
    controller.addOffering({ name, category: 'other', source: 'custom' });
    input.value = '';
    showError(offeringError, '');
    renderAll();
  });

  /* ---------- step 2: the figures ---------- */

  const figuresContainer = $('[data-figures-container]');
  const coverageGroup = $('[data-coverage-group]');
  const coverageError = $('[data-coverage-error]');

  /* One measure: a number, and how well it is known. The evidence question is
     rendered beside every figure rather than once at the end, because "how
     sure are you" only means something next to the thing it is about. */
  const renderMeasure = (offering, measure) => {
    /* An offering that has no appointment time is not ASKED for one. Showing
       the question with a "does not apply" option asks a membership how long
       it takes and invites the same answer for a manicure, where it would be
       false — and a false not-applicable removes an offering from the hours
       denominator while leaving it in the revenue one. The control is
       omitted; the engine already treats the measure as not applicable. */
    if (measure === 'durationMinutes' && !offeringSchema.durationApplies(offering)) return null;

    const wrap = document.createElement('div');
    wrap.className = 'measure';

    const current = offering[measure] || values.UNKNOWN;
    const idBase = `${offering.offeringId}-${measure}`;

    const heading = document.createElement('label');
    heading.className = 'measure-label';
    heading.setAttribute('for', `${idBase}-kind`);
    heading.textContent = labels[measure];
    wrap.appendChild(heading);

    const kind = document.createElement('select');
    kind.id = `${idBase}-kind`;
    kind.setAttribute('aria-label', `${labels[measure]} — ${labels.evidence}`);
    values.VALUE_KINDS.forEach(k => {
      /* "Does not apply" is offered only where it can be TRUE. A price and a
         monthly count always exist for something a business sells, even when
         the owner does not know them — "I do not know" is the honest answer
         there, and the engine counts it as the gap it is. */
      if (k === 'not_applicable' &&
          !offeringSchema.mayBeNotApplicable(measure, offering.category)) return;
      const option = document.createElement('option');
      option.value = k;
      option.textContent = labels.evidenceOptions[k];
      option.selected = current.kind === k;
      kind.appendChild(option);
    });
    wrap.appendChild(kind);

    const numbers = document.createElement('div');
    numbers.className = 'measure-numbers';

    const single = document.createElement('input');
    single.type = 'number';
    single.min = '0';
    single.inputMode = 'decimal';
    single.id = `${idBase}-value`;
    single.setAttribute('aria-label', `${labels[measure]} — value`);
    if (current.value !== null && current.value !== undefined) single.value = current.value;

    const low = document.createElement('input');
    low.type = 'number';
    low.min = '0';
    low.inputMode = 'decimal';
    low.id = `${idBase}-low`;
    low.setAttribute('aria-label', `${labels[measure]} — lowest`);
    if (current.low !== null && current.low !== undefined) low.value = current.low;

    const high = document.createElement('input');
    high.type = 'number';
    high.min = '0';
    high.inputMode = 'decimal';
    high.id = `${idBase}-high`;
    high.setAttribute('aria-label', `${labels[measure]} — highest`);
    if (current.high !== null && current.high !== undefined) high.value = current.high;

    numbers.appendChild(single);
    numbers.appendChild(low);
    numbers.appendChild(high);
    wrap.appendChild(numbers);

    const syncInputs = () => {
      const k = kind.value;
      single.hidden = !(k === 'exact' || k === 'estimate');
      low.hidden = k !== 'range';
      high.hidden = k !== 'range';
    };

    const commit = () => {
      controller.setMeasure(offering.offeringId, measure, kind.value, {
        value: single.value === '' ? null : Number(single.value),
        low: low.value === '' ? null : Number(low.value),
        high: high.value === '' ? null : Number(high.value)
      });
      controller.track('assessment.question_answered', {
        questionId: measure,
        metadata: { reviewType: 'service_mix', stage: 1 }
      });
    };

    kind.addEventListener('change', () => { syncInputs(); commit(); });
    [single, low, high].forEach(input => input.addEventListener('change', commit));
    syncInputs();

    return wrap;
  };

  const renderSelect = (offering, field, optionLabels, list) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const id = `${offering.offeringId}-${field}`;

    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labels[field];
    wrap.appendChild(label);

    const select = document.createElement('select');
    select.id = id;
    list.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = optionLabels[value] || value;
      option.selected = offering[field] === value;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      controller.setField(offering.offeringId, field, select.value);
      /* Category decides whether an appointment time applies at all, so the
         figures are re-rendered rather than patched. */
      if (field === 'category') renderFigures();
    });
    wrap.appendChild(select);
    return wrap;
  };

  const renderFigures = () => {
    figuresContainer.innerHTML = '';
    controller.offerings().forEach(offering => {
      const card = document.createElement('section');
      card.className = 'offering-card';

      const heading = document.createElement('h3');
      heading.textContent = offering.name;
      card.appendChild(heading);

      card.appendChild(renderSelect(offering, 'category',
        labels.categoryOptions, offeringSchema.CATEGORIES));
      offeringSchema.STAGE1_MEASURES.forEach(measure => {
        const measureNode = renderMeasure(offering, measure);
        if (measureNode) card.appendChild(measureNode);
      });
      card.appendChild(renderSelect(offering, 'demand',
        labels.demandOptions, offeringSchema.DEMAND_LEVELS));
      card.appendChild(renderSelect(offering, 'role',
        labels.roleOptions, offeringSchema.ROLES));

      figuresContainer.appendChild(card);
    });
  };

  const renderCoverage = () => {
    coverageGroup.innerHTML = '';
    offeringSchema.COVERAGE_DECLARATIONS.forEach(value => {
      const id = `coverage-${value}`;
      const row = document.createElement('div');
      row.className = 'radio-row';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'coverage';
      input.id = id;
      input.value = value;
      input.checked = controller.state().coverage === value;
      input.addEventListener('change', () => {
        controller.setCoverage(value);
        showError(coverageError, '');
      });

      const label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = labels.coverageOptions[value];

      row.appendChild(input);
      row.appendChild(label);
      coverageGroup.appendChild(row);
    });
  };

  /* ---------- results ---------- */

  const money = i => {
    const mid = values.midpoint(i);
    return mid === null ? 'not known' : `$${Math.round(mid).toLocaleString('en-US')}`;
  };
  const range = i =>
    (i && i.known) ? `$${Math.round(i.low).toLocaleString('en-US')}–$${Math.round(i.high).toLocaleString('en-US')}` : 'not known';
  const percent = i => {
    const mid = values.midpoint(i);
    return mid === null ? 'not known' : `${Math.round(mid * 100)}%`;
  };

  const renderResults = () => {
    const { portfolio, classified } = controller.preview();
    const copy = config.health[classified.health.classification];

    $('[data-health-eyebrow]').textContent = copy.eyebrow;
    $('[data-health-heading]').textContent = copy.heading;
    $('[data-health-body]').textContent = copy.body;

    $('[data-confidence]').textContent =
      `Based on ${portfolio.usableOfferingCount} of ${portfolio.offeringCount} offerings. ` +
      `Confidence in the figures entered: ${portfolio.dataConfidence.confidence.toFixed(2)}. ` +
      classified.health.because;

    /* The basis is rendered with the list, never separately and never
       omitted: a ranking whose scope is missing reads as a ranking of the
       business, which the evidence rarely supports. */
    const leaders = $('[data-revenue-leaders]');
    leaders.innerHTML = '';
    portfolio.revenueLeaders.forEach(leader => {
      const li = document.createElement('li');
      li.textContent =
        `${leader.name} — ${range(leader.monthlyRevenue)} a month, ` +
        `${percent(leader.shareOfEnteredRevenue)} of what you entered.`;
      leaders.appendChild(li);
    });
    if (!portfolio.revenueLeaders.length) {
      const li = document.createElement('li');
      li.textContent = 'Not enough figures to rank anything by revenue yet.';
      leaders.appendChild(li);
    }
    $('[data-revenue-leaders-basis]').textContent = portfolio.revenueLeadersBasis.label;
    $('[data-revenue-total-basis]').textContent = portfolio.totals.monthlyRevenueBasis.label;

    const heavy = $('[data-capacity-heavy]');
    heavy.innerHTML = '';
    portfolio.capacityHeavyOfferings.forEach(entry => {
      const li = document.createElement('li');
      li.textContent =
        `${entry.name} — ${percent(entry.shareOfEnteredCapacity)} of the hours you entered, ` +
        `${percent(entry.shareOfEnteredRevenue)} of the revenue.`;
      heavy.appendChild(li);
    });
    if (!portfolio.capacityHeavyOfferings.length) {
      const li = document.createElement('li');
      li.textContent = 'Appointment times were not given, so we cannot say where the hours go.';
      heavy.appendChild(li);
    }
    $('[data-capacity-basis]').textContent = portfolio.capacityHeavyBasis.label;
    $('[data-capacity-total-basis]').textContent = portfolio.totals.capacityHoursBasis.label;

    /* Findings are built by the shared guidance module so the page and the
       stored report say the same thing in the same words. */
    const guidance = window.CEDServiceMixGuidance.buildGuidance(portfolio, classified);
    const findings = $('[data-findings]');
    findings.innerHTML = '';
    guidance.findings.forEach(finding => {
      const article = document.createElement('article');
      article.className = 'finding';
      const parts = [
        ['What it means', finding.whatItMeans],
        ['Why it matters', finding.whyItMatters],
        ['What to try', finding.whatToTest],
        [`Give it ${finding.testDurationDays} days`, `Keep it if ${finding.keepIf} Change it if ${finding.changeIf} Put it back if ${finding.reverseIf}`]
      ];
      parts.forEach(([title, body]) => {
        const h = document.createElement('h4');
        h.textContent = title;
        const p = document.createElement('p');
        p.textContent = body;
        article.appendChild(h);
        article.appendChild(p);
      });
      findings.appendChild(article);
    });
    if (!guidance.findings.length) {
      const p = document.createElement('p');
      p.textContent = classified.findingsWithheld
        ? classified.withheldReason
        : 'Nothing in the figures you entered supports a pricing or capacity finding. That is a result, not an omission.';
      findings.appendChild(p);
    }

    const gapsSection = $('[data-gaps-section]');
    const gaps = $('[data-gaps]');
    gaps.innerHTML = '';
    portfolio.measurementGaps.forEach(gap => {
      const offering = controller.offerings().find(o => o.offeringId === gap.offeringId);
      const li = document.createElement('li');
      li.textContent = `${offering ? offering.name : 'An offering'}: ${gap.prevents}.`;
      gaps.appendChild(li);
    });
    gapsSection.hidden = portfolio.measurementGaps.length === 0;

    const adds = $('[data-detailed-adds]');
    adds.innerHTML = '';
    config.detailedReviewAdds.forEach(text => {
      const li = document.createElement('li');
      li.textContent = text;
      adds.appendChild(li);
    });

    $('[data-disclaimer]').textContent = config.disclaimer;

    controller.viewResults();
  };

  /* ---------- consent ----------
     The statement is read from the DOM at submit time, so the record is
     provably what was displayed rather than a version number we hope matches. */

  const consentRecords = () => {
    const now = new Date().toISOString();
    const records = {};
    config.meta.consents.forEach(entry => {
      const box = document.getElementById(entry.field);
      const row = box ? box.closest('.consent-row') : null;
      const statement = row ? row.querySelector('[data-consent-statement]') : null;
      records[entry.key] = {
        granted: Boolean(box && box.checked),
        statement: statement ? statement.textContent.trim() : null,
        recordedAt: now
      };
    });
    return records;
  };

  /* ---------- wiring ---------- */

  const renderAll = () => {
    renderOfferingList();
    renderFigures();
    renderCoverage();
  };

  on($('[data-action="start"]'), 'click', () => {
    controller.start();
    showStep('offerings');
  });

  on($('[data-action="to-details"]'), 'click', () => {
    const count = controller.offerings().length;
    if (count < offeringSchema.OFFERING_LIMITS.min) {
      showError(offeringError, `Pick at least ${offeringSchema.OFFERING_LIMITS.min} to compare.`);
      controller.failValidation('offerings');
      return;
    }
    showError(offeringError, '');
    controller.completeStep('offerings');
    renderFigures();
    showStep('figures');
  });

  on($('[data-action="back-to-offerings"]'), 'click', () => showStep('offerings'));
  on($('[data-action="back-to-figures"]'), 'click', () => showStep('figures'));

  on($('[data-action="to-contact"]'), 'click', () => {
    if (!controller.state().coverage) {
      showError(coverageError, 'Tell us what these cover so the shares below mean something.');
      controller.failValidation('figures');
      return;
    }
    showError(coverageError, '');
    controller.completeStep('figures');
    showStep('contact');
  });

  const submitButton = () => $('[data-action="submit"]');

  on($('[data-contact-form]'), 'submit', async event => {
    event.preventDefault();
    /* Belt and braces with the controller's own in-flight guard: the button
       is disabled so a second click cannot even be made, and the controller
       refuses one if it is. */
    if (controller.isSending()) return;

    const error = $('[data-contact-error]');
    const salonName = document.getElementById('salonName').value.trim();
    const email = document.getElementById('email').value.trim();
    const consented = document.getElementById('consentResults').checked;

    /* COMPLIANCE: these say why the fields are needed, and nothing more.
       "to send your results" and "permission to email the results" both
       described an email nobody sends. */
    if (!salonName || !email) {
      showError(error, 'We need the salon name and an email address before this review can be saved to your Business Record.');
      return;
    }
    if (!consented) {
      showError(error, 'We need your permission before this review can be saved.');
      return;
    }
    showError(error, '');

    controller.setContact({
      salonName,
      ownerName: document.getElementById('ownerName').value.trim(),
      email
    });
    controller.setConsent(consentRecords());

    const button = submitButton();
    if (button) button.disabled = true;
    let outcome;
    try {
      outcome = await controller.submit();
    } finally {
      if (button) button.disabled = false;
    }

    if (outcome.status === 'in_flight') return;
    if (outcome.status === 'invalid') {
      showError(error, 'Something in the figures could not be accepted. Go back and check them.');
      return;
    }

    const retryButton = $('[data-action="retry-save"]');
    const queuedPermanently = outcome.status === 'queued' && outcome.result && outcome.result.permanent;
    $('[data-delivery-note]').textContent = outcome.status === 'sent'
      ? 'This review is saved to your Business Record.'
      : outcome.status === 'queued'
        ? queuedPermanently
          ? 'Your results were calculated in this browser, but this review was refused and was not saved to your Business Record or made available to CED staff. Delete the copy stored on this device before starting a corrected review.'
          : 'Your results were calculated in this browser, but this review has not been saved to your Business Record yet and is not available to CED staff. A copy remains on this device. We will retry when you reopen this page, or you can retry now.'
        : 'Preview mode: this review was not saved. Your results were calculated in this browser.';
    if (retryButton) retryButton.hidden = outcome.status !== 'queued' || queuedPermanently;

    renderResults();
    showStep('results');
  });

  on($('[data-action="retry-save"]'), 'click', async event => {
    const button = event.currentTarget;
    const note = $('[data-delivery-note]');
    button.disabled = true;
    note.textContent = 'Trying to save this review to your Business Record…';
    const result = await controller.retryQueuedSubmissions({ force: true });
    button.disabled = false;
    if (result && result.sent > 0) {
      note.textContent = 'This review is saved to your Business Record.';
      button.hidden = true;
      return;
    }
    note.textContent = 'This review is still not saved to your Business Record or available to CED staff. The copy on this device is unchanged. You can try again later.';
  });

  on($('[data-action="pricing-detail"]'), 'click', () => {
    controller.trackIntent('service_mix.pricing_detail_requested');
    window.alert(
      'The Quick Review does not ask what your products and materials cost, so it cannot ' +
      'work out what anything makes you in profit. The Detailed Review adds those costs.'
    );
  });

  on($('[data-action="growth-review"]'), 'click', () =>
    controller.trackIntent('service_mix.growth_review_clicked'));

  on($('[data-action="ai-analysis"]'), 'click', () => {
    controller.trackIntent('service_mix.ai_analysis_clicked');
    window.alert(
      'The AI Opportunity Analysis is not built yet. This review collects the ' +
      'evidence it will read, and nothing is sent anywhere in the meantime.'
    );
  });

  /* Deliberately NOT instrumented.

     `service_mix.bundle_recommendation_viewed` means a visitor saw a bundle
     recommendation. The Quick Review produces none — this control explains
     why there is nothing to see. Firing the event here would have made the
     funnel report recommendations that were never shown, and a measurement
     that is wrong is worse than one that is missing: nobody audits a number
     they already have. The event stays in the catalog for the Detailed
     Review, which will actually recommend bundles, and it fires there.

     No substitute event is invented for this click. Adding one is a change
     to a shared contract, and shared contracts get agreed, not slipped in
     during a repair. */
  on($('[data-action="bundle-detail"]'), 'click', () => {
    window.alert(
      'Which offerings are usually bought together is a Detailed Review question. ' +
      'The Quick Review does not ask it, so it says nothing about bundles.'
    );
  });

  on($('[data-action="clear-data"]'), 'click', () => {
    controller.clearSavedData();
    window.location.reload();
  });

  /* ---------- boot ---------- */

  renderStarters();
  renderAll();
  if (controller.resumed()) {
    const note = $('[data-resume-note]');
    if (note) note.hidden = false;
  }

  /* A connected review does not ask again for what the visitor already gave
     another review on this device. Only names and an email, only from the
     token-bound store, and the visitor can change any of it. */
  const prefilled = controller.prefilledFields();
  const notMine = $('[data-action="not-my-business"]');
  if (prefilled.length) {
    const contact = controller.state().contact;
    prefilled.forEach(field => {
      const input = document.getElementById(field);
      if (input && contact[field]) input.value = contact[field];
    });
    const note = $('[data-prefill-note]');
    if (note) {
      note.hidden = false;
      note.textContent =
        'We have filled these in from the review you already completed on this device. ' +
        'Change anything that is not right.';
    }
    if (notMine) notMine.hidden = false;
  }

  /* Offered only when something WAS prefilled — a button to reject a context
     that does not exist would be a puzzle, not a choice. */
  on(notMine, 'click', () => {
    controller.startNewBusiness();
    ['salonName', 'ownerName', 'email'].forEach(field => {
      const input = document.getElementById(field);
      if (input) input.value = '';
    });
    const note = $('[data-prefill-note]');
    if (note) { note.hidden = true; note.textContent = ''; }
    notMine.hidden = true;
    const salon = document.getElementById('salonName');
    if (salon) salon.focus();
  });
})();
