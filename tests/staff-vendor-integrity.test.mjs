/* ============================================================
   The one vendored browser dependency
   ------------------------------------------------------------
   `staff/vendor/supabase-js-2.112.0.umd.js` is the only
   third-party code this repository serves to a browser, and it
   runs on the page that handles an operator's password. It is a
   COPY, not a fork, and this file is what makes that checkable
   rather than promised.

   Vendored rather than loaded from a CDN so `script-src` stays
   `'self'` — see staff/vendor/README.md for the full reasoning.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

import { STATIC_MANIFEST } from '../tools/static-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = 'staff/vendor/supabase-js-2.112.0.umd.js';
const INSTALLED = 'node_modules/@supabase/supabase-js/dist/umd/supabase.js';
const README = join(ROOT, 'staff/vendor/README.md');

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('the vendored file exists and is published', () => {
  assert.ok(existsSync(join(ROOT, VENDORED)), `${VENDORED} is missing`);
  assert.ok(STATIC_MANIFEST.includes(VENDORED),
    'the onboarding page loads it, so it must be in the static manifest');
});

test('the vendored copy is byte-identical to the installed package', {
  skip: existsSync(join(ROOT, INSTALLED)) ? false : 'node_modules is not installed'
}, () => {
  /* THE PROPERTY: it is a copy. A hand-edited vendored dependency is a fork
     nobody agreed to maintain, and a modified crypto/auth library is the
     worst possible place for one. */
  const installed = readFileSync(join(ROOT, INSTALLED));
  const vendored = readFileSync(join(ROOT, VENDORED));
  assert.ok(installed.equals(vendored),
    'the vendored client differs from the installed package — re-copy it, do not edit it');
});

test('every statement of the version is the same exact version', () => {
  /* THE DEFECT THIS PINS. The vendored README said 2.112.0 was "the exact
     version in package.json / package-lock.json" while package.json said
     `^2.45.0`. A caret range and a byte-identical vendored copy are a
     contradiction waiting to happen: `npm install` on a clean checkout could
     resolve 2.113.0, and the file a browser runs would silently no longer be
     the library the project depends on.

     FIVE PLACES STATE THIS VERSION. They are checked against each other here
     so none can drift alone:

       1. package.json                  the dependency spec
       2. package-lock.json (root)      the declared range
       3. package-lock.json (resolved)  what an install actually produces
       4. the vendored filename         what a browser downloads
       5. staff/vendor/README.md        what a reviewer is told

     Plus, when node_modules is present, the installed copy itself. */
  const vendoredVersion = VENDORED.match(/supabase-js-([0-9.]+)\.umd\.js$/)[1];

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const spec = String(pkg.dependencies['@supabase/supabase-js'] || '');
  assert.equal(spec, vendoredVersion,
    'package.json must pin the exact vendored version — a range may resolve to '
    + 'something the vendored copy is not');
  assert.equal(/^[\^~><=*]/.test(spec), false,
    `the dependency must carry no range operator, found: ${spec}`);

  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['']?.dependencies?.['@supabase/supabase-js'], vendoredVersion,
    'the lockfile root declaration must match package.json exactly');
  assert.equal(lock.packages['node_modules/@supabase/supabase-js']?.version, vendoredVersion,
    'and the resolved entry must be that version');

  const readme = readFileSync(README, 'utf8');
  assert.ok(readme.includes(vendoredVersion), 'the README states the version');
  assert.ok(readme.includes(basename(VENDORED)), 'and names the file exactly');

  if (existsSync(join(ROOT, INSTALLED))) {
    const installedPkg = JSON.parse(readFileSync(
      join(ROOT, 'node_modules/@supabase/supabase-js/package.json'), 'utf8'));
    assert.equal(installedPkg.version, vendoredVersion,
      'the installed copy is the version the filename claims');
  }
});

test('the README claim about pinning is true of the files it describes', () => {
  /* The README is where a reviewer looks first. If it says "exact", the
     manifest and the lockfile have to agree, or the document is the least
     trustworthy thing in the directory. */
  const readme = readFileSync(README, 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (/exact version in `package\.json`/i.test(readme)) {
    assert.equal(pkg.dependencies['@supabase/supabase-js'],
      VENDORED.match(/supabase-js-([0-9.]+)\.umd\.js$/)[1],
      'the README claims an exact pin; package.json must actually carry one');
  }
});

test('the README records the provenance and the checksum that is actually there', () => {
  /* A checksum nobody checks is decoration. This is the check. */
  const readme = readFileSync(README, 'utf8');
  const recorded = readme.match(/`([0-9a-f]{64})`/);
  assert.ok(recorded, 'the README must record a SHA-256');
  assert.equal(recorded[1], sha256(join(ROOT, VENDORED)),
    'the recorded checksum does not match the vendored file');

  const bytes = readFileSync(join(ROOT, VENDORED)).length;
  assert.ok(readme.includes(String(bytes)), 'the README must record the byte count');
  assert.ok(readme.includes('@supabase/supabase-js'), 'and the package it came from');
});

test('the README itself is NOT published', () => {
  /* It is provenance for reviewers, not an asset. The directory is not the
     boundary; the manifest is. */
  assert.equal(STATIC_MANIFEST.includes('staff/vendor/README.md'), false);
  const vendorEntries = STATIC_MANIFEST.filter(p => p.startsWith('staff/vendor/'));
  assert.deepEqual(vendorEntries, [VENDORED],
    'exactly one file from staff/vendor/ is public');
});

test('the onboarding page loads it same-origin, and no page loads a CDN', () => {
  const html = readFileSync(join(ROOT, 'staff/identity-resolution/accept-invite.html'), 'utf8');
  assert.match(html, /<script src="\.\.\/vendor\/supabase-js-2\.112\.0\.umd\.js"><\/script>/,
    'the vendored client is loaded by relative same-origin path');

  /* No remote script anywhere on the staff pages — this is what keeps
     script-src at 'self'. */
  for (const page of ['accept-invite.html', 'index.html']) {
    const source = readFileSync(join(ROOT, 'staff/identity-resolution', page), 'utf8');
    const srcs = [...source.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
    for (const src of srcs) {
      assert.equal(/^(https?:)?\/\//.test(src), false, `${page} loads a remote script: ${src}`);
    }
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(source), false, `${page} has an inline script`);
  }
});

test('the vendored bundle embeds no key of any kind', () => {
  /* It matches a secret-key SWEEP because it contains the string
     `sb_secret_` — in a prefix classifier, which is the opposite of a leak.
     Asserted precisely so the sweep hit is explained rather than tolerated. */
  const source = readFileSync(join(ROOT, VENDORED), 'utf8');
  assert.match(source, /startsWith\(`sb_secret_`\)/,
    'the hit is the library classifying key prefixes');

  for (const pattern of [/sb_secret_[A-Za-z0-9_-]{8,}/, /sb_publishable_[A-Za-z0-9_-]{8,}/,
                         /eyJhbGciOi[A-Za-z0-9_-]{20,}/]) {
    assert.equal(pattern.test(source), false, `an embedded credential matched ${pattern}`);
  }
});

test('the console page does NOT load the Supabase client', () => {
  /* Only the page that must talk to Supabase directly carries it. The console
     still goes through the route, and shipping a client to it would be extra
     surface for no purpose. */
  const html = readFileSync(join(ROOT, 'staff/identity-resolution/index.html'), 'utf8');
  assert.equal(html.includes('vendor/'), false);
  assert.equal(html.includes('supabase'), false);
});
