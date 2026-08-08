# The static build as destructive code

[tools/build-static.mjs](../tools/build-static.mjs) performs a recursive delete
and decides the only files a browser is ever given. This document states what
it will and will not do, and why each rule exists.

The allowlist itself — *which* files are published — is
[tools/static-manifest.mjs](../tools/static-manifest.mjs) and is described in
CLAUDE.md section 13. This document is about the *mechanism*, not the list.

---

## Three defects this design closes

An independent review found all three after the original build script had
passed its own test suite. Each is named in the source, at the code that fixes
it, so a future edit that reopens one has to delete the explanation first.

### 1. The delete fence accepted any directory the manifest named

The original fence asked three questions: is the name usable, does the target
equal `resolve(ROOT, OUTPUT_DIR)`, and is it inside the repository. All three
passed for `OUTPUT_DIR = 'shared'` — and the build recursively deleted
`shared/`. It proved the target was *the configured output directory* without
ever asking whether that was a directory anyone should delete.

**Now:** the permitted output name is a constant in the build script
(`PERMITTED_OUTPUT_NAME = 'dist'`), separate from the manifest's `OUTPUT_DIR`,
and the two must agree. A name matching a known source directory is refused
first, with an error that says what it nearly did. Any other name is refused by
the equality check. Changing the manifest constant alone can no longer widen
what may be deleted.

### 2. Path validation missed Windows shapes

A manifest entry of `\Windows\win.ini` passed the guard. Because
`path.resolve` treats a leading backslash as drive-root on Windows, **both**
its source and its destination then resolved outside the output directory.
The guard checked `startsWith('/')`, `includes('..')` and `/^[a-zA-Z]:/`, and
none of those catches a backslash. The empty string passed too.

**Now:** backslashes, drive letters, UNC prefixes, POSIX-absolute paths, empty
strings, empty segments (from repeated or trailing separators), `.` and `..`
segments and NUL bytes are all refused. Containment is then *proved* with
`path.relative` on canonical paths rather than inferred from the shape.

### 3. Sources were followed through symlinks

`existsSync` and `copyFileSync` both dereference. A symlinked manifest entry —
or a symlinked *directory anywhere in its path* — would have published a file
from outside the repository, and nothing would have said so.

**Now:** every component of every source path is inspected with `lstat`, which
does not follow. A link at any position is refused. The final component must be
a regular file, and its `realpath` must still be inside the canonical
repository root.

---

## What the build guarantees

### It builds into a staging sibling and swaps

Nothing touches the live output until every entry has been validated **and**
copied successfully. The sequence is:

1. Validate the output name and target; refuse a symlink or a non-directory
   sitting where `dist/` belongs.
2. Validate and resolve **every** manifest entry — path shape, existence, kind,
   symlink components, duplicates — before anything is created.
3. Create `dist.tmp-<pid>/`, fenced on the same terms as `dist/`.
4. Copy every file, byte for byte.
5. Prove the staged inventory is exactly the manifest.
6. Only then remove `dist/` and rename the staging directory into place.

A failure anywhere before step 6 leaves the previous output **exactly as it
was**. A half-finished build can never be mistaken for a current one, and a
stale file cannot survive a rebuild because the whole directory is replaced.

### Canonical paths, never string prefixes

`ROOT` is a `realpath`, so a repository reached through a symlinked parent
still compares equal. Containment is `path.relative`, because `dist` and
`dist-old` share a string prefix and are different directories.

### No environment override

Nothing in the build reads `process.env`. A deletion target that a variable
could redirect is not fenced.

### Only its own temporary directory is cleaned up

The staging directory is named from this process's own PID and is removed only
if this run still owns it. `.gitignore` covers `dist.tmp-*/` so a hard-killed
build cannot leave working-tree noise that looks like source.

### Byte-for-byte, always

`copyFileSync` on validated paths. No transform, no minify, no inline, no
substitution — which is what makes "no secret can be injected at build time" a
property of the build rather than a hope. It also matters concretely:
`shared/service-mix-engine/guidance.js` carries a deliberate NUL byte as a hash
domain separator, and a text round-trip would corrupt it.

---

## What is refused, exactly

| Output directory | Manifest entry |
| --- | --- |
| empty, `.`, `..`, `/`, `\` | empty string |
| anything containing a separator | POSIX-absolute (`/etc/passwd`) |
| a drive path (`C:`) | drive path (`C:/x`) |
| a known source directory (`shared`, `server`, `api`, `tests`, `tools`, `supabase`, `docs`, `staff`, `verticals`, …) | UNC (`\\server\share`) |
| any name that is not exactly `dist` | any backslash |
| an existing symlink at that location | `.` or `..` segment |
| an existing non-directory at that location | empty segment (`a//b`, `a/`) |
| a path outside the repository | NUL byte |
| a nested `dist` (`tests/dist`) | a duplicate destination |
| | a source that does not exist |
| | a source that is not a regular file |
| | a symlink at **any** path component |
| | a source whose realpath leaves the repository |
| | a destination that would land outside the output |

An existing symlink at the output location is **refused, never followed and
never unlinked** — removing it would be a decision about somebody else's
directory.

---

## How this is tested

[tests/build-static-safety.test.mjs](../tests/build-static-safety.test.mjs)
drives the exported validators with hostile input and builds real fixture trees
in the OS temporary directory, including genuine symlinks. It never asserts a
property of the current manifest as a substitute for testing the guard — that
is precisely how the three defects above survived the original suite, which
asserted "no manifest entry contains `..`" against a manifest that was correct
while the guard that should have enforced it did not work.

[tests/static-output-contract.test.mjs](../tests/static-output-contract.test.mjs)
owns the repository's real `dist/`: it runs the real build, walks the generated
tree, proves determinism and byte-identity, induces a genuine mid-build failure
and checks the previous output survived it intact.

**Symlink coverage degrades honestly.** Creating file symlinks on Windows needs
Developer Mode or an elevated shell. When it is unavailable those tests skip
with a loud message on stderr rather than passing quietly, because a skipped
symlink test proves nothing about symlink handling. Directory links (junctions)
do not need elevation and are exercised on Windows, which covers the
path-component branch and the final-component branch.
