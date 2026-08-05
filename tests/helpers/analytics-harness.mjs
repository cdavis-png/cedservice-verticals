/* A minimal browser for the analytics client: enough window, document,
   navigator and storage for it to run, plus a controllable clock and a
   transport that can be told to fail.

   The clock matters more than anything else here. Every rule in the client is
   a statement about elapsed time — idle after 60 seconds, abandoned after 30
   minutes, backoff doubling from 2 seconds — and a test that waits for real
   time to pass is a test that nobody runs and that fails on a slow machine. */

import { createRequire } from 'node:module';
import { webcrypto, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

export function installBrowser({ startAt = Date.parse('2026-08-05T09:00:00.000Z'),
                                 coarsePointer = true,
                                 width = 390, height = 844 } = {}) {
  let clock = startAt;

  const listeners = { window: {}, document: {} };
  const add = (bag, type, fn) => { (bag[type] ||= []).push(fn); };

  const storage = new MemoryStorage();

  /* Every request the client makes, and what it was told in reply. */
  const transport = {
    requests: [],
    beacons: [],
    /* Overridable per test: return { ok, status } or throw. */
    respond: () => ({ ok: true, status: 200 }),
    beaconResult: true
  };

  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => add(listeners.document, t, fn),
    removeEventListener: () => {}
  };

  const win = {
    innerWidth: width,
    innerHeight: height,
    crypto: webcrypto && webcrypto.randomUUID ? webcrypto : { randomUUID },
    localStorage: storage,
    addEventListener: (t, fn) => add(listeners.window, t, fn),
    removeEventListener: () => {},
    matchMedia: query => ({ matches: /coarse/.test(query) ? coarsePointer : false })
  };

  const navigator = {
    sendBeacon: (url, body) => {
      /* The client wraps the payload in a Blob, so the harness reads it back
         out of the stub below rather than stringifying an opaque object. */
      const text = body && Array.isArray(body.parts) ? body.parts.join('')
        : typeof body === 'string' ? body : String(body);
      transport.beacons.push({ url, body: text });
      return transport.beaconResult;
    }
  };

  globalThis.window = win;
  globalThis.document = doc;
  globalThis.localStorage = storage;
  /* navigator is getter-only on the Node global, so it has to be redefined
     rather than assigned. */
  Object.defineProperty(globalThis, 'navigator', {
    value: navigator, configurable: true, writable: true
  });
  globalThis.fetch = async (url, init) => {
    transport.requests.push({ url, body: init && init.body, keepalive: init && init.keepalive });
    const result = transport.respond(transport.requests.length);
    if (result instanceof Error) throw result;
    return result;
  };
  /* An inspectable Blob. The client's real code path is exercised — it still
     constructs a Blob and hands it to sendBeacon — and the test can read what
     was in it. */
  const RealBlob = globalThis.Blob;
  globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.options = options; } };
  globalThis.Blob.__real = RealBlob;

  return {
    storage,
    transport,
    now: () => clock,
    /* Advance the clock without waiting for it. */
    advance(ms) { clock += ms; return clock; },
    fire(target, type, detail) {
      const bag = target === 'document' ? listeners.document : listeners.window;
      (bag[type] || []).forEach(fn => fn(detail || {}));
    },
    hide() { doc.visibilityState = 'hidden'; this.fire('document', 'visibilitychange'); },
    show() { doc.visibilityState = 'visible'; this.fire('document', 'visibilitychange'); },
    /* Every request body the client sent, parsed. */
    sentEvents() {
      return transport.requests
        .map(r => { try { return JSON.parse(r.body); } catch { return null; } })
        .filter(Boolean)
        .flatMap(body => body.events || []);
    },
    beaconEvents() {
      return transport.beacons
        .map(b => { try { return JSON.parse(b.body); } catch { return null; } })
        .filter(Boolean)
        .flatMap(body => body.events || []);
    }
  };
}

/* Fresh module instances every time, so queues and timers never leak between
   tests. */
export function loadAnalytics() {
  const paths = [
    '../../shared/analytics/events.js',
    '../../shared/analytics/analytics-client.js'
  ].map(p => require.resolve(p));
  paths.forEach(p => { delete require.cache[p]; });
  const events = require(paths[0]);
  const client = require(paths[1]);
  globalThis.window.CEDAnalyticsEvents = events;
  globalThis.window.CEDAnalytics = client;
  return { events, client };
}

export function uninstallBrowser(client) {
  try { if (client && client._internal) client._internal.teardown(); } catch { /* ignore */ }
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.fetch;
  try { delete globalThis.navigator; } catch { /* getter-only; leaving it is harmless */ }
  if (globalThis.Blob && globalThis.Blob.__real) globalThis.Blob = globalThis.Blob.__real;
}

export const SESSION = '99999999-9999-4999-8999-999999999999';
