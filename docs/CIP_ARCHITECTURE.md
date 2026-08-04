# CED Intelligence Platform — Architecture

**Status:** design only. Nothing described here is built. The only running code
today is the Assessment Engine
([shared/assessment-engine/](../shared/assessment-engine/)) and the nail-salon
vertical.

**Companions**
- [BUSINESS_RECORD_SPEC.md](BUSINESS_RECORD_SPEC.md) — the permanent record everything attaches to
- [BUSINESS_INTELLIGENCE_REPORT.md](BUSINESS_INTELLIGENCE_REPORT.md) — point-in-time intelligence
- [AUTOMATION_POLICY.md](AUTOMATION_POLICY.md) — what may act without a human
- [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md) — identity and ownership decision
- [shared/business-intelligence/report.schema.js](../shared/business-intelligence/report.schema.js) — canonical constants
- [shared/events/event-catalog.js](../shared/events/event-catalog.js) — the inter-engine contract

---

## 1. The shape of the system

CIP turns a completed assessment into a decision, and a decision into either an
automated action or a human's queue. Fourteen engines, one permanent record, one
event contract.

Four rules hold the design together:

0. **`businessId` is the identity.** A permanent UUID owned by the Business
   Record, never derived from a name, email, phone, or domain. Every engine uses
   it to mean "this business." See
   [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md).
1. **The BIR is the interface.** Engines read the Business Intelligence Report,
   not raw form answers. Only the Business Intelligence Engine touches raw
   answers. This is what lets a second vertical reuse every engine downstream
   without any of them learning what a nail technician is.
2. **Engines communicate by events, not calls.** An engine emits what happened;
   it does not know who cares. Consumers are listed in the catalog for
   documentation, not wiring.
3. **Deciding and doing are separate.** Every engine may *propose*. Only the
   Decision Engine chooses. Only the Automation Engine acts. Anything neither
   can safely handle becomes an exception with a human's name on it.

---

## 2. Data flow

```
                          ┌──────────────┐
                          │   Visitor    │
                          └──────┬───────┘
                                 │ answers
                                 ▼
                    ╔════════════════════════╗
                    ║   Assessment Engine    ║   assessment.started
                    ║      (built today)     ║   assessment.partial_saved
                    ╚════════════┬═══════════╝   assessment.completed
                                 │ raw payload (businessId still null)
                                 ▼
                    ╔════════════════════════╗
                    ║ Business Record Engine ║  identity.resolved
                    ║  identity resolution   ║  identity.linked / review_required
                    ╚════════════┬═══════════╝  business.created
                                 │ businessId assigned
                                 ▼
                    ┌────────────────────────┐
                    │   BUSINESS RECORD      │  permanent, append-only
                    │   longitudinal truth   │  identity · lifecycle · timeline
                    └────────────┬───────────┘  consent · attribution · history
                                 │ businessId
                                 ▼
                    ╔════════════════════════╗
                    ║ Business Intelligence  ║  ── the only raw-answer hop ──
                    ║      Engine (BIE)      ║
                    ╚════════════┬═══════════╝
                                 │ bir.generated
                                 ▼
                    ┌────────────────────────┐
                    │  BIR store, append-only│  point-in-time truth
                    └────────────┬───────────┘  referenced by the record
                                 │ read (businessId + birId)
     ┌───────────┬───────────┬───┴────┬────────────┬─────────────┐
     ▼           ▼           ▼        ▼            ▼             ▼
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│Qualifi- │ │ Closing │ │Lifecycle│ │Opportun- │ │ Customer │ │Analytics │
│ cation  │ │         │ │         │ │   ity    │ │ Success  │ │          │
└────┬────┘ └────┬────┘ └────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │           │           │           │            │            │
     └───────────┴─────┬─────┴───────────┴────────────┘            │
                       │ proposals                                 │
                       ▼                                           │
              ╔════════════════╗      approved language     ┌──────────────┐
              │ Decision Engine │◄──────────────────────────│  Knowledge   │
              ╚════════┬════════╝                           │   Engine     │
                       │ classified action                  └──────────────┘
                       ▼
              ╔════════════════╗   cannot / must not act    ╔══════════════╗
              │   Automation   │───────────────────────────►│  Exception   │
              │     Engine     │                            │   Manager    │
              ╚════════┬═══════╝                            ╚══════┬═══════╝
                       │ side effects                              │
                       ▼                                           ▼
            external systems (payments,                     Owner queue
            messaging, scheduling, CRM)                   + exception summary
                       │                                           │
                       └──────────────► outcomes ──────────────────┘
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │   Learning   │  proposes calibration,
                                     │    Engine    │  never applies it
                                     └──────┬───────┘
                                            │ proposals only
                                            ▼
                                    Owner review → BIE / Decision config
```

**The path in words.** A visitor completes a review. The Assessment Engine emits
`assessment.completed` with the raw payload and **no `businessId`** — identity is
not yet known. The Business Record Engine resolves identity: it links to an
existing record at high confidence, creates a new one on `no_match`, or queues a
human when the signals are ambiguous. Only then does the BIE normalize the
payload into a BIR and emit `bir.generated`. Six engines read the new BIR — each
receiving both `businessId` and `birId` — and each proposes something. The
Decision Engine picks one next action and classifies it. The
Automation Engine executes it, or refuses and hands it to the Exception Manager.
Outcomes flow back to Analytics; the Learning Engine studies them and proposes
calibration changes that a human approves before anything moves.

---

## 3. Engines

Each engine below states what it is for, what it may read, what it produces, and
— most importantly — what it is **not** allowed to do. The boundaries are the
architecture; the roles are just labels.

### 3.1 Assessment Engine

*Built today.*

| | |
|---|---|
| **Role** | Collect answers, run the vertical's deterministic scoring, capture consent and attribution, deliver a submission payload. |
| **Inputs** | Visitor answers; the vertical's `assessment.config.js`. |
| **Outputs** | Submission payload (schemaVersion 2); `assessment.started`, `assessment.partial_saved`, `assessment.completed`. |
| **Boundaries** | Does not qualify, price, decide, or contact anyone. Does not know CIP exists. Produces a diagnostic estimate and stops. |

The engine stays deliberately dumb. Everything interpretive lives downstream, so
adding intelligence never means touching the thing visitors interact with.

### 3.2 Business Record Engine

*Added by [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md).
Identity resolution and record custody were previously unowned.*

| | |
|---|---|
| **Role** | Own the permanent Business Record: resolve identity, mint `businessId`, link artifacts to records, propose merges, and write the timeline. |
| **Inputs** | `assessment.completed` and any other inbound signal set; existing Business Records; identity signals. |
| **Outputs** | The Business Record; `identity.resolution_started`, `identity.resolved`, `identity.review_required`, `identity.linked`, `business.created`, `business.merge_requested`, `business.merged`, `business.unmerged`. |
| **Boundaries** | Never merges automatically — merges are owner-approved without exception. Never rewrites a historical event to insert an identifier; it writes `identity.linked` instead. Never interprets a legacy `businessKey` as a `businessId`. No selling, no scoring, no messaging. |

It runs **before** the BIE: a BIR must know which business it belongs to. Folding
this into the BIE would have given that engine two unrelated jobs and blurred its
"only translator" boundary.

### 3.3 Business Intelligence Engine (BIE)

| | |
|---|---|
| **Role** | The only translator. Turns a raw payload into a canonical BIR: normalizes answers, derives profiles, computes capacity, converts the point estimate into a range, scores confidence, and attaches evidence. |
| **Inputs** | `assessment.completed`; the previous current BIR for the same business; vertical config for package facts. |
| **Outputs** | A new BIR revision; `bir.generated`. |
| **Boundaries** | No selling, no messaging, no lifecycle decisions. Never invents a number a formula did not produce. Never overwrites a prior BIR — it supersedes. Never lets an unexplained figure through: every scored claim carries evidence. |

The BIE is the platform's chokepoint by design. If raw answers reach a second
engine, the abstraction has failed and every vertical pays for it.

### 3.4 Decision Engine

| | |
|---|---|
| **Role** | Choose the single next action for a business and classify how it may be carried out. Resolves competing proposals. |
| **Inputs** | Current BIR; proposals from Qualification, Closing, Lifecycle, Opportunity, Customer Success; the Automation Policy; suppression state. |
| **Outputs** | `recommendedNextAction` on the BIR; dispatch to Automation or Exception Manager. |
| **Boundaries** | Executes nothing. Never overrides a hard blocker. Never raises an action's automation class — it may only downgrade toward more human involvement. |

Conflict resolution is deterministic and ordered: **safety** (blockers, consent,
suppression) → **obligation** (a due review, a blocked onboarding) →
**opportunity** (an offer, an upgrade) → **nurture**. Ties break toward the less
intrusive action.

### 3.5 Qualification Engine

| | |
|---|---|
| **Role** | Decide whether a business is a fit, and say why. |
| **Inputs** | Current BIR. |
| **Outputs** | `qualificationProfile`; `lead.qualified`. |
| **Boundaries** | No pricing, no outreach. Must distinguish *disqualified* from *insufficient_data* — missing information is never a rejection. |

### 3.6 Closing Engine

| | |
|---|---|
| **Role** | Compute close readiness deterministically, select the band, and present approved offers. |
| **Inputs** | Current BIR; package facts from vertical config; approved language from the Knowledge Engine. |
| **Outputs** | `closeReadinessProfile`; `lead.close_ready`, `offer.presented`, `checkout.started`. |
| **Boundaries** | Never invents price, discount, term, deliverable, or contract language. Uses the approved close sentence only at `ask_for_sale`. Any hard blocker routes to escalation regardless of score. |

Model detail: [BUSINESS_INTELLIGENCE_REPORT.md §4](BUSINESS_INTELLIGENCE_REPORT.md#4-close-readiness).

### 3.7 Lifecycle Engine

| | |
|---|---|
| **Role** | Own where a business is in its life with CED Service, when it should be reassessed, and when it must be left alone. |
| **Inputs** | BIR history; interaction and response history; `LIFECYCLE_POLICY`. |
| **Outputs** | `lifecycle` section of the BIR; `assessment.reassessment_due`, `customer.quarterly_review_due`. |
| **Boundaries** | Sends nothing itself. Holds veto power over outreach: suppression and frequency caps outrank every other engine's enthusiasm. |

Policy detail: [BUSINESS_INTELLIGENCE_REPORT.md §6](BUSINESS_INTELLIGENCE_REPORT.md#6-lifecycle-policies).

### 3.8 Opportunity Engine

| | |
|---|---|
| **Role** | Match offers to businesses over time — upgrades, new capabilities, and new packages matched against historical BIRs. |
| **Inputs** | Current and historical BIRs; the offer catalog. |
| **Outputs** | `customer.upgrade_ready`, `offer.match_found`. |
| **Boundaries** | Must flag a match built on stale data as requiring a recheck. Must respect capacity: recommending growth a business cannot serve is an overselling failure, not a sale. |

### 3.9 Customer Success Engine

| | |
|---|---|
| **Role** | Everything after purchase: onboarding health, quarterly reviews, value realization, churn risk. |
| **Inputs** | Current BIR; onboarding state; usage and outcome signals. |
| **Outputs** | `onboarding.started`, `onboarding.blocked`; churn risk into the BIR's `riskProfile`. |
| **Boundaries** | Does not sell — an upgrade signal goes to the Opportunity Engine. A blocked onboarding must always raise an exception; it may never sit quietly. |

### 3.10 Automation Engine

| | |
|---|---|
| **Role** | The only component with side effects. Executes classified actions, handles retries, bundles notifications, writes the audit log. |
| **Inputs** | Classified actions from the Decision Engine; the Automation Policy. |
| **Outputs** | External effects; `purchase.completed`, `agreement.accepted`, `integration.failed`. |
| **Boundaries** | Executes only what the Decision Engine classified. Never escalates its own permissions. Never fails silently — an exhausted retry budget becomes an exception. Never handles payment instruments; a processor holds those and CIP holds an opaque reference. |

### 3.11 Knowledge Engine

| | |
|---|---|
| **Role** | The source of everything the platform is allowed to say: offer definitions, approved language, objection responses, contract versions, compliance wording. |
| **Inputs** | Human-authored, human-approved content. Versioned. |
| **Outputs** | Approved text by key; the offer catalog. |
| **Boundaries** | Never generated. Never edited by AI. If a needed sentence is not in the Knowledge Engine, the correct behavior is to escalate, not to compose one. |

This engine is what makes "AI may explain approved offers but may not invent
them" enforceable rather than aspirational.

### 3.12 Analytics Engine

| | |
|---|---|
| **Role** | Aggregate measurement: funnel conversion, band distribution, estimate accuracy against realized outcomes, attribution performance, exception rates. |
| **Inputs** | All events; BIR history. |
| **Outputs** | Reporting datasets and dashboards. |
| **Boundaries** | Read-only. Emits no actions and writes to no BIR. |

### 3.13 Learning Engine

| | |
|---|---|
| **Role** | Study outcomes and propose calibration: readiness weights, confidence inputs, qualification thresholds, opportunity coefficients. |
| **Inputs** | Analytics datasets; realized outcomes versus predictions. |
| **Outputs** | **Proposals only**, with evidence and expected effect. |
| **Boundaries** | Applies nothing. May never change pricing, scoring formulas, or approved language. Every proposal is a versioned change to a constant that a human approves. |

The separation matters: an automatic feedback loop into a system that quotes
dollar figures to small-business owners is exactly the failure mode the
guardrails exist to prevent.

### 3.14 Exception Manager

| | |
|---|---|
| **Role** | Guarantee that nothing falls through. Owns creation, deduplication, severity, bundling, escalation, and resolution of everything automation would not or could not do. |
| **Inputs** | Escalations from any engine; exhausted retries; hard blockers; low-confidence decisions. |
| **Outputs** | `exception.created`; the owner queue; periodic exception summaries. |
| **Boundaries** | Never resolves a business decision on its own. Never drops an exception on timeout — unresolved items age and escalate. Deduplicates so one broken integration is one item, not two hundred. |

---

## 4. Reading the BIR, not the answers

| Engine | Reads raw answers? |
|---|---|
| Assessment Engine | Produces them |
| Business Intelligence Engine | **Yes — the only one** |
| Every other engine | No |

When an engine needs something the BIR does not carry, the fix is to add a field
to the BIR, not to reach around it. That rule is what keeps a hair-salon vertical
from requiring fourteen engines to be modified.

The BIR is append-only. A new revision sets `supersedes` on itself and
`supersededBy` on its predecessor. Historical BIRs stay readable forever, which
is what makes offer-matching against a two-year-old assessment possible.

### 4.1 Which record owns which fact

The Business Record and the BIR both describe a business. They are not
interchangeable, and several fields appear in both. The rule:

| Business Record — **longitudinal authority** | BIR — **point-in-time authority** |
|---|---|
| Permanent identity | Intelligence derived from one evidence set |
| Current lifecycle state | Capacity, risk, opportunity as of generation |
| Reassessment schedule | Confidence and qualification as of generation |
| Longitudinal opportunity history | The recommendation made at that moment |
| Longitudinal health | A *snapshot* of lifecycle and business state |
| Relationship, consent, attribution history | |
| Timeline, merge and correction history | |

- **A BIR never overwrites Business Record state.** Where the two disagree about
  what is *current*, the record wins — the BIR describes the moment it was
  generated, which is exactly its value.
- The record may summarize the latest BIR but retains references to **all** prior
  BIRs.
- Downstream engines receive **both** `businessId` and `birId`.
- A single-assessment recommendation may use one BIR. A longitudinal decision —
  reassessment, offer matching, health trends — must use the record plus the
  relevant BIR history.

Encoded as `RECORD_AUTHORITY` and `BIR_AUTHORITY` in the schemas, with a
consistency check asserting the two lists never overlap.

### 4.2 Identity in events

Identity lives in the **event envelope**, never in the payload. Every event
carries `correlation.businessId`.

`businessId` may be null **only** before identity resolution completes — for
`assessment.started`, `assessment.partial_saved`, `assessment.completed`,
`identity.resolution_started`, and `identity.review_required`. Those events carry
`assessmentSessionId` or `identityResolutionId` to hold the thread instead.

Once identity resolves, the platform emits `identity.linked`. **The original
event is never rewritten to insert an identifier** — history stays immutable, and
the attachment is itself a recorded fact.

Idempotency keys are built from immutable ids, never from a mutable contact
field. An email or business name in an idempotency key is a defect; the catalog's
self-check rejects it.

---

## 5. Guardrails

These hold across every engine and outrank any engine-specific goal.

| Guardrail | How it is enforced |
|---|---|
| **Deterministic math** | Every figure comes from a named formula in config or schema constants. No model output is ever a number. |
| **Range-based estimates** | Opportunity is always low/point/high, spread by confidence per `RANGE_SPREAD_BY_CONFIDENCE`. |
| **Confidence scores** | Every BIR carries `estimateConfidence`; low confidence caps readiness and widens ranges. |
| **No guaranteed results** | Estimates are labeled diagnostic. No engine may state or imply guaranteed revenue, lead volume, or growth. |
| **Consent separation** | Permissions are recorded per purpose. Transactional service messages are distinct from marketing and are never bundled. |
| **Idempotency** | Every event carries an idempotency key; every consumer must be replay-safe. |
| **Attribution** | First touch is immutable; latest touch is free to change. |
| **Data retention** | Local retention limits stay as documented in CLAUDE.md §9; server-side retention must be defined before the first store exists. |
| **Prohibited data** | Payment instruments, credentials, government identifiers, and sensitive health data never enter CIP in any form. |
| **Human approval** | Material exceptions — custom pricing, custom terms, compliance, multi-location, low confidence — require a person. |
| **Identity** | `businessId` is a UUID, never derived from an attribute. Linking may be automatic at high confidence; **merging never is**. |
| **Enum polarity** | Every scale declares whether higher is better or worse, and which values are orthogonal rather than ranked. |

---

## 6. What does not exist yet

Everything except the Assessment Engine. In particular there is **no store**, so
nothing that depends on history — reassessment, offer matching, supersession,
suppression — can function. The first milestone is therefore persistence, not
intelligence. See [BUSINESS_INTELLIGENCE_REPORT.md §8](BUSINESS_INTELLIGENCE_REPORT.md#8-open-questions).
