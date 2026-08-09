# Deployment configuration — why `vercel.json` says what it says

Every value in [vercel.json](../vercel.json) is explained here, because
`vercel.json` itself cannot carry the explanation.

## Why this file exists instead of comments in the config

`vercel.json` is **strict JSON validated against a published schema**, and it
has no comment mechanism at all:

- JSON has no `//` or `/* */` syntax. Vercel's parser is not JSONC and rejects
  the file outright if either appears.
- The schema the file references in its own `$schema` key —
  `https://openapi.vercel.sh/vercel.json` — declares
  **`"additionalProperties": false`** at the top level. Its property list is
  `$schema`, `alias`, `build`, `builds`, `cleanUrls`, `env`, `passiveRegions`,
  `functionFailoverRegions`, `functions`, `git`, `github`, `headers`, `images`,
  `name`, `redirects`, `bulkRedirectsPath`, `regions`, `rewrites`, `routes`.

This repository previously carried its rationale in a top-level `"comments"`
object. That is **not a supported property**, and an unsupported top-level
property is the shape of Vercel's documented `Invalid vercel.json - should NOT
have additional property <name>` failure. The risk was not cosmetic: the
static-output fix is delivered *entirely* through `buildCommand` and
`outputDirectory` **in that same file**, so a configuration Vercel refuses to
parse is a configuration in which the fix does not exist. The prose moved here;
the config now contains only supported properties.

[tests/static-output-contract.test.mjs](../tests/static-output-contract.test.mjs)
asserts that every top-level key in `vercel.json` is one the schema defines, so
a future pseudo-comment fails a test rather than a deployment.

**This is a check on the configuration, not on the platform.** No `vercel build`
and no preview deployment has been run — see "What is still unvalidated" below.

---

## `functions` — `maxDuration`

The function budget must sit between the database timeout
(`CED_DB_TIMEOUT_MS`, 6s) and the browser timeout
(`assessment.config.js` → `submission.timeoutMs`, 20s). Raising
`CED_DB_TIMEOUT_MS` above this value would let the platform kill the request
before the endpoint can answer.

Both configured functions carry the same budget because they share the same
database timeout. `api/analytics.mjs` is deliberately left on platform
defaults, which is why **three** functions deploy while only **two** appear in
the `functions` block. Those two counts are different on purpose and
[tests/staff-deployment-contract.test.mjs](../tests/staff-deployment-contract.test.mjs)
pins both.

## `regions`

Pin the function to the same region as the Supabase project. A function and a
database on different continents add 100–300ms to every query **inside** the
ingestion transaction.

`iad1` is a **placeholder**: change it to match the region chosen in
[SUPABASE_SETUP.md](SUPABASE_SETUP.md).

## The staff function entry

`api/staff/identity-resolution/[...path].mjs` is a **catch-all segment**, which
is what gives the console's sub-paths (`/session`, `/cases`, `/cases/:id`,
`/cases/:id/link`) a route at all. A plain `api/<name>.mjs` serves only its own
exact path. Filesystem routing also hands the function the **original request
URL**, which a rewrite would not.

It is the **only** entrypoint. The implementation lives at
`server/staff-identity-resolution.mjs`, outside `api/`, because Vercel deploys
every file under `api/` as its own function — and a privileged route deployed
twice is a second thing to secure for no benefit.

## The header rules

The `/api/` rule covers the JSON the staff route returns. The `/staff/` rule
covers the **page**, which is a static asset and matches no `/api/` pattern. It
performs a permanent, unerasable attachment and must not be framable.
`frame-ancestors` is the modern control and `X-Frame-Options` is the one older
browsers honour; both are sent because they disagree about nothing here.

## The staff Content-Security-Policy

The policy is delivered in **two halves**, and the split is deliberate — see
"Why the header policy is narrower than it looks" below.

- The **response header** on `/staff/(.*)` carries `frame-ancestors 'none'`
  plus the directives that are identical on every staff page:
  `script-src 'self'`, `style-src 'self'`, `form-action 'none'`,
  `base-uri 'none'`, `object-src 'none'`.
- Each **page** carries a `<meta>` policy with `default-src 'none'` and its own
  `connect-src` — `'self'` for the console, and `'self'` plus the generated
  Supabase project origin for the onboarding page.

Between them: exactly what the pages actually use — same-origin scripts
(`auth.js`, `page.js`, the vendored Supabase client), one same-origin
stylesheet, and `fetch` to the same-origin staff API plus, on the onboarding
page only, one Supabase Auth origin.

There is no inline script, no inline style, no `url()` and no `@import`
anywhere in either page, so no `'unsafe-inline'`, no `'unsafe-eval'`, no
`data:` and no CDN host is needed to make them load. **A policy that has to be
widened to work is not a policy.**

- `form-action 'none'` — both forms are handled in JavaScript and never submit.
  If the scripts failed to load, the default submit would put a password in a
  navigation, and this refuses that.
- `base-uri 'none'` — both scripts fetch path-absolute URLs, which an injected
  `<base>` would re-point at another origin.
- `img-src` is **deliberately absent**. The pages load no image, so
  `default-src 'none'` covering an automatic `/favicon.ico` request is correct
  rather than something to widen for. Supabase returns a TOTP QR code as a
  `data:` image and the onboarding page deliberately does not render it: the
  setup key is shown as text instead, because widening a security header to
  save an operator from typing sixteen characters is the wrong trade.

### `connect-src` is generated, not configured here

The onboarding page (`staff/identity-resolution/accept-invite.html`) talks to
Supabase Auth directly, because a password, a session token and a TOTP secret
must never pass through a CED endpoint (CLAUDE.md §9). Its policy therefore has
to name the **exact Supabase project origin** — which differs between Preview
and Production.

**That origin is not in this file, and must never be.** It is generated at
build time by `tools/build-static.mjs` from `SUPABASE_URL`, the same variable
`GET /auth-config` reads, through the same validator
(`shared/security/supabase-origin.js`). One variable, one validator, two
consumers — so the origin the page is told to call and the origin it is
permitted to reach cannot diverge.

This replaced a literal `https://REPLACE-WITH-PROJECT-REF.supabase.co` that
had to be edited by hand after review. A deployable file with a placeholder in
it is a deployment waiting to ship the placeholder; hardcoding the development
origin instead would have been worse, because the production deployment would
then have been permitted to reach the development project's Auth server.

### Why the header policy is narrower than it looks

The `/staff/(.*)` header CSP carries **no `default-src` and no
`connect-src`**, and that is a correction rather than a relaxation.

A response-header CSP and a `<meta>` CSP are **both** enforced, and the browser
applies their **intersection**. A header saying `connect-src 'self'` would
therefore have blocked the Supabase origin the onboarding page's own generated
policy permits — and `default-src 'none'` would have done it too, being
`connect-src`'s fallback. So the two directives that differ per page live in
each page's `<meta>`, first in `<head>`, before any script or stylesheet.

The header keeps what a meta policy cannot express — `frame-ancestors 'none'`,
which is **ignored** in a meta policy — plus the directives that are identical
on every staff page. `Referrer-Policy: no-referrer` stays a header for the same
reason it always was, and is declared again on the page.

## `buildCommand` and `outputDirectory` — the static output

**Without** `buildCommand` and `outputDirectory`, the output directory is the
**repository root** on Vercel's "Other" preset, so every file outside `api/`
was a static asset: `server/staff-identity-resolution.mjs`, every migration,
every document including the operations runbook, every test, and
`.env.example`.

None of them carries a credential — `.env.example` values are blank and the
server modules read their secrets from the environment at runtime — so this was
**source and operational disclosure rather than a credential leak**. It was
still nobody's decision, which is the part that mattered.

`tools/build-static.mjs` now copies exactly the files named in
`tools/static-manifest.mjs` into `dist/`, **byte for byte**, at their existing
paths.

- It is a **positive allowlist**. "Copy everything except…" fails open, because
  the next file added to the repository is public unless somebody remembers to
  exclude it.
- Paths are **preserved rather than rewritten**, so every current URL keeps
  working with no rewrite rule and no edited reference.
- `dist/` is generated, git-ignored and disposable. The canonical sources never
  move, so there is no second copy for anyone to edit by mistake.

See [STATIC_OUTPUT_SAFETY.md](STATIC_OUTPUT_SAFETY.md) for the build script's
deletion fence, path validation and symlink rules.

## Why exactly one file from `shared/security/` is published

Exactly one — `continuation.js` — because both public pages already load it and
`engine.js` and `controller.js` call `window.CEDContinuation`.

It was **audited rather than assumed**: it holds no secret and reads no
environment variable, its `secret` and `hmacFn` are injected by
`api/assessments.mjs`, and both issue and verify fail closed without them, so
the browser copy can neither mint nor validate a trusted context.

`origin.js`, `rate-limit.js`, `read-body.js`, `staff-note.js`,
`verify-challenge.js` and `limits.js` are server-only and are asserted absent
**by name** in a test. The directory is not the boundary — the audit is.

## Why there is no `.vercelignore`

Excluding `server/` or `shared/` would break the function tracer that follows
the static ESM imports out of `api/`. Those modules must stay **traceable** and
stay **unpublished** — and they are, because the allowlist decides publication
while the tracer reads the source tree.

---

## What is still unvalidated

This file configures the deployment. Nothing here deploys anything, and no
project is connected yet.

The routing, header and output-directory behaviour asserted by
[tests/static-output-contract.test.mjs](../tests/static-output-contract.test.mjs)
and [tests/staff-deployment-contract.test.mjs](../tests/staff-deployment-contract.test.mjs)
is a model of Vercel's **documented** behaviour, not an observation of the
platform. **No `vercel build` and no preview deployment has been run.**

Specifically still unobserved:

- Whether Vercel accepts this `vercel.json` as valid.
- Whether it honours `outputDirectory`.
- Whether it still discovers filesystem functions under `api/` when a
  `buildCommand` is present on the "Other" preset. The documented behaviour is
  that files under `api/` are automatically bundled as functions, and that the
  "Other" preset's output directory defaults to `public` if present and the
  repository root otherwise — which is what made the fix necessary. That both
  hold *together* is documented, not demonstrated here.
- Whether its file tracer follows the static ESM imports out of `api/` into
  `server/` and `shared/`.

Do not describe any of these as validated on the strength of a
configuration-model test or a reading of the documentation. See
[REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md), which is the single
record of what has and has not actually executed.
