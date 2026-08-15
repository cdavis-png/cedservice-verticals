# Automation Policy

**Status:** design only, with one exception. Nothing here is connected to a
payment processor, messaging provider, or scheduler.

**A CRM boundary now exists in code** — `POST /api/sales/promote` and
`POST /api/webhooks/ghl`, added with migrations 0009–0011. It is **not**
automation in the sense this document governs: promotion is an explicit,
authenticated, per-handoff call made by a staff operator, and creating an
opportunity additionally requires a separate recorded pursuit approval. Nothing
sweeps qualified handoffs and nothing promotes on a schedule or a trigger. See
[BI_TO_SALES_OPERATIONS.md](BI_TO_SALES_OPERATIONS.md). Neither surface has
been deployed.

Governs what CIP may do without a human, what it must ask about first, and what
it may never do at all. Where this document and an engine's goals disagree, this
document wins.

**Companions:** [CIP_ARCHITECTURE.md](CIP_ARCHITECTURE.md) ·
[BUSINESS_INTELLIGENCE_REPORT.md](BUSINESS_INTELLIGENCE_REPORT.md) ·
[report.schema.js](../shared/business-intelligence/report.schema.js) ·
[event-catalog.js](../shared/events/event-catalog.js)

---

## 1. Two principles

**Minimum owner interruption.** An owner's attention is the scarcest resource in
the system. Automation exists so a person is involved only where judgment is
genuinely required. A policy that pages someone about every retry is as broken as
one that silently charges a card.

**No silent failure.** Every action ends in a recorded outcome: succeeded,
retrying, or escalated. Nothing is allowed to stop quietly. These two principles
pull against each other, and the classification below is where the tension gets
resolved.

---

## 2. Action classification

Every action carries exactly one class, assigned by the Decision Engine before
dispatch. The Automation Engine may **downgrade** toward more human involvement;
it may never upgrade.

### 2.1 Autonomous

Runs without asking. Reversible, low-consequence, or explicitly pre-authorized.

- Generate a BIR; compute qualification, readiness, capacity, confidence
- Schedule and reschedule internal reassessment windows
- Send the assessment results the visitor consented to receive
- Send an offer at `present_offer` or `ask_for_sale` using approved language
- Retry a failed integration inside its budget
- Write audit and analytics records
- Create, deduplicate, and bundle exceptions
- Apply suppression and frequency caps

**Conditions:** consent for the specific purpose, no hard blocker, confidence not
`low`, and within frequency caps.

### 2.2 Customer-confirmed

The business must take an explicit action. Automation may prepare and present;
the customer decides.

- Accepting a service agreement
- Entering checkout and authorizing payment
- Starting a subscription
- Changing package tier
- Granting an integration connection
- Changing consent

**Conditions:** approved wording, disclosed price and terms, and a
non-pre-selected affirmative action. Silence is never acceptance.

### 2.3 Owner-approved

A CED Service person approves before execution.

- Any pricing that differs from the published rate card
- Any deviation from standard contract terms
- Refunds, credits, cancellations, and involuntary churn saves
- Custom scope, including non-standard Scale engagements
- Multi-location engagements
- Anything with a compliance flag
- Acting on a BIR with `low` confidence or `stale`/`expired` data
- Applying a Learning Engine calibration proposal
- Any first-of-its-kind action in a new vertical
- **Creating a CRM opportunity for a researched business.** Qualification is
  not sufficient on its own: `sales_handoffs.pursuit_approved_by` and
  `pursuit_approved_at` record a second, separate human decision, and both the
  promotion boundary and the database refuse an opportunity link without it.
  Linking a CRM *contact* is the lighter action and needs only qualification.

### 2.4 Prohibited

Never, by any component, under any classification.

- Inventing or altering price, discount, term, deliverable, or contract language
- Promising results, revenue, lead volume, or growth
- Presenting an estimate without its diagnostic-estimate labeling
- Contacting anyone without consent for that specific purpose
- Treating a marketing consent as covering transactional messages, or the reverse
- Storing or transmitting payment instruments, credentials, government
  identifiers, or sensitive health data
- Overwriting or deleting a historical BIR
- Auto-applying a change to pricing, scoring formulas, or approved language
- Retrying a payment beyond its cap
- Closing an exception without a recorded resolution

---

## 3. Automated close

### 3.1 Package eligibility

| Package | Zero-touch | Condition |
|---|---|---|
| **Starter** ($297/mo) | Yes | All gate conditions in §3.2 pass |
| **Salon Growth** ($597/mo) | Yes | Standard scope only |
| **Scale** ($997/mo) | Only if standardized | `packageRecommendation.scopeStandard === true` |
| **Custom** | No | Always owner-approved |

Scale is conditional because its capabilities — AI phone coverage, local SEO,
membership systems — are the ones most often shaped to a specific business.
`scopeStandard` must be a defined, checkable profile before Scale may close
zero-touch. **Until that profile exists, Scale defaults to owner-approved.**

### 3.2 Gate conditions

All must hold, evaluated against the current BIR:

1. `closeReadinessProfile.band === 'ask_for_sale'`
2. No hard blockers
3. `qualificationProfile.outcome === 'qualified'`
4. `estimateConfidence.band !== 'low'`
5. Data freshness is `fresh` or `aging`
6. `packageRecommendation.scopeStandard === true`
7. `technologyProfile.integrationCompatibility === 'supported'`
8. `capacityProfile.oversellRisk !== 'high'`
9. Consent present for `transactional_service`
10. No open exception for this business

Failing any condition does not cancel the sale — it reclassifies the action to
owner-approved and routes it to the queue.

### 3.3 The automated sequence

Each step is customer-confirmed or autonomous as marked, and each is idempotent
under the keys in the event catalog.

| Step | Class | Emits |
|---|---|---|
| Present approved offer | autonomous | `offer.presented` |
| Present agreement for acceptance | customer-confirmed | `agreement.accepted` |
| Checkout | customer-confirmed | `checkout.started` |
| Capture payment | customer-confirmed | `purchase.completed` |
| Create subscription | autonomous | `purchase.completed` |
| Create customer record | autonomous | — |
| Start onboarding | autonomous | `onboarding.started` |

Payment data never enters CIP. Checkout is hosted by the processor; the platform
stores only an opaque `processorReference`. `purchase.completed` is idempotent on
that reference because the processor — not CIP — is the source of truth for
whether money moved.

### 3.4 Escalation triggers

Any of these routes to a human, at any point in the sequence:

- Custom pricing requested
- Custom terms requested
- Unsupported or unknown integration
- Multiple locations
- Compliance concern
- `low` estimate confidence
- Stale or expired assessment data
- High oversell risk
- Payment failure after the cap in §4.2
- Any hard blocker appearing mid-sequence

Escalation preserves state. A business that escalates at checkout keeps its
accepted agreement; a person resumes from there rather than restarting.

### 3.5 What AI may and may not do

**May:** explain an approved offer in its own words; answer questions using
Knowledge Engine content; summarize a BIR for a person; draft an internal
exception summary; select which approved response fits a question.

**May not:** state a price not in vertical config; offer a discount, trial,
extension, or incentive; describe a deliverable not in the approved package
definition; promise an outcome or timeline; author or modify contract language;
answer a question the Knowledge Engine has no approved response for.

That last one is the operative rule. **When approved content does not exist, the
correct behavior is to escalate — never to compose.** A plausible sentence about
pricing is more dangerous than an unanswered question.

---

## 4. Retries and escalation thresholds

### 4.1 Standard integrations

Exponential backoff, doubling from 1 minute, capped at 6 hours, maximum 8
attempts — matching the client-side queue already in production. On exhaustion,
emit `integration.failed` and create an exception. Permanent failures (4xx other
than 408/425/429) are not retried at all; they escalate on the first occurrence.

### 4.2 Payments

Payments are exempt from the standard budget.

| Rule | Value |
|---|---|
| Maximum automatic retries | 1 |
| Minimum interval | 24 hours |
| Hard decline (lost, stolen, fraud) | 0 retries, escalate immediately |
| Escalation | after the single retry fails |

Card networks penalize repeated retries, and a customer seeing multiple attempts
loses trust faster than one seeing a polite failure notice.

### 4.3 Outbound messaging

3 attempts, 15-minute backoff. Never retry in a way that could deliver the same
message twice — messaging is idempotent on the event's idempotency key, not on
the send attempt.

### 4.4 Thresholds

| Condition | Response |
|---|---|
| One transient failure | Retry silently, no notification |
| Retry budget exhausted | `integration.failed` + exception |
| 3+ failures of one integration within 1 hour | Single aggregated exception, severity raised |
| Any payment failure | Immediate exception |
| Any compliance flag | Immediate exception, critical severity |
| Exception unresolved past `dueBy` | Severity raised one level |

---

## 5. Notification bundling

Severity decides cadence, not the sender's urgency.

| Severity | Delivery | Examples |
|---|---|---|
| `critical` | Immediate | Compliance flag, payment fraud signal, prohibited data detected |
| `high` | Hourly digest | Payment failure, blocked onboarding, escalated close |
| `medium` | Daily digest | Custom-scope request, unsupported integration |
| `low` | Weekly summary | Stale data, reassessment overdue, nonresponse dormancy |

Bundling rules:

- One integration failing 200 times is **one** item, with a count.
- One business generating several exceptions in a window arrives as **one**
  grouped item.
- A digest with nothing in it is not sent.
- Severity may be raised by age; it is never lowered automatically.

---

## 6. Audit logging

Every action — autonomous or not — writes an immutable record:

`{ actionId, class, actor, subject, decidedBy, basisBirId, inputs, outcome, timestamp, correlation }`

Requirements: append-only, never edited or deleted; `basisBirId` on every
business-affecting action so the reasoning can be reconstructed; the approving
person recorded for owner-approved actions; and no prohibited data, ever — logs
are subject to the same restrictions as the BIR.

Approved-language usage is logged by key, so it is always possible to prove what
a business was actually shown.

---

## 7. Safe fallback

When automation cannot proceed, in order of preference:

1. **Retry** within budget, if the failure looks transient.
2. **Degrade** — deliver by email when SMS fails, if consent covers it.
3. **Defer** — reschedule outside a quiet period rather than violating one.
4. **Hand off** — create an exception with full state so a person resumes rather
   than restarts.
5. **Stop** — never partially complete a financial or contractual action.

Non-negotiable: a fallback may never reduce a consent requirement, widen a
frequency cap, or lower an action's class. Falling back always moves toward *less*
automated action, never more.

---

## 8. Exceptions and no silent failure

Every exception carries a category, severity, a plain-language summary, the
required action, and enough state to resume. Deduplication is on
`category + subject`, so one broken integration is one item.

The Exception Manager owns the guarantee that nothing is lost: unresolved items
age and escalate, none are auto-closed on timeout, and closing one requires a
recorded resolution.

**Exception summaries** — a periodic digest of what needed a human, what was
resolved, what is still open and aging, and which categories are recurring.
Recurring exceptions are the system's most valuable signal: three custom-pricing
escalations in a week is a pricing problem, not three incidents.

---

## 9. Guardrails

Every guardrail in [CIP_ARCHITECTURE.md §5](CIP_ARCHITECTURE.md#5-guardrails)
applies here. Restated where automation is the specific risk:

| Guardrail | Automation obligation |
|---|---|
| Deterministic math | Automation never computes a figure; it presents what the BIR carries. |
| Range-based estimates | Any presented figure includes its range and disclaimer. |
| Confidence scores | `low` confidence blocks zero-touch close outright. |
| No guaranteed results | No message may promise revenue, leads, or growth. |
| Consent separation | Checked per purpose at send time, never inherited. |
| Idempotency | Every action idempotent on its catalog key; replay is expected. |
| Attribution | First touch is never rewritten by any automated action. |
| Data retention | Automation deletes on request and never resurrects cleared data. |
| Prohibited data | Never stored, logged, or transmitted — including in audit records. |
| Human approval | Material exceptions always reach a person. |

---

## 10. Communication classes and legal basis

> **Not a compliance claim.** Everything in this section — the class
> definitions, the stated bases, and all consent wording in the verticals — is
> **pending professional review**. It describes how the platform is structured,
> not what any jurisdiction requires. No vertical launches until counsel has
> reviewed the wording and the bases below.

Four distinct classes. They are never collapsed, and permission for one is never
treated as permission for another.

| Class | Purpose key | Basis | Examples |
|---|---|---|---|
| **Assessment results delivery** | `results_delivery` | Requested by the recipient — they asked for the results | The assessment results and directly related follow-up |
| **Transactional service** | `transactional_service` | An existing service relationship | Agreement, receipt, payment failure, onboarding steps, service notices, account alerts |
| **Email marketing** | `email_marketing` | Opt-in consent | Tips, offers, newsletters |
| **SMS marketing** | `sms_marketing` | Opt-in consent | Promotional texts |

### Rules

1. **Agreements, receipts, onboarding, service notices, and account alerts are
   transactional.** They exist because the business bought something, and they
   are necessary to deliver it.
2. **Transactional communications rest on the service relationship, not on
   marketing consent.** A customer who declined all marketing must still receive
   their receipt and their onboarding instructions.
3. **Marketing consent is never treated as consent for transactional messages,
   and transactional basis is never stretched to cover marketing.** Adding an
   offer to a receipt converts a transactional message into a marketing one.
4. **Results delivery is narrow.** It covers the assessment results and directly
   related follow-up. It is not a general-purpose channel, and it expires in
   usefulness — it does not become a standing permission.
5. **No class implies another.** Four purposes, four separate records, each with
   `granted`, the exact statement shown, and `recordedAt`.
6. **Basis is checked at send time**, against `consentHistory` in the Business
   Record, never inherited from a prior message or assumed from lifecycle stage.
7. **Withdrawal is immediate and per purpose.** A withdrawal is a new
   `consentHistory` entry, never an edit, and it never cascades into the other
   three classes.

### A modelling note worth flagging

`transactional_service` sits in `VOCAB.consentPurpose` alongside the two
marketing purposes, but it is **not an opt-in** — it is a record of a
relationship-based basis. The vocabulary name is therefore slightly misleading.
It was kept because renaming it would ripple through the BIR, the Business
Record, and the event catalog for a cosmetic gain. The distinction is recorded
here so nobody reads a `transactional_service` entry as evidence that someone
ticked a box. Revisit if the vocabulary is ever versioned for another reason.
