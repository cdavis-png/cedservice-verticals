# Milestone 1 — One business, one record

**Goal:** one completed assessment → one resolved Business Record → one stored
BIR → one append-only timeline, with replay protection and no duplicate
business.

**Status:** implemented and hardened, **not deployed and not connected to a
real Supabase project**. Everything below runs against tests today; the manual
steps in [SUPABASE_SETUP.md](SUPABASE_SETUP.md) connect it to a live database.

> **Milestone 1.1 superseded parts of this document.** An architecture review
> found eight production blockers, all now resolved: the timestamp/constraint
> conflict, retry misclassification, the freshness mismatch, missing input
> limits, unbounded body reading, an undefended public endpoint, self-asserted
> strong identifiers, and the absent erasure path. Read
> [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) alongside this file —
> where the two disagree, that one is current.
>
> Migration order is now **0001 → 0002 → 0003**, and 0003 replaces
> `ingest_assessment`.

---

## 1. Architecture

```
  Browser (nail-salon page, http/https only)
        │  POST /api/assessments
        │  Idempotency-Key: <submissionId>
        ▼
  ┌──────────────────────────────────────────┐
  │ api/assessments.mjs   (Vercel Function)  │
  │  · Origin REQUIRED + exact match         │
  │  · bounded body read (bytes as they land)│
  │  · method + content-type                 │
  │  · payload validation, consent, scores   │
  │  · field + shape limits                  │
  │  · challenge token stripped from payload │
  │  · prohibited-data scan                  │
  │  · honeypot (server-side)                │
  │  · rate limit  ─────────┐                │
  │  · challenge verify  ───┼── cheap first  │
  │  · deterministic request hash            │
  │  · extractIdentitySignals() → persistable│
  │  · generateBir()  → validate             │
  └───────────────────┬──────────────────────┘
                      │ one RPC = one transaction
                      ▼
  ┌──────────────────────────────────────────┐
  │ ingest_assessment()   (Postgres)         │
  │  1 claim idempotency key                 │
  │  2 upsert session                        │
  │  3 resolve identity (indexed join;       │
  │      VERIFIED strong identifiers only)   │
  │  4 create business (only when no match)  │
  │  5 insert submission (+ ingest_meta)     │
  │  6 link session, record evidence,        │
  │      surface cross-business conflicts    │
  │  7 insert BIR, inject businessId,        │
  │      chain supersedes_bir_id             │
  │  8 append timeline (clamped occurred_at) │
  │  9 open case if ambiguous OR conflicting │
  │ 10 audit                                 │
  │ 11 store response for replay             │
  └──────────────────────────────────────────┘
```

Ordering in the function is deliberate: everything that can refuse a request
cheaply runs before anything that costs a network call or a transaction.

The browser never sees a credential. `SUPABASE_SERVICE_ROLE_KEY` is read only
inside the function, and the Supabase client is imported lazily so the module
loads (and the tests run) without it.

**Why the BIR is generated before the transaction.** The BIR is a pure function
of the payload — nothing about it depends on which business it belongs to except
two identity fields. The function generates it with `businessId: null`, and the
SQL injects the resolved id with `jsonb_set` once identity is known. That keeps
one transaction while keeping BIR generation in testable JavaScript.

---

## 2. Table ownership

| Table | Written by | Mode |
|---|---|---|
| `business_records` | ingest (create), future merge | mutable current, audited |
| `business_identifiers` | ingest | append; `valid_to` closes a row |
| `assessment_sessions` | ingest | upsert; `business_id` set once, never rewritten |
| `assessment_submissions` | ingest | **append-only** (delete blocked by trigger) |
| `business_intelligence_reports` | ingest | append-only, one per submission |
| `timeline_events` | ingest | **append-only** (update and delete blocked by trigger) |
| `identity_resolution_cases` | ingest (open), human (resolve) | open once per submission |
| `idempotency_records` | ingest | claim then complete |
| `audit_events` | ingest | **append-only** (update and delete blocked by trigger) |
| `rate_limit_buckets` | rate limiter | ephemeral counters, keyed by HMAC |

Row Level Security is enabled **and forced** on all ten tables with **no
policies**, so `anon` and `authenticated` can read nothing. Only the service
role, which bypasses RLS, can reach them.

`business_records`, `assessment_submissions`, `business_identifiers`, and
`business_intelligence_reports` are additionally writable by
`redact_business_pii()`, which is maintenance-role only. See
[DATA_RETENTION_AND_REDACTION.md](DATA_RETENTION_AND_REDACTION.md).

---

## 3. Identity flow

Signals are extracted from what the payload actually contains — never invented.
Strength is data, not logic: it comes from `identifier_type`, so
`resolve-identity.js` and the SQL cannot disagree about what counts as strong.

Milestone 1.1 added a second axis. **Strength** is intrinsic to the identifier
type; **trust** is intrinsic to its source. Automatic linking requires both,
because on a public endpoint anyone can type anything into a form.

| Situation | Result | Business created? |
|---|---|---|
| Session already linked | link to that business, `linkMethod: session` | no |
| Exactly one candidate with a **verified** strong identifier | link automatically | no |
| No candidate at all | create a new `businessId` (UUID v4) | **yes** |
| One candidate on weak signals only | `resolution_pending`, case opened | **no** |
| A **claimed** (unverified) strong identifier matches | `resolution_pending`, case opened | **no** |
| Two or more verified strong candidates | `resolution_pending`, case opened | **no** |

Strong types: `gbp_place_id`, `external_customer_id`, `payment_customer_id` —
auto-linking only when `verified = true` **and** the source is one of
`trusted_integration`, `verified_enrichment`, `authenticated_customer`,
`manual_verification`, `seed`.

Weak: business name, email, email domain, mobile — **none of which links,
alone or combined**. Merging never happens automatically; there is no code path
for it.

Today's payload carries only visitor-supplied signals, so **any returning
business that is not in the same browser session lands in review**. That is the
expected and correct behaviour until identity evidence can be *verified*, not
merely collected
([IDENTITY_EVIDENCE_ROADMAP.md](IDENTITY_EVIDENCE_ROADMAP.md),
[PRODUCTION_HARDENING.md §6](PRODUCTION_HARDENING.md#6-identity-trust-model)).

---

## 4. Idempotency flow

Three independent layers:

1. **Browser** — the engine's content fingerprint suppresses re-sending an
   unchanged completed review, and the retry queue reuses one `submissionId`
   across every attempt.
2. **Endpoint** — `Idempotency-Key` is required and must equal
   `payload.submissionId`. Neither is ever derived from a contact field. A
   deterministic SHA-256 over the key plus a stable-ordered payload detects a
   changed body under a reused key.
3. **Database** — `insert … on conflict do nothing` on `idempotency_records`
   *is* the lock. A completed key replays its stored response; an in-flight key
   raises; a mismatched hash raises. `timeline_events` additionally carries a
   unique `(event_name, idempotency_key)` index.

Replay returns HTTP 200 with the original identifiers and `replayed: true`. A
first success returns 201. A replay creates nothing — including no second link
in the BIR supersession chain.

**The client half of this was broken until Milestone 1.1.** HTTP 409 carries
two opposite meanings, `request_in_flight` (retry) and
`idempotency_key_conflict` (never retry), and classifying by status alone
treated both as permanent — silently discarding completed assessments.
Classification is now driven by the structured error code.

---

## 5. BIR generation

`shared/business-intelligence/generate-bir.js` — deterministic, no AI, no
enrichment. It **carries scoring through verbatim** rather than recomputing, so
pricing and scoring cannot drift here.

- Opportunity becomes a range, widened by confidence band.
- Confidence is **capped below `high`** while capacity is uncollected: the
  estimate has no known ceiling, so it cannot honestly claim high confidence.
- Unknown stays unknown — `null` or `"unknown"`, never a placeholder number.
- `missingCriticalFields` names all eleven uncollected fields plus any blank
  scored answer.
- Close readiness scores 7 of 10 signals as unknown, lists them in
  `unknownSignals`, and applies the `unknown_decision_authority` soft blocker.
  A representative submission lands at **18/100, band `educate`** — nothing this
  version produces can reach a sellable band, which is the intended behaviour.
- `scopeStandard: false`, conservatively, because location count is unknown.

Each new BIR for a resolved business sets `supersedes_bir_id` to that
business's previous `current_bir_id`, and `current_bir_id` advances **only
after** the new report is safely inserted. Prior reports are preserved and
never rewritten; the chain is walkable from current back to the first.

---

## 6. Timeline sequence

New business:

```
business.created → identity.resolved → identity.linked → assessment.completed → bir.generated
```

Existing business (session or verified strong match): the same without `business.created`.

Ambiguous:

```
identity.resolved → assessment.completed → bir.generated → identity.review_required
```

No `identity.linked` is written, `business_id` stays null on the submission, the
BIR, and the events, and a case is opened. The submission and its BIR are still
stored — the intelligence is valid regardless of which business it belongs to.

---

## 7. Local development

```bash
npm install          # only @supabase/supabase-js
npm test             # 221 tests, no database required
```

The page still previews from `file://` with no server: the vertical config
resolves `submission.endpoint` to `/api/assessments` **only** on `http:` or
`https:`, so opening `index.html` directly keeps logging locally, exactly as
before.

For a full local stack, see [SUPABASE_SETUP.md](SUPABASE_SETUP.md).

---

## 8. Testing

221 tests via Node's built-in runner, across eight files plus two helpers. They
cover validation, origin policy, consent, prohibited data, input limits,
bounded body reading, the honeypot, challenge outcomes, rate limiting, identity
decisions for every branch, the trust model, BIR generation and the
supersession chain, replay, rollback, append-only shape, redaction, and
maintenance.

**What the tests do not cover:** the PL/pgSQL function is *not executed*. There
is no Postgres in the test environment, so `tests/helpers/fake-db.mjs`
implements the same contract in memory, step for step. It proves the endpoint
and the contract; it does not prove the SQL.

It **does** now enforce the CHECK constraints that ingestion can violate. That
change was not cosmetic: the review found a live conflict between the
endpoint's clock-skew allowance and `timeline_events.recorded_at >= occurred_at`
that the previous double, which mirrored only the happy path, could not see.
Verifying the migrations still requires a live database —
[PRODUCTION_HARDENING.md §11](PRODUCTION_HARDENING.md#real-postgres-test-plan).

---

## 9. Rollback

The migrations are additive and create no data. To roll back before any real
traffic:

```sql
drop function if exists public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb);
drop function if exists public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer);
drop function if exists public.check_rate_limit(jsonb, integer, integer);
drop function if exists public.redact_business_pii(uuid, text, text, text);
drop function if exists public.purge_expired_idempotency_records(timestamptz, integer);
drop function if exists public.purge_expired_rate_limit_buckets(timestamptz);
drop table if exists public.rate_limit_buckets, public.audit_events,
  public.idempotency_records, public.identity_resolution_cases,
  public.timeline_events, public.business_intelligence_reports,
  public.assessment_submissions, public.assessment_sessions,
  public.business_identifiers, public.business_records cascade;
drop function if exists public.reject_mutation();
drop function if exists public.touch_updated_at();
```

**Rolling back 0003 alone is not safe.** It narrowed the strong-identifier
unique index to verified rows; reverting would restore the index while
unverified claims exist, and those claims would then reserve identifiers
against their real owners. Roll the whole schema back, or forward-fix.

To roll back the *client* without touching the database, set
`submission.endpoint` back to `null` in the vertical config. Completed
assessments then log locally and nothing is sent.

---

## 10. Known limitations

1. **The SQL is unverified at runtime.** It has never been executed. First run
   against a real project remains the highest-risk step in this milestone.
2. **No manual identity-resolution surface.** `identity_resolution_cases` rows
   accumulate with nothing to work them. Ambiguous submissions are stored safely
   but nobody can resolve them yet — and Milestone 1.1 sends *more* to that
   queue, since claimed strong identifiers no longer auto-link.
3. **Attaching a BIR after resolution is not implemented.** A pending BIR keeps
   `business_id = null` until that surface exists.
4. **Candidate lookup happens inside the transaction**, but two concurrent
   *new* businesses sharing a verified strong identifier are prevented only by
   the partial unique index — the second insert raises and the whole request
   rolls back, so the client retries. Correct, but the retry is not yet
   automatic.
5. **No `identity.resolution_started` event** is emitted; resolution is
   synchronous inside one transaction, so there is no window in which a "started"
   event would be observable.
6. **`assessmentSessionId` is browser-scoped.** A visitor who reassesses from a
   different device produces a new session and, with only weak signals, lands in
   review.
7. **Free-mail domains contribute nothing** — deliberate, but it means most
   sole-operator salons carry even fewer usable signals.
8. **No challenge provider is chosen**, and no monitoring, alerting, disaster-
   recovery position, or least-privilege read role exists. See
   [PRODUCTION_HARDENING.md §14](PRODUCTION_HARDENING.md#14-remaining-launch-blockers).

Resolved since the original list: the idempotency expiry job now exists
(unscheduled), and no vertical or context identifier bloats the lookup index.

---

## 11. The future identity field

`extractIdentitySignals()` already reads `contact.googlePlaceId`,
`contact.externalCustomerId`, `contact.website`, and `contact.businessPhone`
when present, and the database still treats a **verified** `gbp_place_id` as
globally unique. Adding the Google Business Profile field to the assessment
needs no migration.

**But collecting it is no longer sufficient on its own.** Milestone 1.1
separated identifier strength from identifier trust: a place id typed into a
public form is `visitor_supplied` and unverified, so it contributes evidence
and raises a case, but it does not link a record. Making it link requires a
*verification path* — an integration callback, an enrichment provider we
accept as authoritative, or an operator confirming it — and the row must then
carry `verified = true` with a named `verification_method`.

That is the shape of the highest-leverage follow-up: collect the field **and**
choose how it gets verified. Collecting it alone moves identity resolution
from "queues everything" to "queues everything, with better evidence attached".
