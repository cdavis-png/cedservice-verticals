# Real-Postgres validation

The record of the migrations being executed against an actual Supabase
Postgres, and the checklist for repeating it.

**Status: executed and passed.** Blocker B7 — "the SQL has never run" — is
closed. Everything below was observed, not predicted.

> **Correction, 2026-08-09 — read [run 14](#run-14--0006-and-0007-are-already-on-the-hosted-project) first.**
> Migrations **0006 and 0007 are present on the hosted development project**
> `qkpptajglstgucadhfwq` (PostgreSQL 17.6.1.155). Every statement below that
> says either has "never been applied to a hosted database", "never run on
> PostgreSQL 17", or that nothing here has "ever run through PostgREST" was
> written in good faith and is **false**. Those passages are left in place as
> the record of what each run observed at the time, each marked with a
> pointer here; run 14 is the current state.
>
> What run 14 did **not** establish is as important: the deployed definitions
> have not been compared against this repository, the migration-history rows
> have not been read, and the application time and method are unknown. Do not
> read "present" as "matches what is committed".
>
> **Run 15 closes most of that.** The history rows are read (0001–0007
> recorded, 0008 not), the supersession function is compared (it matches), and
> all three of 0008's findings are confirmed against the real database. What
> is still open: nothing has been *executed* there, and only the one function
> has been diffed.
>
> **Run 16 then applied 0008** through the tracked `apply_migration` operation
> — ledger version `20260809173146` — and verified it: the trigger now covers
> UPDATE, no internal function is reachable by `service_role`, both helpers are
> pinned, the two security-advisor warnings are gone, all data is intact, and
> the rule was exercised behaviourally inside a rolled-back transaction. Runs
> 14 and 15 are the before; run 16 was the current state until run 17.
>
> **Run 17 is the current state, and it is not a validation run.** Two further
> migrations — `0009_bi_sales_handoff_foundation` (`20260814182709`) and
> `0010_sales_handoff_fk_indexes` (`20260814182839`) — were found already
> applied to `qkpptajglstgucadhfwq` with **no repository files**. They were
> reconciled *out of* the database rather than applied *into* it.
>
> **Run 18 is the current state.** 0011 was committed and reviewed first and
> then applied, at ledger version `20260815025341` — the order runs 14 to 17
> kept discovering had not been followed. **The hosted ledger records through
> 0011**, plus one older unreconciled entry,
> `20260806171939 create_aeo_answer_visibility_module`, which still has no
> file.

## Runs

| | Run 1 — Milestone 1.1 | Run 2 — migration 0004 |
|---|---|---|
| Date | 2026-08-04 | 2026-08-05 |
| Project | `ced-cip-dev` | `ced-cip-dev` (same) |
| Region | us-west-1 | us-west-1 |
| Postgres | 17.6 | **17.6.1.155** |
| Migrations | 0001 → 0002 → 0003 | 0004, after 0001–0003 |
| Method | Supabase management API; SQL executed directly | same |
| Result | 35 checks passed, 19 violations correctly refused, **2 defects found and fixed** | 31 checks passed, 4 forced rollbacks all clean, **1 defect found and fixed, 1 limitation recorded** |

No production system was touched. No credentials were created, printed, or
stored. The nail-salon page, pricing, scoring, and the assessment itself were
not modified in either run.

### Run 4 — migration 0006, against a disposable local PostgreSQL

| | Run 4 |
|---|---|
| Date | 2026-08-05 |
| Target | **A disposable PostgreSQL created inside the test process.** No host, no port, no socket, no credential. |
| Engine | PGlite 0.5.4 — the PostgreSQL server source compiled to WebAssembly |
| Postgres | **18.3** (the hosted development project is 17.6.1.155) |
| Migrations | 0001 → 0002 → 0003 → 0004 → 0005 → 0006, applied as a chain |
| Method | SQL directly, through an adapter presenting the supabase-js surface the suite uses |
| Result | **59/59 integration tests pass**, **17/17 migration-chain tests pass**, **1 defect found in 0006 and fixed**, 2 defects found in the suite itself and fixed |

No hosted database was touched. Nothing was created, reset, or connected to
remotely. The cluster's data directory is removed when the run ends.

**Why local rather than hosted.** Neither Docker, Podman, WSL, the Supabase
CLI, nor a local PostgreSQL server was installed on the machine, and touching
a hosted project was out of bounds. PGlite is real PostgreSQL and needs none
of them.

**Why this run mattered more than 0004's.** 0006 turns `ingest_assessment()`
into a thin wrapper over a new generic `ingest_review()`, which meant
transcribing the 0003 body. Migration 0004 declined to do exactly this, on the
grounds that a transcription error in the parts that did *not* change is
likelier than a bug in the change itself. That reasoning still holds; it was
overridden only because the alternative was two copies of the
identity-resolution rules, which CLAUDE.md section 3 treats as the defect.
Section O is the compensating control, and it has now run.

### Defect 6 — the analytics envelope version was never widened

**Found by the first execution of 0006.** SM-1 added `reviewType` to the
analytics event envelope and bumped
`shared/analytics/events.js :: ANALYTICS_SCHEMA_VERSION` to 2. The endpoint
accepts `[1, 2]`. Migration 0005 pinned the column to
`check (schema_version between 1 and 1)`, and 0006 never widened it.

```
new row for relation "assessment_analytics_events"
violates check constraint "analytics_events_schema_version_check"
```

Every analytics event a post-SM-1 page emitted would have been refused by the
database — and because ingestion is one transaction per batch, **the whole
batch with it**. The browser would have retried, been refused again, and
eventually dropped the events. Nothing in the unit suite could see it: the
in-memory double does not model that constraint, and the endpoint's own
validation happily accepts version 2.

Fixed in 0006 by widening the constraint to `between 1 and 2`, with version 1
still valid because a page cached before the deploy still emits it. Pinned by
`tests/migration/0006-upgrade.test.mjs`, which ingests a version-2 event
immediately after the upgrade.

### Two defects in the integration suite itself

The suite had **never been run end to end** before this. Two of its own tests
were wrong, and would have failed against a hosted database just as they did
here:

- **M5 and the section E clock-skew test shared the idempotency key
  `it-<RUN>-skew` with different request hashes.** Whichever ran second was
  correctly refused with `idempotency_key_conflict`. The key was the bug; the
  behaviour was right.
- **N10 asserted "one session is one page view" against an aggregate row the
  whole of section N shares.** Every analytics test in the suite writes under
  one campaign source, so they all land on one row and the count was 5. The
  assertion was right and needed a group of its own to be about.

### Run 5 — the audit repair pass

| | Run 5 |
|---|---|
| Date | 2026-08-05 |
| Target | A disposable PostgreSQL created inside the test process, as run 4 |
| Postgres | 18.3 (PGlite 0.5.4) |
| Result | **60/60 integration**, **35/35 migration** (clean install 7, rerun/RLS 7, **RPC roles 11**, upgrade 10, **concurrency 7**) |

Added by this pass:

- **`tests/migration/0006-rpc-roles.test.mjs`** — every check runs after
  `SET ROLE`, not as the database owner. Previous runs proved only that the
  owner could call everything, which is true of any function and says nothing
  about either role.
- **`tests/migration/0006-concurrency.test.mjs`** — the advisory lock that
  stops two concurrent first submissions creating two supersession roots.

### Defect 7 — server RPC execute was never granted, only revoked

Every migration through 0005 revoked `EXECUTE` from `public`, `anon` and
`authenticated`, and then relied on `service_role` *happening* to have it
through a Supabase project's default privileges. Nothing in the schema said
so. A project created differently, or one whose default privileges were later
tightened, would leave the Vercel Function unable to call its own ingestion
function — and no test could have caught it, because every test ran as the
owner.

0006 now grants `EXECUTE` explicitly to `service_role` on all eleven server
RPCs, after revoking from `PUBLIC` (order matters: PostgreSQL grants EXECUTE
to PUBLIC on every new function, and revoking after granting takes it from
nobody useful). Trigger and helper functions are granted to nobody.

### PostgREST — still not executed

Local mode speaks SQL directly. A local PostgREST run was attempted and is
**not achievable here**: PostgREST is a Haskell binary distributed through
GitHub releases rather than npm — the `postgrest` npm package is an unrelated
JavaScript library with no executable — and supabase-js speaks PostgREST's
HTTP API rather than the PostgreSQL wire protocol, so bridging PGlite to a TCP
socket would not help without also fetching and running that binary.

What that leaves unproven, precisely:

- resolution of `ingest_review`'s ten-argument signature **by argument name
  over HTTP**. Locally the signature is proven unique and correctly granted,
  and the adapter binds by name; PostgREST's own resolution is not exercised.
- JSON serialisation of a full payload across the wire.
- that the `service_role` key actually reaches the function as `service_role`.

**Successful PostgREST execution remains a deployment blocker.** Section O is
written and will exercise it on the first run with credentials.

### Concurrency — proven structurally, not by racing

PGlite is a single connection, so two transactions cannot interleave. The
concurrency tests prove the advisory lock exists, is transaction-scoped, is
keyed on `(business, review type)`, is taken **before** the review state is
read, and that the serialised outcome is a single supersession root.
Reproducing the race itself needs two simultaneous connections to a server
Postgres and remains outstanding.

### What run 4 did not validate

- **PostgREST.** Local mode speaks SQL directly. Argument binding, function
  overload resolution over HTTP, and JSON serialisation of a full payload
  remain the hosted path's to prove. `ingest_review`'s ten-argument signature
  resolves correctly *as SQL*; that it resolves through PostgREST does not
  follow from this run.
- **PostgreSQL 17.6.** This ran on 18.3. A behaviour that differs between the
  two majors would not be caught.
- **pgcrypto.** Unavailable in PGlite; 0001's `create extension` was tolerated.
  Nothing in the chain uses a function only pgcrypto provides, and
  `assertNoPgcryptoDependency()` checks that rather than assuming it.
- **Concurrency and scale.** Unchanged from previous runs: neither was
  exercised.

**Migration 0006 is validated as SQL and as a migration. It has still never
been applied to a hosted database, and the hosted run remains outstanding.**

> **Superseded by run 14.** The second sentence is false: 0006 **is** present
> on the hosted development project. What run 4 validated is unchanged — this
> was a local run and it proved what it says it proved. What is wrong is only
> its statement about the hosted database. The deployed definition has still
> not been compared against this repository.

---

## Run 6 — migration 0007, staff identity resolution, against a disposable local PostgreSQL

| | |
|---|---|
| Date | 2026-08-07 |
| Target | Disposable PostgreSQL created inside the test process (PGlite) |
| Version | **PostgreSQL 18.3** |
| Transport | **SQL, directly. Not PostgREST.** |
| Migrations | 0001 → 0002 → 0003 → 0004 → 0005 → 0006 → **0007**, applied as a chain |
| Command | `CED_ALLOW_INTEGRATION_TESTS=true CED_LOCAL_PG=true npm run test:integration:local` |
| Result | **integration suite passes with sections U, V, W and X added; migration-chain suite passes** |

Sections added by 0007, named accurately:

| Section | What it covers |
|---|---|
| **U** | The operator guard, the queue and case reads, the authoritative mutation, locking, idempotency, rollback, masking, and the `anon` / `authenticated` posture |
| **V** | Proposal-vetoed and disagreeing targets, the durable operator reference, case-evidence immutability, the post-write rollback, the post-lock ledger recheck, operator-bound replay, and a resolved case reporting itself unresolvable |
| **W** | `bootstrap_staff_owner` — empty-table only, idempotent for the identical sole operator, refusing every competing caller, and reachable by the server role alone |
| **X** | `redact_business_pii` clearing the resolution note 0003 never knew about, and touching nothing else |

### What run 6 did validate

Executed, as real SQL, against a real PostgreSQL planner, constraint machinery
and trigger machinery:

- **The chain applies with 0007 in it**, on a clean database and as an upgrade
  over populated pre-0006 data, and **re-applying it is a no-op** — the schema
  snapshot before and after a rerun is byte-identical.
- **Sixteen tables**, every one with RLS enabled AND forced and zero policies.
- `staff_operator_guard` refusing every case except an active, AAL2,
  provisioned operator — including an **absent** AAL claim, which is refused
  rather than treated as satisfied.
- **Revocation taking effect on the next call**, with no token involved.
- The **eligible-target derivation** in SQL, including twelve malformed
  evidence shapes of which exactly one well-formed entry survives.
- The **authoritative mutation**: five rows locked, every one rechecked,
  merged-away and non-canonical targets refused, the conflict rule re-run
  against the current target, and the override vocabulary enforced.
- **Rollback**, including a genuine **post-write** failure injected by a
  test-local trigger on `identity_resolution_requests` — submission, report,
  review state, both pointers, case resolution, the operator reference and
  every event roll back together.
- **Idempotency**, including the ledger recheck after the case lock and the
  refusal of a second operator reusing another operator's request id.
- **`bootstrap_staff_owner`** — empty-table-only, idempotent for the identical
  sole operator, refusing every competing caller.
- **Redaction of resolution notes** by the amended `redact_business_pii`.
- **Grants as catalog facts**: `anon`, `authenticated` and `PUBLIC` hold
  nothing on either new table or on any new function; internal helpers hold no
  `service_role` grant either.

### What run 6 did NOT validate

Stated plainly, because every one of these is still owed:

- **PostgreSQL 17.** This ran on **18.3**. The hosted development project runs
  **17.6.1.155**. A behaviour that differs between the two majors would not be
  caught here, and 0007 has never run on 17.
  *(Superseded by run 14: 0007 is present on the hosted 17.6.1.155 project, so
  it has run on 17. This run still did not observe that, and the deployed
  definition is still uncompared.)*
- **Hosted Supabase.** 0007 has **never been applied to any hosted database**.
  *(**False** — superseded by run 14. 0007 is present on
  `qkpptajglstgucadhfwq`. When and how it was applied is unknown.)*
- **PostgREST.** Local mode speaks SQL directly. The staff route calls five
  functions over `db.rpc(...)` — `staff_operator_guard`,
  `staff_identity_queue`, `staff_identity_case`,
  `resolve_identity_case_link_existing`, `check_rate_limit` — and **none of
  them has ever been resolved through PostgREST**. Nothing in this repository
  ever has.
  *(Partly superseded by run 14. PostgREST has now RESOLVED these objects —
  that is what the existence-versus-permission probes did. None has been
  successfully **called** through it, which is what this bullet was really
  about, and that part still stands.)*
- **The two direct table reads.** The route reads
  `identity_resolution_cases` and `assessment_submissions` through PostgREST
  with the elevated key. Local mode reaches them as the database owner
  instead, so the `service_role` grants those reads depend on have not been
  exercised as `service_role`.
- **True multi-connection concurrency.** PGlite is a single connection, so no
  two transactions can interleave. What is proven is the *mechanism* that
  decides a race — `irr_one_per_case` is a unique index, the case row is taken
  `for update`, and the ledger is rechecked after the lock is granted.
  **The race itself has never been run.** Two simultaneous resolutions of one
  case, and two simultaneous sends of one retry, both remain outstanding and
  both need a server Postgres with two connections.
- **`auth.users`.** Absent from PGlite, so the `staff_operators` foreign key
  and `bootstrap_staff_owner`'s confirmed-email check are both **skipped**,
  not passed. Neither has ever executed.
- **Supabase Auth itself.** Everything the console does with it —
  `signInWithPassword`, `mfa.listFactors`, `mfa.challengeAndVerify`,
  `refreshSession`, `signOut`, and `getUser` on every subsequent request — is
  covered against a **stubbed client** on the server side
  (`tests/staff-auth-session.test.mjs`) and a **stubbed network** in the
  browser (`tests/browser/staff-console-browser.test.mjs`). **No real access
  token has ever been verified, no real TOTP factor has ever been enrolled or
  challenged, and no real session has ever been refreshed or revoked.**

  What the suite *does* now establish, and did not before: the production
  factory is exercised as itself, so `persistSession: false`,
  `autoRefreshToken: false` and `detectSessionInUrl: false` are read off a real
  `@supabase/supabase-js` client, a fresh one per call, with no module-level
  Auth state; the stub's method names are pinned against that real client's
  surface, so a rename in a future Supabase version fails here rather than in
  production; and the stub returns the shapes the installed version actually
  returns — `challengeAndVerify` carries no `expires_at`, which is why the
  route's `exp`-claim fallback is the covered path rather than a dead branch.
  Method *names* and *response shapes* are therefore pinned to version
  2.112.0. Their *semantics over the wire* are not, and cannot be without a
  real project.
- **The Vercel platform.** The route's deployment contract — filesystem
  routing for `api/staff/identity-resolution/[...path].mjs`, the header rules,
  the runtime, and the fact that exactly one function now deploys rather than
  two — is asserted by `tests/staff-deployment-contract.test.mjs` against a
  model of Vercel's documented routing. **No local `vercel build` has been
  run**, because the CLI is not a dependency of this repository and
  installing one was out of bounds. A platform build has since run and failed
  closed before reaching routing; see run 13. The model is a check on the configuration, not on the
  platform. In particular, that the file tracer bundles `server/` alongside
  `api/` is expected — the imports are static, which is what
  `api/assessments.mjs` and `api/analytics.mjs` already rely on — but it has
  not been observed.
- **Whether `server/` is ALSO served as a static asset.** The repository has no
  `.vercelignore`, no `outputDirectory` and no build command, so on the
  "Other" preset the root is served statically and
  `/server/staff-identity-resolution.mjs` would be downloadable. Everything
  else outside `api/` is already in that position — `shared/`, `tests/`,
  `docs/`, and `supabase/migrations/*.sql` — and none of them, including this
  one, contains a credential: the staff route names environment variables and
  reads them at runtime.

  **Superseded by run 8**, which replaced the root-as-output arrangement with
  an explicit `outputDirectory` built from an allowlist. What that run does
  *not* do is observe the platform honouring it; that is still owed. The
  obvious fix was and remains wrong: adding `server/` to a `.vercelignore`
  would very likely exclude it from the function's trace as well and take the
  console down with a `MODULE_NOT_FOUND` no local test could see.

**Migration 0007 is validated as SQL and as a migration, on PostgreSQL 18.3,
over a direct SQL connection. It has never been applied to a hosted database,
never run on PostgreSQL 17, never been reached through PostgREST, and never
been raced. All four remain deployment blockers.**

> **Superseded by run 14 on three of the four.** 0007 **is** present on the
> hosted development project, which runs PostgreSQL 17.6.1.155, and PostgREST
> has resolved its objects. It has still **never been raced**, no staff
> function has been successfully called through PostgREST, and the deployed
> definitions have not been compared against this repository. What run 6
> itself validated is unaffected.

---

## Run 7 — real browser request headers, against the real route

| | Run 7 |
|---|---|
| Date | 2026-08-08 |
| Target | The production entrypoint `api/staff/identity-resolution/[...path].mjs`, over a real TCP socket |
| Browser | Headless Chrome, driven by the already-installed `puppeteer-core` |
| Method | The real console page (`index.html`, `auth.js`, `page.js`), signed in through the real form. **`window.fetch` is NOT replaced.** |
| Stubbed | Supabase Auth and the database only, through `handleRequest`'s existing dependency seam |
| Result | **A release blocker found and fixed**; 5/5 checks pass |
| Test | `tests/browser/staff-origin-headers.test.mjs` |

### The defect it found

The route required an exact `Origin` header on **every** request, GET included.
That is not a rule a browser can satisfy. Per the Fetch standard an `Origin`
header is appended when a request's response tainting is `cors` **or** the
method is neither `GET` nor `HEAD`; a same-origin `fetch` keeps tainting
`basic`, so a same-origin `GET` carries none. An `Authorization` header does
not change it, because that forces a preflight only on a cross-origin request.

The console therefore signed in successfully — `POST` does carry `Origin` — and
then **every queue listing and every case read was refused `403
origin_required`**. The queue was unreachable in every standards-compliant
browser, and the subsystem was unusable.

Every suite passed throughout, because none of them made a real request: the
synthetic helpers attached an `Origin` by hand, and
`tests/browser/staff-console-browser.test.mjs` replaces `window.fetch`, so its
requests never reach a socket and never acquire browser-generated headers.

### What run 7 DID validate — observed, not asserted

| Request | `Origin` | `Sec-Fetch-Site` | Route |
|---|---|---|---|
| Same-origin `GET …/cases` | **absent** | `same-origin` | 200 |
| Same-origin `GET …/cases/:id` | **absent** | `same-origin` | 200 |
| Same-origin `GET` with no `Authorization` | **absent** | `same-origin` | — |
| Same-origin `POST …/session` | present, exact | `same-origin` | not refused |
| Same-origin `POST …/cases/:id/link` | present, exact | `same-origin` | not refused |
| Cross-site `GET …/cases` | attacker's origin | `cross-site` | **403**, and no bucket, Auth client or privileged read |

The cross-site refusal is observed to spend nothing: `dbCalls` is empty, no
Supabase Auth client was built, and no token was verified. That is the property
the original always-require-`Origin` rule existed to protect, and it is intact.

### What run 7 did NOT validate — continued below at run 8

- **Only Chromium was driven.** Firefox and Safari were not. The behaviour
  relied on is specified in the Fetch standard rather than Chrome-specific, and
  `Sec-Fetch-Site` is supported in Firefox and in Safari 16.4+, but neither was
  observed here.
- **It ran over plain http against loopback**, using the
  `CED_ALLOW_INSECURE_STAFF` switch that exists for exactly that purpose. TLS
  changes nothing about which headers are appended, but it was not exercised.
- **Supabase Auth and the database were stubbed.** Run 7 is about headers, not
  about Auth; see the Supabase Auth boundary above, which is unchanged.
- **This is not a `vercel build`.** The request reached the production
  entrypoint through a local server, not through Vercel's router.

---

## Run 8 — the static output boundary

| | Run 8 |
|---|---|
| Date | 2026-08-08 |
| Target | The deployment's static surface — what a browser may download |
| Method | A zero-dependency Node build from an explicit allowlist, plus a contract test that walks the generated tree |
| Result | 27 files published, everything else withheld; 38/38 checks pass |
| Files | `tools/static-manifest.mjs`, `tools/build-static.mjs`, `tests/static-output-contract.test.mjs` |

### What was wrong

With no `buildCommand`, no `outputDirectory` and no `public/` directory, the
output directory on Vercel's "Other" preset is the **repository root**. Every
file outside `api/` was a static asset: `server/staff-identity-resolution.mjs`,
all seven migrations, every document including the staff operations runbook,
every test, and `.env.example`.

**No credential was exposed.** `.env.example` carries variable names with blank
values; the server modules read their secrets from the environment at runtime.
This was source and operational disclosure, not a credential leak, and it
should not be recorded as one. What made it worth fixing is that nothing had
decided it — the root was published by omission.

### What run 8 established

- `vercel.json` now sets `"buildCommand": "node tools/build-static.mjs"` and
  `"outputDirectory": "dist"`. The output directory is asserted not to be `.`,
  empty, or the repository root.
- The build copies **only** the 27 files named in the manifest, **byte for
  byte**, at their existing relative paths — so every current URL still
  resolves with no rewrite rule and no edited reference.
- It is **deterministic**: two consecutive builds produce an identical
  inventory and identical SHA-256 content hashes.
- It **starts from empty**, so a file removed from the manifest leaves the
  site; a stray file planted in the output does not survive a rebuild.
- Because there is no transform step, **no secret can be injected at build
  time**. Asserted anyway: no output file assigns a known secret variable,
  contains an `sb_secret_` key, or contains a JWT-shaped literal.
- `shared/security/` in the output contains **exactly**
  `shared/security/continuation.js`. `origin.js`, `rate-limit.js`,
  `read-body.js`, `staff-note.js`, `verify-challenge.js` and `limits.js` are
  asserted absent by name.
- `continuation.js` was **audited before being published**, and the audit is
  executed rather than read: the generated copy is imported and called with
  what a browser has — no secret, no HMAC function — and
  `issueContinuationContext` returns `null` while `verifyContinuationContext`
  returns `not_configured`. It can neither mint nor validate a trusted context.
- `api/` holds exactly three deployable functions, one of them the staff
  catch-all; none is inside the static output; no `.mjs` file of any kind is
  published; there is no `.vercelignore`; and every static ESM import in the
  entrypoint and the implementation still points at a file that exists.

### What run 8 did NOT validate

- **No local `vercel build`.** The Vercel CLI is not a dependency of this
  repository and installing or authenticating one was out of bounds.
  Everything above is a check on the *configuration and the generated tree*,
  not on the platform. **A platform build has since run — see run 13**, and
  it confirms only that Vercel executes the configured `buildCommand`.
- **Whether Vercel honours `outputDirectory`** as documented.
- **Whether `api/` functions are still discovered** when a `buildCommand` is
  present. This is documented behaviour for the "Other" preset; it has not been
  observed here.
- **Whether the file tracer still follows** `api/` → `server/` → `shared/`.
  The imports are static, which is what `api/assessments.mjs` already relies
  on, but no trace has been produced.
- **Whether the header rules match the generated paths on the platform.** They
  are modelled from `vercel.json` exactly as the deployment-contract test
  models routing.

**Until a real preview deployment exists, the static boundary is configured and
tested but not observed.** Do not describe it as verified on the strength of
this run.

---

## Run 14 — 0006 and 0007 are already on the hosted project

**This run corrects a factual error that had propagated through eight
documents.** Every statement in this repository of the form "0006 and 0007
have never been applied to a hosted database" was **false**, and had been for
some time before it was noticed.

| | Run 14 |
|---|---|
| Date | 2026-08-09 |
| Project | `qkpptajglstgucadhfwq` — the persistent hosted **development** project |
| Postgres | 17.6.1.155 |
| Transport | **PostgREST**, read-only |
| Method | Existence-versus-permission probes: ask for an object and distinguish "permission denied" from "not found" |
| Result | **0006 and 0007 are present.** No migration was applied, and nothing was written. |

### What run 14 establishes

- **Migrations 0006 and 0007 are present in the hosted development project.**
  The objects they create resolve through PostgREST and answer *permission
  denied* rather than *not found*, which "not applied" cannot produce.
- **They have therefore run on PostgreSQL 17**, on hosted Supabase. Two of the
  four blockers run 6 closed its section with are not blockers; they were
  already cleared, unrecorded.
- **PostgREST has resolved these objects.** "Nothing in this repository has
  ever run through PostgREST" is no longer true as written.

### What run 14 does NOT establish — and this is the more important half

Presence is not equivalence. A probe that distinguishes *denied* from *absent*
learns that a name exists. It learns nothing about what is behind the name.

- **The deployed definitions are unverified.** Whether the hosted
  `ingest_review`, `enforce_bir_supersession_scope`, `staff_operator_guard` or
  any other object is byte-for-byte what this repository holds is **unknown**.
  An earlier draft, a hand-edit in the SQL editor, or a partially applied file
  would all probe identically.
- **The migration-history records are unverified.** Whether
  `supabase_migrations.schema_migrations` contains rows for 0006 and 0007 —
  and therefore whether `supabase db push` would consider them applied — is
  unknown.
- **When and how they were applied is unknown.** No date, no method, no actor.
- **Execution is still unproven.** The probes were permission refusals. No
  staff function has been *called* through PostgREST, no ingestion has run
  there, and the two direct table reads the route depends on have still never
  been exercised as `service_role`.
- **Nothing else changed.** Real Supabase Auth, real TOTP, real invitations,
  true multi-connection concurrency and the Vercel platform gaps are all
  exactly where runs 6 and 13 left them.

### What this changes about how the next migration is written

Migration **0008** exists because of three defects found in the audit that
followed this discovery (see below), and it is written for a database whose
current definitions cannot be assumed:

- It is **forward-only**. 0006 and 0007 are not edited. A hosted migration is
  history, and history is not rewritten to fix a defect found after it ran.
- It prefers the **narrowest instrument**: `alter function … set search_path`
  and `revoke` change a setting and an ACL without touching a body. Only F3
  requires `create or replace`, and that statement overwrites whatever is
  deployed — which is why comparing the deployed definition first is a
  **required** step in the procedure, not a nicety.
- It is **idempotent**, so applying it to a database whose state is partly
  unknown cannot make things worse on a second attempt.

### The three defects 0008 repairs

| | Defect | Instrument |
|---|---|---|
| **F3** | `bir_supersession_scope` fires on INSERT only, so the invariant 0006 states as absolute is not enforced against any UPDATE | `create or replace` + recreate the trigger for `insert or update` |
| **F6** | 0006's internal functions are revoked from `public, anon, authenticated` but **not** `service_role`, which a Supabase project grants directly through default privileges | `revoke … from … service_role` |
| **F7** | `identity_value_acceptable` and `identity_evidence_fault` are the only two functions in the chain with no pinned `search_path` | `alter function … set search_path` |

F3 is **defence in depth, not a live escape** — stated that way deliberately.
The one UPDATE in the chain that touches a field the rule reads
(`resolve_identity_case_link_existing`) cannot currently violate it, because a
queued report has a null supersession chain. Nothing enforces that coincidence
and nothing tested it.

A fourth defect, **F8**, was application code and needed no migration: the
staff route's `requestHash` omitted the resolution note, so a second call on
one request id with a rewritten justification replayed the first outcome and
discarded the new note. Repaired in `server/staff-identity-resolution.mjs`.

### Deferred findings — recorded, deliberately not repaired

Two audit findings are carried forward rather than fixed. Both are recorded
here so that "not fixed" is a decision with a reason attached rather than an
omission somebody rediscovers.

- **`ingest_review` rule B4v is a dead branch.** 0006 lines 1204–1205 test
  `v_proposal_vetoed or v_proposals_disagree` inside an `else` reachable only
  when both are false, so B4v can never fire. The OUTCOME is unaffected — the
  earlier branch already queues for review — but a vetoed submission skips
  candidate discovery entirely, so its `identity_resolution_cases` row carries
  an empty `candidate_business_ids` even where identifier candidates exist.

  **Not a blocker for the staff resolution path**, and this is the reason it
  can wait: 0007 derives the operator's eligible targets from the case's
  persisted proposal evidence through
  `identity_case_eligible_targets`, not from `candidate_business_ids`. An
  operator working a proposal-vetoed case still sees targets. Repairing B4v is
  a change to what a queued case RECORDS, which is worth doing on its own
  terms and worth keeping out of a migration-hardening pass.

- **Unacceptable identity values are handled two ways.**
  `identity_proposal_conflict` REFUSES a value failing
  `identity_value_acceptable`; the candidate-matching CTE and the
  signal-writing loop silently FILTER one. Both directions are safe here —
  filtering a value out of candidate matching cannot cause a wrong link, it
  can only fail to find a right one — but the same input produces a refusal on
  one path and a shrug on another, and that inconsistency is the kind that
  gets resolved in the wrong direction later.

Neither was touched by 0008, by the source reconciliation that followed it, or
by its application in run 16. **Both remain deferred**, on the same reasoning.

### Verification

`tests/migration/0008-migration-hardening.test.mjs` applies the chain to 0007,
**observes all three defects present**, applies 0008, and asks the same
questions again. F6 needs a deliberate extra step to be honest: the local
fixture creates `anon`, `authenticated` and `service_role` without the default
privileges a real Supabase project carries, so the pre-existing assertion in
`tests/migration/0006-rpc-roles.test.mjs` that "service_role cannot execute
these" was passing **against an absence**. The new test grants the privilege
explicitly first, so the revoke has something real to remove.

**0008 has since been applied and verified — see
[run 16](#run-16--0008-applied-and-verified-on-the-hosted-project).** The
sentence that stood here, "0008 has not been applied anywhere", was true when
run 14 was written and is not now.

---

## Run 18 — 0011 applied, in the right order

**The first migration in this repository to go committed-first, then applied.**
0008 was applied from an approved blob but its file had existed for some time;
0009 and 0010 were applied before they were files at all. This one was written,
tested against the whole chain locally, committed to a reviewed branch, and
only then applied.

| | Run 18 |
|---|---|
| Date | 2026-08-15 |
| Project | `qkpptajglstgucadhfwq` (`ced-cip-dev`) |
| Postgres | 17.6.1.155 |
| Method | tracked Supabase MCP `apply_migration`, with authorization immediately beforehand |
| Migration | `0011_promotion_business_serialization` |
| Ledger version | `20260815025341` |
| Source blob | `e5cfad4053bf034e60dc55a50357d03679d1641e` (sha256 `067397e5…f86631`) |
| Result | applied and recorded; every post-application check passed |

**What it repaired.** Two defects in 0009, forward-only, without editing it:

| Defect | Before | After |
|---|---|---|
| Concurrency keyed per *handoff*, not per *business* | two handoffs of one business could race the GHL contact create | `business_id` column, guard trigger and partial unique index present |
| RLS enabled but **not FORCED** on all four sales tables | `relforcerowsecurity = false` | `true` on all four |

**Post-application verification, read directly:**

| Check | Result |
|---|---|
| Ledger | `20260815025341 — 0011_promotion_business_serialization` |
| `sales_promotion_requests.business_id` | `uuid NOT NULL` |
| `sales_promotion_requests_one_business_processing_uidx` | present |
| `sales_promotion_requests_business_idx` | present |
| `sales_promotion_requests_business_guard` trigger | present |
| RLS enabled / forced, all four sales tables | `true` / `true` |
| Row counts, all four sales tables | 0 / 0 / 0 / 0 — unchanged |
| `business_records` | 14, all still legacy `lead_assessed` — unchanged |
| `timeline_events` | 109 — unchanged |

**Also true as of this run, and not established by it.** One confirmed Supabase
Auth user exists and was bootstrapped through `bootstrap_staff_owner` as the
sole active `owner`, so the `staff_operators` foreign key and the bootstrap's
confirmed-email check have now run for real on a hosted database rather than
being skipped as they are under PGlite. No operator identity is recorded in
this repository.

### What run 18 does NOT establish

- **That the sales lifecycle has ever run.** All four tables are still empty.
  No handoff has been qualified, no contact linked, no opportunity created and
  no webhook delivery received.
- **That either server surface works against the real CRM.** Neither is
  deployed, and every result so far is from the test suite plus read-only or
  non-mutating probes.
- **Anything about Supabase Auth beyond the bootstrap.** No real access token
  has been verified, no factor enrolled, no session refreshed. Bootstrapping an
  owner is a database grant, not a sign-in.

---

## Run 17 — 0009 and 0010 reconciled out of the database

**Nothing was applied in this run, and that is the point.** Every other run in
this document records SQL being executed. This one records SQL being
*recovered*.

| | Run 17 |
|---|---|
| Date | 2026-08-14 |
| Project | `qkpptajglstgucadhfwq` (`ced-cip-dev`) |
| Postgres | 17.6.1.155 |
| Method | read-only `execute_sql` against `supabase_migrations.schema_migrations` |
| Migrations applied | **none** |
| Result | two ledger entries reconciled into repository files; one left outstanding |

**What was found.** The hosted ledger held two entries with no counterpart in
`supabase/migrations/`:

| Version | Name |
|---|---|
| `20260814182709` | `0009_bi_sales_handoff_foundation` |
| `20260814182839` | `0010_sales_handoff_fk_indexes` |

They were applied on 2026-08-14, before the repository had files for them.
The schema they created was confirmed present and correct independently of the
ledger: `sales_handoffs`, `external_record_links`, `sales_promotion_requests`
and `crm_webhook_receipts` all exist with RLS enabled and no policies;
`business_records.lifecycle_state` defaults to `business_record`; the
`business_records_lifecycle_semantics` trigger raises `23514` on new
`lead_assessed`; all 14 existing rows remain `lead_assessed` and none uses a new
value.

**How they were reconciled.** `schema_migrations.statements` stores the text
that actually executed. Each entry's statement was read and written to its
numbered file with a header comment and no other change. Faithfulness was then
*verified rather than asserted*: both sides were lowercased, had `--` comments
stripped and whitespace collapsed, and were compared by MD5.

| File | Normalised MD5 | Length | Match |
|---|---|---|---|
| `0009_bi_sales_handoff_foundation.sql` | `4313c87bf06208e8795acee0f1bf85f0` | 14673 | yes |
| `0010_sales_handoff_fk_indexes.sql` | `9f5e9e6084de42f95891f0b4949c07cc` | 223 | yes |

This inverts the usual caveat in this document. For 0001–0008 the committed
file is the *intended* text and only one deployed function has ever been diffed
against it. For 0009 and 0010 the committed file is provably the *executed*
text — but nothing has been diffed the other way, so what is **not** established
is that the executed text was reviewed before it ran.

**Advisors.** Security advisors were read after reconciliation: 25 findings, all
INFO `rls_enabled_no_policy`, which is the intended design for every table since
0001. No ERROR and no WARN. Unchanged by this run, which changed nothing.

### What run 17 does NOT establish

- **That 0009's SQL was reviewed before it was applied.** It was not, by
  anyone whose review is recorded. The reconciliation proves what ran, not that
  running it was correct.
- **That the four new tables have ever been written to.** All four are empty.
  No handoff, link, promotion request or webhook receipt exists.
- **That the sales lifecycle works.** `staff_operators` held zero rows and
  `auth.users` zero users *at the time of this run*, so no handoff could be
  qualified: both `qualified_by` and `pursuit_approved_by` are foreign keys
  into `staff_operators`. Nothing downstream of qualification had been
  exercised.

  *(Superseded in part by run 18: one active owner now exists, so
  qualification is possible. The tables are still empty, so it still has not
  happened.)*

### Still outstanding after run 17

`20260806171939 create_aeo_answer_visibility_module` is recorded in the ledger
and has **no repository file**. It created `aeo_targets`, `aeo_competitors`,
`aeo_questions`, `aeo_checks` and `maps_snapshots` — present, RLS-enabled, all
empty. It is left unreconciled deliberately; the same recovery procedure would
work, but it belongs to a module unrelated to the sales lifecycle and should be
a decision of its own rather than a rider on this one.

---

## Run 16 — 0008 applied and verified on the hosted project

**The migration is applied, recorded, and verified.** This is the first time
any migration in this repository has been applied to a hosted database by this
project's own tracked procedure, with the verification run immediately
afterwards rather than promised.

| | Run 16 |
|---|---|
| Date | 2026-08-09 |
| Project | `qkpptajglstgucadhfwq` — the persistent hosted **development** project |
| Postgres | 17.6.1.155 |
| Migration | `0008_staff_migration_hardening` |
| Source blob | `f992a3a85c40abf429d7d346de09fb0ad9102f19`, from commit `6939887836aaa2aa3e18cfdcacb5b3319f5bd98b` |
| Mechanism | The tracked `apply_migration` operation — DDL and history row in one call |
| Ledger version | **`20260809173146`** |
| Authorization | Explicit, immediately before the operation, naming the project ref, migration name and source commit |
| Result | **Applied, recorded, and verified. No rollback, no repair, no manual history row.** |

The hosted ledger now records migrations **through 0008**.

### What the post-application verification found

Every item below was checked after the migration ran.

**Migration ledger.** `supabase_migrations.schema_migrations` records the chain
through 0008 at version `20260809173146`. The row was written by
`apply_migration` itself; nothing was inserted by hand.

**F3 — trigger coverage.** `bir_supersession_scope` is an **enabled,
row-level `BEFORE INSERT OR UPDATE`** trigger. The `BEFORE INSERT`-only
definition run 15 observed is gone.

**F6 — internal function privileges.** All **16** internal functions exist, and
none exposes unexpected EXECUTE to `PUBLIC`, `anon`, `authenticated` or
`service_role`. The twelve that genuinely held a `service_role` grant from
Supabase's default privileges no longer do; the four from 0007 that were
already correctly blocked are unchanged, which is the outcome the retracted
blanket-rollback paragraph would have destroyed.

**F7 — pinned search paths.** Both helper functions —
`identity_value_acceptable` and `identity_evidence_fault` — carry pinned search
paths, and **the two mutable-search-path warnings from Supabase's security
advisor are gone.** An independent instrument agreeing that the finding is
closed is worth more than reading the catalog back.

**Performance advisor.** Results **unchanged**. 0008 adds no index, no column
and no plan-visible object, so an unchanged performance profile is the expected
result and is recorded because "we did not check" and "nothing changed" look
identical in a report that omits it.

**Data integrity — nothing moved.**

| | Before (run 15) | After |
|---|---|---|
| Business Records | 12 | **12** |
| Submissions | 16 | **16** |
| BIRs | 16 | **16** |
| Identity-resolution cases | 3 | **3** |
| Supersession chains | 3 | **3** |

Zero broken predecessors, zero cross-business violations, zero
cross-review-type violations — the same three zeros run 15 recorded, now
re-confirmed with the stricter trigger in force.

### Behavioural testing, inside a transaction, with nothing left behind

The catalog says what the trigger *is*. This says what it *does*. Every case
ran inside a transaction that was rolled back, so the hosted database took
**zero persistent test writes** — the counts above are unchanged precisely
because of that.

| Case | Result |
|---|---|
| A valid update to a chained report | **allowed** |
| Moving a chained report to another business | **rejected** |
| Changing a chained report's review type | **rejected** |
| Pointing at an invalid predecessor | **rejected** |
| Pointing at an unknown predecessor | **rejected** |

This is the first time F3's rule has been exercised against real data on
PostgreSQL 17. Until now it had only ever run on PGlite 18.3 against fixtures.

### What run 16 still does NOT establish

- **PostgREST execution.** Still nothing. No RPC has been called through it,
  and the staff route's five functions and two direct table reads remain
  unexercised as `service_role`. The verification above is catalog and SQL, not
  the transport the application uses.
- **The rest of the deployed definitions.** Run 15 compared
  `enforce_bir_supersession_scope()` against its committed source, and 0008 has
  now replaced that one. Every other function in 0006 and 0007 is still
  undiffed against the repository.
- **True multi-connection concurrency.** Unchanged from run 6. The mechanism
  that decides a race is proven; the race has still never been run.
- **Real Supabase Auth, TOTP, invitations and recovery.** Unchanged from runs
  6, 10, 11 and 12 — all still fixtures.
- **Vercel.** Unchanged from run 13. No elevated credential is configured on
  any environment, so no application code has yet reached this schema. Preview
  configuration and hosted end-to-end testing are a separate, separately
  authorized phase.

---

## Run 15 — the hosted preflight for 0008 *(superseded by run 16 — retained as the evidence that justified applying it)*

> **Superseded by [run 16](#run-16--0008-applied-and-verified-on-the-hosted-project).**
> Everything below was true of the database *before* 0008 was applied, and it
> is retained deliberately: it is the record of the three defects being
> confirmed present on the real database, which is what made applying 0008 a
> repair rather than a guess. Read it as the "before" half of a before-and-after
> pair, not as current state. In particular the `BEFORE INSERT`-only trigger,
> the twelve `service_role` grants and the two mutable-`search_path` warnings
> described below are all **now fixed**.

Run 14 found that 0006 and 0007 were present and said, repeatedly, that
*present is not known*. This run reads what run 14 only probed for.

| | Run 15 |
|---|---|
| Date | 2026-08-09 |
| Project | `qkpptajglstgucadhfwq` — the persistent hosted **development** project |
| Postgres | 17.6.1.155 |
| Method | Read-only preflight: catalog reads and migration-history reads |
| Result | **Every one of 0008's three findings confirmed against the real database.** Nothing was applied and nothing was written. |

### Migration history — now read, not unknown

`supabase_migrations.schema_migrations` records **0001 through 0007**,
including:

| Version | Name |
|---|---|
| `20260808200326` | `0006_service_mix_review` |
| `20260808201535` | `0007_staff_identity_resolution` |

**0008 is not recorded and has not been applied.** The "the history rows have
never been read" caveat in runs 6 and 14 is closed.
*(As of run 16, 0008 **is** applied and recorded at version `20260809173146`.
The sentence above describes the state this preflight found.)*

### The definition comparison — done, and it matched

The deployed `enforce_bir_supersession_scope()` body **matches repository
migration 0006 exactly.** This was the one open risk in applying 0008: its F3
repair is a `create or replace`, which overwrites whatever is deployed, and
nobody had looked. There is nothing to lose.

The deployed `bir_supersession_scope` trigger is **`BEFORE INSERT` only** —
the F3 defect, observed on the real database rather than inferred from the
migration file.

### The two ACL findings, confirmed as real

- **F6.** `service_role` holds EXECUTE on the **12** internal functions
  originating in 0001, 0004 and 0006. The four from 0007 are already correctly
  refused. This is the Supabase default-privilege defect exactly as described:
  0006 revoked from `public, anon, authenticated` and the direct grant to
  `service_role` survived. **0008's 16-function revoke stays at full scope** —
  the hosted ACLs prove the broader set fixes something real, and narrowing it
  to one function would leave eleven holes.
- **F7.** `identity_value_acceptable` and `identity_evidence_fault` are the
  only public functions with no pinned `search_path`, and **Supabase's own
  security advisor reports exactly those two mutable-search-path warnings** —
  an independent instrument reaching the same list.

### Context that bounds the blast radius

- `anon`, `authenticated` and `service_role` **cannot CREATE in schema
  `public`**, which is what makes F7 a hygiene and consistency defect rather
  than an exploitable one: there is no role able to plant a shadowing function
  for an unpinned `search_path` to resolve to.
- The function owner `postgres` has `BYPASSRLS` but is **not** `rolsuper`.

### Existing data

| | |
|---|---|
| Business Records | 12 |
| Submissions | 16 |
| BIRs | 16 |
| Identity-resolution cases | 3 |
| Supersession chains | 3 |
| Cross-business supersession violations | **0** |
| Cross-review-type supersession violations | **0** |

Zero violations is the expected result and is worth stating: F3 is a coverage
gap, not evidence that anything has already gone wrong. Nothing needs
repairing before 0008 is applied.

### What run 15 still did NOT establish

- **Nothing was executed.** No RPC was called, no ingestion run, no staff
  function invoked. This was catalog and history reads.
- **Only one definition was compared.** `enforce_bir_supersession_scope()`
  matches; the other functions in 0006 and 0007 have not been diffed against
  their committed source.
- **PostgREST execution.** No privileged RPC has been resolved or executed
  through PostgREST. As of run 15, no elevated credential was configured on
  any Vercel environment.

  **Correction (2026-08-10).** An earlier version of this bullet also stated
  that `GET /auth-config` "is hosted and answers HTTP 200". That assertion is
  **withdrawn**. No reproducible hosted request to it has been identified: no
  host, deployment id, timestamp, response body or header set was ever
  recorded, and a later commit on this same branch (`42f3f7b`) states that
  `/auth-config` was never called and no response header was observed. The
  endpoint exists in this branch's implementation, and its response contract
  is covered by the automated unit and browser suites against local servers —
  which is a different claim from having observed it on a deployment. The
  current Preview is protected by Vercel SSO, so the deployed endpoint's
  response, headers and returned public configuration remain **unobserved**.
  This does not assert that no manual call was ever made; only that no
  sufficient evidence record of one exists.
- **0008 remains unapplied**, on this project and everywhere else.
  *(No longer true — run 16 applied and verified it.)*

---

## Run 13 — the first platform build

**A preview deployment HAS now been attempted, and it failed by design.**
The repository is connected to Vercel through Chris's other Vercel account.
Pushing `agent/staff-secure-onboarding` triggered Preview deployment
`dpl_Ew4VxQhkPHdeErYomKcJgKuTzJzu`. Its Build Logs — inspected manually in
that account — show the build stopped with `SUPABASE_URL is not set.`:
`tools/build-static.mjs` failed closed exactly as designed. **No Preview was
published.** The failed Preview was not retried or modified. `main` @
`8ac657f` had previously deployed successfully.

That observes two things and no more: **Vercel runs the configured
`buildCommand`**, and **the fail-closed guard fires on the real platform**.
Everything downstream of the build — `outputDirectory`, `api/` discovery,
file tracing, the header rules — is still unobserved, because the build
aborted before reaching any of it.

### What run 13 DID validate

- **Vercel executes `buildCommand`.** The build log shows
  `tools/build-static.mjs` running and producing its own refusal message,
  which is only possible if the platform invoked it.
- **The fail-closed guard is real, not just local.** With no `SUPABASE_URL`
  the build refuses rather than publishing a page whose `connect-src` names
  nothing. That is the designed behaviour and it is now observed on the
  platform rather than modelled.
- **A failed build publishes nothing.** No Preview URL was produced.

### What run 13 did NOT validate

- **Everything downstream of the build.** `outputDirectory`, `api/` function
  discovery alongside a `buildCommand`, file tracing from `api/` into
  `server/` and `shared/`, and whether the header rules are applied to the
  generated paths — the build aborted before any of it.
- **A successful Preview.** None has been produced, because
  `SUPABASE_URL` has not been set on any environment.
- Nothing about Supabase, PostgREST, PostgreSQL 17, real Auth, real
  invitations or real recovery emails changed. Runs 6, 10, 11 and 12 stand.

---

## Run 12 — the invitation failure window

Runs 10 and 11 left one gap. Accepting an invitation is two calls —
`verifyOtp({ type: 'invite' })` then `updateUser({ password })` — and between
them the account exists with **no usable password**. The password-based resume
path needs a password, and the invitation cannot be reissued, so that person
was stranded. Password recovery closes it, because it depends on the account
rather than on the invitation.

### What run 12 DID validate

- **Window A — `updateUser` refused.** Driven end to end in a real browser:
  the account is created with no password, the invitation is proven
  unreplayable, a reset is requested, a new password is set on
  `reset-password.html`, and the MFA-resume flow is then reached and
  enrollment completed.
- **Window B — `updateUser` succeeded and its response was lost.** The fixture
  sets the password and destroys the socket, through auth-js's own retries, so
  the account has a password its owner never learned. Proven that the resume
  path cannot help (a guessed password is refused) and that recovery restores
  access anyway.
- **Not an account oracle.** An unknown address produces the *same words* and
  the same absence of an error as a real one, and so does an unreachable
  Supabase — asserted by comparing the rendered strings, not by reading the
  code.
- **The redirect is exact and same-origin.** `redirect_to` on the observed
  `POST /auth/v1/recover` equals the CED origin plus the exact recovery page
  path, and the request carried the publishable key.
- **Recovery tokens fail safely**: wrong type, absent, expired/never-issued,
  malformed, replayed after use, and supplied in the query string. A refused
  query token consumes nothing — the genuinely issued reset is still
  available afterwards.
- **Nothing leaks.** Across the whole recovery flow, CED sees only
  `GET …/auth-config`: no body, no query, no `Referer` carrying a token, and
  the ten sensitive values are absent from every CED request, response and log
  line. `localStorage`, `sessionStorage` and `document.cookie` are empty.
- **Recovery grants nothing.** No factor enrolled, no aal2 session produced,
  no database touched (the injected `db` throws on any access), and a genuine
  aal2 token is still refused `not_an_operator` with no queue read.
- **Under the generated CSP**, served as built, with only the CED and Supabase
  origins contacted and zero CSP violations.

### What run 12 did NOT validate

- **No real recovery email has been sent.** The reset-password template in
  runbook §2.0 is written from Supabase's documented variables; whether
  `{{ .RedirectTo }}` renders as the URL the browser supplied, and
  `{{ .TokenHash }}` into the fragment, is unobserved.
- **The redirect URL has never been added to a project's allowed list**, so
  Supabase has never accepted or refused it — and a refused `redirectTo`
  falls back to the Site URL, which is the wrong-host outcome the
  `{{ .RedirectTo }}` template exists to avoid. That fallback has not been
  observed either.
- **The invitation template still depends on `{{ .SiteURL }}`**, necessarily:
  invitations are created from the Dashboard with no `redirectTo`, so
  `{{ .RedirectTo }}` would be empty. Whether a per-project Site URL routes
  invitations to the right environment is a configuration constraint this
  repository documents and tests for, not one it has observed.
- The Auth server remains a fixture, and every gap from runs 6, 8, 10 and 11
  is unchanged.

---

## Run 11 — the CSP origin is generated, and the invitation moved to the fragment

Run 10 left one deployment defect: `vercel.json`'s staff CSP carried
`https://REPLACE-WITH-PROJECT-REF.supabase.co`, to be replaced by hand after
review. A deployable file with a placeholder in it is a deployment waiting to
ship the placeholder, and hardcoding the development origin instead would have
pointed a production page at development data.

### What run 11 DID validate

- **Two environments, two exact origins, one source tree.** Building with
  `SUPABASE_URL=https://qkpptajglstgucadhfwq.supabase.co` and with a second,
  different project origin produces two policies that differ **only** in that
  origin — asserted by substring-removal equality, not by eyeballing.
- **The build fails closed** on absent, empty, whitespace, `http`, no-scheme,
  credential-bearing, path-bearing, query-bearing, fragment-bearing,
  ported, foreign-host, bare-domain, nested-subdomain, wildcard,
  suffix-trick, too-short, whitespace-separated, `;`-injecting, quote-bearing
  and key-shaped values — 24 cases, each refused by the validator **and** by
  the whole build. Each refusal leaves the previous `dist/` byte-identical and
  no staging directory behind, because the origin is resolved before anything
  is deleted.
- **The refusal never echoes the value**, so a pasted key cannot land in a
  build log.
- **No placeholder anywhere.** `vercel.json` contains neither
  `REPLACE-WITH-PROJECT-REF` nor the string `supabase` at all, and every one of
  the 30 published files is scanned for placeholder-shaped text.
- **One line, one file.** The byte-for-byte test now exempts exactly one
  named file, and a companion test proves that file differs from its source by
  exactly one line, that the line is the base CSP line, that the replacement is
  what `cspLineFor` produces, and that `connect-src` holds exactly two sources
  with no wildcard and no `wss:`.
- **The build and the route cannot diverge** — one variable, one validator,
  three configured spellings (bare, trailing slash, second project) each
  produce a generated `connect-src` and an `/auth-config` `supabaseUrl` that
  are the same string.
- **The header/meta split works in a real browser.** The onboarding suite now
  serves the page **as built**, through the build's own `cspLineFor`, under the
  real `vercel.json` header policy. The full flow completes with zero CSP
  violation messages — which would not be true if the header still carried
  `default-src` or `connect-src`, because the intersection would block the
  Auth origin.
- **The invitation never reaches CED.** It travels in the URL **fragment**, so
  it is absent from the page load's own request line — observed on every
  request Chrome made to the CED origin, on `pathname + search`, plus every
  `Referer`, plus everything the server recorded, plus the logs.
- **A query-string invitation is refused**, on its own and even when a valid
  fragment token is also present, with zero Supabase calls. The page says why.
- **`/auth-config`** returns exactly `{ ok, supabaseUrl, publishableKey }`,
  normalised, `Cache-Control: no-store`, GET-only, with no secret, no legacy
  service-role key and no unrelated configuration.
- **The loopback exception is fenced.** Local development needs
  `SUPABASE_URL` pointed at an http stub; that is accepted **only** with
  `CED_ALLOW_INSECURE_STAFF=true`, a loopback request host, and a non-production
  `NODE_ENV` — all three asserted individually — and the **build** refuses it
  regardless, so no published page can name a loopback origin.

### What run 11 did NOT validate

- **No deployment has set `SUPABASE_URL`,** so no browser has been permitted to
  reach a real `*.supabase.co` origin from a staff page. The generation is
  exercised; the deployed result is not.
- **Whether Vercel serves the header policy on the generated paths**, and
  whether it honours `outputDirectory` and still discovers `api/` alongside a
  `buildCommand` — the run 8 gaps, unchanged.
- **Whether a real Supabase invite email renders `{{ .TokenHash }}` into a
  fragment** the way the template in the runbook specifies. Never sent.
- Everything run 10 left open: the Auth server is still a fixture, no real
  invitation, no real TOTP, and PostgREST / hosted Supabase / PostgreSQL 17 are
  unchanged from run 6.

---

## Run 10 — onboarding moved out of CED

Run 9's onboarding was **withdrawn**. It put two CED endpoints in the credential
path: they accepted the invited user's password and invitation token and
returned the Supabase session, the TOTP secret and the `otpauth://` URI.
CLAUDE.md §9 forbids this platform from transmitting or storing credentials.
The reasoning behind it — "the browser must hold no Supabase key" — confused
the **secret** key, which must never reach a browser, with the **publishable**
key, which is designed for one.

Onboarding now runs between the browser and Supabase Auth directly, with the
vendored supported client. Run 9's results below are superseded except where
this run repeats them.

### What run 10 DID validate

- **No ONBOARDING credential reaches CED, observed on the wire.** Scoped
  deliberately: the console's own `/session` endpoints still exchange a
  password and a TOTP code server-side and are unchanged. The browser suite runs
  two servers on two origins and records the raw body of every request to
  both. Across the full flow and the recovery flow, CED receives exactly one
  request — `GET …/auth-config` — with an empty body, an empty query string,
  and no `Referer` carrying the token. The password, both tokens, the secret,
  the URI and the code are asserted absent from every CED request, response
  and log line.
- **The browser reaches only two origins**, recorded from Chrome's own request
  events: the CED origin and the configured Supabase origin. No CDN.
- **The real vendored client against a real GoTrue wire shape.** The fixture
  Auth server implements `/auth/v1/verify`, `/token?grant_type=password`,
  `/user` (GET and PUT), `/factors`, `/factors/:id/challenge`,
  `/factors/:id/verify`, `/factors/:id` (DELETE) and `/logout`, taken from the
  installed `@supabase/auth-js` 2.112.0. Every request carried the publishable
  key; none carried the secret key.
- **Under the shipped CSP.** The static server sets the real `/staff/(.*)`
  policy read from `vercel.json`, with the placeholder replaced by the fixture
  origin. The console is watched for CSP violation messages; there are none.
- **The publishable key can reach nothing**, in real PostgreSQL through
  PGlite, against the full chain including 0007:
  `tests/migration/0007-anon-grants.test.mjs` proves `anon` and
  `authenticated` are refused SELECT/INSERT/UPDATE/DELETE on six staff tables
  and EXECUTE on six staff functions including the attach mutation, that RLS
  is enabled **and forced** with **no policies**, and that `service_role`
  reaches the same function body — so the refusals are about the role, not a
  broken fixture.
- **Type confinement.** `signup`, `magiclink`, `recovery`, `email_change`,
  `email`, `sms` and an explicitly empty `type` all refuse the link with zero
  Supabase calls. The token is still stripped from the URL when the type is
  refused.
- **Recovery works.** Reload after the password step, with no link parameters:
  password sign-in, stale unverified factor deleted, fresh factor enrolled,
  code verified — and **no `verifyOtp` call**, so no second invitation was
  needed. A wrong password enrolls nothing; an already-verified account is
  refused and signed out.
- **Nothing is persisted.** `localStorage`, `sessionStorage` and
  `document.cookie` are all empty after a completed flow.
- **Enrollment still grants nothing.** A genuine `aal2` token is refused
  `not_an_operator`, from a real browser, with no queue read on its behalf.
- **The dead credential path is gone.** A test names
  `handleInviteAccept`, `handleInviteVerify`, `onboardingPayload`,
  `TOKEN_HASH_RE`, `TOTP_CODE_RE`, `MIN_PASSWORD` and `MAX_TOKEN_HASH` and
  fails if any reappears in the route, and fires a full credential payload at
  seven paths asserting none answers `200`.
- **The vendored client is a copy, not a fork** — byte-identical to the
  installed package, checksum recorded and re-verified.

### What run 10 did NOT validate

- **Supabase Auth is still a fixture.** It speaks the right protocol on the
  right paths; it is not Supabase. No real invitation, no real password
  change, no real factor, no real TOTP code.
- **The invite email template has never been sent.** Whether
  `{{ .TokenHash }}` and `{{ .SiteURL }}` render as documented, and whether
  the link arrives intact, is unobserved.
- **TOTP has never been enabled on a project.**
- **The CSP placeholder has never been replaced.** No browser has been
  permitted to reach a real `*.supabase.co` origin from a staff page, and
  whether Vercel serves that header on the generated paths is still the run 8
  gap.
- **PostgREST, hosted Supabase and PostgreSQL 17** — unchanged from run 6. The
  anon-grant proof ran on PGlite 18.3 as the database owner switching roles,
  not through PostgREST as `anon`.

---

## Run 9 — invitation onboarding *(superseded by run 10 — the endpoints it validated have been removed)*

The runbook told an invited person to accept an invitation, set a password and
enroll a second factor. The repository could do none of it, and `/session`
correctly refuses an account with no verified factor — so an invited operator
met `mfa_enrollment_required` and stopped. The queue was unreachable for
everybody this repository could actually onboard, which was nobody.

Two endpoints now close it: `POST …/onboarding/invite` and
`POST …/onboarding/verify`, with `staff/identity-resolution/accept-invite.html`
as the page.

### What run 9 DID validate

- **The server half**, against a stubbed Auth client whose shape is pinned to
  the installed `@supabase/auth-js` 2.112.0 — `verifyOtp`, `updateUser`,
  `setSession`, `signOut`, `mfa.enroll`, `mfa.challengeAndVerify` all exist on
  a genuinely constructed production client, and the stub invents nothing the
  library lacks. 29 tests in
  [tests/staff-invite-onboarding.test.mjs](../tests/staff-invite-onboarding.test.mjs).
- **The browser half over a real socket** — real Chrome, `window.fetch` NOT
  replaced, the real page, the real `handleRequest`. 10 tests in
  [tests/browser/staff-invite-browser.test.mjs](../tests/browser/staff-invite-browser.test.mjs).
- **Invite-only**, twice over: the page shows no form without a `token_hash`,
  and the route hard-codes `type: 'invite'` so the request cannot ask for
  another type.
- **The invitation is not spent on refusable input.** A short password, an
  over-long one, and a malformed token are all refused with zero Supabase
  calls — observed against a call recorder, not read off the source.
- **Onboarding emits `aal1` and only `aal1`,** and `/onboarding/verify`
  returns no session at all. The `aal2` token was checked as absent from the
  raw HTTP response body on the wire, not just from a parsed object.
- **Neither endpoint touches the database.** Both suites inject a `db` proxy
  that throws on any property access; both flows complete.
- **A fully enrolled account is still refused the queue** with
  `not_an_operator`, and no queue read runs on its behalf.
- **Nothing sensitive is logged.** Console output is captured at
  `CED_LOG_LEVEL=debug` across seven paths, including every failure path, and
  asserted free of the invitation token, the password, the TOTP secret, the
  `otpauth://` URI, both access tokens, the refresh token and the code.

### What run 9 did NOT validate

- **No real invitation has ever been accepted.** The Auth client is a stub in
  both suites. No real `verifyOtp`, no real password change, no real
  `mfa.enroll`, no real `challengeAndVerify`.
- **The invite email template has never been sent.** The template in runbook
  §2.0 is written from Supabase's documented variables. Whether
  `{{ .TokenHash }}` and `{{ .SiteURL }}` render as expected, and whether the
  resulting link reaches `accept-invite.html` intact, is unobserved.
- **TOTP has never been enabled on a project**, so `mfa.enroll` returning
  `502 enrollment_unavailable` when it is disabled is a path this repository
  models rather than one it has seen.
- **No authenticator app has read a real secret.** Manual key entry is
  documented app behaviour, not a thing observed here.
- **Vercel.** The two new static files are in the manifest and the build
  copies 29 rather than 27, but no local `vercel build` has run — unchanged
  from run 8. A platform build has since run and failed closed; see run 13.

---

## 0. Run 2 — migration 0004 and the two-stage assessment

### What was applied

0004 in three parts: constraints and indexes, the two stage triggers, and the
timestamp fix for the defect found mid-run. Applied cleanly, in order, after
0001–0003.

| Check | Result |
|---|---|
| Migration applies cleanly | ✔ |
| Existing rows still valid | ✔ 9 BIRs at schema 2 and 9 submissions at payload 3, all inside the widened ranges. Both constraints added without `NOT VALID`, so Postgres verified every row; `convalidated = true` on both. |
| BIR schema versions 2–4 accepted | ✔ `CHECK ((schema_version >= 2) AND (schema_version <= 4))` |
| Payload schema versions 2–5 accepted | ✔ `CHECK ((payload_schema_version IS NULL) OR (…>= 2 AND …<= 5))` |
| `bir_readiness_band_idx` | ✔ exists, partial on `business_id is not null` |
| `submissions_assessment_stage_idx` | ✔ exists; `Index Scan`, 4 buffers, 0.181 ms |
| `bir_result_state_idx` | ✔ exists; `Index Scan`, 0.187 ms |
| `assessment_submissions_stage_events` trigger | ✔ `AFTER INSERT … FOR EACH ROW` |
| `bir_stage_event` trigger | ✔ `AFTER INSERT … FOR EACH ROW` |
| Both functions `SECURITY DEFINER` | ✔ |
| Both pin `search_path` | ✔ `pg_catalog, public, pg_temp` |
| Execute revoked | ✔ ACL `postgres=X/postgres \| service_role=X/postgres`; `anon`, `authenticated` and `public` all false |
| Security advisors | ✔ 10 × INFO `rls_enabled_no_policy` — unchanged, and the intended design. **No new WARN.** |
| Performance advisors | ✔ all INFO. Three new `unused_index` notices appeared on the new indexes; two cleared once exercised. **No new WARN.** |

The index scans were measured with `enable_seqscan = off`. At 16 rows the
planner correctly prefers a sequential scan; what is being proved is that the
expression indexes are *usable*, not that they are chosen at this size.

### Staged ingestion

| # | Scenario | Result |
|---|---|---|
| 1 | Stage 1 alone | 1 submission, 1 BIR, **7 events**: the function's 5 plus `stage1.completed` and `preliminary_bir.generated`. No Stage 2 event. `resultState = fit_review_available`, band `present_offer`, never `ask_for_sale`. Attribution, consent and `submitted_at` preserved verbatim. |
| 2 | Stage 2, same session | Linked to the **same** `businessId` via the session. New submission, new BIR, `supersedes_bir_id` = the preliminary BIR, `current_bir_id` moved to the full BIR, preliminary preserved unchanged. **7 events**: 4 from the function plus `stage2.started`, `stage2.completed`, `full_bir.generated`. No Stage 1 event repeated. |
| 3 | Replay of both stages | Both returned `replayed: true` with the **original** `birId` and `businessId`, ignoring the fresh BIR ids supplied. Submissions, BIRs and events all unchanged. Exactly one of each staged event name per submission. |
| 4 | Legacy payload (schema 4, no `assessmentStage`) | Accepted. **5 events only** — no staged event of any kind. Report carries `stageDeclared = false`, `provisional = false`. The two gates are independent: the submission trigger keys off the payload, the BIR trigger off `stageDeclared`. |
| 5 | Maximum tolerated clock skew | `submittedAt` at +4m59s and `stage2StartedAt` at +5m00s. Every event — including all three staged ones — clamped to `now()`; `recorded_at >= occurred_at` held on all 8. The visitor's claimed timestamps survive verbatim in `raw_payload` and on `submitted_at`. |
| 6 | `stage2.started` timing | Carries when the fit review **opened** (8 minutes before completion), not when the submission landed, so the gap is recoverable from the timeline. |

### Forced rollbacks

Four failure points, each verified to leave nothing behind. Counts before and
after were identical in every case: 8 businesses, 12 submissions, 12 BIRs, 60
events, 12 keys, 13 audits.

| Failure point | How | Result |
|---|---|---|
| During staged **trigger** execution | `assessmentStage.stage = "one"`, which the trigger casts | Raised inside the submission insert. No submission, no events, no claim. |
| Before the preliminary **BIR** insert | invalid `confidence_band` | Submission **and its two trigger events** already written — all unwound. This is also the "after submission, before timeline completion" case: the function's own timeline inserts had not run. |
| During the function's own **timeline** inserts | a pre-existing `assessment.completed` row colliding on `(event_name, idempotency_key)` | Failed after the submission, its trigger events, and the BIR. All unwound. |
| During full-BIR **supersession** | Stage 2 in the existing chain with an invalid band | `current_bir_id` still points at the preliminary BIR. |

Also verified across the whole database afterwards: **0** `business_records`
whose `current_bir_id` names a missing BIR, and **0** BIRs superseding a
missing BIR. The rolled-back key was then reused successfully — the rollback
does not poison it.

### Stored BIR JSON

Read back from Postgres, not asserted from memory.

| | Stage 1 BIR | Stage 2 BIR |
|---|---|---|
| `schema_version` | 4 | 4 |
| `assessmentStageCompleted` | 1 | 2 |
| `confidenceKind` / `estimateConfidence.kind` | `preliminary` | `full` |
| `closeReadinessProvisional` | `true` | `false` |
| `resultState` | `fit_review_available` | `activation_ready` |
| `band` | `present_offer` | `ask_for_sale` |
| `approvedLanguageKey` | `null` | `ask_for_sale` |
| `missingStage2Evidence` | 23 fields | 8 (all optional or branched away) |
| `supersedes_bir_id` | `null` | the preliminary BIR |
| `current` | no | yes |

The Stage 2 report reached `ask_for_sale` on real deterministic rules, and the
approved language appeared only there — which is also the proof that Stage 1's
cap is doing work rather than describing a case that cannot arise.

### Capacity ranges

The figure the page shows and the figure the report calls capacity-adjusted,
compared field by field **after** a storage round trip.

| Band | Page low / point / high | BIR capacityAdjusted | Equal | Clamped | Ceiling | Unconstrained preserved | Disclaimer |
|---|---|---|---|---|---|---|---|
| `11_20` known | 1427.75 / 1679.70 / 1931.66 | identical | ✔ | no | 2381.50 | 1679.70 | ✔ |
| `none` zero | 651.44 / **766.40** / 881.36 | identical | ✔ | **yes** | 0 | 1679.70 | ✔ |
| `unsure` unknown | 1175.79 / 1679.70 / 2183.61 | identical | ✔ | no | **null**, `ceilingKnown false` | 1679.70 | ✔ |

Zero capacity clamps to 766.40 and **not to zero**: the backfill portion —
appointments already on the book — needs no new headroom and is preserved.
`isDiagnosticEstimate` is true and the disclaimer travels with the figure in
all three.

### Question-path metadata

| | Stage 1 | Stage 2 |
|---|---|---|
| `questionSetVersion` | `nails-questions-3.0.0` | same |
| visible fields | 24 | 41 |
| skipped fields | 0 | 3 |
| stale-cleared | 0 | 0 |
| visible steps | 9 | 7 |
| `stage1CompletedAt` / `stage2StartedAt` / `stage2CompletedAt` | set / null / null | set / set / set |
| Stage 2-only answers present | **0 of 12** | 12 of 12 |
| Stage 1 evidence present | 5 of 5 | 5 of 5 |
| `contact.preferredContact` | `""` | `email` |

A Stage 1 payload carries no Stage 2 answer at all — absent keys, not empty
strings — which is the property that stops "not asked" being stored as
"declined to answer".

---

## 1. Checklist

Repeat this against any fresh development project.

### Prepare

- [ ] Create a Supabase project whose name identifies it as development
      (`ced-cip-dev`). **Never reuse a project that holds anything else.**
- [ ] Note the project ref. Do not copy the service-role key anywhere it can
      be committed.
- [ ] Confirm Postgres 15 or later. `gen_random_uuid()` and `sha256()` are
      relied on as pg_catalog built-ins; neither needs an extension.

### Apply

- [ ] `0001_business_record_foundation.sql`
- [ ] `0002_ingest_assessment.sql`
- [ ] `0003_production_hardening.sql`
- [ ] `0004_assessment_intelligence_expansion.sql`

Order matters. 0003 depends on the first two, **drops and recreates**
`ingest_assessment` (the signature gains `p_meta`), and **narrows** the
strong-identifier unique index to verified rows. 0004 depends on all three; it
adds no function signature, so it needs no drop.

### Verify structure

- [ ] 10 tables in `public`
- [ ] RLS **enabled** on 10, **forced** on 10
- [ ] **0** policies
- [ ] 33 indexes, 29 CHECK constraints, 6 triggers, 9 functions
- [ ] `ingest_assessment` appears **once**, with 8 arguments
- [ ] `business_identifiers_strong_unique` is **gone**;
      `business_identifiers_verified_strong_unique` exists
- [ ] `bir_schema_version_check` accepts **2–4**;
      `assessment_submissions_payload_version_check` accepts **2–5**; both
      report `convalidated = true`, which is what proves no existing row was
      stranded
- [ ] `bir_readiness_band_idx`, `submissions_assessment_stage_idx` and
      `bir_result_state_idx` exist
- [ ] `assessment_submissions_stage_events` and `bir_stage_event` triggers
      exist, both `AFTER INSERT … FOR EACH ROW`
- [ ] Execute is revoked from `public`, `anon`, `authenticated` on **all nine**
      functions, `append_stage_timeline_events` and `append_bir_stage_event`
      included, and both pin `search_path`
- [ ] Supabase security advisors show no `WARN`; the 10
      `rls_enabled_no_policy` notices are `INFO` and **intended**
- [ ] Performance advisors show no `WARN`. New indexes appear as INFO
      `unused_index` until something queries them; that is expected on a fresh
      apply and is not a finding.

### Verify behaviour

- [ ] First submission → `1, 1, 1, 5`
- [ ] Replay → all counts unchanged, original `birId` returned
- [ ] Same session → same business, `linkMethod: session`, BIR chained
- [ ] Claimed strong identifier → `resolution_pending`, no duplicate
- [ ] Verified strong identifier → auto-links
- [ ] Two verified candidates → `resolution_pending`, no merge
- [ ] Cross-business claim → review case, identifier not written
- [ ] `submittedAt` +4 min → succeeds, clamped
- [ ] Rate limit → refuses past the limit with `retryAfterSeconds`
- [ ] Purge → removes only expired keys
- [ ] Redaction → PII gone, structure and scoring preserved
- [ ] Rollback → no orphans, key retryable

Staged flow (0004):

- [ ] Stage 1 → `1, 1, 1, 7`; `stage1.completed` and
      `preliminary_bir.generated` present, no Stage 2 event
- [ ] Stage 1 report → `provisional true`, band never `ask_for_sale`,
      `approvedLanguageKey` null
- [ ] Stage 2, same session → same business, `supersedes_bir_id` = preliminary,
      `current_bir_id` moved, preliminary preserved, 7 events
- [ ] `bir.generated` and `{preliminary,full}_bir.generated` share one
      `occurred_at` — see Defect 3
- [ ] Replay of either stage → nothing created, no staged event fires twice
- [ ] Unstaged payload → 5 events, no staged event of any kind
- [ ] Skew at +5 min → every staged event clamped, `recorded_at >= occurred_at`
- [ ] Four forced rollbacks → counts identical, no dangling `current_bir_id`,
      no BIR superseding a missing BIR, key retryable
- [ ] Capacity fixtures → page range equals `capacityAdjusted` after a round
      trip; zero capacity clamps without zeroing; unknown stays unconstrained
      with `ceilingKnown false`
- [ ] Stage 1 payload contains **no** Stage 2 answer key

### Verify refusals

All 19 in §4 must be refused.

### Clean up

- [ ] Remove volume-seed rows by their marker
- [ ] `drop schema if exists cip_test cascade`
- [ ] Remember: ingested rows are permanent (see the integration README)

---

## 2. Defects found

Real execution found three things the in-memory double could not, plus one
limitation worth stating rather than discovering later.

### Defect 3 — the BIR stage event carried the wrong timestamp *(fixed)*

Found in run 2, first execution.

`bir.generated` and `preliminary_bir.generated` describe **the same BIR insert
in the same transaction**. `ingest_assessment` anchors its event on
`least(submitted_at, now())` — the clamped visitor timestamp. The 0004 trigger
anchored on `generated_at`, which is server receive time.

Measured drift in the first run: **104 seconds**.

That gap is not bounded by clock skew. A submission delivered from the browser
retry queue can be up to `CED_SUBMISSION_MAX_AGE_DAYS` — currently **30 days**
— old, and the two events would then sit a month apart on a timeline that is
append-only and cannot be corrected. A reader sorting by `occurred_at` would
conclude the preliminary report was generated long after the BIR it *is*.

**Fixed** by looking the submission up by primary key and using the same
clamped value:

```sql
select least(s.submitted_at, now()) into v_occurred_at
  from public.assessment_submissions s
 where s.submission_id = new.assessment_submission_id;
v_occurred_at := coalesce(v_occurred_at, least(new.generated_at, now()));
```

Re-validated: `full_bir.generated` and `bir.generated` now share
`2026-08-05 01:18:21.898+00` exactly, and all five staged BIR events written
after the fix show **0.000000** seconds of drift. Pinned by an assertion in
`tests/integration/supabase-real-db.test.mjs` sections M1 and M2.

**One drifted row survives in `ced-cip-dev` and always will.** BIR
`79f827e1-8b61-4912-a48a-ad85fdb24142`, the first Stage 1 ingestion of run 2,
carries the 104-second gap. `timeline_events` refuses `UPDATE` and `DELETE`,
so the defect's own evidence is permanent — which is the append-only guarantee
behaving exactly as designed, and a useful reminder that a bug shipped into
this store cannot be tidied away afterwards. A validation query looking for
timestamp disagreements will return 1, not 0, on this database; on a project
created after the fix it returns 0.

### Limitation — `timelineEventIds` does not include trigger events

`ingest_assessment` returns the ids it collected in its own local array. The
two rows the 0004 triggers write are not in it, because a trigger cannot append
to the calling function's variable. A Stage 1 ingestion returns **5** ids while
**7** rows were written.

Nothing reads this field for business logic; the endpoint uses its length for
one log line, which now under-reports. Every event is discoverable by
`correlation_id = submissionId`, which is what the integration suite uses.

**Not fixed.** Closing it means redefining the 490-line function to re-query
its own writes, and a transcription error in the 485 unchanged lines is a
likelier failure than the gap itself. Recorded here and asserted in M1 so it
stays a decision rather than a surprise.

### Defect 4 — the roll-up turned "no stage yet" into stage zero *(fixed)*

Found in run 3, on the first probe batch.

`assessment_analytics_sessions.max_stage_reached` is constrained to
`null, 1, 2`. The forward-only merge was written as:

```sql
max_stage_reached = greatest(coalesce(s.max_stage_reached, 0),
                             coalesce(excluded.max_stage_reached, 0))
```

A session whose events carry **no stage at all** — a lone `page_viewed`, or a
`clear_saved_data` — has null on both sides. The coalesces turned that into
`greatest(0, 0)` = **0**, which is neither null nor 1 nor 2, so
`analytics_sessions_stage_check` refused the row and **aborted the entire
batch** on the *second* ingest for that session. The first insert always
succeeded, which is why it needed two batches to surface.

**Fixed** by removing the coalesces:

```sql
max_step_reached  = greatest(s.max_step_reached,  excluded.max_step_reached),
max_stage_reached = greatest(s.max_stage_reached, excluded.max_stage_reached),
```

Postgres `GREATEST` skips nulls — `greatest(null, null)` is null,
`greatest(null, 2)` is 2 — which is exactly the intended semantics and simpler
than what it replaced. **"Not reached yet" is null, never zero.**

The in-memory double missed it **twice over**: `Math.max(null, null)` is `0`
rather than null, and the double did not model
`analytics_sessions_stage_check` at all. Both are now fixed, and the case is
pinned in `tests/analytics-endpoint.test.mjs` and section N6.

### Defect 5 — the question-interaction denominator did not exist *(fixed)*

`shared/analytics/funnel.js` defines `questionInteractionRate` as
`questionInteractions ÷ visibleQuestionTotal`, and
`assessment_funnel_daily` had **no column** for the denominator. The rate was
therefore permanently `null` with reason `no_denominator` — a metric section H
of the milestone explicitly asked for, quietly unavailable.

**Fixed** by adding `visible_question_total` and a second `UPDATE` inside
`refresh_assessment_funnel_daily`. The denominator is a sum over **sessions**
of each session's maximum `visible_question_count`, not a sum over events:
summing events would count every question again on every step view. It is a
separate statement because that shape cannot be expressed alongside the
event-level aggregates without double counting.

Verified: a session reporting 23 visible questions across two step views
contributes **23**, not 46, and the rate resolves to 0.9565.

### Six privacy gaps closed

Section G attempted 24 prohibited fields against the real rules. Eighteen were
already refused; **six were not**, and each was a case where
`ANALYTICS_PRIVACY.md` claimed a protection the code did not enforce:

| Leaked | Why the token rule missed it | Fix |
|---|---|---|
| `referrerPath`, `referrerUrl` | tokenizes to *referrer* + *path*, and neither can be prohibited — `referrerHost` and the attribution `path` are both legitimate | named outright |
| `userAgent` | tokenizes to *user* + *agent* | `agent`, `useragent`, `ua` added as tokens |
| `budgetSignal`, `canApprove`, `primaryConcern`, `urgency` | ordinary words; the doc said close-related evidence is excluded and nothing enforced it | every intelligence field except the two allowlisted ones is now prohibited as a field **name**, read from `intelligence.js :: ALL_FIELDS` so a new close-related question is excluded automatically |

`questionId: "budgetSignal"` stays legal — it names a question, which a funnel
needs. `metadata: { budgetSignal: … }` does not, because that is the answer.

Separately, the endpoint now **re-buckets** viewport dimensions rather than
trusting the client's bucketing, the same way it re-applies the field-name
prohibition.

All 24 attempts are now blocked, and 28 legitimate analytics field names were
checked to confirm none is wrongly refused.

### Note — the endpoint's stage validation is load-bearing

A payload whose `assessmentStage.stage` is not an integer makes the trigger's
cast raise and aborts the whole ingestion with a raw Postgres error. That is
correct behaviour for the database — fail closed, lose nothing — and it is
exactly what the forced-rollback test exercises. It is reachable only by a
caller that bypasses the endpoint, which rejects a non-1-or-2 stage with
`400 invalid_assessment_stage` before any database work.

That validation is therefore not merely defensive. Any future server-to-server
ingestion route must repeat it.

### Defect 1 — trigger functions unhardened *(fixed)*

`reject_mutation()` and `touch_updated_at()`, created in 0001, had:

- no pinned `search_path` — flagged by Supabase's linter as
  `function_search_path_mutable` (**WARN**), the only WARN-level advisory
  raised
- the default `PUBLIC` execute grant, so `anon` and `authenticated` could call
  them, contradicting the documented claim that execute is revoked

Neither is `SECURITY DEFINER`, so exposure was small: called directly,
`touch_updated_at()` errors because it is not running as a trigger, and
`reject_mutation()` only raises. But every other function in the schema pins
its path, and the documentation asserted something untrue.

**Fixed** in 0003 §8: both recreated with
`set search_path = pg_catalog, public, pg_temp`, and execute revoked from
`public`, `anon`, `authenticated`. Advisors re-run clean.

### Defect 2 — the H1 performance claim was wrong *(corrected)*

The Milestone 1 review asserted that 0002's candidate lookup — a correlated
`EXISTS` against `business_identifiers` — "cannot use an index" and "will
seq-scan, degrading linearly with the table."

**That is false on PostgreSQL 17.** Measured against 9,008 identifier rows
across 3,006 businesses, after `ANALYZE`:

| Shape | Plan | Buffers | Time |
|---|---|---|---|
| 0002 correlated `EXISTS` | `HashAggregate` → `Nested Loop` → **Index Scan** on `business_identifiers_lookup_idx` | 8 | 0.476 ms |
| 0003 CTE + join | `Nested Loop` → **Index Scan** on `business_identifiers_lookup_idx` | 8 | 0.430 ms |

The planner pulls the correlated subquery up into a semi-join and reaches the
same index. The two shapes are equivalent in cost.

**The rewrite is kept**, because it is where verified-versus-claimed
classification lives and it states the access path explicitly rather than
relying on a planner transformation. But **H1 was not a real blocker**, its
severity should be read as cosmetic, and the "degrades linearly" claim in
[PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) §9 is wrong as written.

No defect was found in the ingestion logic itself.

---

## 3. What the first run produced

### Row counts

| After | businesses | submissions | BIRs | timeline | audit | cases |
|---|---|---|---|---|---|---|
| First submission | 1 | 1 | 1 | **5** | 1 | 0 |
| Replay (same key) | 1 | 1 | 1 | **5** | 1 | 0 |
| Second in same session | 1 | 2 | 2 | 9 | 2 | 0 |

**First submission: `1, 1, 1, 5`. Replay: unchanged.**

The five events, in order:
`business.created` → `identity.resolved` → `identity.linked` →
`assessment.completed` → `bir.generated`.

An existing business produces four (no `business.created`). An unresolved
identity produces four with `identity.review_required` and no `identity.linked`.

**After migration 0004** a *staged* submission produces more, because the
triggers append alongside those events rather than replacing them:

| Submission | Function events | Trigger events | Total |
|---|---|---|---|
| Stage 1, new business | 5 | `stage1.completed`, `preliminary_bir.generated` | **7** |
| Stage 2, existing business | 4 | `stage2.started`, `stage2.completed`, `full_bir.generated` | **7** |
| Unstaged (schema ≤ 4, or no `assessmentStage`) | 5 | none | **5** |

### Database state across run 2

| Table | Before 0004 | After run 2 | Added |
|---|---|---|---|
| `business_records` | 6 | 12 | 6 |
| `business_identifiers` | 8 | 8 | 0 |
| `assessment_sessions` | 7 | 13 | 6 |
| `assessment_submissions` | 9 | 16 | 7 |
| `business_intelligence_reports` | 9 | 16 | 7 |
| `timeline_events` | 41 | 89 | 48 |
| `identity_resolution_cases` | 3 | 3 | 0 |
| `audit_events` | 10 | 17 | 7 |
| `idempotency_records` | 9 | 16 | 7 |

Of the new rows: 7 submissions (Stage 1, Stage 2, legacy, a rollback retry, a
clock-skew case, and two capacity fixtures), 14 staged timeline events, 7 BIRs
of which 7 are schema 4, and 6 submissions at payload schema 5.

**All of it is permanent.** `timeline_events` and `audit_events` refuse
`UPDATE` and `DELETE` by trigger, and `assessment_submissions` refuses
`DELETE`; deleting the parent `business_record` does not help, because the
cascade nulls `business_id` on linked submissions and that violates
`assessment_submissions_identity_consistency`. Only `idempotency_records` and
`rate_limit_buckets` can be removed, and this run left its keys in place so the
replay assertions stay reproducible.

That is the append-only guarantee working. The remedy for a development
database with too much test history is to re-create the project and re-apply
0001–0004, not to try to delete rows.

The four forced rollbacks added **nothing** — they are counted in neither
column, which is the point of them.

### Behaviour confirmed

- **Idempotency.** Replay returned `replayed: true` with the *original* `birId`,
  ignoring the new one supplied. Same key + different hash raised
  `idempotency_key_conflict`.
- **`get diagnostics v_claimed_rows = row_count`** works with the integer
  variable 0003 introduced. (0002 assigned `row_count` to a *boolean*, which
  relied on PL/pgSQL's I/O-cast fallback. It was never exercised at runtime and
  0003 replaces it.)
- **Context is not identity.** A `vertical` signal produced no identifier row;
  only `email_exact` and `business_name` were written, both
  `verified: false`, `source: visitor_supplied`.
- **sha256, not md5.** `payload_hash` is 64 hex characters.
- **BIR chain.** `0002 supersedes 0001`, `current_bir_id` advanced only after
  insert, `report.provenance.supersedes` matched, prior BIRs preserved.
- **Clock skew (B4).** `submittedAt` four minutes ahead ingested successfully.
  `submitted_at` kept the future value verbatim; every event's `occurred_at`
  was clamped to `received_at`; all satisfied
  `recorded_at >= occurred_at`; `reportedSubmittedAt` in the event payload
  preserved the original claim.
- **Trust model.** A claimed `gbp_place_id` matching an existing business gave
  `resolution_pending` with `manual_review_required` and **no** duplicate. A
  *verified* one auto-linked. With one verified and one claimed candidate for
  the same value, the **verified holder won** and the visitor-supplied signal
  did not downgrade the verified row.
- **Squatting reserves nothing.** After a squatter claimed a place id
  unverified, the real owner was still verified against the same value — two
  rows held it, one verified.
- **Cross-business conflict (H3).** A claim on another business's verified
  identifier produced a case whose `conflicting_signals` named
  `heldByBusinessId` and `claimSource: visitor_supplied`, an
  `identity.review_required` event reading *"Cross-business claim on a verified
  identifier."*, and **no** identifier row under the claimer.
- **Rate limiting.** Limit 3: allowed at counts 1–3, refused at 4 with
  `retryAfterSeconds: 725` inside the 900-second window.
- **Purge.** Removed exactly the one expired key; the live key and all
  assessments untouched.
- **Redaction.** 3 submissions, 2 identifier rows and 3 BIR display names
  redacted. Record, 3 submissions, 3 BIRs and 14 timeline events survived.
  `estimateConfidence.band` stayed `medium`, `priceMonthly` stayed `597`,
  `technicians` stayed `3`, consent stayed `true`. Audit event written.
- **The no-PII invariant.** 0 of 41 timeline events and 0 of 10 audit events
  contained contact data — the property redaction depends on, since neither
  table can ever be updated.
- **Rollback.** An invalid `confidence_band` failed the BIR insert; afterwards
  **zero** orphans of any kind, *including the idempotency claim*, and the same
  key then succeeded.

---

## 4. Constraint violations, all correctly refused

| # | Attempt | Refused by |
|---|---|---|
| 1 | Non-UUID `business_id` | `22P02` invalid_text_representation |
| 2 | Timeline `occurred_at` in the future | `timeline_recorded_after_occurred` |
| 3 | `identity_status='linked'` with null `business_id` | `assessment_submissions_identity_consistency` |
| 4 | `resolution_pending` with a `business_id` | same |
| 5 | Duplicate **verified** strong identifier | `business_identifiers_verified_strong_unique` |
| 6 | BIR `schema_version = 99` | `bir_schema_version_check` |
| 7 | Invalid `identity_status` | `business_records_identity_status_check` |
| 8 | `business_records` with `resolution_pending` | `business_records_status_not_pending` |
| 9 | Timeline `UPDATE` | `append_only_violation` trigger |
| 10 | Timeline `DELETE` | same |
| 11 | Audit `UPDATE` | same |
| 12 | Audit `DELETE` | same |
| 13 | Submission `DELETE` | same |
| 14 | `identifier_type='vertical'` | `business_identifiers_no_context_types` |
| 15 | 3000-character identifier | **`business_identifiers_value_length`** |
| 16 | `verified` from `visitor_supplied` | `business_identifiers_verified_requires_trust` |
| 17 | `verified` with `verification_method='none'` | same |
| 18 | `payload_schema_version = 9` | `assessment_submissions_payload_version_check` |
| 19 | Raw IP as a rate-limit bucket key | `rate_limit_key_shape` |

**#15 is the one that matters most.** Before Milestone 1.1 an oversized value
reached a btree index and raised error `54000`, which is *not* a
`unique_violation`, so the ingestion function's handler could not catch it and
the whole transaction aborted. It is now refused by a CHECK constraint, which
is catchable and diagnosable. Blocker B3 confirmed fixed against real Postgres.

---

## 5. A testing lesson worth keeping

Two probes gave misleading results at first:

**Subqueries in the same statement as the mutating call read a stale snapshot.**
Calling `ingest_assessment()` in a CTE and counting rows in the same `SELECT`
returned pre-call values — the counts looked unchanged when they had in fact
changed. Under READ COMMITTED the snapshot is taken once per statement. **Never
assert on counts in the same statement that performs the write.** The Node
suite issues separate requests, so it is not exposed to this; hand-written SQL
probes are.

**`idempotency_expiry_future` blocks simulating expiry the obvious way.**
`expires_at > created_at` is enforced, so you cannot age a record out by
backdating `expires_at` alone. Insert a row with **both** timestamps in the
past.

---

## 6. EXPLAIN guidance

Seed realistic volume first — Postgres will happily seq-scan a small table, so
a plan taken against ten rows proves nothing.

```sql
explain (analyze, buffers, costs off)
with claimed as (
  select * from (values
    ('email_exact','owner@example.test'),
    ('business_name','polished nail studio')
  ) as t(identifier_type, normalized_value)
)
select bi.business_id, array_agg(distinct bi.identifier_type)
  from claimed c
  join public.business_identifiers bi
    on bi.identifier_type = c.identifier_type
   and bi.normalized_value = c.normalized_value
   and bi.valid_to is null
  join public.business_records br
    on br.business_id = bi.business_id and br.merged_into_business_id is null
 group by bi.business_id;
```

**Expect** `Nested Loop` → `Index Scan using business_identifiers_lookup_idx`.
Observed at 9,008 rows: 8 shared buffer hits, 0.430 ms.

A `Seq Scan` on `business_identifiers` means the partial index is missing —
check that 0003's `drop`/`create` pair applied. Per §2, note that the *old*
query shape also reaches this index on PG17, so a seq scan indicates a missing
index rather than the wrong query shape.

---

## 6c. Run 3 — migration 0005, the analytics store

**Executed 2026-08-05 against `ced-cip-dev`, Postgres 17.6.1.155.**

| | |
|---|---|
| Migrations | 0005, after 0001–0004 |
| Method | Supabase management API; SQL executed directly |
| Result | 47 checks passed, **2 defects found and fixed**, 6 privacy gaps closed |
| Business Record rows changed | **0** |

### Structure

| Check | Result |
|---|---|
| Applies cleanly | ✔ in five parts, two of them the fixes below |
| Three tables exist | ✔ `assessment_analytics_events`, `assessment_analytics_sessions`, `assessment_funnel_daily` |
| RLS enabled **and** forced on all three | ✔ |
| Policies | ✔ **0** on all three |
| `anon` / `authenticated` privileges | ✔ no SELECT, no INSERT on any |
| Indexes | ✔ 14, including the three expression indexes |
| CHECK constraints | ✔ 8 |
| Append-only trigger on raw events | ✔ `analytics_events_no_update` → `reject_mutation` |
| Session `updated_at` trigger | ✔ `analytics_sessions_touch` |
| Functions | ✔ 5, all `SECURITY DEFINER`, all pinning `search_path`, execute revoked from `public`, `anon`, `authenticated` |
| Security advisors | ✔ 13 × INFO `rls_enabled_no_policy` (10 existing + 3 new). **No new WARN.** |
| Performance advisors | ✔ all INFO. New `unused_index` notices on analytics indexes not yet exercised. **No new WARN.** |

### Isolation — the check that matters most

```sql
select count(*) from pg_constraint
 where contype = 'f'
   and (conrelid::regclass::text  like 'assessment_analytics%'
     or confrelid::regclass::text like 'assessment_analytics%');
-- 0
```

**Zero foreign keys in either direction.** Also zero analytics functions whose
body references `business_records`, `assessment_submissions`,
`business_intelligence_reports`, `timeline_events`, `audit_events` or
`identity_resolution_cases`.

Business Record counts were taken before the run and again after **every**
analytics operation — 636 event inserts, 68 session roll-ups, nine aggregation
runs, and four purges:

| Table | Before | After |
|---|---|---|
| `business_records` | 12 | **12** |
| `assessment_submissions` | 16 | **16** |
| `business_intelligence_reports` | 16 | **16** |
| `timeline_events` | 89 | **89** |
| `audit_events` | 17 | **17** |
| `identity_resolution_cases` | 3 | **3** |

One column matched a PII-shaped-name scan: `event_name`. That is the same
"name" substring false positive the token rule already exempts, and is not a
finding.

### Event families

All **19 event names** were ingested and stored. Arrival, progress, stage,
intent and other are each represented; 611 fixture events across 63 sessions
plus 25 targeted probes.

| Check | Result |
|---|---|
| Valid event inserts | ✔ |
| Duplicate `eventId` → no second row, reported as `duplicates` | ✔ |
| Empty batch | ✔ `analytics_empty_batch` |
| Mixed-session batch | ✔ `analytics_mixed_sessions` |
| `assessment_stage = 7` | ✔ refused by `analytics_events_stage_check` |
| `schemaVersion = 99` | ✔ refused |
| `activeElapsedMs > totalElapsedMs` | ✔ refused by `analytics_events_timing_sane` |
| Negative duration | ✔ refused |
| Future timestamp | ✔ **clamped**, not refused |
| `UPDATE` on a raw event | ✔ refused: *append_only_violation* |

### Roll-up

| Check | Result |
|---|---|
| Events and summary in one transaction | ✔ |
| Late event does not rewind `result_state` | ✔ `fit_review_complete` held |
| `latest_step_id` / `max_step_reached` monotonic | ✔ stayed at 14 |
| `total_active_ms` / `total_elapsed_ms` never decrease | ✔ |
| Stage timestamps write-once | ✔ an earlier duplicate `stage1_completed` was ignored |
| `started_at` **does** move earlier | ✔ intentional — an earlier start is genuinely earlier |
| Duplicate batch does not inflate counters | ✔ `validation_failures` 1 → 1 |
| Abandonment retracted on return | ✔ `abandoned` → `preliminary_results`, `abandoned_at` cleared |
| Stage 1 completion then exit is **not** abandoned | ✔ 0 such sessions |

### Funnel, from real aggregate rows

`refresh_assessment_funnel_daily` produced 9 rows across 4 segment dimensions
(source × device × vertical × assessment version). Counters fed through
`shared/analytics/funnel.js`:

| Rate | Value | |
|---|---|---|
| view → start | 0.7541 | 46/61 |
| start → Stage 1 | 0.7609 | 35/46 |
| Stage 1 → result view | 0.9714 | 34/35 |
| result → Stage 2 start | 0.4412 | 15/34 |
| Stage 2 start → complete | **withheld** | 12/15, below the sample floor |
| result → recommended system | 0.1471 | 5/34 |
| result → personal review | 0.0882 | 3/34 |
| result → checkout intent | 0.0588 | 2/34 |
| view → Stage 2 | 0.1967 | 12/61 |
| validation failure | 0.4348 | 20/46 |
| resume | 0.0870 | 4/46 |
| abandonment | 0.1957 | 9/46 |

Median active time: Stage 1 **282,859 ms**, Stage 2 **460,000 ms**.

| Aggregation check | Result |
|---|---|
| Safe rerun (×2) | ✔ 8 rows → 8 rows, 65 → 65 page views |
| Empty day | ✔ 0 rows written |
| Duplicate-event immunity | ✔ `stage1_completions` 38 → 38 |
| Late event dated to **its own** day | ✔ landed on 2026-08-02, not today |
| Multiple verticals | ✔ `nails` and `val02-vertical-b` |
| Multiple assessment versions | ✔ 1.3.0, 1.2.0, `unknown` |
| Sessions for stages, events for clicks | ✔ 30 sessions = 30 page views; 2 clicks = 2 |

### Drop-off, with a deliberately weak step

| Step | Stage | Entered | Completed | Exits | Validation failures | Median active | Abandonment |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 45 | 45 | 0 | 0 | 30,000 ms | 0.0% |
| 2 | 1 | 41 | 40 | 1 | 0 | 28,000 ms | 2.4% |
| **7** | 1 | 39 | 29 | 10 | 20 | 51,000 ms | **25.6%** |
| 13 | 2 | 14 | 11 | 3 | 0 | 24,000 ms | *withheld* |
| 14 | 2 | 1 | 0 | 1 | 0 | — | *withheld* |

Step 7 was correctly identified as `highestAbandonmentStepId`. Step 14 shows
100% abandonment on **one** session and was correctly withheld rather than
outranking it. 3 steps reportable, 2 withheld. **No recommendation generated.**

### Retention

| Check | Result |
|---|---|
| Purge at `now()` | ✔ deleted 0; newer events untouched |
| Purge past expiry | ✔ deleted exactly the 1 expired row |
| Aggregates after purge | ✔ 9 rows / 66 page views, unchanged |
| Session purge honours its own expiry | ✔ 1 deleted past expiry, 0 at `now()` |
| `clear_saved_data` retained | ✔ 2 events kept — the record of an erasure outlives the erased data |

### Transport gap

**The endpoint was not exercised against this database.** No service-role key
was available in the working shell and asking for one is out of bounds, so
section E ran against `api/analytics.mjs` through the unit suite's in-memory
double (32 endpoint tests: origin, body bounds, batch limits, mixed
valid/invalid, rate limiting with `Retry-After`, correlation ids, no payload in
logs) while the database functions were driven directly over the management
API.

What that leaves unproven: PostgREST's resolution of the
`ingest_analytics_events(jsonb, jsonb, integer)` signature, and its
serialisation of a batch. Section N of `supabase-real-db.test.mjs` is written
and guarded and will exercise it on the next run with credentials present.

---

## 6b. Section M — migration 0005, the analytics store

**Superseded by section 6c above, which records the executed run.** The
checklist below remains the procedure for repeating it on a fresh project.

0005 is the first migration that adds *tables* since 0001, and the first whose
failure mode is "a funnel is wrong" rather than "a Business Record is wrong".
That difference sets the priorities below: isolation is checked before
correctness, because an analytics table that can reach the Business Record is a
worse problem than a miscounted step.

### Prepare

- [ ] Confirm 0001–0004 are applied and the section-0 checks still pass.
- [ ] Record row counts for **all** tables, analytics and Business Record
      alike. The Business Record counts must not move by a single row during
      this run.

### Apply

- [ ] `0005_assessment_analytics.sql`

### Verify structure

- [ ] Three new tables: `assessment_analytics_events`,
      `assessment_analytics_sessions`, `assessment_funnel_daily`
- [ ] RLS **enabled** and **forced** on all three, with **0** policies
- [ ] `revoke` verified: `anon` and `authenticated` have no privilege on any of
      them
- [ ] Five new functions, all `SECURITY DEFINER`, all pinning
      `search_path = pg_catalog, public, pg_temp`, all with execute revoked
      from `public`, `anon`, `authenticated`:
      `ingest_analytics_events`, `refresh_assessment_funnel_daily`,
      `assessment_step_dropoff`, `purge_expired_analytics_events`,
      `purge_expired_analytics_sessions`
- [ ] `analytics_events_no_update` trigger exists and uses `reject_mutation`
- [ ] **Zero foreign keys** from any analytics table to `business_records`,
      `assessment_submissions`, or `business_intelligence_reports`:
      ```sql
      select conname, conrelid::regclass, confrelid::regclass
        from pg_constraint
       where contype = 'f'
         and conrelid::regclass::text like 'assessment_analytics%';
      ```
      This must return **no rows**. It is the structural proof of the isolation
      rule, and it is the single most important check in this section.
- [ ] No column on any analytics table is named for personal data. Inspect
      `information_schema.columns` and read the list.
- [ ] Advisors show no new `WARN`. New indexes will appear as INFO
      `unused_index` until something queries them.

### Verify behaviour

- [ ] A batch of one event inserts one row and creates one session row
- [ ] Re-sending the same batch inserts nothing and returns the ids as
      `duplicates`, not `accepted`
- [ ] A batch spanning two sessions raises `analytics_mixed_sessions`
- [ ] An empty batch raises `analytics_empty_batch`
- [ ] `active_elapsed_ms > total_elapsed_ms` violates
      `analytics_events_timing_sane`
- [ ] An `occurred_at` in the future is clamped by the function, not rejected
- [ ] `update` on `assessment_analytics_events` is refused by the trigger
- [ ] A journey of seven events rolls up to one session row with
      `result_state = 'preliminary_results'`
- [ ] A **late** event from earlier in the session does not rewind
      `result_state`, `total_active_ms`, or `max_step_reached`
- [ ] An abandonment followed by a completion clears `abandoned_at`
- [ ] `refresh_assessment_funnel_daily` counts **sessions** for stage columns
      and **events** for click columns
- [ ] Running it twice for the same range replaces rather than accumulates
- [ ] `assessment_step_dropoff` returns one row per step with sane counters
- [ ] `purge_expired_analytics_events` deletes only expired rows and **leaves
      `assessment_funnel_daily` untouched**

### The check that matters most

- [ ] After every behavioural test above, re-run the Business Record row counts
      from *Prepare*. **Every one must be unchanged.** If a single
      `business_records`, `assessment_submissions`,
      `business_intelligence_reports`, `timeline_events` or `audit_events` row
      moved, migration 0005 has broken the isolation rule and must not ship.

### Integration suite

`tests/integration/` has no analytics section yet. The unit suite covers the
contract through `tests/helpers/fake-analytics-db.mjs`, which mirrors 0005 step
for step; a real-Postgres section should be added at the same time this
migration is first executed, following the pattern of section M in
`supabase-real-db.test.mjs`.

---

## 7. What this did **not** validate

- **Run 2 did not go through PostgREST.** No service-role key was available in
  the working shell, and asking for one is out of bounds, so run 2 executed its
  SQL through the Supabase management API rather than through
  `db.rpc(...)` the way `api/assessments.mjs` does. Same database, same
  functions, same triggers, same artifacts — a different transport.

  What that leaves unproven for the staged flow specifically: PostgREST's
  resolution of the 8-argument `ingest_assessment` signature, and its
  serialisation of a schema-5 payload. Both are already proven for the
  unstaged flow by run 1, and neither is affected by 0004, which adds no
  function signature and no new argument. Section M of
  `tests/integration/supabase-real-db.test.mjs` is written and guarded and
  will exercise the PostgREST path on the next run with credentials present;
  it has **not yet been executed**.
- **The Vercel Function itself.** The endpoint's own code path — origin policy,
  bounded body reading, limits, honeypot, challenge, rate-limit key derivation
  — is covered by the unit suite (336 tests), not here. Only the SQL it calls
  was exercised against real Postgres.
- **Concurrency.** `request_in_flight` was not reproduced under genuine
  parallel load; it needs two simultaneous connections holding one key. The
  logic is exercised, the race is not.
- **Scale.** 9,008 identifier rows is enough to make the planner choose an
  index; it is not a load test.
- **Run 1 did not push the full production BIR** through the SQL; its fixture
  is a compact stand-in carrying exactly the fields the function reads or
  writes. **Run 2 did.** Every report in run 2 is the real `generate-bir.js`
  output, validated by `validateGeneratedBir` before storage and read back
  from Postgres afterwards, so section 0's BIR assertions are made against
  stored JSON rather than remembered objects.

  Two of the four capacity fixtures were assembled by taking the real
  `capacity90Day = 11_20` report and replacing the five sections that actually
  differ by band — `capacityProfile`, `financialOpportunityProfile`,
  `estimateConfidence`, `riskProfile`, `closeReadinessProfile` — with the real
  generated values for that band. The remaining sections are identical because
  nothing else in the report depends on capacity, which was verified by
  diffing the two full artifacts first (26 and 38 differing leaf paths, all
  inside those five sections plus `provenance.inputHash` and two derived
  narrative fields).
- **Anything about compliance.** Redaction was proven to behave as designed.
  That is a technical statement and nothing more.
