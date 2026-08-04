# Real-Postgres validation

The record of Milestone 1.1's migrations being executed against an actual
Supabase Postgres, and the checklist for repeating it.

**Status: executed and passed.** Blocker B7 — "the SQL has never run" — is
closed. Everything below was observed, not predicted.

| | |
|---|---|
| Project | `ced-cip-dev` (development; created for this purpose) |
| Region | us-west-1 |
| Postgres | 17.6 |
| Migrations | 0001 → 0002 → 0003, in order |
| Date | 2026-08-04 |
| Method | Supabase management API; SQL executed directly |
| Result | **35 structural and behavioural checks passed, 19 constraint violations correctly refused, 2 defects found and fixed** |

No production system was touched. No credentials were created, printed, or
stored. The nail-salon page, pricing, scoring, and the assessment itself were
not modified.

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

Order matters. 0003 depends on both, **drops and recreates**
`ingest_assessment` (the signature gains `p_meta`), and **narrows** the
strong-identifier unique index to verified rows.

### Verify structure

- [ ] 10 tables in `public`
- [ ] RLS **enabled** on 10, **forced** on 10
- [ ] **0** policies
- [ ] 30 indexes, 29 CHECK constraints, 4 triggers, 7 functions
- [ ] `ingest_assessment` appears **once**, with 8 arguments
- [ ] `business_identifiers_strong_unique` is **gone**;
      `business_identifiers_verified_strong_unique` exists
- [ ] Execute is revoked from `public`, `anon`, `authenticated` on **all seven**
      functions
- [ ] Supabase security advisors show no `WARN`; the 10
      `rls_enabled_no_policy` notices are `INFO` and **intended**

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

### Verify refusals

All 19 in §4 must be refused.

### Clean up

- [ ] Remove volume-seed rows by their marker
- [ ] `drop schema if exists cip_test cascade`
- [ ] Remember: ingested rows are permanent (see the integration README)

---

## 2. Defects found

Real execution found two things the in-memory double could not.

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

## 7. What this did **not** validate

- **The Vercel Function itself.** The endpoint's own code path — origin policy,
  bounded body reading, limits, honeypot, challenge, rate-limit key derivation
  — is covered by the 222 unit tests, not here. Only the SQL it calls was
  exercised against real Postgres.
- **Concurrency.** `request_in_flight` was not reproduced under genuine
  parallel load; it needs two simultaneous connections holding one key. The
  logic is exercised, the race is not.
- **Scale.** 9,008 identifier rows is enough to make the planner choose an
  index; it is not a load test.
- **The full production BIR** was not pushed through the SQL. The unit suite
  proves the 7,248-byte artifact's shape and that `schemaVersion` is 2 and the
  band is within the enum; the integration fixture is a compact stand-in
  carrying exactly the fields the function reads or writes.
- **Anything about compliance.** Redaction was proven to behave as designed.
  That is a technical statement and nothing more.
