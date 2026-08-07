# SM-1 — the Independent Quick Service Mix Review

The second review type on the platform, and the first thing that forced the
word "assessment" to stop meaning "the Growth Review".

> **Nothing in this document claims compliance with any law or regulation, and
> nothing here is accounting, tax, legal, or regulatory advice.** Every dollar
> figure the Quick Review produces is a diagnostic estimate. See §4 of
> [CLAUDE.md](../CLAUDE.md), which governs.

---

## 1. What SM-1 is

A free, self-paced review in which an owner enters **two to five offerings**
— three is the recommendation — and receives a deterministic read of where
revenue and staffed hours actually go.

It answers one question: *given what you charge, how long it takes, and how
often you sell it, which offerings earn their place in your day?*

It deliberately does **not** answer *"which offerings are profitable?"* SM-1
collects no direct costs, so it cannot. That single restraint shapes almost
every decision below.

### Two ways in

| Entry | What happens |
| --- | --- |
| **Standalone** | A visitor arrives cold. Identity is resolved by the existing rules; an ambiguous one is queued for review exactly as a Growth Review would be, and the review still completes and still returns results. |
| **After a Growth Review** | The Growth results screen offers it. The server issued a continuation context at Growth submission; the browser echoes it back and the Service Mix submission attaches to the **same** Business Record without the visitor re-typing anything. |

A visitor who arrives standalone and later completes a Growth Review is two
submissions that resolve to one record by the normal identity rules. Nothing
about SM-1 changes those rules.

### Under eight minutes

Stage 1 asks for the business's name and email once (skipped when a
continuation context already supplies them), the coverage declaration, and
then six short fields per offering. Three offerings is 18 offering fields plus
four fixed ones. That is the design target and the reason the per-offering
question list is as short as it is.

---

## 2. Scope — what SM-1 does and does not build

**In scope**

- A reusable `shared/service-mix-engine/` that any vertical can configure.
- The nail-salon Quick Service Mix Review as the first configuration.
- A Service Mix **BIR v5**, generated server-side and persisted.
- `review_type` as a first-class dimension across submissions, sessions,
  reports, and analytics.
- `business_review_states`, so Growth and Service Mix are independently
  current for one business.
- Review-type-separated analytics with an extended privacy denylist.

**Explicitly out of scope**

Stage 2 (direct costs, repeat behaviour, bundling detail, seasonality,
cancellation exposure, pricing sensitivity), the AI Opportunity Analysis,
the Closing Engine, checkout, payments, and activation. §10 lists what SM-2
inherits.

---

## 3. Folder structure

```
shared/service-mix-engine/
  value.schema.js              value contract, uncertainty constants, interval arithmetic
  offering.schema.js           offering identity, vocabularies, limits, payload validation
  calculate.js                 deterministic Stage 1 calculations
  classify.js                  concerns, opportunities, health classification
  guidance.js                  findings, immediate actions, 30-day tests
  generate-service-mix-bir.js  BIR v5 generation and validation
  controller.js                browser controller for the Quick Review page

shared/business-intelligence/
  review-registry.js           review-type routing: which engine, which BIR version

verticals/beauty-wellness-fitness/nails/service-mix/
  service-mix.config.js        starters, copy, thresholds, transport
  site/index.html              the page
  site/styles.css              page styles (tokens are imported, never redefined)

supabase/migrations/
  0006_service_mix_review.sql  run against local PostgreSQL 18.3 (PGlite);
                               NOT applied to any hosted database
```

Every shared file is a classic-script IIFE with the dual
`module.exports` / `window.X` export the rest of the repository uses. No build
step, no ES modules — the page must still open from `file://`.

---

## 4. The Service Mix value contract

The single most important idea in SM-1. An owner rarely knows a number
exactly, and a review that forces them to pretend produces confident nonsense.

Every numeric figure is a **measured value**, not a number:

```js
{ kind: 'exact' | 'range' | 'estimate' | 'unknown' | 'not_applicable',
  value: number | null,          // exact and estimate
  low:   number | null,          // range
  high:  number | null }         // range
```

| kind | Means | Resolves to the interval | Evidence weight |
| --- | --- | --- | --- |
| `exact` | Read off a price list or a report | `[v, v]` | 1.00 |
| `range` | "Between 45 and 60" | `[low, high]` as given | 0.80 |
| `estimate` | "About 50" | `[v·(1−u), v·(1+u)]` | 0.60 |
| `unknown` | Genuinely does not know | no interval | 0.00 |
| `not_applicable` | The measure does not apply | no interval | excluded |

`unknown` and `not_applicable` are **not** the same and are never collapsed.
An unknown is a measurement gap and lowers completeness. A not-applicable is
a correct answer and is removed from the denominator entirely — a retail
product with no appointment time is not an unmeasured service.

### v1 uncertainty constants

Versioned so they can be recalibrated against real data without archaeology.
Changing one changes every interval the engine produces, which is why they
live in exactly one place and carry a version string.

| Measure | ± | Constant |
| --- | --- | --- |
| Selling price | 10% | `sellingPrice` |
| Direct cost | 20% | `directCost` (declared for SM-2; SM-1 never collects one) |
| Duration | 15% | `duration` |
| Monthly volume | 25% | `monthlyVolume` |

`UNCERTAINTY.version` is `service-mix-uncertainty-v1` and is stamped into
every BIR, so a report generated under v1 stays interpretable after a
recalibration.

Volume is the widest band on purpose. Owners estimate "how many did I do last
month" far less accurately than "what do I charge", and an interval that
pretends otherwise understates the real spread.

### Conservative interval arithmetic

All operands are non-negative, which keeps the rules simple and the direction
honest:

```
add(a, b)      → [a.lo + b.lo, a.hi + b.hi]
multiply(a, b) → [a.lo · b.lo, a.hi · b.hi]
divide(a, b)   → [a.lo / b.hi, a.hi / b.lo]
share(p, t)    → [p.lo / t.hi, p.hi / t.lo] clamped to [0, 1]
```

**Any unknown operand makes the result unknown.** There is no fallback, no
imputed median, no "assume the average". This is the arithmetic form of the
rule that SM-1 never fabricates a figure it did not measure.

`divide` by an interval containing zero returns unknown rather than infinity.

---

## 5. Offering identity and snapshot rules

Two identifiers with two jobs, mirroring the `assessmentSessionId` /
`submissionId` split the platform already uses.

| Identifier | Minted | Lifetime |
| --- | --- | --- |
| `offeringId` | When an offering is **first added** | Permanent. Survives renaming. |
| `offeringSnapshotId` | On **every submission** | One per submitted version of that offering. |

The rules, all enforced in `offering.schema.js`:

1. **Renaming retains the `offeringId`.** "Gel manicure" becoming "Gel set" is
   the same offering with a new label, and its history must stay attached.
2. **Every submitted version gets a new `offeringSnapshotId`.** Two
   submissions six months apart produce two snapshots of one `offeringId`, and
   the price change between them is legible.
3. **Replacing creates a new `offeringId` and records `replacesOfferingId`.**
   Discontinuing acrylic fills and introducing a structured-gel service is a
   *different* offering that occupies the old one's place. Merging them under
   one id would average two unrelated things.
4. **Removing before submission creates no permanent history.** An offering
   added and deleted in the same sitting never happened. Only submission makes
   a record.
5. **Offerings are never merged on name similarity.** Not by the engine, not
   by the database, not ever. "Gel mani" and "Gel manicure" may be the same
   thing or may be two price points, and only the owner knows.
6. **Reassessment presents prior offerings for confirmation.** The owner
   confirms, renames, replaces, or removes each one. Silent matching would
   quietly rewrite what a previous report meant.

### Where snapshots live

Inside the append-only submission payload and inside the BIR. **No normalized
offering tables in SM-1.** The submission is already append-only and already
the durable record; a second normalized copy would need its own supersession
rules, its own redaction path, and its own migration before anything reads it.
SM-2 revisits this when longitudinal offering comparison actually needs it.

---

## 6. Deterministic Stage 1 calculations

Collected per offering: name, category, selling price, appointment or labour
time, approximate monthly volume, demand, primary role, and — for each of the
three numeric figures — whether it is exact, a range, an owner estimate, or
unknown.

Collected once: whether the entered offerings represent **all** offerings,
the **most revenue-producing** ones, a **selected sample**, or **unknown**
coverage.

Everything below is computed from those inputs and nothing else.

| Output | Formula | Unknown when |
| --- | --- | --- |
| Monthly revenue | `price × volume` | either operand unknown |
| Capacity hours consumed | `(duration × volume) / 60` | either operand unknown |
| Revenue per capacity hour | `revenue / hours` | either unknown, or hours spans zero |
| Share of entered revenue | `revenue / Σ revenue` | own revenue unknown |
| Share of entered capacity | `hours / Σ hours` | own hours unknown |

Portfolio totals sum only the offerings whose figure is known, and the report
says how many were excluded. A total built by treating unknown as zero would
read as a measurement.

### Completeness and confidence

**Completeness** is evidence-weighted coverage of the required measures:

```
completeness = Σ (weight of each supplied measure) / (count of applicable measures)
```

using the evidence weights in §4. Three offerings with every figure exact
scores 1.00. The same three with every figure estimated scores 0.60. That
difference is the whole point: both are complete in the naive sense and only
one supports a firm conclusion.

**Confidence** blends completeness with two things that decide whether the
portfolio can be reasoned about at all:

```
confidence = completeness · 0.70
           + coverageFactor · 0.20
           + offeringCountFactor · 0.10
```

| Coverage declared | factor | Why |
| --- | --- | --- |
| `all_offerings` | 1.00 | shares are shares of the real business |
| `most_revenue` | 0.80 | the tail is missing but the mass is present |
| `selected_sample` | 0.45 | shares describe the sample, not the business |
| `unknown` | 0.30 | we do not know what we are looking at |

`offeringCountFactor` is `(n − 2) / 3` clamped to `[0, 1]`: two offerings is
the floor and supports the least comparison, five is the ceiling.

Confidence is reported to two decimal places and never rounded up.

### What SM-1 refuses to compute

Contribution leaders, underpricing candidates, add-on opportunities, and
bundle opportunities are all present in the BIR and all resolve to
`{ available: false, reason: 'requires_detailed_review' }` unless complete
cost evidence exists — which in SM-1 it never does.

They are present rather than absent because a consumer that cannot tell
"not measured" from "not applicable" will eventually treat an empty array as
a finding of none.

---

## 7. Health classification

Deterministic, versioned, and **not a score**. A number invites comparison
between businesses that this evidence cannot support; a classification says
what it knows.

Evaluated in order — the first match wins:

| Classification | Condition |
| --- | --- |
| `insufficient_evidence` | fewer than 2 valid offerings, **or** confidence < 0.45 |
| `undermeasured` | enough offerings, but completeness < 0.65 |
| `attention_needed` | at least one sufficiently supported pricing or capacity concern |
| `generally_healthy_with_opportunities` | no major concern and at least one evidence-supported opportunity |
| `generally_healthy` | sufficient confidence, no major concern, no material opportunity |

Order matters. A portfolio with a real concern and thin measurement is
reported as `undermeasured`, not `attention_needed` — because the concern
rests on figures that are not solid enough to act on, and saying otherwise
would send an owner to change a price on the strength of a guess.

### What counts as "sufficiently supported"

A concern is only raised when its **interval**, not its midpoint, clears the
threshold. This is the rule that stops SM-1 manufacturing findings.

| Concern | Raised when |
| --- | --- |
| `capacity_heavy_low_return` | share of entered capacity ≥ 0.40 **and** share of entered revenue ≤ 0.60 × capacity share, both computed from intervals that do not overlap the threshold |
| `revenue_per_hour_far_below_portfolio` | the offering's **entire** revenue-per-hour interval sits below 0.60 × the portfolio's revenue-per-hour midpoint |

| Opportunity | Raised when |
| --- | --- |
| `strong_demand_high_return` | demand is `strong`, and the offering's entire revenue-per-hour interval sits above 1.25 × the portfolio midpoint |
| `weak_demand_high_capacity` | demand is `weak` and capacity share ≥ 0.30 — a scheduling question, framed as one |

Every one of these is a **pricing or capacity** observation. None of them
claims profit, and none of them survives an interval that overlaps its
threshold.

### Language

**"Estimated contribution leader", never "profit leader".** The phrase
"profit" is reserved for a figure that has seen costs. `classify.js` exports
`CONTRIBUTION_LANGUAGE` and the templates read from it, so the wording cannot
drift into a claim SM-1 cannot support.

Since SM-1 collects no costs at all, even *estimated contribution* is
unavailable, and the report says so in those words rather than silently
omitting the section.

---

## 8. Business Record implications

### review_type is the new dimension

`growth_review` and `service_mix`. Every existing row is `growth_review`, by
backfill and by column default, because that is what every existing row is.

### business_review_states

Keyed `(business_id, review_type)`. One row per review type per business,
holding that review type's `current_bir_id`, its most recent submission, and
when it last completed.

This is what makes "Growth and Service Mix remain independently current"
true. Without it there is one `current_bir_id` per business and the second
review type to finish silently displaces the first.

### The legacy pointer

`business_records.current_bir_id` **keeps meaning "the current Growth BIR"**
and is never written by a Service Mix ingestion. It predates review types, it
is referenced by an existing foreign key, and quietly repurposing it would
change what every existing consumer reads without telling them.

`business_review_states` is the forward-looking surface. The legacy column is
maintained for Growth only, and the migration enforces that with a trigger
rather than trusting callers.

### Supersession

A BIR may only supersede another BIR **of the same business and the same
review type**. Enforced in the database, not just in the ingestion function,
because the constraint is the thing that guarantees a Service Mix report can
never enter the Growth supersession chain.

A Service Mix report may **reference** the applicable Growth BIR — that is
what `relatedGrowthReview` is for — but a reference is not a chain link. It
copies nothing, mutates nothing, and supersedes nothing.

### Append-only, unchanged

Every prior submission and every prior report survives. Nothing in SM-1
deletes, rewrites, or supersedes across review types. Timeline and audit
payloads carry no contact data, exactly as before — which for SM-1 also means
they carry no offering names and no prices.

---

## 9. Migration design

`supabase/migrations/0006_service_mix_review.sql`.

**Execution status, stated once and consistently everywhere:**

- It **has** been executed, in full, against a disposable local PostgreSQL
  **18.3** through PGlite 0.5.4 — a clean install, and an upgrade over
  populated pre-0006 data, with `npm run test:migration` and
  `npm run test:integration:local` passing. See
  [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md).
- It **has not** been executed against hosted Supabase, and it has not been
  executed against PostgreSQL 17 — the hosted development project is
  17.6.1.155, and a behaviour that differs between the two majors would not
  have been caught here.
- Nothing has run over PostgREST at all, so signature resolution by argument
  name over HTTP remains unproven.

1. `review_type text not null default 'growth_review'` on
   `assessment_submissions`, `assessment_sessions`,
   `business_intelligence_reports`, `analytics_events`, `analytics_sessions`,
   and `analytics_funnel_daily`, each with a CHECK against the vocabulary.
2. `business_review_states`, primary key `(business_id, review_type)`.
3. The BIR schema-version CHECK widens from `between 2 and 4` to
   `between 2 and 5`. Existing versions stay valid; a v4 Growth report is
   still a correct report.
4. Review-type indexes on the columns reporting will actually filter.
5. A BEFORE INSERT trigger refusing a `supersedes_bir_id` that points at
   another business or another review type.
6. A trigger refusing any attempt to set `business_records.current_bir_id` to
   a non-Growth report.
7. Review-type-aware timeline events: `service_mix.completed` and
   `service_mix_bir.generated`, appended by trigger in the same transaction,
   alongside — never instead of — the existing generic events.
8. `ingest_review()`, the generic path, with `ingest_assessment()` retained as
   a thin wrapper that calls it with `growth_review`. The existing endpoint,
   the existing tests, and any queued browser submission keep working with no
   change at all.
9. RLS enabled **and forced** with **zero policies** on the new table, and
   `revoke all … from anon, authenticated` reapplied.
10. Backfill of every pre-existing row to `growth_review`, and a backfill of
    `business_review_states` from the current Growth pointers.
11. Written to be rerun-safe: `add column if not exists`, `create table if not
    exists`, `drop constraint if exists` before `add constraint`,
    `create or replace function`, and `drop trigger if exists` before
    `create trigger` — the same conventions 0003, 0004 and 0005 use.

### The one real risk, stated plainly

Turning `ingest_assessment` into a wrapper means transcribing its body into
`ingest_review`. Migration 0004 declined to do exactly this and used triggers
instead, on the grounds that a transcription error in the parts that did not
change is likelier than a bug in the change itself. That reasoning still
holds and is why the stage events are still triggers.

It is overridden here for one reason: the alternative is two copies of the
identity-resolution rules, and
[CLAUDE.md §3](../CLAUDE.md) treats a second copy of shared logic as the
defect. A bug fixed in one copy and not the other is a permanently wrong
identity decision, which is worse than a transcription risk that a real-
Postgres run will catch. The compensating control is
[the real-Postgres validation procedure](REAL_POSTGRES_VALIDATION.md), which
must run before 0006 is applied anywhere.

---

## 10. Test and acceptance criteria

Acceptance, restated as things that must be true:

1. The nail-salon Quick Service Mix Review opens and completes.
2. Two offerings is accepted, five is accepted, one is refused, six is refused.
3. A Service Mix BIR v5 is generated, validated, and persisted.
4. It attaches to the same Business Record as a Growth Review when — and only
   when — a server-issued continuation context says so.
5. Growth and Service Mix reports are independently current.
6. Growth scoring, close readiness, pricing, package recommendation, and
   existing BIR records are byte-for-byte unchanged.
7. Analytics is separated by review type and carries no offering name, id,
   price, cost, revenue, volume, or duration.

Test coverage lives in `tests/service-mix-*.test.mjs`. The
existing `tests/scoring-parity.test.mjs` is the regression that proves item 6
and must keep passing untouched.

Migration behaviour is covered by the repository's real-Supabase strategy —
guarded integration tests in `tests/integration/` that skip unless explicit
credentials are present. **The hosted path is skipped**, because no
credentials were available and the instruction forbids touching hosted
Supabase.

The same suites run against a disposable local PostgreSQL 18.3 through PGlite
with `CED_LOCAL_PG=true`, and 0006 passes there in full — see section 9 for
the execution status stated in one place, and
[REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) for what that run
does and does not prove.

---

## 10a. Four things SM-1 does differently, and why

**A proposal is not a decision.** Rule B0, in `ingest_review` (via
`public.identity_proposal_conflict`) and in
`shared/business-record/resolve-identity.js :: proposalConflict`.

**Two** things can name a Business Record before any identifier is looked at,
and neither is evidence about the business:

| Proposal | What it actually proves |
|---|---|
| a continuation context | this browser recently finished a review that resolved to this record |
| an assessment session id | a previous submission carrying this same string resolved to this record |

Both are statements about a **browser**. A friend borrows the laptop, an owner
reviews a second location, a consultant works through two clients — and each
statement stays true while the business changes underneath it.

This was found twice. The token did it first: linking on a valid context alone
filed one business's submission, report, email and name under another. The
session did it again, with no token at all — same journey id, `linkMethod:
"session"`, same outcome. Permanently both times, in tables that refuse UPDATE
and refuse DELETE.

So every proposal is compared with the active identifiers the record it names
already holds. A contradiction is **material** when the business name
contradicts, **and** at least one piece of contact evidence contradicts,
**and** nothing agrees. All three: a name change alone is a rebrand, an email
change alone is a new address, and one agreement anywhere is continuity. The
rule is deliberately hard to trigger, because a false positive costs a queued
review and a false negative costs a permanent cross-business contamination.

**Two proposals, one submission** — rule B0b, deterministic in every case:

| Situation | Outcome |
|---|---|
| both name the same record, no contradiction | link |
| exactly one proposal, no contradiction | link |
| any proposal materially contradicted | review |
| two surviving proposals naming different records | review |

"Any contradiction → review" is stricter than it strictly needs to be in one
case: a consistent session alongside a contradicted token could arguably link
by session. It does not, because the alternative is a rule with an exception
in it. Choosing silently is how a submission ends up attached to one record
while `assessment_sessions.business_id` still points at another — permanently,
since that column is written once and never rewritten.

A vetoed proposal is set aside entirely — not weakened, not used as a
tie-break. Resolution then runs on the submission's own evidence, with one
change: it may not **create**. The only evidence that this is a new business is
the same evidence that just contradicted a saved proposal, so the outcome is
`resolution_pending` with a case for a human. The visitor still gets their
results. The case records which identifier *types* agreed and contradicted,
and never a value.

The browser helps but does not decide. **"This is not my business"** starts a
genuinely new journey: it clears the context and the prefill, **mints a new
assessment session id**, and drops the submission id, its fingerprint and the
completion timestamp — keeping the session would have produced a submission
proposing the very record the visitor had just disowned. Typing over an
identity-bearing prefilled field does exactly the same, silently, because the
quiet path is the one most people take. The offerings survive: they carry no
identity, and discarding them would punish someone for correcting us.

The queued-retry sweep offers a stored context only when the queued payload's
own contact evidence matches the prefill beside it. A queued payload keeps its
original session id, though, and the browser cannot re-issue one for work
already queued — so the server applies rule B0 to a retry exactly as it does
to a live submission.

**Two permissions, not three.** The platform records three independent
consents; this review offers two. SMS consent is only ever offered where a
mobile number is collected, and the Quick Review collects none, so the row
stays absent rather than present-and-disabled.

The required permission does **not** promise an email. Nothing in this
repository sends a message — there is no tested delivery path — so the
statement the visitor ticks says what actually happens: the review is sent to
CED Solutions, the figures are worked out, and the results appear on the
page. A permission describing a behaviour we do not have is not consent to
anything. The wording changes when the behaviour does, and not before. It
remains marked `data-legal-review="pending"` either way.

**A queued review is retried by this page.** A submission that cannot be sent
is saved on the device, and the controller sweeps the queue on every load of
the Service Mix page. The continuation context is resolved *at retry time*
from the shared store and travels as the `X-CED-Continuation` header, so it is
never written into the queued payload or beside it in the queue entry — a
queue entry lives in localStorage for up to thirty days, and a signed bearer
value written there is a credential at rest long after it is useful for
anything but replay. A refreshed context returned by a retry is stored back
under the shared key, keeping the prefill it already had. The submission id
does not change across retries, so the server collapses a retry into a replay.

**Service Mix analytics metadata is a closed allowlist.** For any event
resolved as `service_mix`, only `reviewType`, `stage`, `stepId`, `trigger`,
`offeringSource`, `offeringCountBand` and `resultKind` may appear, and each
value is checked against its own enum or type. The name-based prohibition
catches an honest leak — someone adds `ownerEmail` — but cannot catch
`stepId: "owner@example.com"`, because the key names itself. Unapproved keys
and unapproved values are removed in the browser and refused at the endpoint.

`metadata.reviewType`, when present, must be `service_mix` — an event already
resolved as Service Mix that also claims to be a Growth Review is either a bug
or an attempt to file the row in the other funnel.

Alongside the seven, a short list of **platform annotations** is permitted —
but only on **the one event that uses them**. `assessment.abandoned` may carry
`provisional` (exactly `true`), `trigger` (`idle`, `page_hidden`,
`page_exit`), `quietForMs`, `resumedCount`, `reachedStage1` and
`reachedStage2`. Every other Service Mix event rejects all six.

They exist because `provisional` is what marks an abandonment count as a floor
rather than a total: dropping it would have left this funnel reporting
inferred abandonments as observed ones. They are event-specific because a page
view that claims to be provisional is a lie about how the number was obtained,
and CLAUDE.md section 11 exists to prevent exactly that.

The separation is a **code path**, not a convention. `analytics-client.js`
has two entry points into one queue: the public `track()`, which every page
uses and which can never attach an annotation whatever event it names, and a
module-private `trackInternal()`, used only by the client's own abandonment
inference. The boundary is a parameter the client alone supplies.

`clockSkewClamped` and `claimedOccurredAt` are **never accepted from a
request**. `api/analytics.mjs` strips them from every incoming event and
writes them itself, from the parsed timestamp, only when it actually clamps
one. A client that could assert "my timestamp was clamped" could annotate a
row with something that never happened.

None of this treats browser-originated analytics as trustworthy. There is no
signed session token; the endpoint's real defences remain the origin
allowlist and rate limiting, and the worst outcome of forged events is still a
wrong funnel. What the event-specific rule buys is that a forged event cannot
make a *stored row* claim a provenance it does not have.

`service_mix.bundle_recommendation_viewed` stays in the catalog and is **not
emitted**. The Quick Review recommends no bundles; the control that mentions
them explains their absence. An event name is a shared contract, so it is kept
for the Detailed Review rather than repurposed.

---

## 11. Deferred to SM-2

- **Direct costs** per offering — the only thing that turns "estimated
  contribution" into a figure that may be shown, and the reason the
  `directCost` uncertainty constant already exists.
- **Contribution leaders, underpricing candidates, add-on and bundle
  opportunities** — the four BIR sections that currently resolve to
  `requires_detailed_review`.
- **Repeat behaviour, seasonality, cancellation exposure, pricing
  sensitivity.**
- **Normalized offering tables**, if and when longitudinal comparison across
  reassessments needs them. The snapshot-in-payload design is deliberately the
  smaller commitment.
- **The AI Opportunity Analysis.** SM-1 populates
  `aiOpportunityInputs` in the BIR and nothing reads it yet — the inputs are
  reserved, deterministic, and free of free text so that whatever reads them
  later starts from evidence rather than prose.
- **A surface for the identity-resolution queue.** SM-1 adds a second review
  type that can land in it and still nobody can work it. That gap is older
  than this milestone and is not closed by it.
