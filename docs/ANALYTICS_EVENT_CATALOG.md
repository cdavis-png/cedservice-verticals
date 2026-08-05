# Analytics event catalog

Every event this platform emits, what it means, and what it carries.

The executable definition is
[shared/analytics/events.js](../shared/analytics/events.js). Where this
document and that file disagree, **the file wins** — it is what runs, and both
the browser and the endpoint enforce it.

**Event names are a wire contract.** The raw event table is append-only, so
renaming an event orphans every historical row rather than migrating it. Add a
new name; never repurpose an old one.

---

## The envelope

Every event, without exception, carries these fields.

| Field | Type | Notes |
|---|---|---|
| `eventId` | UUID | Generated client-side. The idempotency key: a retry of the same event is a no-op, not a duplicate row. |
| `eventName` | enum | One of the 19 below. Anything else is refused. |
| `eventVersion` | integer | Per event. Bump when an event's *meaning* changes. |
| `schemaVersion` | integer | Of the envelope. Currently 1. |
| `occurredAt` | ISO 8601 | Client clock, clamped server-side to receive time. |
| `assessmentSessionId` | UUID | The pseudonymous key for everything. Minted by the assessment, never by analytics. |
| `submissionId` | UUID or null | Known only after a stage is submitted. |
| `businessId` | UUID or null | Known only after the server resolves identity. Analytics never resolves it. |
| `verticalId` | string | e.g. `nails`. |
| `assessmentVersion` | string | Content version of the assessment. |
| `questionSetVersion` | string | Question inventory version, independent of scoring. |
| `assessmentStage` | 1, 2, or null | Null before the review is opened. |
| `stepId` | string or null | The step the visitor was on. |
| `questionId` | string or null | The field, when the event is about one. |
| `attribution` | object | `{ firstTouch, latestTouch }`, each `{ path, referrerHost, utm, occurredAt }`. **Never a full URL.** |
| `device` | object | `{ deviceClass, viewportWidth, viewportHeight }`. Bucketed. **No user agent.** |
| `activeElapsedMs` | integer | Time the visitor was plausibly present. See the timing model. |
| `totalElapsedMs` | integer | Wall time since the session began. |
| `stepElapsedMs` | integer or null | Active time in the current step visit. |
| `visibleQuestionCount` | integer or null | Questions on screen for this path. Excludes consent and the bot trap. |
| `completedQuestionCount` | integer or null | Of those, how many have an answer. |
| `consentStatus` | enum | The permission in force when the event was produced. |
| `metadata` | object | Per-event, scrubbed. Never free text a visitor typed. |

---

## The events

`once` means the client suppresses repeats for the whole session and the
database enforces uniqueness by `eventId`.

### Arrival

| Event | Category | Once | Fired when |
|---|---|---|---|
| `assessment.page_viewed` | product | ✔ | The page loads with the engine on it. The denominator of the whole funnel. |
| `assessment.started` | product | ✔ | The review modal opens with **no** saved answers. |
| `assessment.resumed` | product | | The modal opens **with** saved answers. Carries the step resumed at. |

`started` and `resumed` are mutually exclusive per open. The distinction is
keys in saved state, not truthiness — the engine writes `data: {}` on the
first page view so the session id is durable, and treating that as "has saved
state" reported every first-time visitor as a returning one.

### Progress

| Event | Category | Requires | Fired when |
|---|---|---|---|
| `assessment.step_viewed` | product | `stepId` | A step becomes active. **Once per step per stage pass** — navigating back does not view it again. |
| `assessment.question_answered` | product | `questionId` | A field gets its first non-empty value. Once per field. |
| `assessment.validation_failed` | product | `stepId` | Continue was refused. Carries `blockingFields` — which questions, never what was typed. |
| `assessment.step_completed` | product | `stepId` | Continue was accepted. Carries `nextStepId`. |

`question_answered` comes from **one delegated listener** on the form, not one
per field. Fifty-eight listeners would be a maintenance trap the moment a
vertical adds a question.

### Stage boundaries

| Event | Category | Once | Fired when |
|---|---|---|---|
| `assessment.stage1_completed` | product | ✔ | The Growth Review is finished. |
| `assessment.preliminary_results_viewed` | product | | The Stage 1 results screen is painted — including a repaint on resume, because coming back to look again is real behaviour. |
| `assessment.stage2_started` | product | ✔ | The Fit and Activation Review opens. Carries `trigger` and `activeMsSinceResultsViewed`. |
| `assessment.stage2_completed` | product | ✔ | The fit review is finished. Carries `activeMsSinceStage1`. |
| `assessment.full_results_viewed` | product | | The Stage 2 results screen is painted. |

`stage2_started` carries **the single most useful number this milestone
produces**: how long someone sat with their preliminary result before deciding
to continue.

### Intent

| Event | Category | Fired when |
|---|---|---|
| `assessment.improve_recommendation_clicked` | product | "Improve My Recommendation". |
| `assessment.recommended_system_clicked` | product | "See the Recommended System". |
| `assessment.personal_review_clicked` | product | "Request a Personal Review" — an ordinary mailto link, counted by delegation, never intercepted. |
| `assessment.checkout_intent` | product | `window.CEDAssessment.requestFitReview('checkout_intent')` from any control on the page. |
| `assessment.report_requested` | product | "Send My Results & Next Steps". |

A CTA click is recorded **before** the stage it opens, so the two land in the
right order even inside one batch.

### Inference and erasure

| Event | Category | Fired when |
|---|---|---|
| `assessment.abandoned` | product | Inferred. See [ASSESSMENT_ANALYTICS.md](ASSESSMENT_ANALYTICS.md), "Abandonment". Always `provisional: true`. |
| `assessment.clear_saved_data` | **functional** | The visitor erased what we stored on their device. Recorded and flushed *before* the analytics queue is wiped — a deletion nobody can see is a deletion nobody can audit. |

`clear_saved_data` is the only functional event. Everything else is product
analytics: an assessment works perfectly with it all switched off.

---

## Adding an event

1. Add it to `EVENTS` in `events.js` with a category and version.
2. Add a row here.
3. Emit it. If it is a click, add `data-analytics-event="..."` to the control —
   the engine's delegated listener needs no code change.
4. Add it to the aggregation in
   [0005_assessment_analytics.sql](../supabase/migrations/0005_assessment_analytics.sql)
   only if it belongs in the daily funnel.
5. `tests/analytics-events.test.mjs` asserts the catalog and this list agree,
   so it will fail until step 2 is done.

**Before adding a field to `metadata`, read
[ANALYTICS_PRIVACY.md](ANALYTICS_PRIVACY.md).** The prohibition is enforced in
both directions and it will drop your field rather than store it.
