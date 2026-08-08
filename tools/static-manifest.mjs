/* ============================================================
   CED Intelligence Platform — the static output allowlist
   ------------------------------------------------------------
   THE ONE LIST THAT DECIDES WHAT A BROWSER CAN DOWNLOAD.

   WHY THIS FILE EXISTS. The deployment had no build command, no
   `public` directory and no `outputDirectory`, so on Vercel's
   "Other" preset the OUTPUT DIRECTORY WAS THE REPOSITORY ROOT.
   Everything outside api/ was therefore a static asset:
   server/staff-identity-resolution.mjs, every migration, every
   document including the operations runbook, every test, and
   .env.example. None of them contains a credential — the values
   in .env.example are blank and the server modules read their
   secrets from the environment at runtime — so this was source
   and operational disclosure rather than a credential leak. It
   was still not a decision anybody had made on purpose, which is
   the part that mattered.

   THE ARCHITECTURE IS A POSITIVE ALLOWLIST, NOT A DENYLIST.
   "Copy everything except…" fails open: the next file added to
   the repository is public unless somebody remembers to exclude
   it. This list fails closed. A new browser asset is invisible
   until it is named here, which is a broken page in review
   rather than a published document in production.

   CANONICAL SOURCES DO NOT MOVE. Every path below is the file's
   real, only home. The build COPIES it into dist/ at the same
   relative path, so every existing URL keeps working and there is
   no second copy anybody can edit by mistake. dist/ is generated,
   disposable and git-ignored; it is never an authoritative tree.

   WHY THIS LIVES IN tools/ AND NOT build/. .gitignore treats
   `build/` as build OUTPUT, alongside `dist/` and `out/`. Build
   tooling placed there is never committed, so the deployment's
   `buildCommand` would fail with MODULE_NOT_FOUND while every
   local test still passed, because the files exist locally. These
   are build INPUTS and belong in a tracked directory. A test
   asserts they are not ignored.

   WHY THE PATH IS PRESERVED RATHER THAN REWRITTEN. The pages
   reference their dependencies with relative paths — `../../../
   ../shared/assessment-engine/engine.js` from the nails page,
   `@import url("../../../../design-system/standards/tokens.css")`
   from its stylesheet. Preserving the relative layout means no
   HTML, no CSS and no rewrite rule has to change, so the build
   cannot introduce a broken reference by construction.

   ADDING SOMETHING HERE IS A SECURITY DECISION. Read the rule in
   `shared/security/` below before adding anything under it.
   ============================================================ */

/* Every entry is a repository-relative POSIX path. The file lands in the
   output at exactly this path, which is exactly its current public URL. */
export const STATIC_MANIFEST = Object.freeze([

  /* ---------- Growth Review — the nail-salon vertical ---------- */
  'verticals/beauty-wellness-fitness/nails/site/index.html',
  'verticals/beauty-wellness-fitness/nails/site/styles.css',
  'verticals/beauty-wellness-fitness/nails/assessment.config.js',

  /* ---------- Service Mix Review — the same vertical ---------- */
  'verticals/beauty-wellness-fitness/nails/service-mix/site/index.html',
  'verticals/beauty-wellness-fitness/nails/service-mix/site/styles.css',
  'verticals/beauty-wellness-fitness/nails/service-mix/site/page.js',
  'verticals/beauty-wellness-fitness/nails/service-mix/service-mix.config.js',

  /* ---------- the design system ----------
     Both vertical stylesheets @import it. It is the single token file
     CLAUDE.md section 2 names, and nothing else from design-system/ is
     fetched by a browser. */
  'design-system/standards/tokens.css',

  /* ---------- the staff console ----------
     A page, its adapter and its stylesheet. The privileged half —
     server/staff-identity-resolution.mjs — is deliberately NOT here and
     never can be: it is reached through /api, not downloaded. */
  'staff/identity-resolution/index.html',
  'staff/identity-resolution/styles.css',
  'staff/identity-resolution/auth.js',
  'staff/identity-resolution/page.js',

  /* ---------- shared: the assessment engine ---------- */
  'shared/assessment-engine/engine.js',
  'shared/assessment-engine/intelligence.js',
  'shared/assessment-engine/submission.js',

  /* ---------- shared: business intelligence ----------
     Both are loaded by the Growth page to render the report in the browser.
     `generate-bir.js` is ALSO imported by api/assessments.mjs; the canonical
     file stays in shared/ and both consumers read the same one. Its
     neighbours — review-registry.js and the business-record schemas — are
     server-side only and are absent, even though they share a directory. */
  'shared/business-intelligence/report.schema.js',
  'shared/business-intelligence/generate-bir.js',

  /* ---------- shared: analytics ----------
     Observational only, and forbidden from affecting the assessment —
     CLAUDE.md section 11. `funnel.js` is the REPORTING half and runs
     server-side; it is deliberately not here. */
  'shared/analytics/events.js',
  'shared/analytics/analytics-client.js',

  /* ---------- shared: the Service Mix engine ----------
     `generate-service-mix-bir.js` is absent on purpose: the browser renders
     through controller.js and never generates a BIR itself. */
  'shared/service-mix-engine/value.schema.js',
  'shared/service-mix-engine/offering.schema.js',
  'shared/service-mix-engine/calculate.js',
  'shared/service-mix-engine/classify.js',
  'shared/service-mix-engine/guidance.js',
  'shared/service-mix-engine/controller.js',

  /* ---------- shared: page furniture ---------- */
  'shared/scripts/site-nav.js',

  /* ---------- shared/security — READ THIS BEFORE ADDING ONE ----------

     EXACTLY ONE FILE FROM THIS DIRECTORY IS PUBLIC, and it is public
     because of what it CONTAINS, not because of where it lives.

     continuation.js is already an intentional browser dependency: both
     vertical pages load it, and engine.js and controller.js call
     window.CEDContinuation to store, read and clear the opaque continuation
     token. Removing it would break both public reviews.

     It is safe to serve, and that was audited rather than assumed:

       · it contains no secret value and reads no environment variable —
         `secret` and `hmacFn` are INJECTED PARAMETERS, supplied only by
         api/assessments.mjs from CED_CONTINUATION_SECRET;
       · issueContinuationContext returns null without both, and
         verifyContinuationContext returns `not_configured` — never `valid`.
         Both fail closed, so the browser copy cannot mint or validate a
         trusted context;
       · a token forged in the browser with an attacker's own secret fails
         the server's signature check, because the server signs with the one
         it holds;
       · the browser half is storage, echo and sanitisation only, and it
         refuses to store anything shaped like a Business Record id;
       · there is no build-time substitution anywhere in this repository —
         the build below copies bytes and never rewrites them — so no secret
         can be inlined into the published copy;
       · the module holds no mutable state, and its storage helpers no-op
         when localStorage is undefined, so importing the same canonical
         file on the server cannot be influenced by browser state.

     Readable source is not a credential. Every other file in this directory
     is server-only and MUST NOT be added: origin.js, rate-limit.js,
     read-body.js, staff-note.js, verify-challenge.js and limits.js are
     enforcement code that no page loads. A test asserts this directory's
     output contents are exactly the one line below. */
  'shared/security/continuation.js'
]);

/* Paths that must never appear in the output, asserted directly by the
   contract test rather than merely absent by construction. A denylist is not
   what keeps them out — the allowlist above is — but naming them makes the
   guarantee legible and makes a regression say what broke. */
export const FORBIDDEN_OUTPUT_PREFIXES = Object.freeze([
  'api/', 'server/', 'supabase/', 'docs/', 'tests/', 'tools/', 'dist/',
  '.git/', 'node_modules/', 'ai/', 'automations/', 'deployment/',
  'marketing/', 'playbooks/'
]);

export const FORBIDDEN_OUTPUT_FILES = Object.freeze([
  '.env', '.env.example', '.env.local', '.env.production',
  'CLAUDE.md', 'README.md', 'SETUP-ON-MAC.md', 'install-on-mac.sh',
  'package.json', 'package-lock.json', 'vercel.json',
  '.gitignore', '.gitattributes'
]);

/* The complete, exact set permitted under shared/security/ in the output.
   Anything else appearing there is a defect, whatever its name. */
export const PUBLIC_SECURITY_MODULES = Object.freeze([
  'shared/security/continuation.js'
]);

/* Named so their absence is proven by name rather than inferred. */
export const SERVER_ONLY_SECURITY_MODULES = Object.freeze([
  'shared/security/origin.js',
  'shared/security/rate-limit.js',
  'shared/security/read-body.js',
  'shared/security/staff-note.js',
  'shared/security/verify-challenge.js',
  'shared/security/limits.js'
]);

/* The generated directory. Named here so the build and the tests cannot
   disagree about what may be deleted. */
export const OUTPUT_DIR = 'dist';
