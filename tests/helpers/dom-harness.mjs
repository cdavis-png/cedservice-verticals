/* A minimal DOM good enough to run the real engine.js against the real
   assessment.config.js. Not a browser: only the surface engine.js actually
   touches is implemented, and anything it reaches for that is missing throws
   rather than silently returning undefined, so a drift in the engine shows up
   as a failure here instead of a passing test that proves nothing.

   The point is to drive the ACTUAL branching code. A hand-rolled model of what
   branching ought to do would test the model, not the engine. */

import { createRequire } from 'node:module';
import { randomUUID, webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);

class ClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on) this.add(c); else this.remove(c); }
}

class El {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.required = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.listeners = {};
    Object.assign(this, attrs);
  }

  append(child) { child.parent = this; this.children.push(child); return child; }

  /* Depth-first over the subtree, excluding self. */
  descendants() {
    const out = [];
    const walk = node => node.children.forEach(c => { out.push(c); walk(c); });
    walk(this);
    return out;
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === '[required]') return this.required === true;
    if (selector === '[hidden]') return this.hidden === true;
    if (selector === 'input, select, textarea') return ['INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName);
    const attr = selector.match(/^\[data-([a-zA-Z-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return attr[2] === undefined
        ? this.dataset[key] !== undefined
        : this.dataset[key] === attr[2];
    }
    return false;
  }

  querySelectorAll(selector) {
    return this.descendants().filter(n => n.matches(selector));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  /* Walks up, matching self first, like the real closest(). */
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  fire(type, event = {}) {
    (this.listeners[type] || []).forEach(fn => fn(event));
    /* Input and change bubble to the form in the real DOM; the engine relies
       on that, so the harness must do it too. */
    if (['input', 'change'].includes(type) && this.parent) this.parent.fire(type, event);
  }

  reportValidity() {
    if (this.disabled) return true;
    if (this.closest('[hidden]')) return true;
    if (!this.required) return true;
    return String(this.value || '').trim() !== '' || this.checked === true;
  }
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

/* The hooks the engine looks for inside a results step. */
const RESULT_KEYS = ['subject', 'score', 'opportunity', 'package-label',
  'package-reason', 'priorities', 'status', 'assumptions', 'evidence-note'];

/* Builds the modal the engine expects, from a declarative step description so
   a test can state the shape it wants instead of assembling nodes.

   A step may declare:
     stage      — which stage it belongs to (default 1)
     stageName  — the stage's display name, on its first step
     results    — the stage number this step is the results screen for
     actions    — stage-action triggers rendered as buttons on a results step
     note       — render a [data-stage-note] placeholder on this step */
export function buildDom({ steps, extraFields = [] }) {
  const root = new El('div');
  const all = [];

  const modal = root.append(new El('div'));
  modal.classList.add('review-modal');
  modal.setAttribute = () => {};

  const backdrop = modal.append(new El('div'));
  backdrop.classList.add('modal-backdrop');
  const close = modal.append(new El('button'));
  close.classList.add('modal-close');

  const progressText = modal.append(new El('span', { id: 'progressText' }));
  const progressBar = modal.append(new El('i', { id: 'progressBar' }));
  const live = modal.append(new El('p', { id: 'reviewLive' }));
  const stageLabel = modal.append(new El('span'));
  stageLabel.dataset.stageLabel = '';

  const form = modal.append(new El('form', { id: 'growthReview' }));
  const elements = {};
  /* A real form.elements is an HTMLFormControlsCollection: keyed by name AND
     iterable. The engine relies on both, so the harness must provide both. */
  Object.defineProperty(elements, Symbol.iterator, {
    enumerable: false,
    value: function* () { for (const key of Object.keys(this)) yield this[key]; }
  });
  form.elements = elements;

  const results = {};
  const actions = {};
  const notes = [];

  steps.forEach((step, i) => {
    const node = form.append(new El('div'));
    node.classList.add('review-step');
    node.dataset.step = String(i + 1);
    node.dataset.stage = String(step.stage || 1);
    if (step.stageName) node.dataset.stageName = step.stageName;
    if (step.results) node.dataset.resultsFor = String(step.results);
    if (step.finishLabel) node.dataset.finishLabel = step.finishLabel;
    if (i === 0) node.classList.add('active');

    if (step.note) {
      const note = node.append(new El('p'));
      note.dataset.stageNote = '';
      note.hidden = true;
      notes.push(note);
    }

    (step.fields || []).forEach(field => {
      let host = node;
      if (field.conditional) {
        host = node.append(new El('div'));
        host.dataset.question = field.name;
      } else if (field.consentGate) {
        /* A consent whose availability depends on another answer. Wrapped the
           way the real markup wraps it, because the engine keys off the
           wrapper to decide who owns the disabled flag. */
        host = node.append(new El('label'));
        host.dataset.consentGate = field.name;
        host.hidden = true;
      }
      const input = host.append(new El(field.tag || 'select', {
        name: field.name,
        required: Boolean(field.required),
        value: field.value || ''
      }));
      if (field.type) input.type = field.type;
      if (field.disabled) input.disabled = true;
      if (field.statement) {
        const span = host.append(new El('span'));
        span.dataset.consentFor = field.name;
        span.textContent = field.statement;
      }
      elements[field.name] = input;
      all.push(input);
    });

    if (step.results) {
      const hooks = {};
      RESULT_KEYS.forEach(key => {
        const el = node.append(new El('span'));
        el.dataset.result = key;
        hooks[key] = el;
      });
      const disclaimer = node.append(new El('p'));
      disclaimer.classList.add('results-disclaimer');
      disclaimer.textContent =
        'This is a preliminary estimate based on your answers and is not a guarantee of revenue or results.';
      hooks.disclaimer = disclaimer;
      results[step.results] = hooks;

      (step.actions || []).forEach(trigger => {
        const button = node.append(new El('button'));
        button.dataset.stageAction = trigger;
        actions[trigger] = button;
      });
    }
  });

  extraFields.forEach(name => {
    const input = form.append(new El('input', { name, value: '' }));
    elements[name] = input;
    all.push(input);
  });

  const nav = modal.append(new El('div'));
  const prev = nav.append(new El('button', { id: 'prevStep' }));
  const next = nav.append(new El('button', { id: 'nextStep' }));

  const start = root.append(new El('button'));
  start.classList.add('js-start-review');

  return { root, modal, form, elements, prev, next, progressText, progressBar,
           live, stageLabel, start, all, results, actions, notes };
}

/* Installs the globals engine.js expects, loads the real engine, and returns
   handles for driving it. */
export function loadEngine(dom, config, options = {}) {
  const storage = new MemoryStorage();
  const documentListeners = {};
  /* Every payload the engine hands to the transport, in order. The adapter is
     deliberately a recorder and not a stub that always succeeds: what a test
     usually needs to know is what was SENT and when, not what came back. */
  const submissions = [];

  const doc = {
    querySelector: s => dom.root.querySelector(s),
    querySelectorAll: s => dom.root.querySelectorAll(s),
    getElementById: id => dom.root.descendants().find(n => n.id === id) || null,
    addEventListener: (t, fn) => { (documentListeners[t] ||= []).push(fn); },
    body: { style: {} },
    referrer: '',
    readyState: 'complete'
  };

  const win = {
    CED_ASSESSMENT_CONFIG: config,
    crypto: webcrypto && webcrypto.randomUUID ? webcrypto : { randomUUID },
    location: { href: 'https://nails.cedservice.com/', search: '', protocol: 'https:' },
    addEventListener: () => {},
    CEDSubmission: {
      submitAssessment: async payload => {
        submissions.push(JSON.parse(JSON.stringify(payload)));
        return {
          status: options.deliveryStatus || 'sent',
          /* Whatever the capture endpoint returned. Tests that care about the
             connected-review handoff set this; everything else ignores it. */
          ...(options.submissionResponse || {})
        };
      },
      retryPendingSubmissions: async () => {},
      clearQueue: () => {}
    }
  };

  globalThis.window = win;
  globalThis.document = doc;
  globalThis.localStorage = storage;
  globalThis.FormData = class {
    constructor(form) {
      this.pairs = [];
      Object.entries(form.elements).forEach(([name, el]) => {
        /* Mirrors the browser: disabled controls and unchecked boxes are
           omitted. This is what actually excludes a branched-away field. */
        if (el.disabled) return;
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) this.pairs.push([name, el.value || 'on']);
          return;
        }
        this.pairs.push([name, el.value]);
      });
    }
    entries() { return this.pairs[Symbol.iterator](); }
  };
  globalThis.URLSearchParams = URLSearchParams;

  /* Fresh module instance each time, so state never leaks between tests. The
     report modules are loaded the same way the page loads them, so the engine
     computes the visible range with the real functions rather than its
     fallback. */
  const paths = [
    '../../shared/assessment-engine/intelligence.js',
    '../../shared/business-intelligence/report.schema.js',
    '../../shared/business-intelligence/generate-bir.js',
    '../../shared/assessment-engine/engine.js'
  ].map(p => require.resolve(p));
  paths.forEach(p => { delete require.cache[p]; });

  /* The shared continuation store. The nails page loads it before the
     engine; the harness must too, or the Growth Review has nowhere to leave
     a context for a connected review to find. */
  win.CEDContinuation = require('../../shared/security/continuation.js');

  win.CEDIntelligence = require(paths[0]);
  /* The two report modules export to module.exports OR to window, not both,
     so under Node they must be attached by hand. The browser takes the other
     branch of the same expression. */
  win.CEDBusinessIntelligenceSchema = require(paths[1]);
  win.CEDGenerateBir = require(paths[2]);
  require(paths[3]);

  return {
    storage,
    documentListeners,
    submissions,
    api: () => win.CEDAssessment,
    set(name, value) {
      const el = dom.elements[name];
      if (!el) throw new Error(`no such field: ${name}`);
      el.value = value;
      /* A real change event carries the control that changed. The engine's
         single delegated listener reads event.target.name, so the harness
         must supply it or every question looks unanswered. */
      dom.form.fire('change', { target: el });
    },
    open() { dom.start.fire('click'); },
    next() { dom.next.fire('click'); },
    prev() { dom.prev.fire('click'); },
    /* Clicks one of the paths offered after a stage's results. */
    act(trigger) {
      const button = dom.actions[trigger];
      if (!button) throw new Error(`no such stage action: ${trigger}`);
      button.fire('click', { preventDefault() {} });
    },
    result: (stage, key) => dom.results[stage][key].textContent,
    progress: () => dom.progressText.textContent,
    stageLabel: () => dom.stageLabel.textContent,
    note: () => dom.notes.filter(n => !n.hidden).map(n => n.textContent),
    announcement: () => dom.live.textContent
  };
}

export function resetGlobals() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.FormData;
}
