# Assessment analytics

Measuring how people move through the assessment, so completion, Stage 2
adoption and offer engagement can be improved with evidence instead of guesses.

**Status: implemented and validated against real Postgres, not deployed.**
Migration 0005 was applied to `ced-cip-dev` (Postgres 17.6.1.155) on
2026-08-05 and every event family, the roll-up, the funnel, the drop-off
report and retention were exercised end to end — see
[REAL_POSTGRES_VALIDATION.md §6c](REAL_POSTGRES_VALIDATION.md). Two SQL
defects were found and fixed there, and six privacy gaps were closed. Nothing
is wired to a dashboard, and no third-party SDK is loaded anywhere.

**Business Record rows changed during validation: zero.**

Companions:
[ANALYTICS_EVENT_CATALOG.md](ANALYTICS_EVENT_CATALOG.md) (what each event
means) and [ANALYTICS_PRIVACY.md](ANALYTICS_PRIVACY.md) (what it may carry).

---

## 1. The governing rule

**Analytics must never affect the assessment.**

Not its scoring, not its branching, not its payload, not its report, not its
price. Every call in the engine goes through a wrapper that swallows anything
thrown, every public method of the client is guarded, and a failed flush
degrades to "we lose a measurement" rather than "the visitor loses their work".

Two tests pin it: one runs a complete two-stage journey against a client that
throws on *every* call, and one compares the submission payload with and
without a client attached and asserts the answers, results and branching are
identical.

The second rule follows from the first: **nothing analytics writes is ever read
back**. There is no foreign key from an analytics table to the Business Record,
no trigger that touches one, and no function in migration 0005 that writes
outside the analytics tables. The worst outcome of forged analytics is a wrong
funnel — never a wrong report or a wrong price.

---

## 2. Architecture

```
page  →  events.js        the contract: names, categories, prohibitions
      →  analytics-client.js   queue, batch, clocks, retry, sampling
      →  engine.js         instrumentation, via one adapter and delegation
              ↓  POST /api/analytics   (same origin, batched)
      →  api/analytics.mjs      validate each event, refuse PII, rate limit
              ↓  ingest_analytics_events()   one call, one transaction
      →  assessment_analytics_events     append-only, expires
      →  assessment_analytics_sessions   summary, forward-only
      →  assessment_funnel_daily         counters, retained longer
              ↓
      →  funnel.js          counters → rates, and the drop-off report
```

**Postgres counts; JavaScript divides.** Every rate is defined once, in
[funnel.js](../shared/analytics/funnel.js), so "Stage 2 start rate" cannot mean
one thing in SQL and another in a report.

---

## 3. The timing model

Two clocks, because they answer different questions.

| | Measures | Includes the night the tab sat open? |
|---|---|---|
| `totalElapsedMs` | Wall time since the session began | Yes |
| `activeElapsedMs` | Time the visitor was plausibly present | No |

"This step takes four minutes" is only ever true of the second.

The active clock **pauses** on:

- `visibilitychange` → hidden
- window `blur`
- no input for `idleThresholdMs` (default 60s)

and **resumes** on pointer, key, scroll, touch, focus, or the tab becoming
visible. A tab left open overnight yields eight hours of elapsed time and
roughly a minute of active time — asserted by a test.

Per-step time restarts on every step view, so "time on step 4" is time in *this
visit*. Summing visits is the reporting layer's job.

Marks measure active time between milestones and are **null before the mark
happened**, never zero — a zero would read as "instant":

| Measurement | Mark |
|---|---|
| Time to first answer | `markFirstAnswer` |
| Stage 1 result → Stage 2 start | `markResultsViewed` |
| Result → CTA click | `markResultsViewed` |
| Stage 1 → Stage 2 completion | `markStage1Complete` |

---

## 4. Abandonment

**Inferred, never observed, and deliberately reluctant.** Three conditions must
all hold:

1. the visitor started and has not finished the stage they are in;
2. they have been inactive past `abandonThresholdMs` (default 30 minutes), or
   the page is going away;
3. we have not already said this about this exact `(stage, step)` state.

Three things it is **not**:

- **A pause is not an abandonment.** Someone who returns produces
  `assessment.resumed`, which clears the suppression so a later, genuine exit
  is still recorded.
- **Finishing Stage 1 and leaving is not an abandonment.** Stage 2 is optional
  by design; declining it is a successful outcome. Asserted by a test.
- **It is not final.** Every abandonment event carries `provisional: true`, and
  the session roll-up *retracts* it: a session that later produces any
  progression event has its `abandoned_at` cleared. The client cannot know the
  future at the moment it guesses, so the database does the retraction.

**Known blind spot:** a visitor who closes the tab instantly, before any
listener fires, is invisible. Abandonment counts are therefore a floor, not a
total.

---

## 5. Client behaviour

| Concern | Behaviour |
|---|---|
| Batching | Flushes at 12 events, on stage boundaries, on CTA clicks, on modal close, and on page exit. |
| Page exit | `sendBeacon` when available — it survives the navigation, which is exactly when the most interesting event is produced. |
| Offline | Queue mirrored to `localStorage`, restored on the next page view, retried. |
| Retry | Exponential backoff from 2s, capped at 5 minutes, at most 5 attempts, then the event is given up on. |
| Permanent refusal | A 4xx that is not 429 discards the batch — retrying something the endpoint will never accept is a loop with no exit. |
| Queue overflow | Capped at 200; drops the **oldest**, because the newest describe where the visitor actually is. |
| Expiry | Queued events older than 24h are dropped rather than delivered late and misleading. |
| Duplicates | Suppressed by `eventId` client-side and by primary key server-side. Once-per-session events are suppressed by name. |
| Sampling | Decided **once per session**. Per-event sampling would produce a visitor who appears at step 3 and vanishes at step 4 for no reason. |
| Development | With no endpoint (a page opened from `file://`) nothing leaves the device. |

---

## 6. Instrumentation rules

- **One delegated listener per concern.** Questions are counted by a single
  listener on the form reading `event.target.name`; CTAs by a single listener
  on the modal reading `data-analytics-event`. A vertical adds a measurement by
  adding an attribute, not by editing the engine.
- **A step is viewed once per stage pass.** Navigating back does not view it
  again; entering Stage 2 resets the set, because it is a new pass over new
  steps.
- **A click is recorded before the thing it triggers**, so ordering survives
  batching.
- **Nothing is prevented.** The marked-up CTAs are ordinary links and stay
  ordinary links.

---

## 7. Funnel metrics

Defined in [funnel.js](../shared/analytics/funnel.js).

| Rate | Numerator ÷ denominator |
|---|---|
| `view_to_start` | starts ÷ page views |
| `start_to_stage1` | Stage 1 completions ÷ starts |
| `stage1_to_result_view` | preliminary result views ÷ Stage 1 completions |
| `result_to_stage2_start` | Stage 2 starts ÷ preliminary result views |
| `stage2_start_to_complete` | Stage 2 completions ÷ Stage 2 starts |
| `stage2_to_full_result` | full result views ÷ Stage 2 completions |
| `result_to_recommended` | "See the Recommended System" clicks ÷ preliminary result views |
| `result_to_personal_review` | personal review clicks ÷ preliminary result views |
| `result_to_checkout_intent` | checkout intents ÷ preliminary result views |
| `view_to_stage1` | Stage 1 completions ÷ page views |
| `view_to_stage2` | Stage 2 completions ÷ page views |

Plus quality rates: validation failure, question interaction, resume, and
abandonment.

Segmentable by `source`, `deviceClass`, `assessmentVersion`, and
`questionSetVersion` — the last two are how a question change is judged, and
they are in the aggregate's primary key so a version comparison is a query
rather than a migration.

### Two rules that keep the numbers honest

1. **A ratio with a zero denominator is `null`**, never zero and never 100%.
   Nobody reached that step; that is not everybody failing it.
2. **A rate below the sample floor is withheld**, with its sample size
   attached. "60% of 5 people" reads as a finding and is noise. The floor is 30
   by default, is stated on every result, and should be raised for anything
   informing a decision with money attached.

---

## 8. The drop-off report

One row per step. This is the canonical shape; a future dashboard renders it
and adds nothing to it.

```
stepId · stage
visibleSessions · enteredSessions · completedSessions · exits · resumes
validationFailures · medianActiveMs
completionRate · abandonmentRate · validationFailureRate · resumeRate
nextStepConversion
sourceBreakdown · deviceBreakdown
sample · minSample · reportable
```

`visible` and `entered` are different questions and both are needed: a step can
be visible to a session that branches away before reaching it, and a step
nobody entered has no drop-off to explain.

The report names `highestAbandonmentStepId` among rows with enough sample —
and **makes no recommendation**. It says where to look; a person decides what
it means.

---

## 9. Quality controls

| Control | How |
|---|---|
| Duplicate suppression | `eventId` primary key; once-per-session names suppressed client-side. |
| Out-of-order events | The session roll-up is recomputed from **stored rows**, not from the batch, and every field moves forward only. A late event cannot rewind a session. |
| Late events | Accepted up to 7 days; older is refused. Beyond the aggregation window a late event affects raw rows but not a recomputed day unless the range is re-run. |
| Clock skew | Clamped to receive time, with the visitor's claim preserved in `metadata.claimedOccurredAt` so a clamp is explainable rather than invisible. |
| Invalid transitions | The roll-up derives `result_state` from which events exist, not from a state machine the client asserts — so a Stage 2 event with no Stage 1 is simply a session whose Stage 1 is missing, not a corrupt row. |
| Session reconciliation | One row per session, recomputed on every batch. |
| Bot and noise filtering | Origin allowlist, per-session and per-address rate limits, and a schema that refuses unknown event names. **Weak by design today** — see Trust position. |
| Minimum sample | Applied in `funnel.js`, on every rate, reported with the result. |
| Schema versions | `SUPPORTED_SCHEMA_VERSIONS` on both sides; a cached page keeps working across a deploy. |

---

## 10. Trust position

This endpoint is public and unauthenticated, like the assessment endpoint, and
unlike it **cannot justify a challenge**: one on every step view would cost
more than the data is worth and could be solved once and replayed.

Until a signed, integrity-bound session token exists, the defences are the
origin allowlist, strict per-session and per-address rate limiting, and the
fact that **the worst outcome of forged analytics is a wrong funnel**. That is
an acceptable exposure precisely because of the governing rule in §1 — nothing
here reaches the Business Record, the report, or the price.

**This is a known gap, not an oversight.** A signed session token is the fix
and is not built.

---

## 11. Known blind spots

1. **Instant exits are invisible.** No listener fires, so abandonment is a
   floor.
2. **Cross-device journeys are two sessions.** Same limitation as attribution:
   `assessmentSessionId` is per-device.
3. **Ad and privacy blockers** will drop some requests. Analytics under-counts
   and never over-counts, which is the safer direction but must be stated
   before anyone reads a rate as exact.
4. **Sampling is off by default.** At real volume it will need turning down,
   and every historical comparison must then account for the rate.
5. **No server-side page view.** A visitor whose JavaScript fails produces no
   `page_viewed`, so `view_to_start` slightly overstates.
6. **`medianActiveMs` is per step visit**, not per step. Someone who visits a
   step three times contributes three values.
7. **Nothing measures what happens after the assessment.** Whether a checkout
   intent became a customer is a Business Record question, and the join exists
   (`businessId`) but no report uses it yet.

---

## 12. Future work, deliberately not built

- **A dashboard.** The report shapes are defined and stable; rendering them is
  separate work.
- **A/B testing.** `assessmentVersion` and `questionSetVersion` are already in
  the aggregate key, which is the hard part. Assignment, holdout and
  significance are not built, and a significance test would need the sample
  floor replaced with something real.
- **Warehouse export.** No vendor, no SDK, no third-party destination.

---

## 13. Before a pilot

Blocking:

1. ~~Migration 0005 has never been executed.~~ **Resolved 2026-08-05.** Applied
   to `ced-cip-dev`; 47 checks passed and two defects were fixed. What remains
   is a **transport gap**: the endpoint has not run over PostgREST against this
   database, because no service-role key was available. Section N of
   `supabase-real-db.test.mjs` is written and guarded and covers it on the next
   run with credentials present.
2. **The analytics consent policy is pending professional review** — every item
   in [ANALYTICS_PRIVACY.md §6](ANALYTICS_PRIVACY.md).
3. **`CED_ALLOWED_ORIGINS` must include the vertical's production origin**, or
   every event is refused with 403.
4. **`CED_RATE_LIMIT_SECRET` must be set**, or there is no rate limiting at all
   and the endpoint logs an error rather than failing quietly.
5. **A purge schedule must exist** — `refresh_assessment_funnel_daily` *then*
   `purge_expired_analytics_events`, in that order, or a day becomes
   permanently uncomputable.

Not blocking, but decide before reading any number as fact: the sample floor,
the sampling rate, and whether abandonment counts are being read as totals when
they are floors.
