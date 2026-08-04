# Supabase setup

Manual steps to connect the Milestone 1 implementation to a real project.
**None of this has been done yet** — no project exists, no credentials exist,
nothing is deployed.

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

In order:

```
supabase/migrations/0001_business_record_foundation.sql
supabase/migrations/0002_ingest_assessment.sql
supabase/migrations/0003_production_hardening.sql
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

**Or by hand:** paste each file into the SQL editor and run them in order. 0002
depends on the tables from 0001.

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

**The SQL has never been executed.** This is the largest single risk in the
milestone. Do not stop at the happy path — the full sequence, including the
constraint-violation cases the in-memory test double cannot prove, is in
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
