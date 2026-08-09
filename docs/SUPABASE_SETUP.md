# Supabase setup

Manual steps to connect the Milestone 1 implementation to a real project.

> **This document once opened "none of this has been done yet — no project
> exists".** That is wrong and has been for some time. A persistent hosted
> **development** project exists — `qkpptajglstgucadhfwq`, PostgreSQL
> 17.6.1.155 — and it holds migrations **0001 through 0007**, recorded in
> `supabase_migrations.schema_migrations`. A read-only preflight has since
> verified the migration history, the deployed supersession function, and the
> two ACL findings 0008 addresses; see runs 14 and 15 in
> [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md).
>
> Nothing is deployed for public traffic, no production project exists,
> migration **0008 has been applied nowhere**, and **no elevated credential is
> configured on any Vercel environment** — which is why protected staff
> operations are unavailable regardless of what the database holds.

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
| State | Empty | 0001–0007 applied **and recorded** |
| To apply | 0001 → 0008, in order | 0008 only |
| Procedure | §2a | §2b — and §2b is not optional |

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
```

0003 depends on both predecessors. It **drops and recreates**
`ingest_assessment` (the signature gains a `p_meta` argument, so
`create or replace` would leave two ambiguous overloads) and **narrows** the
strong-identifier unique index to verified rows only. See
[PRODUCTION_HARDENING.md §2](PRODUCTION_HARDENING.md#2-migration-order).

**With the Supabase CLI:**

```bash
supabase link --project-ref <ref>
supabase db push
```

**Or by hand:** paste each file into the SQL editor and run them in order.

### 2b. The existing development project — applying 0008

**Only 0008 remains.**

Migration 0008 is forward-only. It repairs three defects in 0006 — F3 trigger
coverage, F6 a `service_role` grant, F7 two unpinned `search_path`s — and edits
no earlier file. The rule behind that is in
[CLAUDE.md §14](../CLAUDE.md): applied history is never rewritten.

#### What the preflight established

A hosted preflight has now been run, read-only. It replaces the uncertainty
this section previously described:

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

#### Applying it

**Use a tracked migration mechanism.** 0008 must end up as a row in
`supabase_migrations.schema_migrations` alongside 0001–0007. A migration that
runs without being recorded leaves the history lying about the schema, and the
next person to reconcile the two has no way to tell an unrecorded migration
from an unapplied one.

- **Do not paste it into the SQL editor.** An earlier revision of this document
  said to; that was wrong. The SQL editor applies the DDL and records nothing.
- **Do not use `supabase db push`.** It is out of scope for this project by
  standing instruction, and the history rows have not been reconciled against
  the CLI's expectations.
- Use the project's tracked mechanism — a migration runner or CI step that
  applies the file **and** writes its history row in the same operation, with
  a version stamp continuing the `202608…` sequence.

**Before applying, confirm the F6 precondition is still true.** It depends on
default privileges rather than on anything in a migration file, so it is the
one finding that could change without a migration running:

```sql
select has_function_privilege('service_role',
         'public.identity_proposal_conflict(jsonb, uuid)', 'EXECUTE') as before_0008;
-- expect true — that IS the defect, and the preflight observed it
```

**Then apply `0008_staff_migration_hardening.sql`.**

**Verify. Every one of these is a catalog fact, not an opinion.**

```sql
-- it is recorded, not merely applied
select version, name from supabase_migrations.schema_migrations order by version;
-- expect a row for 0008 after the two the preflight found:
--   20260808200326 / 0006_service_mix_review
--   20260808201535 / 0007_staff_identity_resolution
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

**A behavioural check, because a grant is not a guarantee.** Ingest
one Growth submission through `ingest_assessment` and confirm it succeeds.
0008 revoked `identity_proposal_conflict`, `identity_value_acceptable` and
`identity_evidence_fault` from every role, and ingestion calls all three from
inside a SECURITY DEFINER function. If that revoke were wrong, this is where it
shows.

**Rollback.** 0008 adds no table, column, index or policy and changes no data,
so reverting it is: restore 0006's `enforce_bir_supersession_scope` body and
its `before insert` trigger, `grant execute` the sixteen internal functions
back to `service_role`, and `alter function … reset search_path` on the two
helpers. There is nothing to migrate back.

**What 0008 has not had.** It has never been applied to any database. It is
tested against a disposable PostgreSQL 18.3 through PGlite by
`tests/migration/0008-migration-hardening.test.mjs`, which observes all three
defects present before applying it and gone afterwards. It has not run on
PostgreSQL 17, on hosted Supabase, or through PostgREST.

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

**Current status.** Migrations **0001–0007** are applied and recorded on the
hosted development project (Supabase PostgreSQL 17.6.1.155), and 0006 and 0007
have additionally been executed against a disposable local PostgreSQL 18.3
through PGlite. **0008 has been applied nowhere.** `GET /auth-config` is hosted
and answers HTTP 200; no privileged RPC has been called, because no elevated
credential is configured on any Vercel environment. See
[REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) runs 14 and 15,
which are the one place this is stated.

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
