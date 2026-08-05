/* Builds the DOM harness from the REAL nails markup and the REAL nails config.

   A synthetic two-step fixture proves the engine works on a synthetic two-step
   fixture. What has to be true is that the shipped page works, so the step
   list, the stage attributes, the conditional wrappers, the required flags,
   and the "(optional)" hints are all read out of index.html.

   The parser is deliberately small and deliberately strict about its
   assumptions: review steps are siblings, never nested, and every field lives
   inside a <label>. If either stops being true the parse produces obviously
   wrong counts rather than quietly plausible ones. */

import { readFileSync } from 'node:fs';
import { buildDom, loadEngine } from './dom-harness.mjs';

const HTML_URL = new URL('../../verticals/beauty-wellness-fitness/nails/site/index.html', import.meta.url);
const CONFIG_URL = new URL('../../verticals/beauty-wellness-fitness/nails/assessment.config.js', import.meta.url);

export const HONEYPOT = 'contactFax';
export const CONSENT_FIELDS = ['consentResults', 'consentEmailMarketing', 'consentSmsMarketing'];

export function loadNailsConfig() {
  const host = {};
  new Function('window', readFileSync(CONFIG_URL, 'utf8'))(host);
  return host.CED_ASSESSMENT_CONFIG;
}

export function parseNailsMarkup() {
  const html = readFileSync(HTML_URL, 'utf8');
  const opens = [...html.matchAll(/<div class="review-step[^"]*"\s+data-step="(\d+)"([^>]*)>/g)];
  const end = html.indexOf('<div class="review-controls">');
  if (!opens.length || end < 0) throw new Error('nails markup: no review steps found');

  const steps = opens.map((match, i) => {
    const body = html.slice(match.index, i + 1 < opens.length ? opens[i + 1].index : end);
    const attrs = match[2];

    const conditional = new Set();
    for (const q of body.matchAll(/data-question="([^"]+)"/g)) conditional.add(q[1]);

    /* Consents whose availability is gated on another answer, and the exact
       wording shown beside each. The engine stores the wording it read from
       the DOM, so the harness must supply the real sentences. */
    const gated = new Set();
    for (const g of body.matchAll(/data-consent-gate="([^"]+)"/g)) gated.add(g[1]);
    const statements = new Map();
    for (const s of body.matchAll(/data-consent-for="([^"]+)">([\s\S]*?)<\/span>/g)) {
      statements.set(s[1], s[2].trim());
    }

    const fields = [];
    /* Split before each <label so an "(optional)" hint belongs to its own
       field rather than to every field on the step. */
    body.split(/(?=<label)/).forEach(chunk => {
      const optional = /\(optional\)/.test(chunk);
      for (const control of chunk.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const attr = control[2];
        const name = (attr.match(/name="([^"]+)"/) || [])[1];
        if (!name) continue;
        let value = (attr.match(/\svalue="([^"]*)"/) || [])[1] || '';
        if (control[1] === 'select') {
          /* A select's initial value is its first option. */
          value = (chunk.slice(control.index).match(/<option value="([^"]*)"/) || [])[1] ?? '';
        }
        fields.push({
          name,
          tag: control[1],
          type: (attr.match(/type="([^"]+)"/) || [])[1] || null,
          value,
          required: /\brequired\b/.test(attr),
          optional,
          conditional: conditional.has(name),
          consentGate: gated.has(name),
          disabled: /\bdisabled\b/.test(attr),
          statement: statements.get(name) || null
        });
      }
    });

    return {
      number: Number(match[1]),
      stage: Number((attrs.match(/data-stage="(\d+)"/) || [])[1] || 1),
      results: Number((attrs.match(/data-results-for="(\d+)"/) || [])[1] || 0),
      stageName: (attrs.match(/data-stage-name="([^"]*)"/) || [])[1] || undefined,
      finishLabel: (attrs.match(/data-finish-label="([^"]*)"/) || [])[1] || undefined,
      fields
    };
  });

  const byName = new Map();
  steps.forEach(step => step.fields.forEach(f =>
    byName.set(f.name, { ...f, step: step.number, stage: step.stage })));

  return { steps, byName };
}

/* A field the visitor is asked to answer: not the bot trap, not a consent
   checkbox (those are counted separately and are not questions), and not
   marked optional in its own label. */
export const isQuestion = name => name !== HONEYPOT && !CONSENT_FIELDS.includes(name);
export const isRequired = (byName, name) =>
  isQuestion(name) && Boolean(byName.get(name)) && !byName.get(name).optional;

export function mountNails(options = {}) {
  const { steps } = parseNailsMarkup();
  const config = loadNailsConfig();

  const dom = buildDom({
    steps: steps.map(step => ({
      stage: step.stage,
      stageName: step.stageName,
      results: step.results || undefined,
      finishLabel: step.finishLabel,
      /* Mirrors the two buttons on the Stage 1 results screen. The third path,
         "Request a Personal Review", is an ordinary link and carries no
         stage action, which is why it is absent here. */
      actions: step.results === 1
        ? ['improve_recommendation', 'see_recommended_system'] : [],
      note: step.stage === 2 && step.stageName !== undefined,
      fields: step.fields.map(f => ({
        name: f.name, tag: f.tag, type: f.type, value: f.value,
        required: f.required, conditional: f.conditional,
        consentGate: f.consentGate, disabled: f.disabled, statement: f.statement
      }))
    })),
    extraFields: [HONEYPOT]
  });

  const engine = loadEngine(dom, config, options);
  return { dom, engine, config, steps };
}

/* Everything Stage 1 asks, answered plausibly. Deliberately a middling salon:
   a perfect or hopeless one would hide band changes behind saturation. */
export const STAGE1_ANSWERS = {
  salonName: 'Polished Nail Studio',
  ownerName: 'Test Owner',
  email: 'owner@polished.test',
  technicians: '3', appointmentsDay: '12', averageTicket: '50', daysOpen: '24',
  callsDay: '8', missedCallsDay: '2', missedCallProcess: '1',
  noShowsWeek: '2', cancelsWeek: '3', reminders: '1', waitlist: '0',
  rebooking: '1', reactivation: '0', inactiveClients: '150',
  reviewCount: '65', rating: '4.4', reviewRequests: '1', promotions: '1',
  locationCount: '1', capacity90Day: '11_20'
};

/* A strong but honest Stage 2: can decide, has budget, keeps a supported
   platform, raises no objection. */
export const STAGE2_ANSWERS = {
  bookingPlatform: 'square', bookingPlatformStaying: 'keep',
  willingToChangeSoftware: 'maybe', yearsInBusiness: '4_10',
  willingnessToExpand: 'yes', capacityLeadTime: 'immediate',
  respondentRole: 'owner', canApprove: 'yes',
  decisionTiming: 'this_week', startTiming: 'immediately', urgency: 'critical',
  budgetSignal: 'budgeted',
  phoneSetup: 'mobile_only', customIntegrationNeeded: 'no',
  primaryConcern: 'none', challenge: 'Filling open appointments',
  preferredContact: 'email'
};

export function answer(engine, dom, answers) {
  Object.entries(answers).forEach(([name, value]) => {
    if (dom.elements[name]) engine.set(name, value);
  });
}

/* Ticks the required results-delivery consent, the way the visitor does. */
export function grantResultsConsent(dom) {
  const box = dom.elements.consentResults;
  box.checked = true;
  dom.form.fire('change');
}

/* Walks Continue until the current stage's results screen is reached. */
export function walkToResults(engine, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const before = engine.api().inspect();
    const last = before.visibleSteps[before.visibleSteps.length - 1];
    if (before.currentStep === last) return before;
    engine.next();
    const after = engine.api().inspect();
    if (after.currentStep === before.currentStep) {
      throw new Error(`stuck on step ${before.currentStep}: validation refused to advance`);
    }
  }
  throw new Error('walkToResults: never reached a results step');
}
