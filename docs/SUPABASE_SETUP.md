# Supabase setup

Manual steps to connect the Milestone 1 implementation to a real project.

> **This document once opened "none of this has been done yet — no project
> exists".** That is wrong and has been for some time. A persistent hosted
> **development** project exists — `qkpptajglstgucadhfwq`, PostgreSQL
> 17.6.1.155 — and it already holds migrations **0001 through 0007**. This was
> established on 2026-08-09 by read-only PostgREST probes; see run 14 in
> [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md).
>
> Nothing is deployed for public traffic, no production project exists, and
> migration **0008 has been applied nowhere**. §2 is written for the situation
> that actually obtains: a database that is *present and uncharacterised*.

---

## 1. Create the project

1. Create a Supabase project. Choose a region close to your customers.
2. Note the **Project URL** (`https://<ref>.supabase.co`).
3. Under **Project Settings → API**, copy the **`service_role`** key.

> **The `service_role` key bypasses Row Level Security and can read and write
> every table.** It belongs only in the Vercel Function environment. Never put
> it in browser code, never prefix it with `NEXT_PUBLIC_`, never paste it into a
> vertical config, and never commit it. If it is ever exposed, rotate it in
> Supabase immediately.
>
> The `anon` key is **not used** by this milestone and does not need to be
> configured anywhere.

---

## 2. Apply the migrations

There are two situations, and they need different procedures. Decide which one
you are in **before** running anything.

| | A brand-new project | The existing development project |
|---|---|---|
| State | Empty | 0001–0007 present, definitions uncharacterised |
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

**Only 0008 remains, and it must not be applied blind.**

Migration 0008 is forward-only. It repairs three defects in 0006 — F3 trigger
coverage, F6 a `service_role` grant, F7 two unpinned `search_path`s — and edits
no earlier file. The rule behind that is in
[CLAUDE.md §14](../CLAUDE.md): applied history is never rewritten.

The complication is that **nobody has read the deployed definitions.** The
probes that found 0006 and 0007 distinguished "permission denied" from "not
found" and nothing more. Two of 0008's three repairs do not care —
`alter function … set search_path` and `revoke` change a setting and an ACL
without touching a body. The third does:

> `create or replace function public.enforce_bir_supersession_scope()`
> **overwrites whatever is currently deployed under that name.** If the hosted
> definition differs from `0006_service_mix_review.sql` — an earlier draft, a
> hand-edit in the SQL editor, a half-applied file — that difference is
> destroyed silently and without a diff.

So the comparison is a step, not a suggestion.

**Step 1 — read what is actually deployed.**

```sql
select pg_get_functiondef('public.enforce_bir_supersession_scope()'::regprocedure);

-- and the trigger it drives
select tgname, pg_get_triggerdef(oid) as def
  from pg_trigger
 where tgrelid = 'public.business_intelligence_reports'::regclass
   and not tgisinternal
 order by tgname;
```

Compare the function body against the one in `0006_service_mix_review.sql`
§5. It should differ in nothing. The trigger should read
`BEFORE INSERT ... FOR EACH ROW` — that is the F3 defect, and seeing it is how
you confirm 0008 is aimed at the right target.

**If the body differs from 0006's, stop.** Someone changed the database
outside this repository. Record what it says before deciding anything; 0008
would erase it.

**Step 2 — read the migration-history rows.**

```sql
select version, name, statements is not null as has_statements
  from supabase_migrations.schema_migrations
 order by version;
```

This has never been read on this project. It answers whether the CLI believes
0001–0007 are applied. **Do not run `supabase db push` until it has been
read**: if the table is empty or partial, `db push` will try to replay
migrations the database already has. Most of the chain is written to be
re-runnable, but "most" is not a basis for pushing at a database whose state
you have not established.

Until the history is reconciled, apply 0008 **by hand in the SQL editor** — one
file, pasted whole. It is a single transaction's worth of DDL with no data
change.

**Step 3 — check the F6 precondition.** This is the one that shows whether the
defect is really present on *this* project, since it depends on default
privileges rather than on anything in a migration file:

```sql
select has_function_privilege('service_role',
         'public.identity_proposal_conflict(jsonb, uuid)', 'EXECUTE') as before_0008;
-- expect true — that IS the defect
```

**Step 4 — apply `0008_staff_migration_hardening.sql`.**

**Step 5 — verify. Every one of these is a catalog fact, not an opinion.**

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

**Step 6 — a behavioural check, because a grant is not a guarantee.** Ingest
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

**Current status.** Migrations **0001–0007** are present on the hosted
development project (Supabase PostgreSQL 17.6.1.155). 0006 and 0007 have
additionally been executed against a disposable local PostgreSQL 18.3 through
PGlite. **0008 has been applied nowhere.** No SQL in this repository has been
successfully *called* through PostgREST — the probes that established the above
were permission refusals, not executions. See
[REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) run 14, which is the
one place this is stated.

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
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Never exposed to the browser |
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
