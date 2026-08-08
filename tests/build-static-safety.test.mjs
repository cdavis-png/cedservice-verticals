/* ============================================================
   The static build as DESTRUCTIVE CODE
   ------------------------------------------------------------
   tools/build-static.mjs performs a recursive delete and writes
   the only files a browser is ever given. This file attacks it.

   THREE DEFECTS THIS EXISTS FOR, each found by review after the
   original suite passed:

     1. The delete fence accepted any directory the manifest
        named. OUTPUT_DIR = 'shared' passed every check and
        recursively removed shared/. The fence proved the target
        was "the configured output directory" and never asked
        whether that was a directory anyone should delete.

     2. Path validation missed Windows shapes. A manifest entry
        of `\Windows\win.ini` passed the guard, and BOTH its
        source and its destination then resolved outside the
        output directory.

     3. Sources were followed through symlinks. existsSync and
        copyFileSync both dereference, so a symlinked manifest
        entry would have published a file from outside the
        repository entirely.

   WHY THESE TESTS LOOK LIKE THIS. The old suite asserted
   PROPERTIES OF THE REAL MANIFEST — "no entry contains .." — and
   the manifest was correct, so it passed while the guard that
   was supposed to enforce it did not work. A property of today's
   data is not a test of the code. Everything below drives the
   exported validators with hostile input, or builds a real
   fixture tree on disk, and never restates the implementation's
   own conditions as the expectation.

   NOTHING HERE TOUCHES THE REPOSITORY'S OWN dist/. The fixtures
   live in the OS temporary directory and are removed afterwards.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync,
         existsSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { __testing } from '../tools/build-static.mjs';
import { STATIC_MANIFEST, OUTPUT_DIR } from '../tools/static-manifest.mjs';

const {
  ROOT, PERMITTED_OUTPUT_NAME, TEMP_PREFIX, SOURCE_DIRECTORIES,
  assertOutputName, assertTemporaryName, assertDirectChildOfRoot, assertNotSymlink,
  validateManifestPath, assertSafeSource, assertSafeDestination, planManifest
} = __testing;

/* ---------- fixtures ----------
   A real directory tree, not a mock. realpath because macOS hands back a
   symlinked /var and the build compares canonical paths. */
const fixtures = [];
const newFixture = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ced-build-safety-')));
  fixtures.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of fixtures) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/* Symlink creation needs elevation or Developer Mode on Windows. When it is
   unavailable the symlink tests SKIP LOUDLY rather than passing quietly — a
   skipped symlink test proves nothing, and symlink handling is defect 3. */
const symlinkSupport = (() => {
  const dir = newFixture();
  writeFileSync(join(dir, 'target.txt'), 'x');
  mkdirSync(join(dir, 'targetdir'));
  const out = { file: false, dir: false };
  try { symlinkSync(join(dir, 'target.txt'), join(dir, 'flink'), 'file'); out.file = true; } catch {}
  try { symlinkSync(join(dir, 'targetdir'), join(dir, 'dlink'), 'junction'); out.dir = true; } catch {}
  return out;
})();

if (!symlinkSupport.file || !symlinkSupport.dir) {
  console.error(
    `\n  ! SYMLINK COVERAGE PARTIALLY SKIPPED: file symlinks=${symlinkSupport.file}, `
    + `directory links=${symlinkSupport.dir}.`
    + '\n    On Windows this needs Developer Mode or an elevated shell.'
    + '\n    Symlink rejection was NOT fully observed on this run.\n');
}

/* ============================================================
   1. The output target — what may be deleted
   ============================================================ */

test('the only permitted output is the repository\'s own dist/', () => {
  assert.equal(PERMITTED_OUTPUT_NAME, 'dist');
  assert.equal(OUTPUT_DIR, PERMITTED_OUTPUT_NAME,
    'the manifest constant and the build fence must agree, or one of them is decorative');
  assert.doesNotThrow(() => assertOutputName('dist'));
});

test('no source directory can ever become the output', () => {
  /* Defect 1, directly. Every one of these previously passed. */
  for (const name of ['api', 'server', 'shared', 'supabase', 'docs', 'tests', 'tools',
                      'staff', 'verticals', 'design-system', 'node_modules', '.git']) {
    assert.throws(() => assertOutputName(name), /is a source directory/, name);
  }
  /* And the list is not aspirational: these really are directories that exist. */
  for (const name of ['api', 'server', 'shared', 'supabase', 'docs', 'tests', 'tools']) {
    assert.ok(existsSync(join(ROOT, name)), `${name} really is real source`);
    assert.ok(SOURCE_DIRECTORIES.includes(name));
  }
});

test('structurally dangerous output names are refused', () => {
  for (const name of ['', '.', '..', '/', '\\', './dist', '../dist', 'dist/', 'a/b',
                      'dist\\sub', 'C:', 'C:/dist']) {
    assert.throws(() => assertOutputName(name), /refusing to build/,
      `OUTPUT_DIR = ${JSON.stringify(name)} must be refused`);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => assertOutputName(bad), /refusing to build/, String(bad));
  }
});

test('even a harmless different name is refused, because equality is the guarantee', () => {
  for (const name of ['build', 'public', 'out', 'dist2', 'dist-old']) {
    assert.throws(() => assertOutputName(name), /not the permitted output directory/, name);
  }
});

test('containment is canonical, so a shared prefix is not a shared directory', () => {
  /* `dist-old` starts with `dist`. A startsWith fence would have accepted it. */
  assert.throws(() => assertDirectChildOfRoot(join(ROOT, 'dist-old'), 'dist', 'output'),
    /is not dist/);
  assert.throws(() => assertDirectChildOfRoot(join(ROOT, 'distant'), 'dist', 'output'),
    /is not dist/);
  assert.throws(() => assertDirectChildOfRoot(ROOT, 'dist', 'output'),
    /not inside the repository/);
  assert.throws(() => assertDirectChildOfRoot(resolve(ROOT, '..'), 'dist', 'output'),
    /not inside the repository/);
  assert.throws(() => assertDirectChildOfRoot(resolve(ROOT, '../elsewhere/dist'), 'dist', 'o'),
    /not inside the repository/);
  assert.throws(() => assertDirectChildOfRoot(join(ROOT, 'tests', 'dist'), 'dist', 'o'),
    /is not dist/, 'a nested dist is not THE dist');
  assert.doesNotThrow(() => assertDirectChildOfRoot(join(ROOT, 'dist'), 'dist', 'output'));
});

test('the temporary build directory is fenced on the same terms', () => {
  assert.doesNotThrow(() => assertTemporaryName(`${TEMP_PREFIX}1234`));
  for (const name of ['dist', 'shared', '', '.', '..', 'dist.tmp', 'tmp-1', 'a/b',
                      `${TEMP_PREFIX}`]) {
    assert.throws(() => assertTemporaryName(name), /refusing to build/, name);
  }
});

/* ============================================================
   2. An existing symlink at the output location
   ============================================================ */

test('a symlink at the output location is refused, and its target is untouched',
  { skip: symlinkSupport.dir ? false : 'directory symlinks unavailable on this machine' },
  () => {
    const dir = newFixture();
    const precious = join(dir, 'precious');
    mkdirSync(precious);
    writeFileSync(join(precious, 'data.txt'), 'IRREPLACEABLE');

    const link = join(dir, 'dist');
    symlinkSync(precious, link, 'junction');
    assert.ok(lstatSync(link).isSymbolicLink() || lstatSync(link).isDirectory());

    assert.throws(() => assertNotSymlink(link, 'the output directory'),
      /is a symbolic link/,
      'a linked output must be refused rather than followed OR unlinked');

    /* The refusal must not have been a deletion in disguise. */
    assert.equal(readFileSync(join(precious, 'data.txt'), 'utf8'), 'IRREPLACEABLE');
    assert.ok(existsSync(link), 'the link itself is left exactly as it was found');
  });

test('a file where the output directory should be is refused', () => {
  const dir = newFixture();
  const asFile = join(dir, 'dist');
  writeFileSync(asFile, 'not a directory');
  assert.throws(() => assertNotSymlink(asFile, 'the output directory'),
    /exists and is not a directory/);
});

test('an absent output location is acceptable — that is the first build', () => {
  const dir = newFixture();
  assert.doesNotThrow(() => assertNotSymlink(join(dir, 'nothing-here'), 'output'));
});

/* ============================================================
   3. Manifest path shapes — POSIX and Windows
   ============================================================ */

test('Windows path shapes are refused', () => {
  /* Defect 2, directly. `\Windows\win.ini` passed the old guard and resolved
     to C:\Windows\win.ini as BOTH source and destination. */
  const cases = [
    ['\\Windows\\win.ini', /backslash/],
    ['shared\\security\\continuation.js', /backslash/],
    ['\\\\server\\share\\x.txt', /backslash/],
    ['C:/Windows/win.ini', /absolute drive path/],
    ['c:/x', /absolute drive path/],
    ['Z:/x', /absolute drive path/]
  ];
  for (const [entry, pattern] of cases) {
    assert.throws(() => validateManifestPath(entry), pattern, JSON.stringify(entry));
  }
});

test('POSIX-absolute, empty, dot and traversal shapes are refused', () => {
  const cases = [
    ['', /empty path/],
    ['/etc/passwd', /absolute path/],
    ['//server/share', /absolute path/],
    ['../outside.js', /"\.\." segment/],
    ['shared/../../outside.js', /"\.\." segment/],
    ['./shared/x.js', /"\." segment/],
    ['shared/./x.js', /"\." segment/],
    ['shared//x.js', /empty path segment/],
    ['shared/x.js/', /empty path segment/],
    ['/shared/x.js', /absolute path/],
    ['shared/x\0.js', /NUL byte/]
  ];
  for (const [entry, pattern] of cases) {
    assert.throws(() => validateManifestPath(entry), pattern, JSON.stringify(entry));
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => validateManifestPath(bad), /refusing to build/, String(bad));
  }
});

test('a genuine manifest entry is accepted and split into its segments', () => {
  assert.deepEqual(validateManifestPath('shared/security/continuation.js'),
    ['shared', 'security', 'continuation.js']);
  for (const entry of STATIC_MANIFEST) {
    assert.doesNotThrow(() => validateManifestPath(entry), entry);
  }
});

test('a destination can never be written outside the output directory', () => {
  const stage = newFixture();
  /* Every shape that could escape is refused before a destination is derived,
     and a legitimate one lands inside — proven with path.relative, not by
     reading the implementation. */
  const to = assertSafeDestination('shared/security/continuation.js', stage);
  assert.ok(to.startsWith(stage + sep));
  assert.equal(to, join(stage, 'shared', 'security', 'continuation.js'));

  for (const entry of ['../escape.js', '/etc/passwd', '\\Windows\\win.ini', 'C:/x', '']) {
    assert.throws(() => assertSafeDestination(entry, stage), /refusing to build/,
      JSON.stringify(entry));
  }
});

/* ============================================================
   4. Sources: existence, kind, duplicates, symlinks
   ============================================================ */

test('a source that does not exist stops the build', () => {
  const dir = newFixture();
  assert.throws(() => assertSafeSource('nope.js', dir), /does not exist/);
  assert.throws(() => assertSafeSource('a/b/nope.js', dir), /does not exist/);
});

test('a directory is not a publishable source', () => {
  const dir = newFixture();
  mkdirSync(join(dir, 'adir'));
  assert.throws(() => assertSafeSource('adir', dir), /not a regular file/);
});

test('a path that traverses a non-directory is refused', () => {
  const dir = newFixture();
  writeFileSync(join(dir, 'afile'), 'x');
  assert.throws(() => assertSafeSource('afile/child.js', dir),
    /does not exist|not a directory/);
});

test('duplicate destinations are refused', () => {
  const dir = newFixture();
  writeFileSync(join(dir, 'a.js'), 'x');
  assert.throws(() => planManifest(['a.js', 'a.js'], dir),
    /duplicate manifest destination/);
  /* And a plan with no duplicate is fine, so the check is not just always-throw. */
  writeFileSync(join(dir, 'b.js'), 'y');
  assert.equal(planManifest(['a.js', 'b.js'], dir).length, 2);
});

test('a symlinked SOURCE FILE is refused, so nothing outside the repo is published',
  { skip: symlinkSupport.file ? false : 'file symlinks unavailable on this machine' },
  () => {
    /* Defect 3, directly. copyFileSync dereferences, so without this the build
       would have published the contents of a file outside the tree. */
    const outside = newFixture();
    writeFileSync(join(outside, 'secret.txt'), 'SHOULD NEVER BE PUBLISHED');

    const repo = newFixture();
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'innocent.js'), 'file');

    assert.throws(() => assertSafeSource('innocent.js', repo),
      /passes through a symbolic link/);
    assert.throws(() => planManifest(['innocent.js'], repo),
      /passes through a symbolic link/);
  });

test('a symlinked DIRECTORY COMPONENT is refused, not just the final file',
  { skip: symlinkSupport.dir ? false : 'directory symlinks unavailable on this machine' },
  () => {
    /* A link anywhere in the path redirects everything below it, so checking
       only the last component would miss this entirely. */
    const outside = newFixture();
    mkdirSync(join(outside, 'private'));
    writeFileSync(join(outside, 'private', 'notes.js'), 'SHOULD NEVER BE PUBLISHED');

    const repo = newFixture();
    symlinkSync(join(outside, 'private'), join(repo, 'public'), 'junction');

    assert.throws(() => assertSafeSource('public/notes.js', repo),
      /passes through a symbolic link/);
  });

test('a symlinked FINAL component is rejected as a link, before its kind is considered',
  { skip: symlinkSupport.dir ? false : 'directory symlinks unavailable on this machine' },
  () => {
    /* Covers the last-component branch of the walk even where file symlinks
       need elevation: the symlink test must fire BEFORE the is-it-a-regular-
       file test, or a link would be reported as the wrong kind of problem and
       a future edit could reorder them without anything noticing. */
    const outside = newFixture();
    mkdirSync(join(outside, 'target'));

    const repo = newFixture();
    symlinkSync(join(outside, 'target'), join(repo, 'entry'), 'junction');

    assert.throws(() => assertSafeSource('entry', repo), /passes through a symbolic link/,
      'reported as a link, not as "not a regular file"');
  });

test('an ordinary file inside the fixture root is accepted', () => {
  /* The mirror of the tests above: the rejections are specific, not blanket. */
  const dir = newFixture();
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'ok.js'), 'fine');
  assert.equal(assertSafeSource('nested/ok.js', dir), join(dir, 'nested', 'ok.js'));
});

test('the real manifest plans cleanly against the real repository', () => {
  const plan = planManifest(STATIC_MANIFEST, ROOT);
  assert.equal(plan.length, STATIC_MANIFEST.length);
  for (const { relPath, from } of plan) {
    assert.ok(from.startsWith(ROOT + sep), `${relPath} resolves inside the repository`);
    assert.ok(lstatSync(from).isFile(), `${relPath} is a regular file`);
  }
});
