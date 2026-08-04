# Business Intelligence Report (BIR)

**Status:** design only. No BIR has ever been generated.

The canonical shape and all deterministic constants live in
[shared/business-intelligence/report.schema.js](../shared/business-intelligence/report.schema.js).
This document explains what the fields *mean* and why the model behaves as it
does. Where the two disagree, **the schema wins** — it is the executable
authority, and this document quotes it rather than restating it.

---

## 1. What the BIR is for

One report per evidence set, holding what CIP concluded at that moment — with the
reasoning attached.

> **Scope of authority.** The BIR is **point-in-time**. The
> [Business Record](BUSINESS_RECORD_SPEC.md) is **longitudinal** and owns
> permanent identity, current lifecycle state, the reassessment schedule,
> relationship, consent, attribution, timeline, and merge history. A BIR must
> never overwrite Business Record state; where the two disagree about what is
> *current*, the record wins. Fields here describing lifecycle or business state
> are a snapshot as of `generatedAt`, not current truth. Encoded as
> `BIR_AUTHORITY` in the schema.

Four properties make it work:

1. **Canonical.** Every engine downstream of the Business Intelligence Engine
   reads the BIR instead of raw form answers. A new vertical changes the
   assessment and the config; it does not change a single downstream engine.
2. **Versioned and append-only.** A revision is never edited. A new one
   `supersedes` its predecessor, which is marked `supersededBy` and kept.
   History is the product: matching a new offer against a two-year-old
   assessment is only possible because nothing was overwritten.
3. **Explainable.** Every scored claim traces to evidence. If a number cannot be
   explained, it does not belong in the report.
4. **Honest about what it does not know.** Confidence, freshness, and
   `missingCriticalFields` are first-class. Absence of data must never read as a
   negative finding.

---

## 2. Report sections

### 2.1 Identity and provenance

`identity` answers *who this is about*: **`businessId`** — the permanent UUID
owned by the Business Record — plus `identityStatus`, `identityResolutionId`,
`verticalId`, the source `assessmentSessionId` and `submissionId`, and
`customerId` once they buy.

**A BIR never mints a `businessId`.** It receives one from the Business Record
Engine, or carries none at all while identity is still being resolved.
`businessId` may be null only when `identityStatus` is `legacy_unresolved` or
`resolution_pending`.

> **Schema v2.** `businessKey` was removed in BIR schema v2. Migrated v1 reports
> carry the original string as `legacyBusinessKey`, **provenance only** — it is
> never parsed, hashed, or reinterpreted as a `businessId`. v1 reports remain
> readable and are held to the v1 contract, not this one. See
> [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md).

`provenance` answers *where this came from and whether to trust it*: the BIE
version, assessment content version, payload schema version, `inputHash`,
`generatedAt`, and the `supersedes` / `supersededBy` / `isCurrent` chain.

`inputHash` carries real weight. Identical normalized answers must produce an
identical hash, which is how the platform distinguishes *"they retook the
assessment and nothing changed"* from *"something moved."* Only the latter
should ever trigger outreach.

### 2.2 Profiles

| Section | Answers |
|---|---|
| `businessProfile` | Who they are: name, industry, staff, locations, tenure |
| `capacityProfile` | How much more work they could actually absorb — see §5 |
| `operationsProfile` | How the appointment book is run today |
| `customerProfile` | Retention, rebooking, reactivation, reputation |
| `technologyProfile` | What they run and whether we integrate with it |
| `marketingProfile` | Promotion maturity, stated challenge, attribution |
| `automationProfile` | What is already automated and what is missing |
| `financialOpportunityProfile` | The money question — see §3 |
| `riskProfile` | Overselling, data quality, implementation, churn, compliance |

Each profile is derived, never copied. `operationsProfile.reminderMaturity` is a
vocabulary term, not the raw `reminders` select value — that indirection is what
lets a gym vertical populate the same field from a different question.

### 2.3 Decision sections

`qualificationProfile`, `closeReadinessProfile`, `recommendedNextAction`,
`packageRecommendation`, `explanation`, `lifecycle`, and
`reassessmentHistory` carry what CIP concluded. Each is written by exactly one
engine, named in [CIP_ARCHITECTURE.md §3](CIP_ARCHITECTURE.md#3-engines).

---

## 3. Estimates, ranges, and confidence

### 3.1 A point estimate is not an honest answer

The assessment produces a single deterministic figure — today,
`opportunity: 1679.7`. Publishing one number implies a precision the inputs do
not support: it rests on self-reported averages and a fixed recovery
coefficient.

The BIR therefore carries a **range**, derived deterministically from the point
estimate by confidence band (`RANGE_SPREAD_BY_CONFIDENCE`):

| Confidence | Range |
|---|---|
| high | −15% … +15% |
| medium | −30% … +30% |
| low | −50% … +50% |

The spread is a floor. An engine may never present a range narrower than the
band allows, and may never present the point figure alone.

### 3.2 Two figures, both kept

`financialOpportunityProfile` records both:

- **`unconstrained`** — what the formulas produce, matching what the assessment
  page shows today.
- **`capacityAdjusted`** — the same figure clamped so recovered demand never
  exceeds what the business could actually serve, with `clampApplied` and
  `clampReason`.

Keeping both is deliberate. The clamp is often the more useful number and always
the more defensible one, but discarding the raw figure would make the BIR
disagree silently with the page the visitor saw. Any customer-facing use should
prefer `capacityAdjusted`; see [§8](#8-open-questions) for the unresolved
consequence.

### 3.3 Confidence

`estimateConfidence.score` (0..1) is deterministic, from three inputs:

- **completeness** — scored fields answered ÷ scored fields available
- **consistency** — penalties for contradictory answers (missed calls exceeding
  total calls; no-shows exceeding appointments)
- **freshness** — how old the underlying answers are

Confidence is computed once and referenced everywhere. It widens the opportunity
range, feeds close readiness as one weighted signal, and caps the readiness band
when low. It is never recomputed by a consuming engine.

### 3.4 Compliance

Every figure is a diagnostic estimate. `isDiagnosticEstimate` is always true and
`disclaimer` carries the exact wording shown to the business. No engine may
present a figure without it. This is the same rule the Assessment Engine already
enforces by reading the disclaimer from the DOM, extended across the platform.

---

## 4. Close readiness

A deterministic model. The same BIR always produces the same band — no model
judgment, no drift, no "the AI thought they seemed keen."

### 4.1 Signals

Ten signals, each scored 0..100 with its own evidence, combined by the weights in
`CLOSE_READINESS_SIGNALS` (they total 1.00):

| Signal | Weight | Asks |
|---|---|---|
| `packageFit` | 0.15 | Does a standard package genuinely fit? |
| `decisionAuthority` | 0.15 | Can this person actually say yes? |
| `urgency` | 0.12 | Is there a reason to act now? |
| `capacity` | 0.12 | Could they absorb the growth? |
| `budgetSignals` | 0.12 | Is the price plausible for this business? |
| `implementationCompatibility` | 0.10 | Do we integrate with what they run? |
| `objectionsResolved` | 0.08 | Is anything unanswered still standing? |
| `estimateConfidence` | 0.06 | Do we trust our own numbers? |
| `engagementBehavior` | 0.06 | Completion, return visits, response |
| `scopeStandardization` | 0.04 | Is this in-catalog or bespoke? |

Authority and package fit carry the most weight because getting either wrong
wastes everyone's time in the most expensive way.

### 4.2 Bands

| Band | Score | Intent |
|---|---|---|
| `educate` | 0–39 | They do not yet see the problem. Teach, do not pitch. |
| `clarify` | 40–59 | Interest without enough information. Ask, do not pitch. |
| `present_offer` | 60–79 | Show the recommended package and its reasoning. |
| `ask_for_sale` | 80–100 | Make the ask. |
| `escalate` | — | Route to a human. |

**`escalate` is not the top of the ladder.** It is a side exit, reached by
blockers rather than by score. A business can score 94 and still escalate because
it has three locations. `bandBeforeBlockers` preserves what the score alone said,
so escalation reasons stay auditable.

### 4.3 Blockers

**Hard blockers** (`HARD_BLOCKERS`) force `escalate` regardless of score: custom
pricing requested, custom terms requested, unsupported integration, multiple
locations, compliance concern, respondent lacks authority, prohibited data
detected, consent missing for the required purpose.

**Soft blockers** (`SOFT_BLOCKERS`) cap the band without escalating:

| Soft blocker | Caps at |
|---|---|
| `unknown_decision_authority` | `clarify` |
| `low_estimate_confidence` | `present_offer` |
| `unresolved_objection` | `present_offer` |
| `capacity_oversell_risk` | `clarify` |
| `stale_assessment_data` | `clarify` |

Capping at `clarify` for capacity risk is deliberate: when a business cannot
absorb more demand, the honest next step is a question, not an offer.

### 4.4 Approved close language

At `ask_for_sale`, and only there:

> Based on your assessment results, the next logical step is to activate the
> system and begin onboarding.

Held in `APPROVED_CLOSE_LANGUAGE` and referenced by key. It is never paraphrased,
never regenerated, and never combined with an invented incentive, deadline, or
discount. In any other band, the correct behavior is the band's behavior — an
engine that "just asks anyway" is a defect.

---

## 5. Capacity and growth readiness

### 5.1 Why capacity gates everything

A salon fully booked at 24 days a month cannot serve twelve recovered
appointments. Selling growth into a business with no headroom produces an unhappy
customer, a refund, and a review — and it edges toward implying delivered demand,
which the platform must never do.

Capacity is therefore not a nice-to-have field. It **clamps the opportunity
estimate**, feeds close readiness at 0.12, and can cap the band on its own.

### 5.2 The primary question

> **If demand increases, how much additional business could you comfortably
> handle over the next 90 days?**

Three things make this the right question. It asks about *comfort*, not
theoretical maximum, so it surfaces the practical ceiling. It is bounded to 90
days, matching the horizon of any early engagement. And it asks what **they**
could handle, never implying what CED Service will deliver — this question must
never be paired with language suggesting demand is promised.

It is **not collected today** and must be added before capacity scoring can run.

### 5.3 The eight assessments

| Dimension | Field | Notes |
|---|---|---|
| Current unused capacity | `unusedCapacityPerMonth` | Headroom in today's book |
| Maximum practical capacity | `maxPracticalCapacityPerMonth` | Ceiling under current staff, hours, space |
| Staffing expandability | `staffingExpandable` | Can they hire or add shifts? |
| Hours expandability | `hoursExpandable` | Can they open longer? |
| Equipment or space constraints | `spaceOrEquipmentConstrained` | The hardest ceiling — chairs and rooms |
| Willingness to expand | `willingnessToExpand` | Capability is not appetite |
| Operational readiness | `operationalReadiness` | Can they absorb demand without degrading service? |
| Risk of overselling | `oversellRisk` | The output that gates everything |

`willingnessToExpand` earns its place: an owner who *could* add a technician but
does not want to has the same effective ceiling as one who cannot, and treating
those two as different is how a customer ends up sold something they resent.

### 5.4 From headroom to risk

```
headroomRatio = additionalCapacity90Day / currentThroughput(90-day window)
```

Banded by `CAPACITY_HEADROOM_BANDS`:

| Band | Ratio | Oversell risk |
|---|---|---|
| `none` | 0–2% | high |
| `limited` | 2–10% | moderate |
| `moderate` | 10–25% | low |
| `ample` | 25%+ | low |

Consequences, in order:

1. `capacityAdjusted` opportunity is clamped to servable volume, with the reason
   recorded.
2. The `capacity` readiness signal is scored from the band.
3. `oversellRisk: high` raises the `capacity_oversell_risk` soft blocker, capping
   readiness at `clarify`.
4. When capacity is unknown, the risk is `unknown` and confidence drops — an
   unknown ceiling is treated as a reason for caution, never as `ample`.

### 5.5 Language discipline

Nothing derived from capacity may state or imply delivered demand. Permitted:
*"your salon could comfortably absorb about N more appointments per month."*
Prohibited: any phrasing that suggests CED Service will supply them.

---

## 6. Lifecycle policies

All intervals live in `LIFECYCLE_POLICY`.

### 6.1 Reassessment cadence

| Situation | Cadence | Kind |
|---|---|---|
| Active customer | every 90 days | `quarterly_review` |
| Active customer | every 365 days | `annual_full` |
| Unconverted lead | 90 days after last meaningful interaction | `quick_recheck` |
| Meaningful business change | immediately | `change_triggered` |

The unconverted-lead clock runs from the **last meaningful interaction**, not
from the assessment date. Someone who opened an email last week is not due
because they assessed three months ago.

A *meaningful business change* — staff count, hours, locations, booking system,
ownership — invalidates derived profiles and triggers reassessment regardless of
schedule.

### 6.2 Nonresponse backoff

Consecutive nonresponse widens the interval: **90 → 180 → 365 days**, then
`lead_dormant` and no further scheduled outreach. Dormant is not deletion;
records persist and a dormant lead can be revived by an inbound signal.

### 6.3 Staleness

| Age | Freshness | Effect |
|---|---|---|
| ≤ 90 days | `fresh` | Full confidence |
| ≤ 180 days | `aging` | Confidence reduced |
| ≤ 365 days | `stale` | `stale_assessment_data` soft blocker; recheck required |
| > 365 days | `expired` | Not usable for an offer without reassessment |

Past `quickRecheckRequiredAfterDays` (180), any offer built on that BIR must
carry `requiresRecheck`. A quick recheck confirms only the volatile fields —
capacity, staffing, ticket, booking system — rather than repeating all 24
questions.

### 6.4 History is never overwritten

Every reassessment creates a new BIR revision. `reassessmentHistory` holds
**references** — `{ birId, generatedAt, trigger, closeReadinessBand,
opportunityPoint }` — never copies, so the report cannot drift from the records
it cites.

This is what makes `offer.match_found` possible: a new capability can be matched
against every historical BIR, including businesses that never converted.

### 6.5 Suppression and frequency

| Rule | Value |
|---|---|
| Maximum outbound contacts | 4 per 30 days |
| Quiet period after purchase | 14 days |
| Quiet period after decline | 30 days |
| Explicit opt-out | permanent for that purpose |
| Open exception on the account | outreach paused |

Suppression is a **veto**. The Lifecycle Engine's `suppressedUntil` outranks
every other engine's proposal, and consent is checked per purpose at send time —
never assumed from a consent granted for a different purpose.

---

## 7. Explanation and evidence

`explanation.evidence` is required, not decorative. Each entry is
`{ id, kind, field, statement, sourceRef, weight }`, where `kind` is one of
`answer`, `derived`, `policy`, `observed_behavior`, `external`.

Every scored claim must trace to at least one entry. Three things depend on it:
a human reviewing an escalation can see *why* in seconds; a business owner asking
"how did you get that number?" gets a real answer; and the Learning Engine can
attribute outcomes to specific signals rather than to the score as a whole.

---

## 8. Open questions

Unresolved items that block implementation. Each needs a decision before the
affected engine can be built.

1. ~~**Identity resolution.**~~ **RESOLVED** by
   [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md):
   `businessId` is a permanent UUID owned by the Business Record; `businessKey`
   is deprecated. What remains open is *evidence quality* — today's signals can
   reach `probable_match` but never `unique_match`, so no automatic linking is
   possible. See [IDENTITY_EVIDENCE_ROADMAP.md](IDENTITY_EVIDENCE_ROADMAP.md).
2. **No store exists.** Reassessment, supersession, offer matching, and
   suppression all assume durable server-side history. Today the only storage is
   `localStorage` on the visitor's device. **Blocks:** Lifecycle, Opportunity,
   Customer Success.
3. **Readiness inputs are not collected.** Decision authority, urgency, budget
   signals, objections, and booking system are not in any assessment — five of
   ten signals, 0.55 of the total weight. On today's data, close readiness
   cannot exceed `clarify`. Either the assessment gains questions or readiness
   stays advisory.
4. **Capacity is not collected.** The 90-day question does not exist, so the
   clamp cannot run and `oversellRisk` is always `unknown`.
5. **Multi-location is a hard blocker but is never asked.** The trigger can only
   fire on data the platform does not have.
6. **Page and BIR will disagree.** The page shows an unclamped point figure; the
   BIR prefers a clamped range. Until the page shows the same range, a business
   can be told two different numbers. Recommendation: move the page to the range
   once capacity data exists — this changes visible output and needs explicit
   approval.
7. **Server-side retention is undefined.** Local limits are documented; nothing
   says how long a BIR lives once a store exists.
8. **Consent purpose mapping.** Onboarding and receipt messages are transactional
   under `transactional_service`, not marketing — but today's assessment collects
   only `results_delivery`, `email_marketing`, and `sms_marketing`. The
   transactional purpose needs a defined basis before automated close can send
   anything.
