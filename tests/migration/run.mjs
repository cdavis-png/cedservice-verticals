/* ============================================================
   Migration test runner
   ------------------------------------------------------------
   Runs each migration test file in its OWN node process, one at
   a time.

   Two reasons, both learned the hard way on this machine:

     1. PGlite does not return its WebAssembly heap when a
        cluster is closed, so two clusters in one process cost
        twice the memory even when only one is open. A process
        per file is the only way to keep the peak at one.

     2. `node --max-old-space-size=… --test` does NOT pass that
        flag to the child processes node:test forks for each
        file, and with V8's default heap sizing the WASM
        allocation fails with "Fatal process out of memory:
        Zone" — reproducibly, 0 runs in 3. Setting it explicitly
        succeeds 3 in 3. NODE_OPTIONS is how the child gets it.

   Plain `node --test tests/migration/*.test.mjs` still works
   when a machine has room to spare. This runner is what makes
   it work when it does not.
   ============================================================ */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/* Defaults to this directory. The integration suite in local mode has the
   same two problems and uses the same runner: `node tests/migration/run.mjs
   tests/integration`. */
const target = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : HERE;

const files = readdirSync(target)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .map(f => resolve(target, f));

if (!files.length) {
  console.error('No migration test files found.');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', file], {
    stdio: 'inherit',
    env: {
      ...process.env,
      /* Reaches the child; the parent's own --max-old-space-size does not. */
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=256`.trim()
    }
  });
  if (result.status !== 0) failed++;
}

process.exit(failed === 0 ? 0 : 1);
