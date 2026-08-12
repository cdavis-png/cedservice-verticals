/* ============================================================
   The function bundle contract
   ------------------------------------------------------------
   WHAT THIS IS, AND WHY IT IS DIFFERENT FROM EVERY OTHER
   DEPLOYMENT TEST IN THIS REPOSITORY.

   tests/static-output-contract.test.mjs checks what a BROWSER may
   download. This file checks what a FUNCTION is given. Those are
   two different artifacts produced by two different mechanisms,
   and until this file existed only the first had a test.

   It does not model the packaging step. It RUNS it: `@vercel/nft`
   is the same tracer Vercel executes when it builds a Serverless
   Function, so the file set computed here is the file set that
   gets deployed. Each entrypoint is then copied into a temporary
   directory containing NOTHING ELSE and imported from there.

   WHY THE IMPORT IS THE POINT. A test that only inspects the
   traced list has to know in advance which module might be
   missing. Importing the packaged tree asks the question the
   platform asks — "does this module load?" — so it catches the
   NEXT omission too, whatever causes it.

   THE DEFECT THIS EXISTS FOR. api/assessments.mjs statically
   imports shared/business-intelligence/review-registry.js, which
   resolved its own dependencies through a VARIABLE:

     const req = name => … ? require(name) : null;
     const serviceMix = req('../service-mix-engine/generate-service-mix-bir.js')

   A tracer cannot follow `require(name)`. It records no
   dependency and emits no warning, so four service-mix modules
   were never packaged, the unguarded require threw at MODULE
   SCOPE, and every request to /api/assessments answered
   FUNCTION_INVOCATION_FAILED — GET, OPTIONS and POST alike,
   because a cold-start throw happens before any request logic.

   It reached production. The test that was closest to catching it
   — "function tracing still has real source modules to follow" in
   the static output contract — asserts that the files the tracer
   WOULD follow still exist, examines only the staff chain, and
   understands only string-literal static imports. A dependency
   that is needed but never referenced statically was invisible to
   it by construction.

   COST. @vercel/nft is a devDependency, test-only, imported by no
   shipped file. Tracing three entrypoints and importing three
   temporary packages costs a few seconds; missing this class of
   defect costs a production outage that no local check can see.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/* Every file Vercel deploys as its own function. Kept explicit rather than
   globbed: a new entrypoint should have to be named here, so that adding one
   is a decision rather than an accident. tests/static-output-contract.test.mjs
   independently asserts that api/ holds exactly these three. */
const ENTRYPOINTS = [
  'api/assessments.mjs',
  'api/analytics.mjs',
  'api/staff/identity-resolution/[...path].mjs'
];

/* @supabase/supabase-js is imported DYNAMICALLY inside each handler's client
   factory, never at module scope, so it is not needed to prove a module
   loads. Vercel installs it from package.json; nft reports it as an
   unresolved bare specifier when node_modules is absent, which is expected
   and is not what this file is looking for. */
const traceEntry = async entry => {
  const { fileList } = await nodeFileTrace([join(ROOT, entry)], { base: ROOT });
  return [...fileList]
    .map(f => f.split('\\').join('/'))
    .filter(f => !f.startsWith('node_modules/'))
    .sort();
};

/* ------------------------------------------------------------
   T1 — the packaged artifact must actually load
   ------------------------------------------------------------ */

test('every deployed function imports successfully from its TRACED file set alone', async t => {
  for (const entry of ENTRYPOINTS) {
    await t.test(entry, async () => {
      const traced = await traceEntry(entry);

      /* The entrypoint must trace itself, or the base/path handling is wrong
         and everything below would be vacuous. */
      assert.ok(traced.includes(entry), `${entry} traced itself`);

      const dir = mkdtempSync(join(tmpdir(), 'ced-fn-bundle-'));
      try {
        for (const file of traced) {
          const target = join(dir, file);
          mkdirSync(dirname(target), { recursive: true });
          cpSync(join(ROOT, file), target);
        }

        /* node_modules is deliberately NOT copied. Nothing in these modules
           needs a package at import time; if that ever changes, this import
           fails and the change becomes visible. */
        const url = pathToFileURL(join(dir, entry)).href;
        const mod = await import(url);

        assert.ok(typeof mod.GET === 'function',
          `${entry} exposes its named method handlers from the packaged tree`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('the traced set carries no test, document, migration or build file', async () => {
  /* The function bundle deserves the same discipline as the static output.
     A traced tests/ or supabase/ path would mean a dependency edge nobody
     intended, and would ship the repository into a function. */
  const forbidden = ['tests/', 'docs/', 'supabase/', 'tools/', 'staff/', 'verticals/', 'dist/'];
  for (const entry of ENTRYPOINTS) {
    for (const file of await traceEntry(entry)) {
      for (const prefix of forbidden) {
        assert.equal(file.startsWith(prefix), false,
          `${entry} traced ${file}, which does not belong in a function bundle`);
      }
    }
  }
});

test('the service-mix engine really is reachable from the assessments bundle', async () => {
  /* The specific regression, pinned by name. The generic import test above
     would fail without these too, but naming them keeps the connection to the
     outage legible to whoever reads this next. */
  const traced = await traceEntry('api/assessments.mjs');
  for (const file of [
    'shared/business-intelligence/review-registry.js',
    'shared/service-mix-engine/generate-service-mix-bir.js',
    'shared/service-mix-engine/calculate.js',
    'shared/service-mix-engine/classify.js',
    'shared/service-mix-engine/guidance.js'
  ]) {
    assert.ok(traced.includes(file), `${file} is traced into the assessments function`);
  }
});

/* ------------------------------------------------------------
   T2 — no dependency may hide behind a variable
   ------------------------------------------------------------
   The class of defect, not the instance. A literal specifier can be
   followed by a tracer; a computed one cannot, and it fails silently.

   Comments and strings are stripped before matching so that prose ABOUT
   this rule — including the comment at the top of this file — cannot trip
   it. Browser-only code is not exempt: these modules are dual, and the
   server half is what gets traced. */

const stripCommentsAndStrings = source => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "'S'")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '"S"')
  .replace(/`(?:[^`\\]|\\.)*`/g, '`S`');

test('no module reachable from an API entrypoint calls require() with a computed specifier', async () => {
  const seen = new Set();
  for (const entry of ENTRYPOINTS) {
    for (const file of await traceEntry(entry)) {
      if (!/\.(js|mjs|cjs)$/.test(file) || seen.has(file)) continue;
      seen.add(file);

      const code = stripCommentsAndStrings(readFileSync(join(ROOT, file), 'utf8'));
      /* After stripping, a literal require reads require('S'). Anything else
         inside the parentheses is computed. */
      const offenders = [...code.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)]
        .map(m => m[1].trim())
        .filter(arg => arg !== "'S'" && arg !== '"S"');

      assert.deepEqual(offenders, [],
        `${file} calls require() with a computed specifier — a tracer cannot follow it, `
        + 'and the module will be missing from the deployed function');
    }
  }
});

/* ------------------------------------------------------------
   T3 — every functions glob must match a real function
   ------------------------------------------------------------
   `vercel.json`'s `functions` keys are GLOBS, and in a glob `[...]` is a
   CHARACTER CLASS. The key

     api/staff/identity-resolution/[...path].mjs

   therefore matched one character from {. p a t h} followed by `.mjs` — it
   matched no file at all, and the staff route's declared maxDuration and
   memory were silently not applied.

   The existing contract test compares the key STRINGS with deepEqual, which
   cannot see this. Matching them against the filesystem can. */

/* A glob translated with GLOB semantics, which is the whole point: `[` opens
   a CHARACTER CLASS. Translating brackets literally would reproduce the
   mistake this test exists to catch, and the test would pass on the broken
   configuration.

   Backslash escaping is deliberately not offered as an out. It was measured
   against minimatch — the matcher this dialect follows — and
   `…/\[...path\].mjs` does NOT match `…/[...path].mjs`. The only form that
   demonstrably matches a filesystem-routing filename is a wildcard. */
const globToRegExp = pattern => {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') { out += '[^/]*'; continue; }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i) {
        out += `[${pattern.slice(i + 1, close).replace(/\\/g, '\\\\')}]`;
        i = close;
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

test('every vercel.json functions glob matches at least one real function file', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  for (const pattern of Object.keys(config.functions || {})) {
    const matched = ENTRYPOINTS.filter(f => globToRegExp(pattern).test(f));
    assert.ok(matched.length >= 1,
      `vercel.json functions key "${pattern}" matches no function file. `
      + 'In a glob, [...] is a character class — a filesystem-routing bracket must be escaped.');
    for (const f of matched) {
      assert.ok(existsSync(join(ROOT, f)), `${f} exists to be configured`);
    }
  }
});

test('the staff route is one of the functions vercel.json actually configures', () => {
  /* The budget the runbook promises is only real if the key reaches the file.
     Asserted separately from the generic rule above so a regression names the
     route rather than a pattern. */
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const staff = 'api/staff/identity-resolution/[...path].mjs';
  const matching = Object.keys(config.functions || {})
    .filter(pattern => globToRegExp(pattern).test(staff));

  assert.equal(matching.length, 1,
    'exactly one functions entry configures the staff route');
  assert.equal(config.functions[matching[0]].maxDuration, 15);
  assert.equal(config.functions[matching[0]].memory, 512);
});

/* A guard on the guard: the escaping rule above must genuinely reject the
   unescaped form, or T3 would pass for the wrong reason after a revert. */
test('an UNESCAPED bracket key would still be caught', () => {
  /* Glob semantics modelled directly: `[...path]` is a character class over
     {. p a t h}, so it matches a SINGLE character and never the real
     filename. This is what the deployed configuration was doing. */
  const asCharClass = /^api\/staff\/identity-resolution\/[.path]\.mjs$/;

  assert.equal(asCharClass.test('api/staff/identity-resolution/[...path].mjs'), false,
    'read as a character class, the unescaped key does not match its own file');
  assert.ok(asCharClass.test('api/staff/identity-resolution/p.mjs'),
    'it matches single-character names instead — which is why it configured nothing');
});
