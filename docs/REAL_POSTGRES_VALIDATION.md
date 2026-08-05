# Real-Postgres validation

The record of the migrations being executed against an actual Supabase
Postgres, and the checklist for repeating it.

**Status: executed and passed.** Blocker B7 — "the SQL has never run" — is
closed. Everything below was observed, not predicted.

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
