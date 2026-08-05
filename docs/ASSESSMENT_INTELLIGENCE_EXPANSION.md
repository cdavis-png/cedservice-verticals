# Assessment Intelligence Expansion

The minimum additional evidence needed for reliable close readiness, capacity
analysis, safer package recommendations, and stronger identity resolution —
collected without turning a diagnostic into an interrogation.

**Status: implemented and validated against real Postgres, not deployed.**
Migration 0004 was applied to `ced-cip-dev` (Postgres 17.6.1.155) on
2026-08-05 and the staged flow was exercised end to end — see
[REAL_POSTGRES_VALIDATION.md §0](REAL_POSTGRES_VALIDATION.md). One SQL defect
was found and fixed there. Nothing here changes pricing, the Growth Score, or
the opportunity formula.

The evidence is now collected in **two stages**. Nothing was removed; what
changed is *when* each answer is asked for, and that a visitor receives a
complete, useful result after the first stage. See
[§0, the two-stage model](#0-the-two-stage-model), which governs everything
below it.

---

## 0. The two-stage model

### Why progressive profiling

The first version of this expansion asked everything in one pass: 39 required
questions before a visitor saw a single number. Every one of them earned its
place individually and the total was still wrong. A busy salon owner who
abandons at question 30 has given us nothing and received nothing, and no
amount of "each question is justified" recovers that.

So the review is split at the point where its purpose changes.

| | Stage 1 — Growth Review | Stage 2 — Fit and Activation Review |
|---|---|---|
| Question | How is this salon losing appointments? | Should we sell to them, and would it work? |
| Whose interest | Theirs | Ours |
| Offered | Immediately | Only after Stage 1 results, or on request |
| Optional | No — it is the review | Yes, always |
| Produces | Growth Score, capacity-aware range, three priorities, package fit | Full close-readiness evidence |

Stage 1 is not a teaser and Stage 2 is not the real assessment. Stage 1 is a
**complete answer to a smaller question**. That framing is load-bearing: it is
why a preliminary report scores only what it asked rather than scoring the rest
as zero, and why its confidence is called `preliminary` rather than `low`.

### Stage 1 versus Stage 2 field ownership

The split is a shared contract in
[intelligence.js](../shared/assessment-engine/intelligence.js) —
`STAGE1_FIELDS` and `STAGE2_FIELDS` — for the same reason the field names are.
The browser decides what to ask from it and `generate-bir.js` decides what to
call outstanding from it; two disagreeing copies would report evidence as
withheld when it was simply not yet requested.

**Stage 1 holds exactly two intelligence fields**, and both are there because
the platform cannot function without them:

| Field | Why Stage 1 |
|---|---|
| `locationCount` | Scope. A multi-site business cannot be sized against the standard offer, and that is true of the *diagnosis*, not just of the sale. |
| `capacity90Day` | The ceiling. Without it the visible estimate cannot honestly be bounded, and CLAUDE.md section 4 forbids pairing a figure with anything implying we will supply the demand to fill it. |

Everything else Stage 1 asks is operational: it feeds the Growth Score, the
opportunity formula, the package threshold, or the delivery of results.

**Moved from Stage 1 to Stage 2** by this milestone: respondent role, decision
authority, additional approvers, decision timing, preferred start timing,
urgency, budget signal, booking platform, whether they are keeping it,
willingness to change software, migration concern, phone setup, keeping the
number, custom integration, expansion willingness, staffing and hours
expandability, space constraints, capacity lead time, objection category,
objection detail, prior bad experience, open questions, years in business,
website, business phone, Google Business Profile, multi-location systems,
biggest current challenge, and preferred contact method.

Two of those deserve their reasoning stated. **Biggest current challenge** and
**preferred contact method** are not close-related and were not on the list of
things to move; they went anyway, because neither is needed to produce a Growth
Review and both are needed when arranging what happens next. Results are
delivered by email regardless of the preferred *channel*.

### Result states

Four, resolved deterministically in
[generate-bir.js](../shared/business-intelligence/generate-bir.js) and recorded
in `assessmentProgress.resultState`.

| State | When |
|---|---|
| `preliminary_results` | Stage 1 complete and no Stage 2 evidence outstanding |
| `fit_review_available` | Stage 1 complete; Stage 2 evidence would improve accuracy |
| `fit_review_complete` | Stage 2 complete |
| `activation_ready` | Stage 2 complete **and** the band is `present_offer` or `ask_for_sale` |

`preliminary_results` is not reachable in the nails vertical, because its
Stage 2 asks 23 things. The rule is written about the evidence rather than
about this vertical, so a future vertical whose Stage 1 is self-sufficient
lands there correctly instead of being permanently labelled "incomplete".

### Confidence changes

`estimateConfidence.kind` is `preliminary` or `full`. It is **not** a second
quality grade. Every input the confidence score reads — completeness across the
16 scored answers, internal consistency, freshness, and the capacity ceiling —
is Stage 1 evidence, so a preliminary score is directly comparable to a full
one. A test asserts that none of `SCORED_ANSWER_FIELDS` ever moves to Stage 2.

### Close-readiness limitations at Stage 1

Three rules, all enforced by the validator:

1. **Stage 1 scores only the signals Stage 1 asked about**, with the weights
   renormalised across them (`packageFit`, `capacity`, `estimateConfidence`,
   `engagementBehavior`, `scopeStandardization` — 0.43 of the total weight).
   The rest are listed, scored zero, and marked `inScope: false`. Scoring them
   as real zeros would report "not asked" as "answered badly" and cap every
   preliminary result near 35 regardless of the business.
2. **Stage 1 may never reach `ask_for_sale`** and may never carry the approved
   close language. The band is capped at `present_offer` *before* blockers are
   applied, so a hard blocker can still route to `escalate`.
3. **Stage 1 does not cap the band for evidence it chose not to collect.** The
   soft blockers that rest on Stage 2 answers are set aside into
   `deferredBlockers` — visible, not silently dropped — and apply in full at
   Stage 2.

Stage 1 evidence still bites: `multiple_locations` escalates and
`capacity_oversell_risk` caps at `clarify`, because both rest on answers
Stage 1 actually has.

### Conversion rationale

The three paths after Stage 1 results:

| Path | Effect |
|---|---|
| Improve My Recommendation | Opens Stage 2, trigger `improve_recommendation` |
| See the Recommended System | Opens Stage 2, trigger `see_recommended_system`, showing *"To confirm the best fit and setup path, answer a few final questions."* |
| Request a Personal Review | An ordinary link. A way out of the review, not further into it. |

Any control anywhere on the page can open Stage 2 through
`window.CEDAssessment.requestFitReview(trigger)`, which is how a future
checkout or proposal button reaches it without the engine knowing what checkout
is. It returns `false` when there is no further stage, so the caller can fall
back to its own path.

The explanation is deliberately not called another assessment. It is the same
review, continued.

### History

Two stages are **two submissions, two idempotency keys, and two reports**.
Nothing is overwritten:

- Stage 1 → `stage1.completed`, `preliminary_bir.generated`
- Stage 2 → `stage2.started`, `stage2.completed`, `full_bir.generated`

`stage2.started` carries the moment the visitor *opened* the fit review, not
the moment the submission landed, so the gap between starting and finishing is
recoverable from the timeline. The full report supersedes the preliminary one
through `provenance.supersedes` and `supersedes_bir_id`; both stay readable.

The existing `assessment.completed` and `bir.generated` events are **not**
renamed. They are a published contract, and an append-only store cannot rename
an event retroactively. The stage events are additional facts.

`assessmentSessionId`, first-touch attribution, consent records, the retry
queue, the branching record, and stale-answer handling all carry across the
boundary unchanged.

---

## 1. The governing rule

**The Growth Score is not touched.** It measures the visitor's operational
problem and is shown to them on screen. Everything added here measures whether
we can responsibly sell into that problem, which is our business and not
theirs. Mixing the two would corrupt a number a small-business owner is being
asked to trust.

This is enforced, not just intended:
[tests/scoring-parity.test.mjs](../tests/scoring-parity.test.mjs) restates the
original formulas independently and pins them across 4,000 randomised answer
sets, then asserts that none of the 25 new fields can move the score or the
estimate by any value.

---

## 2. Every new field

Field names are a **shared contract**, not vertical vocabulary: the browser and
`generate-bir.js` both read them through
[shared/assessment-engine/intelligence.js](../shared/assessment-engine/intelligence.js).
The question wording belongs to the vertical; the names do not.

### Business structure — step 8

| Field | Required | Shown when | Supports |
|---|---|---|---|
| `locationCount` | yes | always | `businessProfile.locationCount`, `multiLocationComplexity`, scope standardization, identity ranking |
| `yearsInBusiness` | yes | always | `businessProfile.yearsInBusiness` |
| `bookingPlatform` | yes | always | `technologyProfile.bookingSystem`, integration status |
| `bookingPlatformStaying` | no | a real platform is in use | `implementationCompatibility` |
| `migrationConcern` | no | they might actually move | `implementationCompatibility` |
| `businessPhone` | **no** | step 14 | identity evidence only |
| `website` | **no** | step 14 | identity evidence only |
| `googleProfile` | **no** | step 14 | identity evidence only |

### Growth capacity — step 9

The approved question, verbatim:

> **If demand increases, how much additional business could you comfortably
> handle over the next 90 days?**

Options: none right now · 1–5 · 6–10 · 11–20 · more than 20 additional
appointments per week · unsure.

| Field | Required | Shown when | Supports |
|---|---|---|---|
| `capacity90Day` | yes | always | `capacityProfile`, the clamp, `capacityReadiness` |
| `staffingExpandable` | no | headroom is limited or unsure | `capacityReadiness`, `expansionReadiness` |
| `hoursExpandable` | no | headroom is limited or unsure | `capacityReadiness` |
| `spaceConstraint` | no | headroom is limited or unsure | `capacityReadiness` |
| `willingnessToExpand` | yes | always | `expansionReadiness` |
| `capacityLeadTime` | no | willing to expand | `expansionReadiness` |

**This never implies lead volume.** It asks what the business could absorb; it
promises nothing about what will arrive. The clamp uses it only to *reduce* an
estimate, never to raise one.

### Decision readiness — step 10

| Field | Required | Shown when | Supports |
|---|---|---|---|
| `respondentRole` | yes | always | `decisionProfile` |
| `canApprove` | yes | always | `decisionReadiness`, `authority_absent` blocker |
| `otherApprovers` | no | `canApprove` answered and not "yes" | approval path |
| `decisionTiming` | yes | always | `decisionReadiness` |
| `startTiming` | yes | always | `decisionReadiness` |
| `urgency` | yes | always | readiness signal `urgency` |
| `changeReason` | **no** | always | `decisionProfile.changeReason` (free text) |

### Multi-location — step 11 *(whole step branches)*

| Field | Required | Shown when | Supports |
|---|---|---|---|
| `multiLocationSystems` | no | `locationCount > 1` | `multiLocationComplexity`, `implementationCompatibility` |

### Implementation compatibility — step 12

| Field | Required | Shown when | Supports |
|---|---|---|---|
| `phoneSetup` | yes | always | `technologyProfile.phoneSetup` |
| `keepNumber` | no | a real phone service is in use | `implementationCompatibility` |
| `willingToChangeSoftware` | no | keeping or unsure about their platform | `implementationCompatibility` |
| `customIntegrationNeeded` | yes | always | `unsupported_integration` blocker |

### Budget and objections — step 13

| Field | Required | Shown when | Supports |
|---|---|---|---|
| `budgetSignal` | yes | always | `budgetReadiness` |
| `primaryConcern` | yes | always | `objectionSeverity` |
| `concernDetail` | **no** | a concern was selected | `objectionProfile.detail` (free text) |
| `priorBadExperience` | no | a concern was selected | `objectionSeverity` |
| `openQuestions` | **no** | always | `objectionProfile.openQuestions` (free text) |

**Budget is an affordability signal and nothing more.** No revenue, balances,
credit, or financial position is asked, and the page says so where the question
appears. Adding any of those would violate CLAUDE.md section 9.

---

## 3. Branching

Config-driven and generic. The engine knows how to hide a question; it knows
nothing about what a location is.

```js
branching: {
  steps:     { 13: read => Number(read.val('locationCount')) > 1 },
  questions: { otherApprovers: read => read.val('canApprove') !== '' &&
                                       read.val('canApprove') !== 'yes' }
}
```

Markup wraps each conditional question in `[data-question="fieldName"]`.

**All branching is in Stage 2.** Stage 1 has none: every predicate keys off an
answer Stage 2 collects, so there is nothing to branch on. The shortest and the
longest Growth Review are the same review, which means the estimate of how long
it takes is exact rather than a range.

Mechanics that matter:

- **Hiding disables.** `hidden` alone would leave a required field silently
  blocking submission from a step nobody can see. Disabling is what removes it
  from `FormData` and from constraint validation.
- **A hidden answer is cleared, not retained**, and every clear is recorded in
  `branching.staleClearedFields` with a reason and timestamp. Keeping it would
  let a withdrawn answer go on feeding scoring; discarding it silently would
  lose the fact that it was ever given.
- **An empty step is skipped** — but only when it has no unconditional content.
  A step mixing conditional and unconditional questions is never empty.
- **Progress counts visible steps**, and a change in the total is announced
  through a polite live region. An ordinary advance is not announced, because
  that would be noise.
- **Resume order is answers → branching → step.** A saved step that no longer
  applies snaps *backwards* to the nearest visible step, never forward past a
  question the visitor has not seen.
- **A predicate that throws shows the question.** Failing open is the safe
  direction; the alternative is a blank step and a stranded visitor.
- **A field on a branched-away step is not "visible" either**, even though
  nothing about the field itself is conditional. `multiLocationSystems` sits
  unconditionally on a step-branched step; reporting it as shown made the
  report call it unanswered when it was never applicable, and those mean
  opposite things. Found by the staging work, fixed in `visibleFieldNames`.
- **A question in a stage the visitor never opened is not "skipped".** It was
  not offered. It is reported under `assessmentProgress.missingStage2Evidence`,
  never in `branching.skippedFields` and never in `missingCriticalFields`.
- **Nothing may branch away a question whose answer could raise a hard
  blocker.** `customIntegrationNeeded` is the obvious candidate for a branch
  off "you use a paper book" and is deliberately unconditional: a `yes` routes
  the prospect to a person, and hiding it would quietly close the path that
  exists to catch what we cannot serve.

An unanswered gate is not a "no". `otherApprovers` waits until `canApprove` has
actually been answered rather than appearing immediately — a mistake worth
having made once, since it showed up as a real premature question.

---

## 4. The nine dimensions

Range `0..100`, `null` when unknown, each with its own confidence and evidence
list. **Polarity is not uniform.**

| Dimension | Polarity | Measures |
|---|---|---|
| `capacityReadiness` | higher is better | Room to absorb demand now |
| `expansionReadiness` | higher is better | Willingness and speed to create room |
| `decisionReadiness` | higher is better | Authority plus timing |
| `budgetReadiness` | higher is better | Stated ability to fund |
| `implementationCompatibility` | higher is better | How readily it can be put in place |
| `identityConfidenceInput` | higher is better | Quality of identity evidence offered |
| `closeReadinessEvidence` | higher is better | **Coverage**, not favourability |
| `multiLocationComplexity` | **higher is WORSE** | Scope and integration burden |
| `objectionSeverity` | **higher is WORSE** | Strength of stated resistance |

Two run backwards, and both say so in their own `note`. A previous milestone
shipped an enum whose meaning inverted between two profiles and it took a
review to catch, so every dimension now declares polarity as data.

`closeReadinessEvidence` is the one most easily misread: it measures how much
evidence is *present*, not how good it is. A prospect who answered everything
unfavourably scores 100 there and low everywhere else.

**Unknown is never favourable.** A missing answer scores `null` and is listed;
it is never defaulted to a midpoint. An explicit "unsure" is recorded as
`answered_unknown` — distinct from never being asked, and scored the same.

---

## 5. Capacity and the clamp

`capacity90Day` maps to the **low end** of each band, deliberately: an estimate
that overstates what a business can absorb is the one that does harm.

| Answer | Additional/week | Headroom band | Oversell risk |
|---|---|---|---|
| `none` | 0 | `none` | high |
| `1_5` | 1 | `limited` | moderate |
| `6_10` | 6 | `moderate` | low |
| `11_20` | 11 | `ample` | low |
| `over_20` | 21 | `ample` | low |
| `unsure` | — | `unknown` | unknown |

> **`headroomBand: "none"` is the WORST case**, not the best. It means no room
> at all. See `schema.POLARITY.capacityHeadroom`.

### How the clamp works

The estimate is split by driver, and **only the part that needs new capacity is
capped**:

- **New demand** — recovered missed calls, reactivated clients. Needs headroom.
- **Backfill** — recovered no-shows and cancellations. Fills a slot the business
  *already had*, so headroom is irrelevant.

```
ceiling         = additionalPerMonth × averageTicket
capacityAdjusted = backfillPortion + min(newDemandPortion, ceiling)
```

Driver shares are recomputed from the answers, but only the **proportions** are
used — they are applied to the point figure the visitor was actually shown, so
the total can never drift from what they saw.

Consequences, all deliberate:

- **Capacity unknown → no clamp**, the estimate stays uncapped, and the missing
  ceiling is recorded (`ceilingKnown: false`) and stated in `clampReason`.
- **Zero headroom does not zero the estimate.** A business that cannot take on
  anything new can still stop losing what it already books. In the reference
  fixture that is $1,679.70 → $766.40, not → $0.
- **The unconstrained figure is never rewritten.** Both are reported.
- Confidence is still **capped below `high`** while capacity is unknown, and
  that cap now lifts when capacity is answered — which is the entire reason the
  question was added.

---

## 6. Close readiness

Five bands. Four are a ladder; `escalate` is **orthogonal** — it means a human
must look, not that the prospect is closest to buying.

```
educate < clarify < present_offer < ask_for_sale     escalate (separate)
```

Ten weighted signals, unchanged from the schema. What changed is that seven of
them now have real evidence instead of scoring zero as unknown.

### Blockers

**Hard — force `escalate` regardless of score:**

| Blocker | Fires when |
|---|---|
| `unsupported_integration` | integration status is unsupported, or a custom integration is needed |
| `multiple_locations` | `locationCount > 1` |
| `authority_absent` | states they cannot approve **and** cannot name who can |

**Soft — cap the band:**

| Blocker | Caps at | Fires when |
|---|---|---|
| `unknown_decision_authority` | clarify | authority not answered |
| `severe_objection` | clarify | prior bad experience, results skepticism, or contract concern |
| `capacity_oversell_risk` | clarify | zero headroom |
| `no_defined_approval_path` | clarify | cannot approve alone, but a path exists |
| `unresolved_objection` | present_offer | any concern raised |
| `low_estimate_confidence` | present_offer | confidence band is low |

Rules this enforces, each with a test:

- Unknown evidence cannot produce a sellable band.
- A high score cannot override a hard blocker — `bandBeforeBlockers` is kept so
  the reason stays legible.
- A low-confidence estimate cannot reach `ask_for_sale`.
- A non-decision-maker cannot reach `ask_for_sale` without an approval path.
- A capacity-constrained business is not pushed into aggressive growth.

### Multi-location

Multi-location is **not a judgement about the prospect**. There is simply no
standardized multi-site scope to sell them yet, so the deal cannot close itself
and routes to a human. When that scope exists, remove `multiple_locations` from
the hard blockers and set `scopeStandard` accordingly — that is the whole
change.

### The approved language

Set only at `ask_for_sale`, carried as `approvedLanguageKey`, and resolved
against `schema.APPROVED_CLOSE_LANGUAGE`:

> Based on your assessment results, the next logical step is to activate the
> system and begin onboarding.

**It is not displayed.** The current results UI has no appropriate place for it
and the Closing Engine does not exist. It travels in the BIR for that engine to
use later. A test asserts it never appears below `ask_for_sale`.

---

## 7. Identity evidence

Four optional fields: `businessPhone`, `website`, `googleProfile`,
`locationCount`.

- **Always unverified.** Everything a public form produces is
  `visitor_supplied`, and the trust model is unchanged: strong **and** verified
  **and** from a trusted source is still what auto-linking requires.
- It **improves candidate ranking** via `identityConfidenceInput` and gives a
  reviewer more to work with.
- It **can never link a record on its own**, and `identityEvidence` states
  `verified: false, autoLinkEligible: false` explicitly.
- Exact values and their source are preserved in the payload and the report.
- **Legal name and full address are deliberately absent.** They belong at
  checkout, not in a diagnostic.

---

## 8. Privacy boundaries

- No revenue, balances, credit, or financial position — only an affordability
  band, with the page saying so.
- No payment, credential, or health data. The prohibited-field pattern is
  unchanged and still enforced at both ends.
- Free text (`changeReason`, `concernDetail`, `openQuestions`) is capped at 300
  characters, carried as evidence for a human, and **never parsed for meaning**.
  Severity comes from the enum, not the prose.
- Everything new is `raw_payload` content, so it is covered by the existing
  redaction path. The identity fields are in the redaction set.

---

## 9. Known limitations

1. **The stage targets are not both met, and cannot both be met.** The total
   question inventory is fixed by "do not remove collected intelligence", so
   staging changes *when*, not *how many*. See §10 for the arithmetic and for
   the five questions that would have to go.
2. ~~Migration 0004 has not been executed.~~ **Resolved 2026-08-05.** Applied
   to `ced-cip-dev` on Postgres 17.6.1.155, with both triggers, all three
   indexes, both widened constraints, four forced rollbacks, and the staged
   flow end to end. One defect found and fixed: the BIR stage event anchored
   its `occurred_at` on `generated_at` while `ingest_assessment` anchors on the
   clamped `submitted_at`, so two events describing one insert drifted — 104
   seconds in the measured case, and up to the 30-day retry window in the
   worst. Details in [REAL_POSTGRES_VALIDATION.md §2](REAL_POSTGRES_VALIDATION.md).

   Still outstanding: section M of the integration suite is written and guarded
   but has **not run over PostgREST**, because no service-role key was
   available in the working shell. Run 2 executed the same SQL through the
   management API instead. 0004 adds no function signature, so the transport
   difference does not affect what it changed.
3. **The page and the report agree on the figure; the page and the
   *unconstrained* figure do not.** The screen shows the capacity-adjusted
   range, which for a capacity-constrained salon is materially smaller than the
   raw formula output. That is the correct direction — capacity may only ever
   reduce an estimate — but it means the number is lower than it was before
   this milestone for exactly the businesses least able to absorb work.
4. **Multi-location escalates at Stage 1.** `locationCount` is Stage 1
   evidence, so a multi-site salon is routed to a human before it has been
   asked anything about buying. That is right, and it sends more work to an
   identity- and scope-review queue that still has no surface.
5. **Stage 2 completion is unmeasured.** Nothing yet reports how many visitors
   open the fit review or finish it. The index and the stage timeline events
   make it answerable; no one is asking the question yet.
6. **`integrationStatus` is inferred from a fixed list** of booking platforms.
   "Other" and "unsure" resolve to `unknown`, not `unsupported` — we do not know
   that we cannot integrate, only that we have not checked.
7. **Driver shares are recomputed from the answers** using the same shape as the
   vertical's formula. Only proportions are used so the total cannot drift, but
   a future vertical with a different formula needs its own share function.
8. **No engagement-behaviour signal beyond completion.** `engagementBehavior` is
   still a flat 70 for anyone who finished either stage. Opening the fit review
   is a stronger signal than completing Stage 1 and is not yet scored.
9. **The approved close language has nowhere to appear**, by design, until the
   Closing Engine exists.
10. **One-question-at-a-time was interpreted as the existing grouped-step flow.**
    The site has always shown several related questions per step; that pattern is
    preserved rather than replaced.

---

## 10. Question counts and timing

Measured by driving the real engine against the real markup and the real
config — see [tests/helpers/nails-markup.mjs](../tests/helpers/nails-markup.mjs),
which parses `index.html` rather than modelling it. Excludes the three consent
checkboxes; "required" excludes fields whose own label says `(optional)`.

The markup is **17 steps and 58 named fields**: 9 steps in Stage 1, 8 in
Stage 2, each stage ending in its own results screen.

### Stage 1 — Growth Review

**23 required questions and 1 optional one, on every path.** Stage 1 has no
branching, so the shortest and the longest Growth Review are identical.

At roughly 10–12 seconds per field, that is **4–5 minutes**, before reading
time — inside the 4–6 minute target.

### Stage 2 — Fit and Activation Review

| Branch | Required | Incl. optional | Steps |
|---|---|---|---|
| Paper book, decides alone, no concern | 15 | 20 | 7 |
| **Typical** — supported platform, keeping it, decides alone | **17** | **22** | **7** |
| Approval chain, or landline keeping the number, or multi-location | 18 | 23–24 | 7–8 |
| Objection raised | 18 | 24 | 7 |
| Unknown capacity, or no capacity and wants to expand | 20 | 25 | 7 |
| Longest — every branch open | 25 | 31 | 8 |

**3–5 minutes** typical, **5–6 minutes** at the longest.

### Where this lands against the targets

| Target | Actual | |
|---|---|---|
| Stage 1 shortest ≤ 20 required | 23 | over by 3 |
| Stage 1 longest ≤ 24 required | 23 | met |
| Stage 2 typical 10–14 required | 17 | over by 3 |

**The two targets cannot both be met while the inventory is fixed.** Staging
changes *when* a question is asked, not how many there are: 23 + 17 = 40, which
is the same 39–40 the single-stage version asked, plus the one field the
branched-away-step fix correctly stopped counting as skipped.

Stage 1's floor is **21**, and it is arithmetic, not preference:

| Purpose | Fields |
|---|---|
| Growth Score inputs | 9 |
| Additional opportunity-formula inputs | 5 |
| Package-threshold inputs (`technicians`, `callsDay`) | 2 |
| Delivering the result (`salonName`, `ownerName`, `email`) | 3 |
| Platform-required (`locationCount`, `capacity90Day`) | 2 |
| **Floor** | **21** |

The two above the floor are `appointmentsDay` and `reviewCount`, both kept
because the brief named "appointment volume" and "review process" as Stage 1
evidence. Dropping them reaches 21 and no lower — 20 requires moving a figure
the visitor has already been shown, which is not a decision to make in a diff.

To bring Stage 2 to 14, five would have to go. The honest candidates, weakest
first: `yearsInBusiness` (scores nothing), `challenge` (scores nothing),
`startTiming` (near-duplicate of `decisionTiming`), `reviewCount` if it moves
here rather than being cut, and `preferredContact`. That is a product decision
about how much evidence the Closing Engine is owed, not an engineering one.

---

## 11. Future Closing Engine integration

Everything the Closing Engine will need is already in the BIR:

| It needs | It reads |
|---|---|
| Whether to ask | `closeReadinessProfile.band` |
| Why not, if not | `hardBlockers`, `softBlockers`, `bandBeforeBlockers` |
| What to say | `approvedLanguageKey` → `schema.APPROVED_CLOSE_LANGUAGE` |
| Who can agree | `decisionProfile` |
| What to offer | `packageRecommendation`, `scopeStandard` |
| What it is worth | `financialOpportunityProfile.capacityAdjusted` |
| What to resolve first | `objectionProfile`, `unresolvedObjections` |
| Whether they can take it on | `capacityProfile` |
| What will be hard | `technologyProfile`, `riskProfile.implementationRisk` |
| How much of this is guesswork | `estimateConfidence`, `evidencePath` |

Two more it now reads, both from `assessmentProgress`:

| It needs | It reads |
|---|---|
| Whether this is settled or provisional | `closeReadinessProfile.provisional`, `confidenceKind` |
| Whether the visitor has been asked at all | `resultState`, `missingStage2Evidence` |

A Closing Engine acting on a `fit_review_available` report would be acting on a
review the visitor has not finished. `provisional` is the flag that stops it.

**Still missing before it can be built:** a standardized multi-site scope,
engagement signals beyond completion, a surface for the identity-resolution
queue, and — before any of it takes real traffic — the launch blockers in
[PRODUCTION_HARDENING.md §14](PRODUCTION_HARDENING.md).
