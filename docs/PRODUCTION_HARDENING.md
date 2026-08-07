# Milestone 1.1 — Production hardening

What the Milestone 1 architecture review found, what was changed in response,
and what is still outstanding.

**Status: not deployed.** This document describes Milestone 1.1 **as it stood
when it was written**, and the paragraph below is kept as a record of that
moment rather than as a current statement.

> *Historical, superseded:* "not connected to a real Supabase project, no
> credentials created … the PL/pgSQL has still never executed."

**Current execution status**, which is stated once in
[REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) and repeated
nowhere else in a form that can drift:

- Migrations 0001–0005 have been executed against **Supabase PostgreSQL
  17.6.1.155**, in a development project.
- Migration 0006 has been executed against a **disposable local PostgreSQL
  18.3** through PGlite, clean-install and upgrade, and has **not** been
  executed against PostgreSQL 17, hosted Supabase, or PostgREST.
- Nothing has ever run through PostgREST.

Nothing here changes pricing, scoring, the visible assessment design,
deterministic BIR generation, append-only guarantees, idempotency semantics,
or the rule that no business is ever merged automatically.

---

## 1. Blockers and their resolutions

| # | Blocker | Resolution | Where |
|---|---|---|---|
| B1 | Public endpoint had no authentication, no rate limiting, and explicitly allowed a missing `Origin` | Four layers: required exact-match Origin, server-side honeypot, database-backed rate limiting, provider-neutral challenge | [§3](#3-endpoint-threat-model) |
| B2 | Visitor-supplied strong identifiers auto-linked and could squat a value permanently | Strength and trust separated; only verified identifiers from trusted sources auto-link; uniqueness backstop narrowed to verified rows | [§6](#6-identity-trust-model) |
| B3 | No length caps; an oversized value aborted the transaction with a non-catchable btree error | Centralised limits applied before any database work; identity values rejected, never truncated | [§4](#4-input-limits) |
| B4 | `submittedAt` up to 5 minutes ahead violated `recorded_at >= occurred_at` and aborted ingestion | Timeline timestamp clamped to server time; visitor value preserved; skew recorded | [§5](#5-timestamps-and-clock-skew) |
| B5 | HTTP 409 `request_in_flight` was classified permanent, silently discarding assessments | Retry classification driven by structured error code, not status | [§7](#7-retry-and-timeout-behaviour) |
| B6 | 24-hour server freshness window contradicted the 30-day browser queue | `CED_SUBMISSION_MAX_AGE_DAYS`, default 30 | [§5](#5-timestamps-and-clock-skew) |
| B7 | PL/pgSQL never executed | **Closed.** Executed against Supabase Postgres 17.6: 35 checks passed, 19 violations correctly refused, 2 defects found and fixed | [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) |
| B8 | No erasure path; append-only triggers actively prevented one | `redact_business_pii()`, redaction rather than deletion | [DATA_RETENTION_AND_REDACTION.md](DATA_RETENTION_AND_REDACTION.md) |
| H1 | Candidate lookup believed unable to use an index | Rewritten to a CTE + join. **The premise was wrong on PG17** — both shapes reach the index. Kept for clarity, not speed | [§9](#9-candidate-lookup) |
| H2 | `vertical` written as an identifier row per business | Context types are no longer persisted; a CHECK constraint forbids them | [§9](#9-candidate-lookup) |
| H3 | Cross-business identifier collisions silently swallowed | Detected explicitly and raised as a resolution case | [§6](#6-identity-trust-model) |
| H4 | Whole body buffered before the size check | Bounded reader counts bytes as they arrive | [§4](#4-input-limits) |
| H5 | No timeout on the RPC; client timeout equal to the platform limit | Explicit budget with an asserted ordering | [§7](#7-retry-and-timeout-behaviour) |
| H6 | Unhandled errors logged only `err.name` | Full detail server-side under a correlation id; nothing internal returned | [§8](#8-logging-and-observability) |
| H7 | Exactly one payload version accepted | Supported range with a migration window | [§10](#10-version-compatibility-policy) |
| M5 | `idempotency_records` grew without bound | `purge_expired_idempotency_records()` | [§12](#12-maintenance) |
| M10 | Honeypot named `website`, colliding with the roadmap identity field | Renamed to `contactFax` | [§3](#3-endpoint-threat-model) |
| M12 | `supersedes_bir_id` never populated | BIR chain maintained on every ingestion | [§13](#13-bir-history-chain) |
| M13 | MD5 used for the payload hash | `sha256` via pgcrypto | migration 0003 |
| M15 | A subtransaction per identifier | `on conflict do nothing` instead of an exception block | migration 0003 |

Not addressed in this milestone, deliberately: M3 (monitoring and alerting),
M4 (disaster recovery position), M8 (least-privilege read role). Each needs a
decision that is not a code change. See [§14](#14-remaining-launch-blockers).

---

## 2. Migration order

```
0001_business_record_foundation.sql   tables, constraints, RLS
0002_ingest_assessment.sql            ingestion v1
0003_production_hardening.sql         trust model, rate limiting, redaction,
                                      maintenance, ingestion v2
```

Apply in order. 0003 depends on both.

**0003 drops and recreates `ingest_assessment`.** The signature changes — a
`p_meta` argument is added — so `create or replace` would produce a second
overload and make the PostgREST call ambiguous. Dropping first is correct and
deliberate. The function is recreated in the same migration, so there is no
window in which it is missing.

**0003 also narrows an existing unique index.** `business_identifiers_strong_unique`
is dropped and replaced by `business_identifiers_verified_strong_unique`,
which applies only to `verified = true` rows. That is the change that stops an
unverified claim from reserving an identifier. Rolling 0003 back would restore
the squatting exposure.

---

## 3. Endpoint threat model

`POST /api/assessments` is public and unauthenticated **by necessity**: it
accepts submissions from small-business owners who have no account and never
will. It cannot be protected by a credential, so it is protected in layers.

| Layer | Stops | Does not stop |
|---|---|---|
| Origin allowlist | Cross-site posting from another page; casual scripting | A determined caller forging the header |
| Bounded body reading | Memory exhaustion via a large or lying body | Many small requests |
| Field and shape limits | Index-breaking values; nesting and node-count attacks | Plausible-looking junk |
| Server-side honeypot | Naive form-filling bots | Anything that reads the markup |
| Rate limiting | Volume from one address or session | A distributed source |
| Challenge verification | Automated submission at scale | A human filling the form dishonestly |
| Idempotency | Duplicate records from retries and replays | Genuinely distinct submissions |

No layer is sufficient alone. That is why there are seven.

### Origin policy

- An `Origin` header is **required**. A request without one is refused with
  `origin_required`. This reverses the Milestone 1 behaviour, which allowed it.
- Matching is exact: scheme, host, and port, against `CED_ALLOWED_ORIGINS`.
- Refused: `null`, `*`, malformed URLs, non-http(s) schemes, anything carrying
  a path, query, fragment, or credentials, and any suffix near-miss
  (`https://nails.cedservice.com.evil.test`).
- `OPTIONS` uses the identical allowlist. A refused preflight receives no CORS
  headers, so the browser reports it as blocked rather than as an application
  error.

**Server-to-server ingestion is not supported here.** When a partner or
internal system needs to submit assessments, it gets its own authenticated
route with its own credential. Loosening the Origin rule on this endpoint to
accommodate it would remove the only thing standing between the public
internet and the write path.

### Honeypot

The field is named **`contactFax`**, not `website`. The identity roadmap
collects a real business website; a trap sharing that name would have turned
bot noise into identity evidence the moment the legitimate field shipped.

- The **value is never transmitted**. Only `integrity.honeypotFilled`, a
  boolean, travels. The trap cannot become a channel for smuggling data into
  storage.
- Enforcement is **server-side**. The browser no longer suppresses the
  submission, because a bot posting directly never runs browser code — a
  browser-side check protects nothing.
- A tripped honeypot receives a **generic success-shaped 200** and writes
  nothing: no business, no submission, no timeline event, not even an
  idempotency claim. The response says nothing about honeypots, bots, traps,
  or rejection, so a bot learns nothing from having hit one.

### Challenge verification

`shared/security/verify-challenge.js` is **provider-neutral**. It speaks the
`secret` + `response` form-POST shape that Cloudflare Turnstile and Google
reCAPTCHA both use, and returns one of six outcomes:

| Outcome | Meaning | Endpoint response | Client behaviour |
|---|---|---|---|
| `verified` | Passed | proceed | — |
| `rejected` | Provider says no | 403 `challenge_rejected` | permanent |
| `expired` | Token was valid once | 400 `challenge_invalid` | retryable |
| `malformed` | Token missing or unusable | 400 `challenge_invalid` | retryable |
| `unavailable` | Verifier unreachable, erroring, rate-limiting us, or misconfigured | 503 `challenge_unavailable` + `Retry-After` | retryable |
| `skipped` | Not required, or a non-production bypass | proceed | — |

Distinguishing `rejected` from `unavailable` is the point. Collapsing them is
how a provider outage becomes a day of lost assessments — and a bad secret is
*our* misconfiguration, so it maps to `unavailable`, never to "the visitor
failed a test".

It **fails closed in production**: required plus unconfigured means every
submission is refused. The development bypass is available only when
`NODE_ENV` is not `production`. `CED_CHALLENGE_REQUIRED` defaults to **true**
when unset, because an absent variable must not silently disable a protection.

The token is a credential. It is **lifted out of the payload before
validation, hashing, or any database call**, and replaced with
`integrity.challengePresented: true`. The prohibited-data policy already
rejects a field named `challengeToken`, and that is correct rather than
inconvenient — it is exactly the kind of thing that must not be persisted.
Stripping is deterministic, so a replay of the identical body still hashes
identically and is still recognised as a replay.

> **A production challenge provider must be selected and configured before
> public traffic.** None is chosen. No provider UI, widget, or script is
> integrated, and none is in scope for this milestone. The hidden input
> `cedChallengeToken` is read if present and is absent today.

**Known trade-off, stated plainly.** A submission older than 15 minutes is
**exempt** from the challenge. A token cannot be re-solved by a background
retry, so requiring one would permanently discard an assessment that was
completed offline — which is blocker B6 reintroduced through a different door.
The residual risk is that a caller who forges an old `submittedAt` skips the
challenge; that caller is still subject to the Origin rule, the rate limiter,
and idempotency. This must be revisited when a provider is chosen, most likely
by having the client re-challenge before a retry, which is UI work.

### Rate limiting

Fixed-window counters in Postgres (`check_rate_limit`), because a serverless
function has no memory between invocations.

- Two scopes: pseudonymous **address** and **assessmentSessionId**. The second
  catches a single browser looping from a rotating address.
- **No raw address is ever stored.** The bucket key is
  `HMAC-SHA256(CED_RATE_LIMIT_SECRET, "<scope>:<value>")`. A stored key is
  useless to anyone who obtains the database without also obtaining the
  secret, and rotating the secret invalidates every historical bucket.
- Checked **before** the ingestion transaction, so a refused request creates
  no business, no submission, and no idempotency claim.
- Exceeding it returns **429** with `Retry-After` and a matching
  `retryAfterSeconds` in the body.
- A rate limiter that errors is logged and does not take the endpoint down;
  the other layers still apply. A rate limiter that is *unconfigured* in
  production is logged at `error`, because silence there would be worse.

> **Proxy trust must be verified during deployment.** The address is read from
> `x-real-ip`, then the first entry of `x-forwarded-for`, then
> `cf-connecting-ip`, then `true-client-ip`. Any of these is client-controlled
> unless a trusted proxy overwrites it. Confirm on the real platform which
> header is authoritative before relying on address-scoped limits; until then,
> treat the session scope as the more trustworthy of the two.

---

## 4. Input limits

`shared/security/limits.js` holds every bound. The concrete failure it
prevents: values reaching `business_identifiers` land in btree indexes, which
reject an entry over roughly 2704 bytes with error **54000** — which is not a
`unique_violation`, so the ingestion function's handler could not catch it and
the entire transaction aborted. One oversized name became a permanent 502 loop.

| Category | Limit | Category | Limit |
|---|---|---|---|
| `business_name` | 160 | `answer_key` | 64 |
| `owner_name` | 120 | `answer_value` | 2000 |
| `email` | 254 | `answer_count` | 120 |
| `mobile` | 32 | `consent_statement` | 2000 |
| `website` | 253 | `recommendation_copy` | 600 |
| `gbp_place_id` | 128 | `priority_text` | 600 |
| `external_customer_id` | 128 | `priority_count` | 10 |
| `url`, `referrer` | 2048 | `disclaimer` | 2000 |
| `utm_name` | 64 | `nesting_depth` | 12 |
| `utm_value` | 256 | `array_length` | 100 |
| `utm_count` | 24 | `total_nodes` | 2000 |
| identifier value (hard ceiling) | 256 | `key_length` | 128 |

Rules that matter:

- **Identity values are rejected, never truncated.** A shortened identifier is
  a *different* identifier, and a different identifier links the wrong
  business.
- Structural bounds are deliberately looser than field bounds. A structural
  bound set equal to a field bound masks it — which is exactly what happened
  on the first attempt here, where `key_length` at 64 made the `answer_key`
  and `utm_name` categories unreachable.
- Depth is checked **before** recursing, so a hostile body cannot exhaust the
  stack on its way to being rejected.
- Violations report the category, path, limit, and actual **length**. The
  offending value is never echoed back.
- Everything is rejected with a stable **422 `payload_limit_exceeded`**,
  carrying `details.violations[]`.

**Request-size and field-size enforcement are separate.** Bytes on the wire
are `shared/security/read-body.js`; parsed field sizes are `limits.js`. A
4 KB payload with one 3000-character name passes the first and fails the
second.

The bounded reader counts bytes as the stream is consumed and abandons the
request at the first chunk that crosses the limit. `Content-Length` is treated
as a hint: an oversized declared length is refused before the stream opens,
but a *small* declared length is not trusted. Malformed UTF-8 is a rejection
(`invalid_encoding`), not a substitution — a body that does not decode cleanly
is not something to store. An oversized body never reaches `JSON.parse`.

---

## 5. Timestamps and clock skew

The conflict: the endpoint accepted `submittedAt` up to five minutes in the
future, and `timeline_events` enforces `recorded_at >= occurred_at`. A device
clock one second fast aborted the entire ingestion, returned 502, and retried
into the same failure.

Both halves were individually reasonable. The bug only existed between them,
and the test double could not see it because it did not model CHECK
constraints. It does now.

Resolution:

- `assessment_submissions.submitted_at` and the stored payload keep the
  visitor's value **verbatim**. It is the completion time and it is never
  rewritten.
- `received_at` is a separate fact: when the server got it.
- Timeline `occurred_at` is `least(submittedAt, now())`.
- Skew beyond one second sets `clockSkewDetected`, returned in the response,
  logged, and recorded in `assessment_submissions.ingest_meta` alongside
  `originalSubmittedAt`, `timelineOccurredAt`, `timelineTimestampClamped`, and
  the correlation id — so a clamped timestamp is explainable years later.
- Beyond five minutes ahead the timestamp is not credible and is refused with
  `submitted_at_in_future`.

Freshness now matches the browser queue: `CED_SUBMISSION_MAX_AGE_DAYS`,
default **30**. Freshness is not an abuse control — idempotency, rate
limiting, and the challenge are. Rejecting a two-day-old queued submission
only ever loses a real assessment.

---

## 6. Identity trust model

Strength and trust are different axes, and automatic linking requires both.

- **Strength** is intrinsic to the identifier *type*. A place id is strong; a
  business name is not.
- **Trust** is intrinsic to the *source*. Anything typed into a public form is
  `visitor_supplied` and unverified.

```
autoLinkable = STRONG_TYPES.includes(type) && verified && TRUSTED_SOURCES.includes(source)
```

Trusted sources: `trusted_integration`, `verified_enrichment`,
`authenticated_customer`, `manual_verification`, `seed`. Every identifier
carries `source`, `verified`, `verification_method`, and
`verification_evidence`, and a CHECK constraint refuses a row that claims to
be verified without a trusted source and a named method.

| Situation | Outcome | Business created? |
|---|---|---|
| Session already linked, **and nothing in the submission contradicts that record** | link, `linkMethod: session` | no |
| Session already linked, **materially contradicted** (rule B0) | `resolution_pending` + case | **no** |
| One candidate with a **verified** strong identifier | link automatically | no |
| No candidate | create | **yes** |
| No candidate, but a saved proposal was vetoed | `resolution_pending` + case | **no** |
| Weak-only match | `resolution_pending` + case | **no** |
| **Claimed** (unverified) strong match | `resolution_pending` + case | **no** |
| Two verified strong candidates | `resolution_pending` + case | **no** |

A session id is a client-supplied journey identifier. It PROPOSES a Business
Record; it does not decide one. See rule B0 in
[SERVICE_MIX_REVIEW.md](SERVICE_MIX_REVIEW.md) §10a, and
`shared/business-record/resolve-identity.js :: proposalConflict`.

Consequences that are deliberate:

- **Squatting reserves nothing.** The uniqueness backstop covers verified rows
  only, so a bot claiming a place id it does not own cannot block the real
  owner from later being verified against the same value.
- **Cross-business collisions surface.** A claim on an identifier another
  business already holds as verified is recorded in
  `identity_resolution_cases.conflicting_signals`, raised as an
  `identity.review_required` event, and **not written** under the claiming
  business. Previously an `exception when unique_violation then null` handler
  swallowed this, leaving a record whose strong identifier was never stored
  and which therefore could never match again.
- Identifier **format and length** are validated before a value becomes a
  signal at all. A malformed place id produces no signal rather than a bad one.
- **No merge exists.** There is no merge function, no auto-merge path, and no
  `merge` action in `RESOLUTION_ACTIONS`.

---

## 7. Retry and timeout behaviour

### Retry classification

Status alone was not enough. HTTP 409 carries two opposite meanings:

| Code | Status | Meaning | Classification |
|---|---|---|---|
| `request_in_flight` | 409 | A concurrent request holds this key | **retryable** |
| `idempotency_key_conflict` | 409 | This key was used for different content | **permanent** |

The client now classifies by **structured error code first**, falling back to
status only when no code is available.

Retryable: `request_in_flight`, `rate_limited`, `challenge_unavailable`,
`challenge_invalid`, `ingestion_failed`, `ingestion_timeout`,
`not_configured`, `body_read_failed`, plus any 5xx and 408/425/429.

Permanent: `idempotency_key_conflict`, `challenge_rejected`, every validation
code, `payload_too_large`, `payload_limit_exceeded`, `prohibited_data`,
`unsupported_version`. Permanent entries are **retained, not discarded** — the
queue keeps them for inspection until they expire.

`challenge_invalid` is retryable rather than permanent on purpose: a token
that has aged out cannot be refreshed by a retry, but the submission becomes
challenge-exempt once it passes the 15-minute age threshold, so a later retry
succeeds.

`Retry-After` is honoured from the header or `error.retryAfterSeconds`, and
only ever **lengthens** the backoff — the server knows when its rate-limit
window resets and the client does not. Advice is clamped to the 6-hour maximum.

### Timeout budget

```
challenge 3s  <  database 6s  <  function 15s  <  client 20s
```

- Challenge: `CED_CHALLENGE_TIMEOUT_MS`.
- Database: `CED_DB_TIMEOUT_MS`, applied as an abort signal **and** a race.
  An abort signal only helps if the transport honours it; a driver that
  ignores it would otherwise pin the function until the platform kills it.
- Function: `vercel.json` `maxDuration`.
- Client: `submission.timeoutMs` in each vertical config. Previously 10s,
  identical to Vercel's default limit, so the client abandoned requests at
  exactly the moment the platform did.

A database timeout returns **504 `ingestion_timeout`** with `Retry-After`. The
transaction may still commit afterwards; that is safe, because the retry
carries the same `Idempotency-Key` and collapses into a replay.

A previous version of the timeout helper leaked its race timer, which pinned
the event loop for the full budget on every successful request. Both timers
are now always cleared.

---

## 8. Logging and observability

- Every request carries a **correlation id**, returned in the
  `X-Correlation-Id` header, in successful bodies, and in `error.correlationId`.
  A visitor reporting "it failed" can be traced without being asked for
  anything.
- Unhandled errors log the **name, message, and stack server-side**. The
  previous version logged only `err.name`, which satisfied "do not expose
  internals to clients" by discarding the information needed to fix anything.
- Database error messages are logged in full server-side and mapped to a small
  set of client-safe codes.
- **Never logged:** contact details, answers, request bodies, challenge
  tokens, secrets, or raw addresses.
- No stack trace, SQL text, credential, or database detail ever reaches a
  client response.

Alerting and metrics are **not** part of this milestone. See §14.

---

## 9. Candidate lookup

> **Corrected by the real-Postgres run.** The original claim here — that
> 0002's correlated `EXISTS` "cannot use an index" and "degrades linearly" —
> **is false on PostgreSQL 17.** Measured over 9,008 identifier rows, the old
> shape and the new one produce the same plan, the same 8 buffer hits, and
> equivalent timings (0.476 ms vs 0.430 ms): the planner pulls the subquery up
> into a semi-join and reaches the same index.
>
> H1 was therefore **not a real blocker**. The rewrite is kept for the reasons
> below, but on clarity grounds, not performance.
> See [REAL_POSTGRES_VALIDATION.md §2](REAL_POSTGRES_VALIDATION.md#2-defects-found).

The Milestone 1 shape correlated a subquery against every row of
`business_identifiers`:

```sql
where exists (select 1 from jsonb_array_elements(p_signals) s
               where s->>'type' = bi.identifier_type ...)
```

It now expands the signals into a small `claimed` CTE and **joins into**
`business_identifiers` on `(identifier_type, normalized_value)`, which
`business_identifiers_lookup_idx` covers. The value of the rewrite is that it
states the access path explicitly rather than depending on a planner
transformation, and that it is where verified-versus-claimed classification
lives.

Context types are no longer persisted at all. A row per business recording
`vertical = nails` matched nothing (context types were excluded from the
lookup) while bloating the index with a single hot key. A CHECK constraint now
forbids them, and 0003 deletes any that exist. **The vertical is preserved as
context on `business_records.vertical_id`**, which is where it belongs.

### EXPLAIN guidance

Run against a real project with representative volume — a few thousand
businesses at minimum, since Postgres will happily seq-scan a small table:

```sql
explain (analyze, buffers)
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

**Expect** a `Nested Loop` driven by the CTE with an `Index Scan` on
`business_identifiers_lookup_idx`. **A `Seq Scan` on `business_identifiers`
means the rewrite did not take effect** — check that the index survived 0003
and that the join is not being flattened into a filter.

---

## 10. Version compatibility policy

- `CURRENT_PAYLOAD_SCHEMA = 3` — adds the `integrity` envelope.
- `SUPPORTED_PAYLOAD_SCHEMAS = [2, 3]`.
- `assessment_submissions.payload_schema_version` records what was received,
  with a CHECK constraint matching the supported range.

The rule: **when the current version moves forward, the previous one stays
accepted.** A browser holding a page cached before the deploy has queued
payloads in the older shape, and rejecting them loses completed work for a
reason that has nothing to do with the visitor.

A schema-2 payload has no `integrity` envelope, so during the migration window
it is treated as honeypot-absent and challenge-exempt. It is still
rate-limited, still size-limited, and still idempotent.

Unsupported versions return **400 `unsupported_version`** with
`details.{received, supported, current, reason}`, where `reason` is `retired`
for anything below the minimum and `unrecognised` above it.

**Retiring a version** means: confirm no queued payloads of that version can
still be within `CED_SUBMISSION_MAX_AGE_DAYS`, then remove it from the
supported set and widen the database CHECK in the same migration. With a
30-day window, a version cannot be retired less than 30 days after the deploy
that superseded it.

---

## 11. Real-Postgres test plan

**Everything above is verified against an in-memory double.** It mirrors the
SQL step for step and now enforces the CHECK constraints that ingestion can
violate, which is what makes the timestamp tests meaningful — but it is not
Postgres.

*Historical, superseded:* this section once continued "and the PL/pgSQL has
never run". It has since run. Migrations 0001–0005 executed against a hosted
development PostgreSQL 17 project, and the whole chain including 0006 executes
against a disposable local PostgreSQL 18.3 through PGlite on every
`npm run test:migration`. **0006 has not run against PostgreSQL 17, hosted
Supabase, or PostgREST**, and nothing has ever run through PostgREST — both
remain deployment blockers. See
[REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md).

The plan below is still the one to run against a scratch project before any
pilot traffic; the local run does not replace it.

**Setup.** Apply 0001, 0002, 0003 in order. Confirm 10 tables with RLS enabled
and forced, 0 policies, and the five functions present.

**Migration correctness**

1. `business_identifiers_strong_unique` is gone;
   `business_identifiers_verified_strong_unique` exists.
2. No rows remain with `identifier_type in ('vertical','locality')`.
3. `ingest_assessment` exists with exactly one signature (8 arguments). Two
   overloads would make the PostgREST call ambiguous.

**Constraint behaviour — the part the double cannot prove**

4. Insert a `timeline_events` row with `occurred_at` in the future; expect
   `timeline_recorded_after_occurred` to fire. Then ingest a submission whose
   `submittedAt` is 4 minutes ahead and confirm it **succeeds** with a clamped
   `occurred_at`.
5. Insert a `business_identifiers` row with a 3000-character
   `normalized_value`; expect `business_identifiers_value_length`, not a raw
   btree error.
6. Insert `verified = true` with `source = 'visitor_supplied'`; expect
   `business_identifiers_verified_requires_trust`.
7. Insert `identifier_type = 'vertical'`; expect
   `business_identifiers_no_context_types`.

**Language-level checks**

8. `get diagnostics v_claimed_rows = row_count` now assigns to an **integer**,
   not a boolean. The previous version relied on PL/pgSQL's I/O-cast fallback
   (`1` → `'1'` → `true`); confirm the claim path behaves correctly on both a
   first write and a replay.
9. `continue when ...` inside the identifier loop skips as intended.
10. `array_remove(array_agg(distinct case ... end), null)` yields `{}` rather
    than `{NULL}` for a candidate with no verified strong identifier.

**Behaviour**

11. First ingestion → `1, 1, 1, 5` across businesses, submissions, BIRs,
    events. Replay with the same key leaves all four unchanged and returns
    `replayed: true`.
12. Two concurrent requests on one key: one succeeds, the other either replays
    or raises `request_in_flight`. Neither creates a duplicate.
13. Second assessment for one business sets `supersedes_bir_id` to the prior
    `current_bir_id`, and `current_bir_id` advances only after the insert.
14. `check_rate_limit` returns `allowed: false` on the request after the limit,
    with a positive `retryAfterSeconds`, and buckets expire.
15. `redact_business_pii` completes without violating a constraint, and
    `purge_expired_idempotency_records` removes only rows past `expires_at`.

**Performance**

16. Seed ~5000 businesses (~30 000 identifiers) and run the EXPLAIN in §9.
    Confirm an index scan.

---

## 12. Maintenance

`purge_expired_idempotency_records(p_now, p_limit)` deletes **only** rows past
`expires_at`, in batches so a backlog cannot hold one long transaction open,
and returns the count removed. `purge_expired_rate_limit_buckets(p_now)` does
the same for rate-limit buckets, which are additionally swept probabilistically
(1% of calls) so the hot path is not also a delete path.

**No scheduler is wired up.** Both are maintenance-role only; execute is
revoked from `public`, `anon`, and `authenticated`. When one is needed, the
two candidate paths are:

- **`pg_cron`** inside Supabase — simplest, keeps the credential in the
  database, needs the extension enabled.
- **An authenticated maintenance route** invoked by a scheduled job — more
  moving parts, but observable in the same place as the rest of the platform.

Neither is chosen. Until one is, run them by hand during the pilot and watch
`idempotency_records` growth.

---

## 13. BIR history chain

`supersedes_bir_id` existed and was never populated, so successive reports for
one business were unlinked even though `current_bir_id` was being overwritten.

Now, on every ingestion for a resolved business:

1. `select current_bir_id ... for update` — the previous current report.
2. Insert the new BIR with `supersedes_bir_id` set to it, and record the same
   value in `report.provenance.supersedes`.
3. **Only then** update `current_bir_id`.

Every prior BIR is preserved and none is rewritten. The chain is walkable from
`current_bir_id` back to the first report. A replay returns before any of this
and creates no second link. A submission whose identity is unresolved gets a
stored BIR with `business_id = null` and no chain link, until a resolution
surface exists to attach it.

Prior reports are **not** updated to record that they were superseded — that
would be rewriting historical intelligence. The backward chain carries the
same information.

---

## 14. Remaining launch blockers

### Before a private pilot

1. ~~Execute the real-Postgres test plan.~~ **Done** — see
   [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md). Migrations
   0001–0003 are proven against Supabase Postgres 17.6. Two defects were found
   and fixed; the ingestion logic itself had none. Not yet validated:
   concurrency (`request_in_flight` under genuine parallel load) and the
   endpoint's own code path against a live database.
2. **Choose and configure a challenge provider**, or run the pilot on a
   private URL with `CED_CHALLENGE_REQUIRED=false` and accept that the
   endpoint is then defended by six layers rather than seven.
3. **Verify proxy header behaviour** on the real platform so address-scoped
   rate limiting is trustworthy (§3).
4. **Generate `CED_RATE_LIMIT_SECRET`** and set every variable in
   [.env.example](../.env.example).
5. **Pin the function region** in `vercel.json` to the Supabase region.

### Before public traffic

6. **A challenge provider is mandatory.** Not optional.
7. **Monitoring and alerting** — nothing currently surfaces resolution-queue
   depth, 429 rate, 5xx rate, replay rate, or ingestion latency. Combined with
   the absent review surface, ambiguous submissions are invisible *and*
   unworkable.
8. **A disaster-recovery position** — no stated RPO/RTO, no PITR tier
   decision, no export path. The Business Record is described as permanent and
   nothing yet backs that.
9. **Consent wording reviewed by counsel**, and `data-legal-review="pending"`
   removed from the markup.
10. **The retention and redaction policy reviewed by counsel** — see
    [DATA_RETENTION_AND_REDACTION.md](DATA_RETENTION_AND_REDACTION.md). Nothing
    in this repository claims compliance with any law.
11. **An identity-resolution surface.** Cases accumulate with nobody able to
    work them, and with only weak signals available most returning businesses
    land in that queue.
12. **A least-privilege read role.** Today everything is the service role, so
    the first admin surface would be built on a key that can rewrite history.
13. **A scheduled maintenance job** for the two purge functions (§12).
