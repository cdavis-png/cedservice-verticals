# Supabase setup

Manual steps to connect the Milestone 1 implementation to a real project.

> **This document once opened "none of this has been done yet — no project
> exists".** That is wrong and has been for some time. A persistent hosted
> **development** project exists — `qkpptajglstgucadhfwq`, PostgreSQL
> 17.6.1.155 — and its `supabase_migrations.schema_migrations` records
> migrations **0001 through 0011**, plus one entry
> (`20260806171939 create_aeo_answer_visibility_module`) that has no
> repository file. 0009 and 0010 were applied *before* they were committed
> and their files are records rather than pending work — see CLAUDE.md §14.
>
> 0008 was applied on 2026-08-09 through the tracked `apply_migration`
> operation, at ledger version `20260809173146`, and its post-application
> verification passed in full. A read-only preflight confirmed all three of its
> findings on the real database first. See runs 14, 15 and 16 in
> [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md).
>
> Nothing is deployed for public traffic, no production project exists, and
> **no elevated credential is configured on any Vercel environment** — which is
> why protected staff operations are unavailable regardless of what the
> database holds. The schema is ready; the deployment is not.

---

## 1. Create the project

1. Create a Supabase project. Choose a region close to your customers.
2. Note the **Project URL** (`https://<ref>.supabase.co`).
3. Under **Project Settings → API keys**, copy the **secret** key
   (`sb_secret_…`). Configure it as `SUPABASE_SECRET_KEY`.

> **The secret key bypasses Row Level Security and can read and write every
> table.** It belongs only in the Vercel Function environment. Never put it in
> browser code, never prefix it with `NEXT_PUBLIC_`, never paste it into a
> vertical config, and never commit it. If it is ever exposed, rotate it in
> Supabase immediately.
>
> **`SUPABASE_SERVICE_ROLE_KEY` is the legacy name for the same privilege
> level and is accepted only for compatibility with projects configured before
> the rename.** Do not obtain or configure one for a new deployment. All three
> server surfaces select their key through
> [shared/security/supabase-keys.js](../shared/security/supabase-keys.js),
> which prefers `SUPABASE_SECRET_KEY` and falls back to the legacy name only
> when the preferred variable is **unset**. A preferred variable that is set
> but malformed is a refusal, not a fallback — see §3.
>
> The **publishable** key (`sb_publishable_…`, legacy name `anon`) is a
> different privilege level and is configured separately. It is required only
> by the staff onboarding and recovery pages, which call Supabase Auth
> directly; it grants nothing, which
> `tests/migration/0007-anon-grants.test.mjs` proves as a catalog fact. The
> assessment and analytics endpoints do not use it.

---

## 2. Apply the migrations

There are two situations, and they need different procedures. Decide which one
you are in **before** running anything.

| | A brand-new project | The existing development project |
|---|---|---|
| State | Empty | **0001–0011 applied and recorded** |
| To apply | 0001 → 0011, in order | **nothing** |
| Procedure | §2a | §2b, retained as the worked example |

> **The right-hand column is now history.** It read "0001–0007 applied / apply
> 0008 only" while that was the decision in front of us. `qkpptajglstgucadhfwq`
> is fully migrated; §2b is kept because it is the pattern the next migration
> follows, not because anything in it needs running.

### 2a. A brand-new, empty project

In order, all of them:

```
supabase/migrations/0001_business_record_foundation.sql
supabase/migrations/0002_ingest_assessment.sql
supabase/migrations/0003_production_hardening.sql
supabase/migrations/0004_assessment_intelligence_expansion.sql
supabase/migrations/0005_assessment_analytics.sql
supabase/migrations/0006_service_mix_review.sql
supabase/migrations/0007_staff_identity_resolution.sql
supabase/migrations/0008_staff_migration_hardening.sql
supabase/migrations/0009_bi_sales_handoff_foundation.sql
supabase/migrations/0010_sales_handoff_fk_indexes.sql
supabase/migrations/0011_promotion_business_serialization.sql
```

0009 is **not re-runnable** — it is a reconciled record of SQL that was applied
before it was committed, and its `create` statements are bare (CLAUDE.md §14).
On an empty project that is fine: it runs exactly once, in order. Do not apply
it to a database that already has it.

0003 depends on both predecessors. It **drops and recreates**
`ingest_assessment` (the signature gains a `p_meta` argument, so
`create or replace` would leave two ambiguous overloads) and **narrows** the
strong-identifier unique index to verified rows only. See
[PRODUCTION_HARDENING.md §2](PRODUCTION_HARDENING.md#2-migration-order).

**Apply them through the tracked workflow, one file per operation, in order** —
the same mechanism §2b specifies for 0008: the connected Supabase
**MCP `apply_migration`** operation, with the migration name taken from the
file name (`0001_business_record_foundation`, and so on) and the query set to
that file's exact UTF-8 contents. Each call applies the DDL **and** records the
migration in `supabase_migrations.schema_migrations`.

Confirm after each one that the expected history row appeared before moving to
the next. A chain that is half-applied and half-recorded is worse to untangle
than one that stopped cleanly.

> **The SQL Editor is not an option here either.** An earlier revision of this
> document offered it as a "by hand" alternative. It applies the DDL and
> records nothing, so a project set up that way starts life with an empty
> migration history and a fully migrated schema — the exact state that made
> the development project's history unknowable until a preflight went and read
> it. **`supabase db push` is also prohibited**, for this project and for a new
> one. Both prohibitions are listed in full in §2b and apply to every project,
> not only the existing one.

### 2b. The existing development project — 0008 is applied

> **DONE. Nothing in this section needs running against
> `qkpptajglstgucadhfwq` again.** Migration `0008_staff_migration_hardening`
> was applied through the tracked `apply_migration` operation and recorded at
> ledger version **`20260809173146`**, from blob
> `f992a3a85c40abf429d7d346de09fb0ad9102f19` (commit `6939887`). The hosted
> ledger records migrations **through 0008**, and the post-application
> verification passed in full — see
> [REAL_POSTGRES_VALIDATION.md run 16](REAL_POSTGRES_VALIDATION.md).
>
> The rest of §2b is **retained as the worked procedure**, because it is the
> pattern the next migration follows and because the preflight it describes is
> the evidence that made applying 0008 a repair rather than a guess. Read the
> preflight table as the *before* state. Do not re-run the apply step.

**What was applied.** Migration 0008 is forward-only. It repairs three defects
in 0006 — F3 trigger coverage, F6 a `service_role` grant, F7 two unpinned
`search_path`s — and edits no earlier file. The rule behind that is in
[CLAUDE.md §14](../CLAUDE.md): applied history is never rewritten.

#### What the preflight established *(the "before" state)*

A read-only hosted preflight was run first. It replaced the uncertainty this
section previously described, and every finding in it was subsequently
**confirmed fixed** by the post-application verification:

| Question | Answer |
|---|---|
| Migration history | `supabase_migrations.schema_migrations` records **0001–0007** |
| 0006 | `20260808200326 / 0006_service_mix_review` |
| 0007 | `20260808201535 / 0007_staff_identity_resolution` |
| 0008 | **Not recorded. Not applied.** |
| Deployed `enforce_bir_supersession_scope()` | **Matches repository 0006, exactly** |
| Deployed `bir_supersession_scope` trigger | `BEFORE INSERT` only — the F3 defect, confirmed present |
| F6 | `service_role` holds EXECUTE on the **12** internal functions from 0001/0004/0006; 0007's four are already correctly refused |
| F7 | `identity_value_acceptable` and `identity_evidence_fault` are the only public functions with no pinned `search_path`, and Supabase's security advisor reports exactly those two |
| Data | 12 Business Records, 16 submissions, 16 BIRs, 3 cases, 3 supersession chains, **0 supersession violations** of either kind |

Two consequences follow, and both matter.

**The definition comparison is done, and it matched.** `create or replace
function public.enforce_bir_supersession_scope()` overwrites whatever is
deployed under that name, so applying 0008 blind could have silently destroyed
a hosted difference. There is no difference. Re-run the comparison if
significant time passes or anyone touches the SQL editor in between —

```sql
select pg_get_functiondef('public.enforce_bir_supersession_scope()'::regprocedure);
```

— and **stop if it no longer matches `0006_service_mix_review.sql` §5.**
Otherwise this step is satisfied.

**The 12-function scope of F6 is confirmed as a real defect, not a
precaution.** `service_role` genuinely holds EXECUTE on all twelve, because a
Supabase project's default privileges grant it directly and 0006 revoked only
from `public, anon, authenticated`. Do not narrow 0008's revoke list.

#### Applying it — the procedure that was followed, and the one to reuse

**The mechanism is named, not left to judgement.** 0008 **was** applied through
the connected Supabase **MCP `apply_migration`** operation, with exactly these
inputs. The same shape applies to the next migration; substitute its name and
file.

| Input | Value used for 0008 |
|---|---|
| Project | `qkpptajglstgucadhfwq` |
| Migration name | `0008_staff_migration_hardening` |
| Query | the exact UTF-8 contents of `supabase/migrations/0008_staff_migration_hardening.sql`, **from the approved commit** — blob `f992a3a85c40abf429d7d346de09fb0ad9102f19`, commit `6939887` |
| Recorded as | ledger version **`20260809173146`** |

That single operation applies the DDL **and** records the migration in
`supabase_migrations.schema_migrations`. Both halves happen together, which is
the entire reason this mechanism was chosen: a migration that runs without
being recorded leaves the history lying about the schema, and the next person
to reconcile the two has no way to tell an unrecorded migration from an
unapplied one.

**The query is the file, byte for byte.** Do not retype it, do not reflow it,
do not apply a subset "to start with", and do not edit it in transit to fix
something noticed at the last moment. If the file needs to change, it changes
in the repository, is reviewed, and is committed — and the commit that is
applied is the one that was approved. The verification queries below assume
the whole file ran.

**Explicit human authorization is required immediately before the operation**,
in the same sitting, against this project reference. Standing approval of the
plan is not approval to run it: this is a privileged, schema-altering write to
a database holding 12 Business Records, and the authorization must be given
with the project ref and migration name in view. An authorization given
earlier, or for a different project, or before a change to the file, does not
carry over.

Prohibited, without exception:

- **No SQL Editor.** It applies the DDL and records nothing.
- **No `supabase db push`.**
- **No separate manual insertion of a history row.** `apply_migration` writes
  it. Writing one by hand — before, after, or instead — creates a record whose
  truthfulness nothing checked, which is the failure this whole procedure
  exists to prevent.
- **No migration repair.** `supabase migration repair` rewrites history to
  match an assumption. The history here has been read and is correct; there is
  nothing to repair, and a repair command run against a correct history can
  only make it wrong.

**Before applying, confirm the F6 precondition is still true.** It depends on
default privileges rather than on anything in a migration file, so it is the
one finding that could change without a migration running:

```sql
select has_function_privilege('service_role',
         'public.identity_proposal_conflict(jsonb, uuid)', 'EXECUTE') as before_0008;
-- expect true — that IS the defect, and the preflight observed it
```

**Then apply `0008_staff_migration_hardening.sql`.** *(Done — ledger version
`20260809173146`.)*

**Verify. Every one of these is a catalog fact, not an opinion.** All of them
were run immediately after the application and all passed; the expected results
below are what was observed.

```sql
-- it is recorded, not merely applied
select version, name from supabase_migrations.schema_migrations order by version;
-- expect a row for 0008 after the two the preflight found:
--   20260808200326 / 0006_service_mix_review
--   20260808201535 / 0007_staff_identity_resolution
--   20260809173146 / 0008_staff_migration_hardening   ← observed
```

```sql
-- F3: the trigger now covers UPDATE as well as INSERT
select tgname, pg_get_triggerdef(oid) as def
  from pg_trigger
 where tgrelid = 'public.business_intelligence_reports'::regclass
   and tgname = 'bir_supersession_scope';
-- expect: BEFORE INSERT OR UPDATE ... FOR EACH ROW

-- F6: no internal function is executable by the server credential
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('reject_mutation','touch_updated_at',
                     'append_stage_timeline_events','append_bir_stage_event',
                     'append_service_mix_timeline_event','append_service_mix_bir_event',
                     'enforce_bir_supersession_scope','enforce_growth_only_current_bir',
                     'analytics_review_type','identity_proposal_conflict',
                     'identity_value_acceptable','identity_evidence_fault',
                     'identity_case_eligible_targets','mask_contact_value',
                     'identity_resolution_replay','reject_case_evidence_change')
   and has_function_privilege('service_role', p.oid, 'EXECUTE');
-- expect zero rows

-- F6, the other half: everything the server calls still works
select has_function_privilege('service_role',
         'public.ingest_review(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb, text, uuid)',
         'EXECUTE') as ingest,
       has_function_privilege('service_role',
         'public.resolve_identity_case_link_existing(uuid, text, uuid, uuid, uuid, text, text, jsonb, text, boolean, text)',
         'EXECUTE') as resolve;
-- expect true, true

-- F7: no function in the schema is left with an unpinned search_path
select proname from pg_proc
 where pronamespace = 'public'::regnamespace and prokind = 'f' and proconfig is null
 order by proname;
-- expect zero rows
```

**What was observed, in full.** Every check above passed:

| Check | Result |
|---|---|
| Ledger | records through 0008 at `20260809173146` |
| F3 | `bir_supersession_scope` is an **enabled, row-level `BEFORE INSERT OR UPDATE`** trigger |
| F6 | all 16 internal functions exist; none exposes unexpected EXECUTE to `PUBLIC`, `anon`, `authenticated` or `service_role` |
| F7 | both helpers carry pinned search paths |
| Security advisor | the two mutable-search-path warnings are **gone** |
| Performance advisor | **unchanged** — 0008 adds no index, column or plan-visible object |
| Data | 12 Business Records, 16 submissions, 16 BIRs, 3 cases, 3 supersession chains — all intact |
| Integrity | zero broken predecessors, zero cross-business violations, zero cross-review-type violations |

**Behavioural checks, because a catalog entry is not a behaviour.** Run inside
a transaction and rolled back, so the database takes **zero persistent test
writes**:

| Case | Result |
|---|---|
| A valid update to a chained report | **allowed** |
| Moving a chained report to another business | **rejected** |
| Changing a chained report's review type | **rejected** |
| An invalid predecessor | **rejected** |
| An unknown predecessor | **rejected** |

**Still worth doing when a credential exists.** Ingest one Growth submission
through `ingest_assessment` and confirm it succeeds. 0008 revoked
`identity_proposal_conflict`, `identity_value_acceptable` and
`identity_evidence_fault` from every role, and ingestion calls all three from
inside a SECURITY DEFINER function — so this is where a wrong revoke would
show. It has **not** been run against the hosted project, because no elevated
credential is configured on any Vercel environment; the local suite covers the
same path against PGlite.

#### If something goes wrong

*(Not exercised for 0008 — the application and verification both passed. This
is the standing procedure for the next migration, and for 0008 itself should a
later problem surface.)*

**There is no rollback step, and the blanket one this section used to carry was
unsafe.** It said to "`grant execute` the sixteen internal functions back to
`service_role`". Four of those sixteen —
`identity_case_eligible_targets`, `mask_contact_value`,
`identity_resolution_replay` and `reject_case_evidence_change` — originate in
0007, which revoked them from `service_role` correctly, and the preflight
confirmed they were **already blocked before 0008 ran**. Restoring all sixteen
would not undo 0008; it would grant the server credential execute on four
functions it has never been allowed to call, and leave the database less safe
than it was before anything was attempted. A rollback that overshoots its own
migration is worse than the defect it is undoing.

What to do instead depends on where the failure landed.

**`apply_migration` reports failure.** Inspect the migration history and the
affected catalog objects *before* retrying — do not retry on the assumption
that nothing happened:

```sql
select version, name from supabase_migrations.schema_migrations order by version;

select pg_get_functiondef('public.enforce_bir_supersession_scope()'::regprocedure);

select tgname, pg_get_triggerdef(oid) as def
  from pg_trigger
 where tgrelid = 'public.business_intelligence_reports'::regclass
   and not tgisinternal
 order by tgname;

select proname, proconfig from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('identity_value_acceptable','identity_evidence_fault');
```

**If 0008 is absent from the history and the database is still in its preflight
state** — the supersession function matching 0006, the trigger `BEFORE INSERT`
only, the two helpers unpinned — then nothing took effect and the operation may
be retried **once the cause of the failure has been determined**. Retrying
without knowing why it failed is how a transient-looking failure becomes a
partial application nobody expected.

**If 0008 IS recorded but the post-apply verification above fails**, the
history is correct and the schema is not what was expected. Do **not**:

- delete its history row,
- mark it reverted,
- rerun it blindly,
- or manually reverse everything it did.

Instead, **create a forward-only `0009` migration containing only the required
corrective change**, and apply it through the same `apply_migration` operation.
This is the rule from [CLAUDE.md §14](../CLAUDE.md), applied to 0008 itself:
applied history is never rewritten, including 0008's.

Two constraints on what 0009 may contain:

- **Do not reverse F6 or F7 merely because F3 needs correcting.** The three
  repairs are independent. A `search_path` that is now pinned and a grant that
  is now revoked are both correct regardless of what the trigger is doing, and
  unpicking them to "get back to a known state" discards two good fixes to
  address a third.
- **Never restore `service_role` access to an internal function** unless a
  specific application dependency proves that exact grant is necessary — named
  function, named caller, named failure. "Something might need it" is not
  evidence, and the four 0007 functions above are the standing example of
  grants that were correctly absent all along.

**What 0008 has now had.** It is applied and recorded on the hosted
development project (PostgreSQL 17.6.1.155), verified against the catalog, the
security advisor and the data, and exercised behaviourally inside a rolled-back
transaction. It is also tested against a disposable PostgreSQL 18.3 through
PGlite by `tests/migration/0008-migration-hardening.test.mjs`, which observes
all three defects present before applying it and gone afterwards.

**What it still has not had.** Nothing in this repository has been
successfully *called* through PostgREST, so the schema 0008 hardened has never
been reached by application code. That needs an elevated credential on a Vercel
environment, which is a separate phase.

### Verify

```sql
-- 10 tables, all with RLS enabled and zero policies
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;
select count(*) as policy_count from pg_policies where schemaname = 'public';  -- expect 0

-- five functions, and exactly ONE ingest_assessment signature
select proname, pronargs from pg_proc
 where proname in ('ingest_assessment','check_rate_limit','redact_business_pii',
                   'purge_expired_idempotency_records','purge_expired_rate_limit_buckets')
 order by proname;

-- the uniqueness backstop now covers verified identifiers only
select indexname from pg_indexes
 where tablename = 'business_identifiers' and indexname like '%strong%';
-- expect business_identifiers_verified_strong_unique, and NOT the old
-- business_identifiers_strong_unique
```

A non-zero `policy_count` means someone added a policy. In this milestone that
is wrong: there is no anonymous or authenticated access path by design.

Two `ingest_assessment` rows means 0003's `drop` did not take effect and the
PostgREST call will be ambiguous.

### Smoke test the function

*Historical, superseded:* this section once read "the SQL has never been
executed", which was true when it was written and is not now.

**Current status.** Migrations **0001–0011** are applied and recorded on the
hosted development project (Supabase PostgreSQL 17.6.1.155), 0008 at ledger
version `20260809173146` with its post-application verification passed, 0009 at
`20260814182709` and 0010 at `20260814182839` — those two applied before they
were committed and reconciled afterwards from the stored statements — and 0011
at `20260815025341`, which went in the right order: committed and reviewed
first, then applied. 0006,
0007 and 0008 have additionally been executed against a disposable local
PostgreSQL 18.3 through PGlite. No privileged RPC has been called through
PostgREST. See [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) runs
14, 15 and 16, which are the one place this is stated.

**`GET /auth-config` — what is and is not known.** The endpoint exists in the
staff-onboarding implementation, and its response contract is covered by the
automated unit and browser suites against local servers. **No reproducible
hosted HTTP 200 request to it has been identified.** An earlier version of
this paragraph asserted one; that assertion is withdrawn for want of any
evidence record — no host, deployment id, timestamp, response body or headers
were ever captured. The current Preview is protected by Vercel SSO, so the
deployed endpoint's response, headers and returned public configuration remain
**unobserved**. Nothing here asserts that no manual call was ever made; only
that no sufficient record of one exists.

Executing the SQL is still not the same as smoke-testing this project. Do not
stop at the happy path — the full sequence, including the constraint-violation
cases the in-memory test double cannot prove, is in
[PRODUCTION_HARDENING.md §11](PRODUCTION_HARDENING.md#real-postgres-test-plan).

At minimum, before any traffic:

```sql
select
  (select count(*) from business_records)            as businesses,
  (select count(*) from assessment_submissions)      as submissions,
  (select count(*) from business_intelligence_reports) as birs,
  (select count(*) from timeline_events)             as events;
```

A first successful ingestion should give `1, 1, 1, 5`. Calling it a second time
with the same key must leave all four unchanged.

Then ingest one submission whose `submittedAt` is four minutes ahead of server
time. It must **succeed**, with `assessment.completed.occurred_at` clamped to
server time — that path aborted the whole transaction before this milestone.

---

## 3. Vercel environment variables

Set these in **Project Settings → Environment Variables**, for every environment
that serves the endpoint. Template: [.env.example](../.env.example).

| Variable | Scope | Notes |
|---|---|---|
| `SUPABASE_URL` | server | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | **server only** | **Preferred.** `sb_secret_…`. Never exposed to the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | **Legacy compatibility only.** The pre-rename name for the same key. Do not configure one for a new deployment |
| `SUPABASE_PUBLISHABLE_KEY` | server | Browser-safe; served to the staff onboarding and recovery pages by `GET /auth-config`. Not used by assessments or analytics |
| `SUPABASE_ANON_KEY` | server | Legacy compatibility name for the publishable key |
| `CED_ALLOWED_ORIGINS` | server | Comma-separated exact origins; a missing `Origin` is refused |
| `CED_IDEMPOTENCY_RETENTION_DAYS` | server | `30` |
| `CED_SUBMISSION_MAX_AGE_DAYS` | server | `30` — must be ≥ the browser queue retention |
| `CED_MAX_REQUEST_BYTES` | server | `65536` |
| `CED_CHALLENGE_VERIFY_URL` | server | Provider endpoint; **no provider chosen yet** |
| `CED_CHALLENGE_SECRET` | **server only** | Never logged or returned |
| `CED_CHALLENGE_REQUIRED` | server | `true`; defaults to true when unset |
| `CED_CHALLENGE_EXPECTED_ACTION` | server | `assessment_submit` |
| `CED_CHALLENGE_TIMEOUT_MS` | server | `3000` |
| `CED_RATE_LIMIT_SECRET` | **server only** | `openssl rand -hex 32`; rotating it invalidates all buckets |
| `CED_RATE_LIMIT_WINDOW_SECONDS` | server | `900` |
| `CED_RATE_LIMIT_MAX_REQUESTS` | server | `20` |
| `CED_DB_TIMEOUT_MS` | server | `6000`, below the 15s function budget |
| `CED_LOG_LEVEL` | server | `info` in production |

Vercel exposes only `NEXT_PUBLIC_`-prefixed variables to the client. None of
these carry that prefix, and none may be given it.

**One elevated key, selected one way, by all three server surfaces.**
`api/assessments.mjs`, `api/analytics.mjs` and
`server/staff-identity-resolution.mjs` all resolve the elevated key through
[shared/security/supabase-keys.js](../shared/security/supabase-keys.js). The
rule has three parts and each fails closed:

- `SUPABASE_SECRET_KEY` is preferred; `SUPABASE_SERVICE_ROLE_KEY` is consulted
  only when the preferred variable is **unset**.
- A value is accepted only when it is *positively* an elevated key — a valid
  `sb_secret_…`, or a legacy JWT whose `role` is exactly `service_role`. A
  publishable or `anon` key in an elevated variable is refused, and the
  reverse is refused too.
- **A preferred variable that is set but malformed does not fall back.** It is
  a misconfiguration to fix, not a fallback to take; otherwise a typo would
  leave the deployment quietly running on the legacy key, invisible until the
  day that variable is removed.

This used to be split: the staff route preferred the modern name and the two
public endpoints read only the legacy one. Setting just `SUPABASE_SECRET_KEY`
therefore brought up the authenticated console while assessment capture
answered `503 not_configured` and analytics silently degraded, with no logged
cause. `tests/supabase-key-selection.test.mjs` pins all three consumers
against that.

**Two things must be true before production traffic.** With
`CED_CHALLENGE_REQUIRED` on and no verify URL configured, the endpoint fails
closed and refuses every submission — that is intended, and it means a
provider must be chosen first. And with no `CED_RATE_LIMIT_SECRET`, rate
limiting silently does nothing; the endpoint logs this at `error` in
production rather than hiding it.

Set `maxDuration` and the function region in [vercel.json](../vercel.json).
Pin the region to the same continent as the Supabase project: a function and
a database far apart add 100–300 ms to every query **inside** the ingestion
transaction.

---

## 4. CORS

`CED_ALLOWED_ORIGINS` is an exact-match allowlist — scheme included, no trailing
slash, no wildcards.

```
CED_ALLOWED_ORIGINS=https://nails.cedservice.com,https://www.cedservice.com
```

Behaviour:

- Allowed `Origin` → CORS headers echoed, request proceeds.
- Unlisted `Origin` → **403**, and no CORS headers, so the browser reports it as
  blocked rather than as an application error.
- **No `Origin` header at all → 403 `origin_required`.** This reverses the
  Milestone 1 behaviour. The endpoint serves browsers, and a caller without an
  origin is either not a browser or is hiding; either way it belongs on the
  authenticated server-to-server route, which does not exist yet. Loosening
  this to accommodate one would remove the only thing standing between the
  public internet and the write path.
- `null`, `*`, malformed URLs, non-http(s) schemes, origins carrying a path or
  query, and suffix near-misses are all refused.

Preflight is handled and uses the **same** allowlist: `OPTIONS` returns 204
with `Access-Control-Allow-Methods: POST, OPTIONS` and
`Access-Control-Allow-Headers: Content-Type, Idempotency-Key, Accept, X-CED-Challenge`.

---

## 5. Local development

```bash
npm install
npm test               # 221 tests, no database needed
```

To exercise the real endpoint locally you need `vercel dev` plus a `.env.local`
containing the variables above pointed at a **development** Supabase project —
never production.

The nail-salon page still previews straight from disk with no server at all: the
config resolves the endpoint only on `http:`/`https:`, so `file://` keeps logging
locally.

---

## 6. Rollback

See [IMPLEMENTATION_MILESTONE_1.md §9](IMPLEMENTATION_MILESTONE_1.md#9-rollback)
for the `drop` statements. To disconnect the client without touching the
database, set `submission.endpoint` back to `null` in the vertical config —
assessments then log locally and nothing is sent.

**This is teardown of the whole milestone, not recovery from a migration.** If
a migration applied to a project that already holds data went wrong, the
procedure is §2b, "If something goes wrong": inspect first, and correct
forward with a new migration. Do not reach for `drop` statements to undo one
migration.

---

## 7. Security notes

- RLS is **enabled and forced** on all ten tables with **no policies**. Adding
  one would open a public read path; do not, in this milestone.
- `revoke all on all tables in schema public from anon, authenticated` is applied
  by the migrations, and execute is revoked from `public`, `anon`, and
  `authenticated` on **all five** functions — including
  `redact_business_pii` and both purge functions, which are maintenance-role
  only.
- The endpoint returns no stack traces, SQL text, credentials, challenge
  tokens, or database details. Database errors are mapped to a small set of
  client-safe codes, and the full message is logged server-side under a
  correlation id.
- Structured logs carry identifiers, outcomes, and a correlation id only —
  never contact details, answers, request bodies, tokens, secrets, or raw
  addresses.
- Payment instruments, credentials, government identifiers, and health data are
  rejected at the endpoint before anything is stored. The challenge token is
  caught by the same rule, which is why it is stripped from the payload before
  validation and never persisted.
- Rate-limit buckets store an HMAC of the address, never the address itself.
- A visitor-supplied strong identifier is recorded as evidence but can never
  link a Business Record on its own. See
  [PRODUCTION_HARDENING.md §6](PRODUCTION_HARDENING.md#6-identity-trust-model).
