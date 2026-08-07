# Integration tests — real Postgres

These run against real PostgreSQL. The unit suite proves the contract; this
proves the SQL.

There are **two modes**, and they are separate rather than one relaxed into
the other:

| | Local | Hosted |
|---|---|---|
| Where | A disposable PostgreSQL created inside the test process | An actual Supabase development project |
| Transport | SQL, directly | PostgREST, the same path the Vercel Function uses |
| Credentials | None. There is no host, no port and no socket. | Service-role key required |
| Rows | Vanish when the process exits | **Permanent. There is no undo.** |
| Command | `npm run test:integration:local` | `npm run test:integration` |

A shell that sets both is **refused**: a run that could go either way is a run
nobody can reason about afterwards.

Neither mode is part of `npm test`.

---

## Local mode

```bash
npm install                              # @electric-sql/pglite is a devDependency

export CED_ALLOW_INTEGRATION_TESTS=true
export CED_LOCAL_PG=true
# and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must NOT be set

npm run test:integration:local
```

PowerShell: `$env:CED_LOCAL_PG = 'true'`.

**What it is.** [PGlite](https://pglite.dev) is the PostgreSQL server source
compiled to WebAssembly. The planner, plpgsql, the constraint machinery and the
triggers are the real ones. `tests/helpers/local-pg.mjs` creates a cluster,
creates the roles a Supabase project already has (`anon`, `authenticated`,
`service_role` with `BYPASSRLS`), applies the migration chain in order, and
presents the slice of the supabase-js surface this suite uses.

**What it is not.**

- **Not PostgREST.** It speaks SQL directly. Argument binding, function
  overload resolution over HTTP, and JSON serialisation of a large payload are
  the hosted path's job to prove.
- **Not the same PostgreSQL version.** PGlite here is **18.3**; the hosted
  development project is **17.6.1.155**. A behaviour that differs between the
  two majors would not be caught.
- **Not pgcrypto.** The extension is unavailable, and migration 0001's
  `create extension` is tolerated. Nothing in the chain uses a function only
  pgcrypto provides — `gen_random_uuid()` has been core since PostgreSQL 13
  and `sha256()` since 11 — and `assertNoPgcryptoDependency()` checks that
  rather than assuming it.

**Memory.** A PGlite cluster costs roughly half a gigabyte resident, and it
does not return that memory when the cluster is closed. On a machine with
little headroom, V8 fails with `Fatal process out of memory: Zone` before the
suite finishes. `tests/migration/run.mjs` is what makes it reliable: one
process per test file, with `--max-old-space-size` passed through
`NODE_OPTIONS` so it actually reaches the child. `npm run test:integration:local`
uses it.

---

## Hosted mode

Everything below concerns the hosted path.

---

## Before you run anything

> **Every row this suite ingests is permanent.**
>
> `timeline_events` and `audit_events` refuse `UPDATE` and `DELETE` by trigger,
> and `assessment_submissions` refuses `DELETE`. Deleting the parent
> `business_record` does not help: the cascade nulls `business_id` on linked
> submissions, which then violates
> `assessment_submissions_identity_consistency`, so the delete fails.
>
> That is the append-only guarantee working exactly as designed. It also means
> **you cannot undo a run.** Point this only at a database you are willing to
> leave test history in.

Each run uses freshly generated identifiers, so reruns never collide and one
run can never observe another's rows. The suite prints what it left behind.

---

## Required environment

| Variable | Purpose |
|---|---|
| `CED_ALLOW_INTEGRATION_TESTS` | Must be exactly `true`. No other value runs. |
| `SUPABASE_URL` | The development project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key. Never logged, never echoed, not even its length. |
| `CED_TEST_PROJECT_REF` | The project ref you *intend* to write to. Must match `SUPABASE_URL`. |
| `CED_TEST_PROJECT_LABEL` | Optional, but required if the ref itself does not contain `dev`/`test`/`staging`/`scratch`/`sandbox`. |
| `CED_PRODUCTION_PROJECT_REFS` | Optional comma-separated deny-list, for shells that also hold production credentials. |

---

## The guards

The suite refuses to run unless **all** of these pass. It prints one clear
refusal listing every reason, then skips every test.

1. `CED_ALLOW_INTEGRATION_TESTS === 'true'` — the exact string, not merely
   truthy. Running against a real database is never the default.
2. `NODE_ENV` is not `production`.
3. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present.
4. `CED_TEST_PROJECT_REF` is set **and matches the project in `SUPABASE_URL`**.
   This is the guard that catches a stale `SUPABASE_URL` left in a shell —
   naming the target and having it disagree with the URL is refused.
5. The host and ref do not match the deny-list: `prod`, `production`, `live`,
   the known public hostnames, plus anything in
   `CED_PRODUCTION_PROJECT_REFS`.
6. The target is *positively* identified as development, via the ref or
   `CED_TEST_PROJECT_LABEL`. Failing to look like production is not the same as
   being a development database.

Credentials never appear in output, in assertion messages, or in the cleanup
summary.

---

## Running

```bash
npm install                      # @supabase/supabase-js is required here

export CED_ALLOW_INTEGRATION_TESTS=true
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # do not commit, do not echo
export CED_TEST_PROJECT_REF=<ref>
export CED_TEST_PROJECT_LABEL=ced-cip-dev

npm run test:integration
```

On Windows PowerShell, use `$env:NAME = '...'` instead of `export`.

To run everything:

```bash
npm run test:all                 # unit, then integration
```

`npm test` and `npm run test:unit` never touch a database.

---

## What is covered

| Area | Tests |
|---|---|
| **Migration 0006 — review types and Service Mix (section O)** | **14** |
| Schema, signature resolution, permissions | 2 |
| First submission, replay, idempotency conflict | 3 |
| Session linking and the BIR supersession chain | 1 |
| Identity trust: claimed vs verified, squatting, conflicts | 4 |
| Clock skew and the timeline constraint | 2 |
| Append-only protection | 2 |
| Deliberate constraint violations | 1 (12 cases) |
| Rate limiting | 1 |
| Idempotency cleanup | 1 |
| Redaction and the no-PII-in-history invariant | 2 |
| Transaction rollback and retry | 1 |
| **Migration 0004 — the two-stage assessment (section M)** | **11** |
| Cleanup | 1 |

Section M stores **real** Business Intelligence Reports produced by
`generate-bir.js`, not the compact stand-in the rest of the suite uses. The
stage rules live inside that artifact; a stand-in with the right shape would
prove the triggers fire and nothing about what they fire on.

> **Section M has not yet run over PostgREST.** Its SQL was validated against
> `ced-cip-dev` through the Supabase management API on 2026-08-05 — same
> database, same functions, same triggers, same artifacts — because no
> service-role key was available in that shell. It **has** now run against
> real PostgreSQL in local mode. See
> [docs/REAL_POSTGRES_VALIDATION.md §0 and §7](../../docs/REAL_POSTGRES_VALIDATION.md).

> **Sections M, N and O first executed on 2026-08-05, in local mode**, which
> is also the first time this suite had ever been run end to end. That run
> found three defects: one in migration 0006 (the analytics envelope version
> constraint was never widened) and two in this suite (two tests sharing one
> idempotency key, and one aggregate assertion counting the whole section
> rather than its own group). All three are fixed.

## The migration chain

`npm run test:migration` is a separate suite covering migration 0006 as a
migration rather than as a set of functions: a clean installation of the whole
chain, and an upgrade applied on top of a **populated pre-0006 database** with
representative Growth Review history. It always runs locally and never touches
anything hosted.

---

## What cannot be cleaned up

The final test removes only what this run created **and what the database
permits deleting**:

- idempotency records, by exact key
- rate-limit buckets, by exact key

Every statement is keyed to an identifier this run generated. There is no
blanket delete anywhere in the suite, so unrelated rows cannot be touched.

Left behind permanently, by design:

- `assessment_submissions` and their `raw_payload`
- `business_records` created by ingestion
- `business_intelligence_reports`
- `timeline_events` and `audit_events`

If a development database accumulates too much test history, the remedy is to
re-create the project and re-apply the migrations, not to try to delete rows.
That is a deliberate consequence of an append-only design, and it is worth
feeling once before relying on the guarantee in production.

---

## Fixtures

Invented businesses, `.test` domains, and generated UUIDs only. No real person,
address, phone number, or email appears anywhere in this suite. The BIR used is
a compact stand-in carrying exactly the fields `ingest_assessment` reads or
writes; the full 7 KB production artifact is covered by the unit suite.

---

## If a test fails

Read [docs/REAL_POSTGRES_VALIDATION.md](../../docs/REAL_POSTGRES_VALIDATION.md)
first — it records what the first validated run produced, so a difference tells
you whether the migration, the data, or the expectation changed.

A failure in `deliberate constraint violations` means a constraint is missing:
check that all four migrations applied, in order.

A failure in section M with `payload_schema_version` or `bir_schema_version`
means 0004 did not apply. A section-M failure on the shared `occurred_at`
assertion means the Defect 3 fix was lost — read §2 of the validation record
before changing the assertion.
