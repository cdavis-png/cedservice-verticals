/* ============================================================
   The staff routing contract
   ------------------------------------------------------------
   WHY THIS FILE EXISTS, AND WHY IT DOES NOT MODEL ANYTHING.

   tests/staff-deployment-contract.test.mjs already asserts that
   every console path "resolves to exactly one function". It
   passed for months while the deployment answered
   `404: NOT_FOUND`, because it validated the repository's own
   REGEX MODEL of Vercel routing against itself. The model said
   `[...path]` was a catch-all — which is what Vercel documents
   for framework presets — and this project is not one.

   Observed on a real Preview deployment:

     GET …/identity-resolution/cases           -> application JSON
     GET …/identity-resolution/session/refresh -> 404: NOT_FOUND

   One segment reaches the function, two do not: `[param]`
   behaviour, not `[...param]`. Every path below `/cases/:id` was
   unreachable, which is the entire resolution workflow.

   So this file compiles the rewrite with `convertRewrites` from
   `@vercel/routing-utils` — the package Vercel itself uses to
   turn `vercel.json` into routes — and matches paths against the
   regex THAT produces. When Vercel's semantics change, this test
   changes with them, because it imports them rather than
   restating them.

   WHAT IT STILL CANNOT DO. It proves the rewrite matches what it
   should and misses what it should. It cannot prove Vercel
   applies the rewrite in the deployed routing order, nor that
   the destination resolves to this function. Those are platform
   facts and only a Preview can settle them; the plan document
   records them as owed.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertRewrites } from '@vercel/routing-utils';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

const STAFF_PREFIX = '/api/staff/identity-resolution';

/* Every path the console calls, from the runbook and the page sources. */
const SUPPORTED = [
  `${STAFF_PREFIX}/auth-config`,
  `${STAFF_PREFIX}/cases`,
  `${STAFF_PREFIX}/cases/2f1c9a2e-0000-4000-8000-00000000abcd`,
  `${STAFF_PREFIX}/cases/2f1c9a2e-0000-4000-8000-00000000abcd/link`,
  `${STAFF_PREFIX}/session`,
  `${STAFF_PREFIX}/session/refresh`,
  `${STAFF_PREFIX}/session/signout`
];

/* Compiled by Vercel's own converter, not by this file. */
const compiled = convertRewrites(config.rewrites || []);
const staffRoute = compiled.find(r => new RegExp(r.src).test(`${STAFF_PREFIX}/cases`));

test('vercel.json declares exactly one staff rewrite, and nothing else', () => {
  assert.equal((config.rewrites || []).length, 1,
    'one rewrite: the narrowest repair that reaches every supported path');
  assert.deepEqual(config.rewrites[0], {
    source: `${STAFF_PREFIX}/:path+`,
    destination: `${STAFF_PREFIX}/_router`
  });
  assert.ok(staffRoute, 'it compiles to a route that matches a staff path');
});

test('every supported staff path matches the compiled rewrite — multi-segment included', () => {
  const rx = new RegExp(staffRoute.src);
  for (const path of SUPPORTED) {
    const match = rx.exec(path);
    assert.ok(match, `${path} must reach the staff function`);
    /* The captured sub-path is the whole remainder, slashes intact. That is
       what the destination carries forward and what the entrypoint restores. */
    assert.equal(match[1], path.slice(STAFF_PREFIX.length + 1),
      `${path} captures its full sub-path`);
  }
});

test('the multi-segment paths that returned a platform 404 are the ones this fixes', () => {
  /* Named individually. These four were unreachable in production and are the
     reason this rewrite exists. */
  const rx = new RegExp(staffRoute.src);
  for (const path of [
    `${STAFF_PREFIX}/session/refresh`,
    `${STAFF_PREFIX}/session/signout`,
    `${STAFF_PREFIX}/cases/test-id`,
    `${STAFF_PREFIX}/cases/test-id/link`
  ]) {
    assert.ok(rx.test(path), `${path} was a Vercel 404 and must now match`);
  }
});

test('the capture is carried to the destination as a query parameter', () => {
  /* Documented Vercel behaviour, and the mechanism the entrypoint depends on:
     a `source` parameter the destination does not consume is appended to the
     destination's query. Asserted against the compiled output rather than
     assumed. */
  assert.match(staffRoute.dest, /^\/api\/staff\/identity-resolution\/_router\?/,
    'the destination is the single literal segment the platform resolves');
  assert.match(staffRoute.dest, /(^|[?&])path=\$1(&|$)/,
    'the full sub-path is carried as ?path=');
});

test('nothing outside the staff namespace is captured', () => {
  const rx = new RegExp(staffRoute.src);
  for (const path of [
    '/api/assessments',
    '/api/analytics',
    '/api/staff/identity-resolution',          /* the bare prefix: :path+ needs a segment */
    '/api/staff/other/cases',
    '/staff/identity-resolution/index.html',
    '/staff/identity-resolution/accept-invite.html',
    '/verticals/beauty-wellness-fitness/nails/site/index.html',
    '/shared/security/continuation.js',
    '/design-system/standards/tokens.css',
    '/'
  ]) {
    assert.equal(rx.test(path), false, `${path} must NOT be rewritten`);
  }
});

/* ------------------------------------------------------------
   The entrypoint seam that restores the original path
   ------------------------------------------------------------ */

const entrypoint = await import(
  pathToFileURL(join(ROOT, 'api/staff/identity-resolution/[...path].mjs')).href);

/* Drive the exported handler with a fake handleRequest is not possible — the
   export closes over the real one — so the seam is observed through the URL
   the handler receives, by asking the application to route it. A 405 or a
   JSON refusal both prove the path was understood; a 404 proves it was not. */
const routeOf = async (url, method = 'GET') => {
  /* `Sec-Fetch-Site: none` is what a browser sends on a top-level navigation,
     and it is what the route's provenance gate accepts for a safe method with
     no `Origin`. Without it every request here is refused `403 origin_required`
     BEFORE any path routing happens — which would make this file assert that
     the gate works rather than that the path was understood. */
  const res = await entrypoint[method](
    new Request(url, { method, headers: { 'sec-fetch-site': 'none' } }));
  return { status: res.status, body: await res.clone().json().catch(() => null) };
};

test('a rewritten request is routed by its ORIGINAL path, not the destination', async () => {
  /* /session serves POST only, so GET must produce the application's own
     405 — which is only possible if the handler saw `/session`. */
  const rewritten = await routeOf(
    `https://example.test${STAFF_PREFIX}/_router?path=session`);
  assert.equal(rewritten.status, 405, 'the handler routed on the restored path');
  assert.equal(rewritten.body?.code, 'method_not_allowed');

  /* And the same path asked for directly behaves identically, so the seam
     changes nothing about what the routes do. */
  const direct = await routeOf(`https://example.test${STAFF_PREFIX}/session`);
  assert.equal(direct.status, rewritten.status);
  assert.equal(direct.body?.code, rewritten.body?.code);
});

test('a multi-segment rewritten path is restored with its separators intact', async () => {
  /* /session/refresh is POST-only too. Reaching its 405 means both segments
     survived the round trip. */
  const res = await routeOf(
    `https://example.test${STAFF_PREFIX}/_router?path=session%2Frefresh`);
  assert.equal(res.status, 405);
  assert.equal(res.body?.code, 'method_not_allowed');
});

test('a supplied path cannot escape the staff namespace', async () => {
  /* The restored path is rebuilt from validated segments under a FIXED
     prefix, so traversal, absolute paths and encoded separators are left
     unrestored rather than followed.

     Asserted by COMPARISON rather than against a status list: a rejected
     input must be indistinguishable from asking for the destination with no
     `path` at all — same status, same code. That stays true however the
     pre-route refusals are configured, and it says exactly the thing that
     matters, which is that nothing was restored. */
  const unrestored = await routeOf(`https://example.test${STAFF_PREFIX}/_router`);

  for (const hostile of [
    '..%2F..%2Fassessments',
    '%2Fapi%2Fassessments',
    'cases%2F..%2F..%2Fanalytics',
    'cases%2Ftest%00id',
    'https:%2F%2Fevil.test%2Fx',
    '..%2F..%2F..%2Fetc%2Fpasswd'
  ]) {
    const res = await routeOf(`https://example.test${STAFF_PREFIX}/_router?path=${hostile}`);
    assert.equal(res.status, unrestored.status,
      `${hostile} must be treated exactly as an unrestored request`);
    assert.equal(res.body?.code, unrestored.body?.code, `${hostile} refused identically`);
    assert.notEqual(res.status, 405,
      `${hostile} must not be restored into a servable staff path`);
  }

  /* And the control: a LEGITIMATE path is restored, so the comparison above
     is discriminating rather than vacuous. */
  const legitimate = await routeOf(
    `https://example.test${STAFF_PREFIX}/_router?path=session`);
  assert.notEqual(legitimate.status, unrestored.status,
    'a valid sub-path really is restored, so the test can tell the difference');
  assert.equal(legitimate.status, 405);
});

test('an unrewritten request is passed through untouched', async () => {
  /* The seam only fires on the exact destination. Everything else keeps the
     behaviour it had before the rewrite existed, which is what lets the rest
     of the suite go on driving real URLs. */
  const res = await routeOf(`https://example.test${STAFF_PREFIX}/cases`);
  assert.notEqual(res.status, 404, 'a direct path is still routed by its own pathname');
});
