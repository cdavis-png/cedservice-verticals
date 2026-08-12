/* ============================================================
   The static output contract
   ------------------------------------------------------------
   WHAT THIS IS, STATED HONESTLY.

   It is a check on the BUILD and on the CONFIGURATION. It runs
   the real build, walks the real generated tree, and asserts what
   is in it and what is not. It also models Vercel's documented
   URL resolution well enough to ask "could a browser fetch this
   path", and no further.

   IT IS NOT A `vercel build`, and it proves nothing about the
   platform. Whether Vercel honours `outputDirectory`, whether it
   still discovers api/ functions when a build command is present,
   and whether its file tracer follows the static ESM imports out
   of api/ into server/ and shared/ are all platform behaviour.
   They are recorded as unvalidated in
   docs/REAL_POSTGRES_VALIDATION.md and can only be settled by a
   real build or a preview deployment.

   WHY IT EXISTS. The deployment had no build command, no `public`
   directory and no `outputDirectory`, so the output directory was
   the REPOSITORY ROOT and every file outside api/ was downloadable
   — server/staff-identity-resolution.mjs, every migration, the
   operations runbook, every test, .env.example. No credential was
   exposed, but nothing had decided that any of it should be
   public, and no test could see it either way.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, symlinkSync,
         rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

import { buildStatic, listOutput, __testing as buildTesting } from '../tools/build-static.mjs';
import {
  STATIC_MANIFEST, OUTPUT_DIR, FORBIDDEN_OUTPUT_PREFIXES, FORBIDDEN_OUTPUT_FILES,
  PUBLIC_SECURITY_MODULES, SERVER_ONLY_SECURITY_MODULES
} from '../tools/static-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

/* One build for the whole file. Determinism gets its own second build. */
/* The build now generates the onboarding page's connect-src from
   SUPABASE_URL, and fails closed without it. Every build in this file uses
   one fixed origin so the output is comparable between runs; the generation
   itself — including its refusals — is owned by
   tests/build-csp-generation.test.mjs. */
const SUPABASE_ORIGIN = 'https://qkpptajglstgucadhfwq.supabase.co';
const BUILD_ENV = { SUPABASE_URL: SUPABASE_ORIGIN };

const { outputRoot, written } = buildStatic({ quiet: true, env: BUILD_ENV });

const hashOf = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const outPath = rel => join(outputRoot, rel.split('/').join(sep));

/* ============================================================
   The output directory is a real, separate directory
   ============================================================ */

test('the configured output directory is not the repository root', () => {
  assert.equal(typeof config.outputDirectory, 'string');
  assert.ok(config.outputDirectory.length > 0, 'an output directory is configured at all');
  for (const bad of ['.', './', '', '/', '..']) {
    assert.notEqual(config.outputDirectory, bad,
      `outputDirectory must not be ${JSON.stringify(bad)} — that publishes the repository`);
  }
  assert.equal(config.outputDirectory, OUTPUT_DIR,
    'vercel.json and the manifest name the same directory');
  assert.notEqual(resolve(ROOT, config.outputDirectory), ROOT);
  assert.ok(resolve(ROOT, config.outputDirectory).startsWith(ROOT + sep),
    'and it is inside the repository');
});

test('a build command is configured, and it is the zero-dependency script', () => {
  assert.equal(config.buildCommand, 'node tools/build-static.mjs');
  assert.ok(existsSync(join(ROOT, 'tools/build-static.mjs')));
  assert.ok(existsSync(join(ROOT, 'tools/static-manifest.mjs')));
});

/* The properties the schema at https://openapi.vercel.sh/vercel.json defines at
   the top level. That schema sets "additionalProperties": false, so a key that
   is not in this list is not a harmless annotation — it is the shape of
   Vercel's documented `Invalid vercel.json - should NOT have additional
   property <name>` refusal. Transcribed from the schema and from
   https://vercel.com/docs/project-configuration, and deliberately written out
   rather than fetched: a test must not need the network to run. */
const VERCEL_TOP_LEVEL_PROPERTIES = Object.freeze([
  '$schema', 'alias', 'build', 'buildCommand', 'builds', 'bunVersion', 'cleanUrls',
  'crons', 'devCommand', 'env', 'fluid', 'framework', 'functionFailoverRegions',
  'functions', 'git', 'github', 'headers', 'ignoreCommand', 'images',
  'installCommand', 'name', 'outputDirectory', 'passiveRegions', 'public',
  'redirects', 'bulkRedirectsPath', 'regions', 'rewrites', 'routes', 'trailingSlash'
]);

test('vercel.json uses only properties Vercel actually supports', () => {
  /* THE DEFECT THIS PINS. vercel.json carried a top-level "comments" object
     used as a pseudo-comment. It is not a supported property, and the schema
     the file itself references forbids unknown ones — so the whole
     configuration was at risk of being refused, taking buildCommand and
     outputDirectory with it and leaving the repository root published. The
     prose now lives in docs/DEPLOYMENT_CONFIGURATION.md.

     This is a check on the CONFIGURATION against the documented schema. It is
     not an observation of the platform; no vercel build has been run. */
  const unsupported = Object.keys(config)
    .filter(key => !VERCEL_TOP_LEVEL_PROPERTIES.includes(key));
  assert.deepEqual(unsupported, [],
    `vercel.json has unsupported top-level propert(ies): ${unsupported.join(', ')} — `
    + 'move explanatory prose to docs/DEPLOYMENT_CONFIGURATION.md');

  /* Named individually, because this is the one that was there. */
  assert.equal('comments' in config, false,
    'a pseudo-comment property must not come back');
});

test('vercel.json is JSON, not JSONC — no comment syntax survives anywhere', () => {
  /* Vercel's parser is not JSONC. A `//` or `/* *\/` would fail the whole file,
     and JSON.parse alone would have caught that — but only if something
     actually parses the raw text, which is what this does. */
  const raw = readFileSync(join(ROOT, 'vercel.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'vercel.json must be valid strict JSON');

  /* Comment syntax is looked for OUTSIDE string values, because a legitimate
     value can contain the same characters. The `functions` key is a glob —
     `api/staff/identity-resolution/*.mjs` — and a naive substring scan read
     its `/*` as a block comment. JSON.parse above is the real guarantee (a
     genuine comment makes the whole file throw); this is the belt-and-braces
     check, and it has to be precise enough not to forbid a valid config. */
  const outsideStrings = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.equal(/^\s*\/\//m.test(outsideStrings), false, 'no // line comment');
  assert.equal(outsideStrings.includes('/*'), false, 'no /* block comment');

  /* And the stripping must not have hidden a real comment: a block comment
     between two keys survives it. */
  const withComment = '{"a": 1, /* c */ "b": 2}'.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.ok(withComment.includes('/*'), 'the scan still sees a genuine comment');
});

test('the explanatory prose the config cannot carry is written down somewhere', () => {
  /* Removing the comments must not lose the reasoning. */
  const doc = join(ROOT, 'docs/DEPLOYMENT_CONFIGURATION.md');
  assert.ok(existsSync(doc), 'docs/DEPLOYMENT_CONFIGURATION.md explains vercel.json');
  const text = readFileSync(doc, 'utf8');
  for (const topic of ['maxDuration', 'regions', 'outputDirectory', 'buildCommand',
                       'continuation.js', '.vercelignore', 'catch-all']) {
    assert.ok(text.includes(topic), `the deployment doc still explains ${topic}`);
  }
});

test('the generated directory is git-ignored, so it is never an authoritative tree', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^dist\/?$/m,
    'dist/ must be ignored or the build output becomes committed source');
});

test('the build tooling is NOT git-ignored, or the deployment build cannot run', () => {
  /* THE DEFECT THIS PINS. These files first lived in build/, which .gitignore
     lists as build OUTPUT alongside dist/ and out/. They would therefore never
     have been committed — and the deployment's buildCommand would have failed
     with MODULE_NOT_FOUND while every local test passed, because the files
     exist locally. Build INPUTS must live in a tracked directory.

     Asserted against .gitignore's own rules rather than by running git, so it
     holds in a checkout with no git available. */
  const rules = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    .split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'));

  for (const file of ['tools/build-static.mjs', 'tools/static-manifest.mjs']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
    const dir = `${file.split('/')[0]}/`;
    for (const rule of rules) {
      const normalised = rule.replace(/^\/+/, '');
      assert.notEqual(normalised, dir,
        `.gitignore excludes ${dir} — ${file} would never be committed and the build would fail on deploy`);
      assert.notEqual(normalised, file, `.gitignore excludes ${file}`);
    }
  }

  /* And vercel.json's build command points at the tracked location. */
  assert.match(config.buildCommand, /^node tools\//,
    'the build command must run a tracked script');
});

/* ============================================================
   Determinism
   ============================================================ */

test('two consecutive builds produce the same inventory and the same content hashes', () => {
  const first = listOutput(outputRoot).map(f => [f, hashOf(outPath(f))]);
  const second = buildStatic({ quiet: true, env: BUILD_ENV });
  const after = listOutput(second.outputRoot).map(f => [f, hashOf(outPath(f))]);

  assert.deepEqual(after.map(e => e[0]), first.map(e => e[0]), 'identical file inventory');
  assert.deepEqual(after, first, 'identical content hashes — nothing is timestamped or reordered');
});

test('every generated file is a byte-for-byte copy of its canonical source', () => {
  /* EXACTLY ONE EXEMPTION, named as a constant by the build itself rather
     than restated here. Everything else is still a pure copy, which is what
     keeps "no secret can be injected at build time" a property of the build:
     there is one transform, it writes one line, and the next test pins what
     that line may contain. */
  for (const rel of STATIC_MANIFEST) {
    if (buildTesting.GENERATED_FILES.includes(rel)) continue;
    assert.equal(hashOf(outPath(rel)), hashOf(join(ROOT, rel.split('/').join(sep))),
      `${rel}: the published copy differs from the canonical source`);
  }
});

test('each generated file differs from its source by exactly the CSP line', () => {
  /* Two pages talk to Supabase Auth directly — the invitation page and the
     password-recovery page — so both need the exact origin. Neither may
     change by anything else. */
  assert.ok(buildTesting.GENERATED_FILES.length >= 1);
  for (const rel of buildTesting.GENERATED_FILES) assertOneLineDelta(rel);
});

const assertOneLineDelta = rel => {
  const source = readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8');
  const built = readFileSync(outPath(rel), 'utf8');

  const sourceLines = source.split(/\r?\n/);
  const builtLines = built.split(/\r?\n/);
  assert.equal(builtLines.length, sourceLines.length, `${rel}: no line was added or removed`);

  const changed = sourceLines
    .map((line, i) => (line === builtLines[i] ? null : i))
    .filter(i => i !== null);
  assert.equal(changed.length, 1, `${rel}: exactly one line changed, not ${changed.length}`);
  assert.equal(sourceLines[changed[0]], buildTesting.CSP_SOURCE_LINE);
  assert.equal(builtLines[changed[0]], buildTesting.cspLineFor(SUPABASE_ORIGIN));

  /* And the generated LINE is a CSP and nothing else — no key, no second
     host, no wildcard. Scoped to the line, because the surrounding document
     is prose and may legitimately contain an asterisk. */
  const line = builtLines[changed[0]];
  assert.equal(/sb_(secret|publishable)_|service_role/.test(built), false, rel);
  assert.equal(line.includes('*'), false, `${rel}: no wildcard source`);
  assert.equal(line.includes('wss'), false, `${rel}: no WebSocket source`);
  const connect = line.match(/connect-src ([^;]+);/)[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", SUPABASE_ORIGIN],
    `${rel}: exactly two sources — self and the one validated project origin`);
};

/* ============================================================
   Per-environment generation
   ------------------------------------------------------------
   THIS FILE OWNS THE REPOSITORY'S dist/, so it owns every test
   that calls buildStatic — node's test runner runs files
   concurrently, and two files rebuilding one directory is a race
   rather than a test. The validator, the route half and the
   source contract live in tests/build-csp-generation.test.mjs,
   which deliberately calls no build.
   ============================================================ */

/* A second, different project origin. Preview and Production must be able to
   produce different policies from the same source tree — that is the whole
   reason the origin is generated instead of committed. */
const PRODUCTION_ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';

test('Preview and Production generate different exact CSP origins', () => {
  const cspIn = () => readFileSync(outPath(buildTesting.GENERATED_FILES[0]), 'utf8')
    .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];

  const preview = buildStatic({ quiet: true, env: { SUPABASE_URL: SUPABASE_ORIGIN } });
  const previewCsp = cspIn();
  assert.equal(preview.supabaseOrigin, SUPABASE_ORIGIN);
  assert.ok(previewCsp.includes(`connect-src 'self' ${SUPABASE_ORIGIN};`), previewCsp);
  assert.equal(previewCsp.includes(PRODUCTION_ORIGIN), false);

  const production = buildStatic({ quiet: true, env: { SUPABASE_URL: PRODUCTION_ORIGIN } });
  const productionCsp = cspIn();
  assert.equal(production.supabaseOrigin, PRODUCTION_ORIGIN);
  assert.ok(productionCsp.includes(`connect-src 'self' ${PRODUCTION_ORIGIN};`), productionCsp);
  assert.equal(productionCsp.includes(SUPABASE_ORIGIN), false,
    'a production build must not be permitted to reach the development project');

  /* The two differ ONLY in the origin. Nothing else about the policy — or the
     page — moves between environments. */
  assert.equal(previewCsp.replace(SUPABASE_ORIGIN, ''), productionCsp.replace(PRODUCTION_ORIGIN, ''));

  buildStatic({ quiet: true, env: BUILD_ENV });
});

test('a trailing slash builds the same policy as no trailing slash', () => {
  const cspIn = () => readFileSync(outPath(buildTesting.GENERATED_FILES[0]), 'utf8')
    .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];

  buildStatic({ quiet: true, env: { SUPABASE_URL: `${SUPABASE_ORIGIN}/` } });
  const withSlash = cspIn();
  buildStatic({ quiet: true, env: BUILD_ENV });
  assert.equal(cspIn(), withSlash, 'one origin has one spelling in the policy');
});

test('a missing or invalid SUPABASE_URL fails the build before anything is touched', () => {
  const cspIn = () => readFileSync(outPath(buildTesting.GENERATED_FILES[0]), 'utf8');
  const before = cspIn();

  for (const value of [undefined, '', 'https://evil.test', 'sb_secret_abcdefghijk',
                       'http://qkpptajglstgucadhfwq.supabase.co',
                       `${SUPABASE_ORIGIN}/auth/v1`, 'https://*.supabase.co',
                       `${SUPABASE_ORIGIN} https://evil.test`]) {
    assert.throws(() => buildStatic({ quiet: true, env: { SUPABASE_URL: value } }),
      /refusing to build/, String(value));
  }

  /* And every one of those refusals left the previous output exactly as it
     was — the origin is resolved before the delete, not after. */
  assert.equal(cspIn(), before, 'the published page is untouched');
  assert.deepEqual(listOutput(outputRoot), [...STATIC_MANIFEST].sort());
  const strays = readdirSync(ROOT).filter(e => e.startsWith(buildTesting.TEMP_PREFIX));
  assert.deepEqual(strays, [], 'and no staging directory was left behind');
});

test('no placeholder survives into the built output, anywhere', () => {
  for (const rel of STATIC_MANIFEST) {
    const text = readFileSync(outPath(rel), 'utf8');
    assert.equal(text.includes('REPLACE-WITH-PROJECT-REF'), false,
      `${rel} carries a placeholder`);
    assert.equal(/PROJECT-REF|YOUR-PROJECT|<your-|TODO:/i.test(text), false,
      `${rel} carries something that reads as a placeholder`);
  }
});

test('vercel.json carries no placeholder and no Supabase host at all', () => {
  /* THE DEFECT THIS PINS. The staff CSP once carried
     `https://REPLACE-WITH-PROJECT-REF.supabase.co`, which had to be replaced
     by hand after review — a deployable configuration with a placeholder in
     it. Hardcoding the development origin instead would have been worse: the
     production deployment would have been permitted to reach the development
     project's Auth server. The origin is generated per environment now, and
     no Supabase host belongs in this file. */
  const raw = readFileSync(join(ROOT, 'vercel.json'), 'utf8');
  assert.equal(raw.includes('REPLACE-WITH-PROJECT-REF'), false);
  assert.equal(raw.includes('supabase'), false, 'vercel.json names no Supabase host');
});

test('the NUL byte in guidance.js survives the copy, so the build is byte-safe', () => {
  /* shared/service-mix-engine/guidance.js carries a deliberate NUL as a hash
     domain separator. A text round-trip through a default encoding would
     corrupt it, and the corruption would only show up as wrong hashes in
     production. */
  const source = readFileSync(join(ROOT, 'shared/service-mix-engine/guidance.js'));
  const copied = readFileSync(outPath('shared/service-mix-engine/guidance.js'));
  assert.ok(source.indexOf(0) > 0, 'the source really does contain a NUL byte');
  assert.equal(copied.indexOf(0), source.indexOf(0));
  assert.ok(copied.equals(source));
});

test('a stale file does not survive a rebuild', () => {
  /* The output is removed and recreated, so a file that leaves the manifest
     leaves the site. A build that merely overlaid new files would keep
     publishing whatever a previous manifest had published — which is exactly
     how a withdrawn document stays online. */
  const stray = outPath('stale-leftover.txt');
  writeFileSync(stray, 'this should not survive');
  assert.ok(existsSync(stray), 'the stray file was really created');

  buildStatic({ quiet: true, env: BUILD_ENV });

  assert.equal(existsSync(stray), false, 'the rebuild started from empty');
  assert.deepEqual(listOutput(outputRoot), [...STATIC_MANIFEST].sort(),
    'and the inventory is the manifest again');
});

test('a successful build leaves no temporary directory behind', () => {
  /* The build stages into a sibling and renames. If a stage directory
     survived, the next run would inherit it and `dist.tmp-*` would accumulate
     in the working tree. */
  const strays = readdirSync(ROOT).filter(e => e.startsWith(buildTesting.TEMP_PREFIX));
  assert.deepEqual(strays, [], `stray staging directories: ${strays.join(', ')}`);
});

test('a build that fails part way leaves the PREVIOUS output intact and current', () => {
  /* THE PROPERTY: a half-finished build must never be mistaken for a current
     one. The build validates everything, copies into a staging sibling, and
     only then removes and replaces the live output — so a failure anywhere
     before the swap leaves the previous site exactly as it was.

     Induced through the real buildStatic(), not simulated: a staging directory
     that is a symlink is refused by the same fence that protects dist/, which
     aborts this build after the output target has been checked but before
     anything has been removed. */
  const before = listOutput(outputRoot).map(f => [f, hashOf(outPath(f))]);
  assert.ok(before.length > 0, 'there is a previous output to protect');

  const stage = join(ROOT, `${buildTesting.TEMP_PREFIX}${process.pid}`);
  let linked = false;
  try { symlinkSync(join(ROOT, 'docs'), stage, 'junction'); linked = true; } catch {}

  if (!linked) {
    console.error('  ! failed-build test SKIPPED: directory symlinks unavailable');
  } else {
    try {
      assert.throws(() => buildStatic({ quiet: true, env: BUILD_ENV }), /symbolic link/,
        'the build refused rather than proceeding');

      assert.deepEqual(listOutput(outputRoot).map(f => [f, hashOf(outPath(f))]), before,
        'the previous output is byte-for-byte what it was — not truncated, not partial');

      /* And the refusal did not follow the link into docs/. */
      assert.ok(existsSync(join(ROOT, 'docs/DEPLOYMENT_CONFIGURATION.md')),
        'the symlink target was not touched');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  /* The next real build still succeeds and restores the invariant. */
  buildStatic({ quiet: true, env: BUILD_ENV });
  assert.deepEqual(listOutput(outputRoot), [...STATIC_MANIFEST].sort());
});

/* ============================================================
   The manifest and the output agree, in both directions
   ============================================================ */

test('every manifest entry names a real source file', () => {
  for (const rel of STATIC_MANIFEST) {
    assert.ok(existsSync(join(ROOT, rel.split('/').join(sep))),
      `${rel} is in the manifest but does not exist`);
  }
});

test('every generated file corresponds to a manifest entry, and every entry generates a file', () => {
  const generated = listOutput(outputRoot);
  assert.deepEqual(generated, [...STATIC_MANIFEST].sort(),
    'the output is exactly the manifest — no extra file, no missing file');
});

test('the manifest has no duplicates and no path that escapes the output', () => {
  assert.equal(new Set(STATIC_MANIFEST).size, STATIC_MANIFEST.length, 'no duplicate entries');
  for (const rel of STATIC_MANIFEST) {
    assert.equal(rel.includes('..'), false, `${rel}: no parent traversal`);
    assert.equal(rel.startsWith('/'), false, `${rel}: not absolute`);
    assert.equal(/^[a-zA-Z]:/.test(rel), false, `${rel}: not a drive path`);
  }
});

test('the build refuses a manifest source that has been moved or renamed', () => {
  /* Publishing a silently incomplete site is worse than failing the build: a
     missing script is a page that loads and then does nothing. Exercised
     through the exported resolver rather than by pointing the build at a
     different root — the build no longer takes a root, because a redirectable
     deletion target is not a fenced one. */
  assert.throws(() => buildTesting.assertSafeSource('shared/security/does-not-exist.js'),
    /manifest source does not exist/);

  /* And the live output is untouched by a rejected entry. */
  assert.deepEqual(listOutput(outputRoot), [...STATIC_MANIFEST].sort(),
    'a rejected source must not have disturbed the previous output');
});

test('the recursive delete is fenced to exactly the one permitted output directory', () => {
  /* The only thing between a configuration typo and an automated `rm -rf`, so
     it is asserted directly rather than only through a successful build.
     THE DEFECT THIS PINS: the old fence proved the target was "the directory
     the manifest names" and never asked whether that was a directory anyone
     should delete, so OUTPUT_DIR = 'shared' passed and deleted shared/. */
  const { assertOutputName, assertDirectChildOfRoot, PERMITTED_OUTPUT_NAME } = buildTesting;

  assert.doesNotThrow(() => assertOutputName(PERMITTED_OUTPUT_NAME));
  assert.equal(PERMITTED_OUTPUT_NAME, OUTPUT_DIR, 'the manifest and the fence agree');

  for (const name of ['shared', 'server', 'api', 'tests', 'tools', 'supabase', 'docs',
                      'staff', 'verticals', 'node_modules', '.git']) {
    assert.throws(() => assertOutputName(name), /is a source directory/,
      `OUTPUT_DIR = ${name} must be refused as a source directory`);
  }

  for (const name of ['', '.', '..', '/', 'dist/', '../dist', 'dist\\x', 'C:', 'a/b']) {
    assert.throws(() => assertOutputName(name), /refusing to build/,
      `OUTPUT_DIR = ${JSON.stringify(name)} must be refused`);
  }

  /* A merely different name is refused too, even though it is harmless: the
     equality is what makes the guarantee, and the list above is only there to
     make the failure legible. */
  assert.throws(() => assertOutputName('build'), /not the permitted output directory/);
  assert.throws(() => assertOutputName('public'), /not the permitted output directory/);

  /* Containment is path.relative on canonical paths, so a shared prefix is not
     a shared directory. */
  assert.throws(() => assertDirectChildOfRoot(resolve(ROOT, 'dist-old'), 'dist', 'x'),
    /is not dist/);
  assert.throws(() => assertDirectChildOfRoot(ROOT, 'dist', 'x'), /not inside the repository/);
  assert.throws(() => assertDirectChildOfRoot(resolve(ROOT, '..'), 'dist', 'x'),
    /not inside the repository/);
  assert.throws(() => assertDirectChildOfRoot(resolve(ROOT, 'tests/dist'), 'dist', 'x'),
    /is not dist/);
});

/* ============================================================
   Nothing that should be private is public
   ============================================================ */

test('no forbidden directory appears anywhere in the output', () => {
  const generated = listOutput(outputRoot);
  for (const prefix of FORBIDDEN_OUTPUT_PREFIXES) {
    const hits = generated.filter(f => f === prefix.slice(0, -1) || f.startsWith(prefix));
    assert.deepEqual(hits, [], `${prefix} must not be published`);
  }
});

test('no forbidden file appears anywhere in the output', () => {
  const generated = listOutput(outputRoot);
  for (const name of FORBIDDEN_OUTPUT_FILES) {
    const hits = generated.filter(f => f === name || f.endsWith(`/${name}`));
    assert.deepEqual(hits, [], `${name} must not be published`);
  }
});

test('the specific files that used to be downloadable are gone', () => {
  /* Named individually because these are the ones that mattered. */
  const generated = new Set(listOutput(outputRoot));
  for (const path of [
    'server/staff-identity-resolution.mjs',
    'api/assessments.mjs',
    'api/analytics.mjs',
    'api/staff/identity-resolution/[...path].mjs',
    'supabase/migrations/0007_staff_identity_resolution.sql',
    'supabase/migrations/0001_business_record_foundation.sql',
    'docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md',
    'docs/REAL_POSTGRES_VALIDATION.md',
    'tests/staff-auth-session.test.mjs',
    'tests/browser/staff-origin-headers.test.mjs',
    '.env.example',
    'CLAUDE.md',
    'package.json',
    'package-lock.json',
    'vercel.json',
    'tools/build-static.mjs',
    'tools/static-manifest.mjs'
  ]) {
    assert.equal(generated.has(path), false, `${path} is still published`);
  }
});

test('no secret-like value is embedded anywhere in the output', () => {
  /* There is no substitution step, so this should be impossible by
     construction. Asserted anyway, because "impossible by construction" is a
     claim about code that can change. */
  const generated = listOutput(outputRoot);
  const secretNames = [
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY',
    'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
    'CED_RATE_LIMIT_SECRET', 'CED_CONTINUATION_SECRET', 'CED_CHALLENGE_SECRET'
  ];
  for (const rel of generated) {
    const text = readFileSync(outPath(rel), 'utf8');
    /* An assigned value, not a mention. continuation.js names
       CED_CONTINUATION_SECRET in prose explaining that it never holds it. */
    for (const name of secretNames) {
      const assigned = new RegExp(`${name}\\s*[:=]\\s*['"\`][^'"\`\\s]+`);
      assert.equal(assigned.test(text), false, `${rel} appears to assign ${name}`);
    }
    assert.equal(/sb_secret_[A-Za-z0-9_-]+/.test(text), false, `${rel} contains a secret key`);
    /* A JWT-shaped literal. */
    assert.equal(/['"`]eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text), false,
      `${rel} contains a JWT-shaped literal`);
  }
});

/* ============================================================
   shared/security — an exact set, decided by content
   ============================================================ */

test('the output\'s shared/security contains exactly the approved browser-safe set', () => {
  const inOutput = listOutput(outputRoot).filter(f => f.startsWith('shared/security/'));
  assert.deepEqual(inOutput, [...PUBLIC_SECURITY_MODULES].sort(),
    'exactly the audited browser dependency, and nothing else from that directory');
  assert.deepEqual(inOutput, ['shared/security/continuation.js']);
});

test('every server-only security module is absent, by name', () => {
  const generated = new Set(listOutput(outputRoot));
  for (const path of SERVER_ONLY_SECURITY_MODULES) {
    assert.equal(generated.has(path), false, `${path} is server-only and must not be published`);
  }
});

test('the source directory really does hold more than the output does', () => {
  /* If someone adds a file to shared/security/ it appears here and NOT in the
     output, which is the intended direction. This asserts the allowlist is
     actually filtering rather than coincidentally matching. */
  const source = readdirSync(join(ROOT, 'shared/security'))
    .filter(f => f.endsWith('.js')).map(f => `shared/security/${f}`).sort();
  assert.ok(source.length > PUBLIC_SECURITY_MODULES.length,
    'the directory has server-only modules that are being withheld');
  for (const m of SERVER_ONLY_SECURITY_MODULES) {
    assert.ok(source.includes(m), `${m} should exist in source; the denylist is stale if not`);
  }
});

test('the published continuation module carries no secret and reads no environment', () => {
  /* The audit that justifies publishing it, pinned so a future edit that adds
     an environment read fails here rather than in production. */
  const text = readFileSync(outPath('shared/security/continuation.js'), 'utf8');
  assert.equal(/process\s*\.\s*env/.test(text), false, 'it reads no environment variable');
  assert.equal(/import\s|require\s*\(/.test(text), false, 'and imports nothing');

  /* Both halves fail closed without injected material. */
  assert.match(text, /if \(!secret \|\| typeof hmacFn !== 'function'\) return null;/,
    'issue returns null without a secret');
  assert.match(text, /if \(!secret \|\| typeof hmacFn !== 'function'\) \{[\s\S]{0,400}?OUTCOME\.notConfigured/,
    'verify reports not_configured rather than valid without a secret');
});

test('the published continuation module cannot mint or validate a trusted context', async () => {
  /* Not read off the source — executed. This is the browser\'s copy, given
     exactly what a browser has: no secret and no HMAC function. */
  const mod = await import(
    new URL(`file://${outPath('shared/security/continuation.js').split(sep).join('/')}`).href);
  const api = mod.default || mod;

  assert.equal(api.issueContinuationContext({
    businessId: '33333333-3333-4333-8333-333333333333', issuedAtMs: Date.now()
  }), null, 'no token can be issued without the server-held secret');

  for (const args of [{}, { secret: '' }, { secret: 'x' }, { hmacFn: () => 'sig' }]) {
    assert.equal(api.issueContinuationContext({
      businessId: '33333333-3333-4333-8333-333333333333', issuedAtMs: Date.now(), ...args
    }), null, `issue must fail closed for ${JSON.stringify(Object.keys(args))}`);
  }

  const verified = api.verifyContinuationContext({ token: '1.abc.def', nowMs: Date.now() });
  assert.equal(verified.status, 'not_configured', 'verify fails closed, never "valid"');
  assert.equal(verified.businessId, null, 'and yields no Business Record id');
});

/* ============================================================
   The URLs a browser actually asks for
   ============================================================ */

/* Vercel serves the output directory at the site root. A request for /p is
   answered by <output>/p, and a directory request by its index.html. This
   models that, and nothing more. */
const resolveStaticUrl = urlPath => {
  const clean = urlPath.split('?')[0].split('#')[0].replace(/^\/+/, '');
  if (clean.includes('..')) return null;
  const direct = join(outputRoot, clean.split('/').join(sep));
  if (existsSync(direct) && statSync(direct).isFile()) return clean;
  const index = join(direct, 'index.html');
  if (clean && existsSync(index) && statSync(index).isFile()) return `${clean}/index.html`;
  return null;
};

test('every public page URL still resolves', () => {
  for (const url of [
    '/verticals/beauty-wellness-fitness/nails/site/index.html',
    '/verticals/beauty-wellness-fitness/nails/site/',
    '/verticals/beauty-wellness-fitness/nails/service-mix/site/index.html',
    '/verticals/beauty-wellness-fitness/nails/service-mix/site/'
  ]) {
    assert.ok(resolveStaticUrl(url), `${url} must still resolve`);
  }
});

test('the staff console page, script and stylesheet still resolve at their current URLs', () => {
  for (const url of [
    '/staff/identity-resolution/index.html',
    '/staff/identity-resolution/',
    '/staff/identity-resolution/auth.js',
    '/staff/identity-resolution/page.js',
    '/staff/identity-resolution/styles.css'
  ]) {
    assert.ok(resolveStaticUrl(url), `${url} must still resolve`);
  }
});

test('every shared browser script URL still resolves', () => {
  for (const rel of STATIC_MANIFEST.filter(p => p.startsWith('shared/'))) {
    assert.equal(resolveStaticUrl(`/${rel}`), rel, `/${rel} must still resolve`);
  }
  assert.equal(resolveStaticUrl('/design-system/standards/tokens.css'),
    'design-system/standards/tokens.css');
});

test('a direct URL for a private path resolves to nothing', () => {
  for (const url of [
    '/server/staff-identity-resolution.mjs',
    '/server/',
    '/api/assessments.mjs',
    '/shared/security/rate-limit.js',
    '/shared/security/origin.js',
    '/shared/security/supabase-keys.js',
    '/shared/security/read-body.js',
    '/shared/security/staff-note.js',
    '/shared/security/verify-challenge.js',
    '/shared/security/limits.js',
    '/shared/business-intelligence/review-registry.js',
    '/shared/analytics/funnel.js',
    '/supabase/migrations/0007_staff_identity_resolution.sql',
    '/docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md',
    '/tests/staff-auth-session.test.mjs',
    '/.env.example',
    '/.env',
    '/CLAUDE.md',
    '/package.json',
    '/package-lock.json',
    '/vercel.json',
    '/tools/static-manifest.mjs',
    '/.git/config',
    '/.gitignore'
  ]) {
    assert.equal(resolveStaticUrl(url), null, `${url} must not resolve to a static file`);
  }
});

test('path traversal out of the output resolves to nothing', () => {
  for (const url of [
    '/../CLAUDE.md',
    '/../../etc/passwd',
    '/shared/../../.env.example',
    '/staff/identity-resolution/../../../server/staff-identity-resolution.mjs'
  ]) {
    assert.equal(resolveStaticUrl(url), null, `${url} must not resolve`);
  }
});

/* ============================================================
   Every reference inside the output resolves inside the output
   ============================================================ */

test('every asset the generated pages reference exists in the generated output', () => {
  /* The completeness check. If a page names a script that the manifest forgot,
     the site would deploy and then fail in the browser — this is what stops
     that reaching a deployment. */
  const generated = new Set(listOutput(outputRoot));
  const problems = [];

  const check = (fromRel, ref) => {
    if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(ref) || ref.startsWith('#')) return;
    const base = fromRel.split('/').slice(0, -1);
    const parts = ref.split('?')[0].split('#')[0].split('/');
    const stack = ref.startsWith('/') ? [] : [...base];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    const target = stack.join('/');
    if (!target) return;
    if (!generated.has(target)) problems.push(`${fromRel} -> ${ref} (${target})`);
  };

  for (const rel of listOutput(outputRoot)) {
    const text = readFileSync(outPath(rel), 'utf8');
    if (rel.endsWith('.html')) {
      for (const m of text.matchAll(/<(?:script|link|img)[^>]*?(?:src|href)="([^"]+)"/gi)) {
        check(rel, m[1]);
      }
      for (const m of text.matchAll(/<a[^>]*?href="([^"]+)"/gi)) check(rel, m[1]);
    }
    if (rel.endsWith('.css')) {
      for (const m of text.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)/gi)) check(rel, m[1]);
      for (const m of text.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) check(rel, m[1]);
    }
  }

  assert.deepEqual(problems, [], 'every referenced asset resolves inside the output');
});

test('the two reviews still reach each other, which is the connected-review path', () => {
  const growth = readFileSync(outPath(
    'verticals/beauty-wellness-fitness/nails/site/index.html'), 'utf8');
  assert.match(growth, /href="\.\.\/service-mix\/site\/index\.html"/,
    'the Growth Review still links to the Service Mix Review');
  const mix = readFileSync(outPath(
    'verticals/beauty-wellness-fitness/nails/service-mix/site/index.html'), 'utf8');
  assert.match(mix, /href="\.\.\/\.\.\/site\/index\.html"/, 'and back');
});

test('the published pages still load the continuation module they depend on', () => {
  for (const page of [
    'verticals/beauty-wellness-fitness/nails/site/index.html',
    'verticals/beauty-wellness-fitness/nails/service-mix/site/index.html'
  ]) {
    assert.match(readFileSync(outPath(page), 'utf8'), /shared\/security\/continuation\.js/,
      `${page} loads it, which is why it is published`);
  }
});

/* ============================================================
   Functions are still functions
   ============================================================ */

test('no API function is inside the static output', () => {
  const generated = listOutput(outputRoot);
  assert.deepEqual(generated.filter(f => f.startsWith('api/')), [],
    'api/ is a function surface, not a static one');
  assert.deepEqual(generated.filter(f => f.endsWith('.mjs')), [],
    'no server module of any kind is published');
});

test('the api/ tree is untouched by the build and still holds exactly three functions', () => {
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|js|ts)$/.test(entry)) {
        found.push(full.slice(ROOT.length + 1).split(sep).join('/'));
      }
    }
  };
  walk(join(ROOT, 'api'));
  assert.deepEqual(found.sort(), [
    'api/analytics.mjs',
    'api/assessments.mjs',
    'api/staff/identity-resolution/[...path].mjs'
  ], 'the build did not move, copy or remove a function');
  assert.equal(found.filter(f => /staff/i.test(f)).length, 1, 'exactly one staff function');
});

test('the vercel.json functions block still names exactly the intended entries', () => {
  /* THESE KEYS ARE GLOBS, NOT PATHS, and the staff entry says `*.mjs` for
     that reason. `[...]` is a character class in a glob, so the previous key
     — the literal filename `…/[...path].mjs` — matched one character from
     {. p a t h} and therefore matched NO file at all. The staff function ran
     on platform defaults with its declared budget silently discarded.

     Backslash escaping is not an available fix: measured against the glob
     dialect Vercel follows, `…/\[...path\].mjs` does not match the real
     filename either. A wildcard is the form that demonstrably does.

     This assertion compares STRINGS and cannot see any of that, which is
     exactly how the defect survived. tests/function-bundle-contract.test.mjs
     matches every key against the filesystem, which is the check with teeth.
     Both are kept: this one pins intent, that one pins reality. */
  assert.deepEqual(Object.keys(config.functions).sort(), [
    'api/assessments.mjs',
    'api/staff/identity-resolution/*.mjs'
  ]);
});

test('the implementation stays outside api/ and outside the static output', () => {
  assert.ok(existsSync(join(ROOT, 'server/staff-identity-resolution.mjs')),
    'the canonical implementation is still where the entrypoint imports it from');
  assert.equal(existsSync(join(ROOT, 'api/staff-identity-resolution.mjs')), false);
  assert.equal(new Set(listOutput(outputRoot)).has('server/staff-identity-resolution.mjs'), false);
});

test('function tracing still has real source modules to follow, and nothing hides them', () => {
  /* The tracer reads the static ESM imports in api/. Those specifiers must
     point at files that still exist in the repository — the build copies, it
     never moves — and no .vercelignore may exclude them. */
  assert.equal(existsSync(join(ROOT, '.vercelignore')), false,
    'no .vercelignore: excluding server/ or shared/ would break tracing');

  const entry = readFileSync(join(ROOT, 'api/staff/identity-resolution/[...path].mjs'), 'utf8');
  assert.match(entry, /from '\.\.\/\.\.\/\.\.\/server\/staff-identity-resolution\.mjs'/);

  const impl = readFileSync(join(ROOT, 'server/staff-identity-resolution.mjs'), 'utf8');
  for (const spec of ['../shared/business-record/resolve-identity.js',
                      '../shared/security/staff-note.js',
                      '../shared/security/rate-limit.js',
                      '../shared/security/read-body.js',
                      '../shared/security/origin.js']) {
    assert.ok(impl.includes(`from '${spec}'`), `${spec} is a static import`);
    assert.ok(existsSync(resolve(ROOT, 'server', spec)), `${spec} still exists to be traced`);
  }

  /* And the modules the tracer needs are NOT the ones being published. */
  const generated = new Set(listOutput(outputRoot));
  assert.equal(generated.has('shared/security/rate-limit.js'), false,
    'traced for the function, withheld from the browser — both, at once');
});

test('no rewrite makes the repository reachable again', () => {
  /* A catch-all rewrite to a filesystem path would undo the whole allowlist. */
  for (const rule of config.rewrites || []) {
    assert.equal(/^\/\(\.\*\)$|^\/\(\.\*\)\/?$/.test(rule.source || ''), false,
      `a catch-all rewrite (${rule.source}) would republish the repository`);
    assert.equal(/\.\./.test(rule.destination || ''), false,
      `${rule.destination}: a rewrite must not traverse out of the output`);
  }
});

/* ============================================================
   Headers still land on the generated paths
   ============================================================ */

const headerMatches = (source, path) =>
  new RegExp(`^${source.replace(/\(\.\*\)/g, '.*')}$`).test(path);

const headersFor = path => {
  const found = {};
  for (const rule of config.headers || []) {
    if (!headerMatches(rule.source, path)) continue;
    for (const h of rule.headers) found[h.key.toLowerCase()] = h.value;
  }
  return found;
};

test('the staff CSP and security headers still cover every generated staff asset', () => {
  for (const rel of listOutput(outputRoot).filter(f => f.startsWith('staff/'))) {
    const headers = headersFor(`/${rel}`);
    assert.equal(headers['x-frame-options'], 'DENY', rel);
    assert.equal(headers['cache-control'], 'no-store', rel);
    assert.equal(headers['referrer-policy'], 'no-referrer', rel);
    assert.equal(headers['x-robots-tag'], 'noindex, nofollow, noarchive', rel);

    /* THE HEADER POLICY CARRIES NO `default-src` AND NO `connect-src`, and
       that is the correction rather than a relaxation.

       A response-header CSP and a meta CSP are BOTH enforced, and the result
       is their intersection. A header saying `connect-src 'self'` would
       therefore have blocked the Supabase origin the onboarding page's own
       policy permits — and `default-src 'none'` would have done it too, being
       the fallback for connect-src. So the two directives that differ per
       page live in each page's meta, and the header keeps what a meta cannot
       express. */
    const csp = headers['content-security-policy'] || '';
    assert.match(csp, /^frame-ancestors 'none';/, `${rel}: the header leads with the one directive a meta cannot express`);
    assert.equal(/(^|;)\s*default-src/.test(csp), false,
      `${rel}: default-src in the header would intersect with the generated connect-src`);
    assert.equal(/(^|;)\s*connect-src/.test(csp), false,
      `${rel}: connect-src in the header would intersect with the generated one`);
    /* The directives that are identical on every staff page stay in the
       header, where they also cover a response no page element declares. */
    for (const directive of ["script-src 'self'", "style-src 'self'",
                             "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) {
      assert.ok(csp.includes(directive), `${rel}: the header still carries ${directive}`);
    }
  }
});

test('every generated staff HTML page carries its own meta CSP, before any resource', () => {
  /* The header cannot carry default-src or connect-src, so each page must —
     and a page that forgot would be governed by nothing but the header,
     which permits any connection. */
  for (const rel of listOutput(outputRoot).filter(f => f.startsWith('staff/') && f.endsWith('.html'))) {
    const html = readFileSync(outPath(rel), 'utf8');
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(meta, `${rel} declares no meta CSP`);

    const policy = meta[1];
    assert.ok(policy.startsWith("default-src 'none'"), `${rel}: ${policy}`);
    assert.ok(policy.includes("script-src 'self'"), rel);
    assert.ok(policy.includes("style-src 'self'"), rel);
    assert.ok(policy.includes("connect-src 'self'"), rel);
    assert.equal(policy.includes('frame-ancestors'), false,
      `${rel}: frame-ancestors is ignored in a meta policy and belongs in the header`);
    assert.equal(policy.includes('data:'), false, `${rel}: no data: source`);
    assert.equal(policy.includes('*'), false, `${rel}: no wildcard`);

    /* BEFORE ANY SCRIPT, STYLESHEET OR OTHER FETCH. A meta policy governs
       only what is parsed after it, so one placed below a <script> or a
       <link> would not have covered it. */
    const at = html.indexOf(meta[0]);
    for (const marker of ['<script', '<link', '<img', '<style']) {
      const first = html.indexOf(marker);
      if (first !== -1) {
        assert.ok(at < first, `${rel}: the meta CSP must precede the first ${marker}`);
      }
    }
  }
});

test('the public verticals are still unaffected by the staff rules', () => {
  for (const rel of listOutput(outputRoot).filter(f => f.startsWith('verticals/'))) {
    assert.deepEqual(headersFor(`/${rel}`), {},
      `${rel}: a marketing page must not inherit the staff policy`);
  }
  assert.deepEqual(headersFor('/design-system/standards/tokens.css'), {});
});

test('the api header rule still covers the staff route JSON', () => {
  const headers = headersFor('/api/staff/identity-resolution/cases');
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
});
