# Vendored browser dependency

One file, one reason, and it is the only third-party code this repository
serves to a browser.

| | |
|---|---|
| File | `supabase-js-2.112.0.umd.js` |
| Package | `@supabase/supabase-js` |
| Version | 2.112.0 — pinned exactly (no range) in `package.json`, the `package-lock.json` root declaration, and the resolved lock entry |
| Source | `node_modules/@supabase/supabase-js/dist/umd/supabase.js` |
| Bytes | 210770 |
| SHA-256 | `eb7564b09d311fd7b0375a7c0dc687a4c7c8ca9eda22c7823285fe86cfb21601` |
| Modified | No. Byte-for-byte the published build. |

## Why it is here

`staff/identity-resolution/accept-invite.html` completes a Supabase
invitation: it verifies the invite token, sets the user's password, enrolls a
TOTP factor and verifies it. Every one of those steps involves a password, a
session token, a TOTP secret or a TOTP code, and **none of those may pass
through a CED endpoint** — CLAUDE.md §9 forbids this platform from
transmitting or storing credentials. So the browser has to speak to Supabase
Auth itself, with the supported client.

## Why vendored rather than a CDN

The staff Content-Security-Policy is `script-src 'self'`. A CDN script would
mean widening it to a third-party origin, which would let *any* script from
that origin run on the page that handles the operator's password. Vendoring
keeps `script-src 'self'` exactly as it is; only `connect-src` is widened, and
only to the one Supabase project origin.

A supply-chain compromise of the CDN would reach the page. A compromise of the
npm package reaches this file only when somebody deliberately re-copies it,
which is a reviewable diff.

## Why the whole client rather than `@supabase/auth-js`

`@supabase/auth-js` ships no bundled build — only an ESM tree whose relative
imports carry no file extensions, which a browser cannot resolve without an
import map, and an inline import map needs `script-src 'unsafe-inline'`. That
is a worse trade than 210 KB.

The unused halves (realtime, storage, functions, postgrest) are inert: nothing
on the page calls them, and `connect-src` names only the Supabase origin over
`https:` — no `wss:`, so the realtime client could not open a socket even if
something tried.

## Updating it

1. Change the version in `package.json` and install.
2. Copy `node_modules/@supabase/supabase-js/dist/umd/supabase.js` here under
   the new version's filename.
3. Update the manifest entry in `tools/static-manifest.mjs`, this file's
   table, and the checksum.
4. Run `npm test`. `tests/staff-vendor-integrity.test.mjs` fails if the
   vendored copy and the installed package differ by a single byte, and if
   any of the five statements of the version disagree: `package.json`, the
   `package-lock.json` root declaration, the resolved lock entry, the
   filename above, and this table. The dependency must carry **no range
   operator** — a caret and a byte-identical vendored copy contradict each
   other, because a clean install could resolve a version the vendored file
   is not.

Never edit this file by hand. It is not source; it is a copy.
