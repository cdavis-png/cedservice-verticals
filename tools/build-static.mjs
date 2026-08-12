/* ============================================================
   CED Intelligence Platform — the static output build
   ------------------------------------------------------------
   Copies exactly the files named in static-manifest.mjs into a
   generated directory, at their existing paths, and nothing else.

   ZERO DEPENDENCIES, on purpose. This repository has no bundler
   and no build step by design (CLAUDE.md section 1), and adding
   one to publish static files safely would be a larger change
   than the problem. Node's own fs is enough.

   WHAT IT IS NOT. It does not transform, minify, rewrite, inline,
   or substitute anything. Every output file is a BYTE-FOR-BYTE
   copy of its source, which is what makes "no secret can be
   injected at build time" a property of the build rather than a
   hope. Bytes rather than text also matters concretely:
   shared/service-mix-engine/guidance.js contains a deliberate NUL
   byte as a hash domain separator, and a text round-trip through
   a default encoding would corrupt it.

   DETERMINISTIC. Same inputs, same output, same content hashes.
   Nothing is timestamped, ordered by filesystem enumeration, or
   given a build id. Two consecutive runs produce identical trees,
   which a test asserts.

   ------------------------------------------------------------
   THIS FILE IS DESTRUCTIVE CODE AND IS WRITTEN AS SUCH.

   It performs a recursive delete. Three earlier weaknesses were
   found by review and are each closed below, by name:

     1. THE FENCE ACCEPTED ANY DIRECTORY THE MANIFEST NAMED.
        Setting OUTPUT_DIR to `shared` passed every check and
        recursively deleted shared/. The fence proved the target
        was "the configured output directory" without ever asking
        whether that was a directory anyone should delete. It now
        refuses a name that is not exactly the one permitted
        output directory, and refuses every known source directory
        ahead of that with a distinct error.

     2. PATH VALIDATION MISSED WINDOWS SHAPES. A manifest entry of
        `\Windows\win.ini` passed the guard, and BOTH its source
        and its destination then resolved outside the output
        directory. Backslashes, drive letters, UNC prefixes, empty
        strings, empty segments and dot segments are all refused
        now, and containment is proved with path.relative on
        canonical paths rather than inferred from the shape.

     3. SOURCES WERE FOLLOWED THROUGH SYMLINKS. existsSync and
        copyFileSync both dereference, so a symlinked manifest
        entry would have published a file from outside the
        repository. Every component of every source path is now
        inspected with lstat, which does not follow, and the final
        realpath is proved to be inside the repository.

   IT BUILDS INTO A TEMPORARY SIBLING AND SWAPS. Nothing touches
   the live output until every entry has been validated AND
   copied. A build that fails half way leaves the previous output
   exactly as it was, rather than a half-published site that looks
   current. The temporary directory gets the same fence as the
   real one, and only the exact directory this process created is
   ever cleaned up.

   ------------------------------------------------------------
   ONE GENERATED VALUE, IN TWO NAMED FILES.

   Every file is copied byte for byte EXCEPT a single line in each
   of the two staff pages that talk to Supabase Auth directly —
   accept-invite.html and reset-password.html — where
   `connect-src` is completed with the Supabase project origin.

   WHY IT HAS TO BE GENERATED. Those pages talk to Supabase Auth
   directly, so the policy has to name the exact project origin —
   and the origin differs between Preview and Production. A
   literal in `vercel.json` would be a placeholder somebody has to
   remember to replace (unsafe, and it shipped once), or the
   development project's origin hardcoded into main (worse: the
   production deployment would be permitted to reach the
   development database's Auth server).

   WHAT THAT DOES NOT LOOSEN. The substitution is one known line,
   in each named file, replaced with one value that has been
   validated as an exact scheme-host-port by
   shared/security/supabase-origin.js. The replacement is checked
   after it is made. NO KEY, NO SECRET AND NO CREDENTIAL IS EVER
   SUBSTITUTED — the publishable key is fetched at run time from
   /auth-config and is deliberately NOT built in, so the property
   "no secret can be inlined at build time" still holds by
   construction rather than by care.

   NO ENVIRONMENT OVERRIDE OF ANY PATH. `SUPABASE_URL` is the only
   variable read, it reaches only the CSP text, and nothing about
   the output directory, the staging directory, the manifest or
   the delete fence can be influenced by the environment. A
   deletion target a variable could redirect is not fenced.
   ============================================================ */

import {
  rmSync, mkdirSync, copyFileSync, existsSync, statSync, lstatSync,
  readdirSync, realpathSync, renameSync, readFileSync, writeFileSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';

import { STATIC_MANIFEST, OUTPUT_DIR } from './static-manifest.mjs';
import supabaseOrigin from '../shared/security/supabase-origin.js';

const { validateSupabaseOrigin, describeOriginFailure } = supabaseOrigin;

/* CANONICAL. realpath rather than resolve, so a repository reached through a
   symlinked parent still compares equal to the paths derived from it. Every
   containment check below is made against this value. */
const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

/* The ONLY directory name this build may ever create or remove. Stated here
   rather than taken from the manifest, so that changing the manifest constant
   cannot by itself widen what may be deleted — the two must agree. */
const PERMITTED_OUTPUT_NAME = 'dist';

/* The staging directory is a sibling of the output and shares its fence. */
const TEMP_PREFIX = 'dist.tmp-';

/* Refused as an output target ahead of the equality check, so a typo that
   happens to name real source gets an error that says what it nearly did.
   The equality check below is what actually guarantees safety; this list
   exists to make the failure legible. */
const SOURCE_DIRECTORIES = Object.freeze([
  'api', 'server', 'shared', 'supabase', 'docs', 'tests', 'tools',
  'staff', 'verticals', 'design-system', 'marketing', 'playbooks',
  'automations', 'deployment', 'ai', 'node_modules', '.git', '.github'
]);

const fail = message => { throw new Error(message); };

/* ---------- names ----------
   A path SEGMENT, not a path. Anything with a separator in it is not a name
   and is refused before it can be resolved into something surprising. */
const assertUsableName = (name, label) => {
  if (typeof name !== 'string' || name.length === 0) {
    fail(`refusing to build: ${label} is empty or not a string`);
  }
  if (name.includes('\0')) fail(`refusing to build: ${label} contains a NUL byte`);
  if (name === '.' || name === '..') {
    fail(`refusing to build: ${label} is not a usable name (${name})`);
  }
  if (/[\\/]/.test(name)) {
    fail(`refusing to build: ${label} must be a single path segment (${name})`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    fail(`refusing to build: ${label} is a drive path (${name})`);
  }
  return name;
};

/* The final output directory. Structure first, then "is this real source",
   then the equality that actually decides it. */
export const assertOutputName = name => {
  assertUsableName(name, 'the output directory');
  if (SOURCE_DIRECTORIES.includes(name.toLowerCase())) {
    fail(`refusing to build: ${name} is a source directory and must never be the output`);
  }
  if (name !== PERMITTED_OUTPUT_NAME) {
    fail(`refusing to build: ${name} is not the permitted output directory `
       + `(${PERMITTED_OUTPUT_NAME})`);
  }
  return name;
};

export const assertTemporaryName = name => {
  assertUsableName(name, 'the temporary build directory');
  if (SOURCE_DIRECTORIES.includes(name.toLowerCase())) {
    fail(`refusing to build: ${name} is a source directory and must never be a build directory`);
  }
  if (!name.startsWith(TEMP_PREFIX) || name.length <= TEMP_PREFIX.length) {
    fail(`refusing to build: ${name} is not a temporary build directory (${TEMP_PREFIX}…)`);
  }
  return name;
};

/* ---------- containment ----------
   path.relative on canonical paths, never a string prefix. `a/dist` and
   `a/dist-old` share a prefix and are different directories; relative() says
   so and startsWith does not. */
const assertDirectChildOfRoot = (target, expectedName, label) => {
  const rel = relative(ROOT, target);
  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') {
    fail(`refusing to touch ${target}: ${label} is not inside the repository`);
  }
  if (rel !== expectedName) {
    fail(`refusing to touch ${target}: ${label} is not ${expectedName}`);
  }
  if (target === ROOT) fail('refusing to touch the repository root');
};

/* A symlink at the output location is REFUSED, never followed and never
   unlinked. Removing it would be a decision about somebody else's directory,
   and following it would put the build outside its fence. */
const assertNotSymlink = (target, label) => {
  let info = null;
  try { info = lstatSync(target); } catch { return; }        /* absent is fine */
  if (info.isSymbolicLink()) {
    fail(`refusing to touch ${target}: ${label} is a symbolic link`);
  }
  if (!info.isDirectory()) {
    fail(`refusing to touch ${target}: ${label} exists and is not a directory`);
  }
};

/* Every condition, every time, immediately before the delete. */
const removeFenced = (target, expectedName, label) => {
  assertDirectChildOfRoot(target, expectedName, label);
  assertNotSymlink(target, label);
  rmSync(target, { recursive: true, force: true });
};

/* ---------- manifest paths ----------
   Repository-relative POSIX, and nothing else. Pure: no filesystem access, so
   it is testable on its own and behaves identically on POSIX and Windows. */
export const validateManifestPath = p => {
  if (typeof p !== 'string') fail('refusing to build: manifest entry is not a string');
  if (p.length === 0) fail('refusing to build: manifest entry is an empty path');
  if (p.includes('\0')) fail(`refusing to build: manifest entry contains a NUL byte`);
  if (/\\/.test(p)) {
    fail(`refusing to build: manifest entry uses a backslash separator: ${p}`);
  }
  if (/^[a-zA-Z]:/.test(p)) {
    fail(`refusing to build: manifest entry is an absolute drive path: ${p}`);
  }
  if (p.startsWith('/')) {
    fail(`refusing to build: manifest entry is an absolute path: ${p}`);
  }
  const segments = p.split('/');
  for (const segment of segments) {
    if (segment === '') {
      fail(`refusing to build: manifest entry has an empty path segment: ${p}`);
    }
    if (segment === '.' || segment === '..') {
      fail(`refusing to build: manifest entry has a "${segment}" segment: ${p}`);
    }
  }
  return segments;
};

/* Resolves a manifest entry to a real source file, refusing anything that
   reaches outside the repository or passes through a link on the way.

   lstat, component by component, because a symlink ANYWHERE in the path
   redirects everything below it. stat and existsSync both follow, so neither
   can be used to ask this question. */
export const assertSafeSource = (relPath, root = ROOT) => {
  const segments = validateManifestPath(relPath);

  let walked = root;
  for (let i = 0; i < segments.length; i++) {
    walked = join(walked, segments[i]);
    const last = i === segments.length - 1;
    let info;
    try { info = lstatSync(walked); } catch {
      fail(`refusing to build: manifest source does not exist: ${relPath}`);
    }
    if (info.isSymbolicLink()) {
      fail(`refusing to build: ${relPath} passes through a symbolic link `
         + `(${segments.slice(0, i + 1).join('/')})`);
    }
    if (last) {
      if (!info.isFile()) {
        fail(`refusing to build: manifest source is not a regular file: ${relPath}`);
      }
    } else if (!info.isDirectory()) {
      fail(`refusing to build: ${relPath} traverses something that is not a directory `
         + `(${segments.slice(0, i + 1).join('/')})`);
    }
  }

  /* Belt and braces: the canonical source must still be inside the canonical
     repository after every link has been ruled out. */
  const canonical = realpathSync(walked);
  const rel = relative(root, canonical);
  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') {
    fail(`refusing to build: ${relPath} resolves outside the repository (${canonical})`);
  }
  return canonical;
};

/* The destination is derived from the same validated segments, and is proved
   to land inside the staging directory rather than assumed to. */
export const assertSafeDestination = (relPath, stageRoot) => {
  const segments = validateManifestPath(relPath);
  const to = join(stageRoot, ...segments);
  const rel = relative(stageRoot, to);
  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') {
    fail(`refusing to build: ${relPath} would be written outside the output directory`);
  }
  return to;
};

/* ---------- the plan ----------
   Every entry validated and resolved BEFORE anything is created or removed.
   Exported and parameterised by root so the dangerous cases can be exercised
   against a real temporary fixture — a symlinked source, a duplicate, a
   Windows path — instead of only against the manifest that happens to be
   correct today. */
export const planManifest = (entries = STATIC_MANIFEST, root = ROOT) => {
  if (!Array.isArray(entries)) fail('refusing to build: the manifest is not an array');
  const plan = [];
  const destinations = new Set();
  for (const relPath of entries) {
    validateManifestPath(relPath);
    if (destinations.has(relPath)) {
      fail(`refusing to build: duplicate manifest destination: ${relPath}`);
    }
    destinations.add(relPath);
    plan.push({ relPath, from: assertSafeSource(relPath, root) });
  }
  return plan;
};

/* ============================================================
   The one generated value
   ============================================================ */

/* The ONLY files whose bytes the build is allowed to change, named here so no
   other file can acquire the exemption by accident.

   Both talk to Supabase Auth directly — one accepts an invitation, the other
   completes a password recovery — so both policies must name the exact
   project origin. Everything else in the manifest is still copied byte for
   byte. */
export const GENERATED_FILES = Object.freeze([
  'staff/identity-resolution/accept-invite.html',
  'staff/identity-resolution/reset-password.html'
]);

/* The exact line as it exists in the source, and the exact line the build
   writes in its place. Matched literally rather than by pattern: a regex over
   a Content-Security-Policy is a way to rewrite more of it than intended, and
   an exact match means a change to the page's policy has to be a deliberate
   change here too. */
export const CSP_SOURCE_LINE =
  `  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; `
  + `script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; `
  + `base-uri 'none'; object-src 'none'">`;

export const cspLineFor = origin =>
  CSP_SOURCE_LINE.replace(`connect-src 'self';`, `connect-src 'self' ${origin};`);

/* Reads and validates the project origin. Pure apart from the object it is
   handed, so the failing cases are testable without touching process.env. */
export const resolveSupabaseOrigin = (env = process.env) => {
  const result = validateSupabaseOrigin(env && env.SUPABASE_URL);
  if (!result.ok) {
    fail(`refusing to build: ${describeOriginFailure(result.reason)}\n`
       + '       The onboarding page\'s Content-Security-Policy is generated from it, '
       + 'and a build\n       that guessed would publish a page permitted to reach the '
       + 'wrong Supabase project.');
  }
  return result.origin;
};

/* Applies the substitution inside the STAGED tree, and proves it happened.

   Everything is checked after the write, not before: that the source line was
   present exactly once, that it is gone, that the generated line is there,
   that the rest of the file is untouched, and that nothing key-shaped was
   introduced. A generated file nobody verified is a file nobody can trust. */
const generateCspIn = (stageRoot, origin, relPath) => {
  const target = join(stageRoot, ...relPath.split('/'));
  const before = readFileSync(target, 'utf8');

  const occurrences = before.split(CSP_SOURCE_LINE).length - 1;
  if (occurrences !== 1) {
    fail(`refusing to build: ${relPath} must contain the base CSP line exactly `
       + `once (found ${occurrences}). The build cannot generate a policy it cannot find.`);
  }

  const generated = cspLineFor(origin);
  const after = before.replace(CSP_SOURCE_LINE, generated);

  if (!after.includes(generated)) fail('refusing to build: the CSP line was not written');
  if (after.includes(CSP_SOURCE_LINE)) fail('refusing to build: the base CSP line survived');
  if (after.length !== before.length + (generated.length - CSP_SOURCE_LINE.length)) {
    fail('refusing to build: the CSP substitution changed more than one line');
  }
  /* Belt and braces on the property that matters most about a build that
     rewrites bytes at all. */
  if (/sb_(secret|publishable)_|service_role/.test(after)) {
    fail('refusing to build: a key-shaped value reached the generated page');
  }

  writeFileSync(target, after);
};

/* Every generated page, or the build fails. A page that quietly kept the
   fail-closed baseline would be a page that silently cannot reach Supabase. */
const generateCsp = (stageRoot, origin) => {
  for (const relPath of GENERATED_FILES) generateCspIn(stageRoot, origin, relPath);
};

/* Every file actually present in the output, as repository-relative POSIX
   paths. Sorted, so the inventory is comparable between runs. */
export const listOutput = (outputRoot) => {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full.slice(outputRoot.length + 1).split(sep).join('/'));
    }
  };
  if (existsSync(outputRoot)) walk(outputRoot);
  return out.sort();
};

export const buildStatic = ({ quiet = false, env = process.env } = {}) => {
  /* ---------- 0. the generated value, before anything is touched ----------
     A misconfigured origin must cost nothing: no delete, no staging
     directory, no half-published site. It is also the failure most likely to
     happen, because it is the one thing that differs per environment. */
  const supabase = resolveSupabaseOrigin(env);

  /* ---------- 1. the output target, before anything exists ---------- */
  assertOutputName(OUTPUT_DIR);
  const outputRoot = join(ROOT, OUTPUT_DIR);
  assertDirectChildOfRoot(outputRoot, PERMITTED_OUTPUT_NAME, 'the output directory');
  assertNotSymlink(outputRoot, 'the output directory');

  /* ---------- 2. the whole manifest, before anything is created ----------
     A source that has moved, been renamed, become a link, or was written as a
     Windows path must stop the build. Copying what is left would publish a
     silently incomplete site, and a missing script is a page that loads and
     then does nothing. */
  const plan = planManifest(STATIC_MANIFEST, ROOT);

  /* ---------- 3. stage ----------
     A sibling of the output, fenced identically, named so it can never be
     mistaken for source and can never be the output itself. */
  const stageName = assertTemporaryName(`${TEMP_PREFIX}${process.pid}`);
  const stageRoot = join(ROOT, stageName);

  let owned = false;
  try {
    removeFenced(stageRoot, stageName, 'the temporary build directory');
    mkdirSync(stageRoot, { recursive: true });
    owned = true;

    for (const { relPath, from } of plan) {
      const to = assertSafeDestination(relPath, stageRoot);
      mkdirSync(dirname(to), { recursive: true });
      /* Byte-for-byte. No read-as-text, no re-encode, no transform. */
      copyFileSync(from, to);
    }

    /* ---------- 3a. the one generated value ----------
       After every copy, inside the staging directory, so the canonical source
       is never written to and a failure here still leaves the live output
       exactly as it was. */
    generateCsp(stageRoot, supabase);

    /* ---------- 4. prove the staged tree before it becomes the site ---------- */
    const written = listOutput(stageRoot);
    const expected = [...STATIC_MANIFEST].sort();
    if (written.length !== expected.length || written.some((f, i) => f !== expected[i])) {
      fail(`refusing to publish: the staged output is not the manifest `
         + `(${written.length} file(s), expected ${expected.length})`);
    }

    /* ---------- 5. swap ----------
       Only now. Removing the previous output is the last destructive act, and
       it happens when the replacement is already complete on disk. */
    removeFenced(outputRoot, PERMITTED_OUTPUT_NAME, 'the output directory');
    renameSync(stageRoot, outputRoot);
    owned = false;

    if (!quiet) {
      console.log(`Static output: ${written.length} files -> ${OUTPUT_DIR}/`);
      /* The origin is not a secret and printing it is how a deploy log shows
         which project the published page was permitted to reach. */
      console.log(`Onboarding connect-src: 'self' ${supabase}`);
    }
    return { outputRoot, written, supabaseOrigin: supabase };
  } finally {
    /* ONLY the directory this process created, and only if it still owns it. */
    if (owned) {
      try { removeFenced(stageRoot, stageName, 'the temporary build directory'); } catch {}
    }
  }
};

/* Exported so the fence can be tested as itself, with hostile inputs, rather
   than only through a build that happens to succeed. */
export const __testing = {
  ROOT, PERMITTED_OUTPUT_NAME, TEMP_PREFIX, SOURCE_DIRECTORIES,
  assertOutputName, assertTemporaryName, assertDirectChildOfRoot, assertNotSymlink,
  validateManifestPath, assertSafeSource, assertSafeDestination, planManifest,
  GENERATED_FILES, CSP_SOURCE_LINE, cspLineFor, resolveSupabaseOrigin
};

/* Runnable as the Vercel build command, and by hand. */
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const { written } = buildStatic();
    for (const f of written) console.log(`  ${f}`);
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}
