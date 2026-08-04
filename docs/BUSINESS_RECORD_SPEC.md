# Business Record — Specification

**Status:** design only. No Business Record has ever been created. There is no
store, no endpoint, no automation. This document and the seven schema files
beside it are the contract that the first implementation will be built against.

**Schemas:** [business-record](../shared/business-record/business-record.schema.js) ·
[identity-resolution](../shared/business-record/identity-resolution.schema.js) ·
[timeline-event](../shared/business-record/timeline-event.schema.js) ·
[relationship](../shared/business-record/relationship.schema.js) ·
[health-profile](../shared/business-record/health-profile.schema.js) ·
[opportunity-profile](../shared/business-record/opportunity-profile.schema.js) ·
[memory-fact](../shared/business-record/memory-fact.schema.js)

**Companions:** [CIP_ARCHITECTURE.md](CIP_ARCHITECTURE.md) ·
[BUSINESS_INTELLIGENCE_REPORT.md](BUSINESS_INTELLIGENCE_REPORT.md) ·
[AUTOMATION_POLICY.md](AUTOMATION_POLICY.md)

---

## 1. Purpose

**The Business Record is the permanent source of truth for the relationship with
a business.**

Everything else CIP produces is a document about a moment. An assessment is what
they told us in March. A BIR is what we concluded from it. A purchase is one
transaction. Each is a photograph; none is the relationship.

The Business Record is the thing that persists between those moments, and
everything else **attaches** to it:

| Attaches to the record | Never replaces |
|---|---|
| Assessments | prior assessments |
| Business Intelligence Reports | prior BIRs |
| Purchases, agreements, subscriptions | prior commercial history |
| Communications and AI conversations | prior interactions |
| Lifecycle transitions | prior stages |
| Health profiles | prior periods |
| Opportunities | prior opportunities |
| Consents | prior consents |

A reassessment in 2028 does not replace the 2026 assessment. It joins it. That
single property is what makes quarterly reassessment, historical offer matching,
and honest trend analysis possible — and it is the property most systems lose
first, by updating a row in place.

### 1.1 Authority: longitudinal versus point-in-time

The Business Record and the BIR both describe a business, and several fields
appear in both. Settled by
[ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md):

| Business Record — **longitudinal authority** | BIR — **point-in-time authority** |
|---|---|
| Permanent identity | Intelligence from one evidence set |
| Current lifecycle state | Capacity, risk, opportunity as of generation |
| Reassessment schedule | Confidence and qualification as of generation |
| Longitudinal opportunity history | The recommendation made at that moment |
| Longitudinal health | A *snapshot* of lifecycle and business state |
| Relationship history | |
| Consent history | |
| Attribution history | |
| Timeline | |
| Merge and correction history | |

- **A BIR never overwrites Business Record state.** Where the two disagree about
  what is *current*, the record wins — a BIR describes the moment it was
  generated, which is precisely its value.
- The record may summarize the latest BIR but retains references to **all** prior
  BIRs.
- Downstream engines receive **both** `businessId` and `birId`.
- A single-assessment recommendation may use one BIR. A longitudinal decision
  must use the record plus relevant BIR history.

Encoded as `RECORD_AUTHORITY` here and `BIR_AUTHORITY` in the BIR schema, with a
consistency check asserting the two lists never overlap.

---

## 2. Data flow

```
   assessment.completed
          │
          ▼
   ┌──────────────────┐   signals: gbp id, phone, domain, address, name, email
   │ Identity         │◄──────────────────────────────────────────────
   │ Resolution       │
   └────────┬─────────┘
            │
    ┌───────┴────────┬─────────────────┬──────────────────┐
    ▼                ▼                 ▼                  ▼
 unique_match   probable_match   possible_duplicate    no_match
    │                │                 │                  │
 auto-link       queue for         queue for          create new
 (strong          review            review            Business Record
  signal only)      │                 │                  │
    └───────────────┴────────┬────────┴──────────────────┘
                             ▼
                  ╔═══════════════════════╗
                  ║   BUSINESS RECORD     ║  permanent, append-only
                  ║   businessId (UUID)   ║
                  ╚═══════════┬═══════════╝
                              │
   ┌──────────┬───────────┬───┴───┬────────────┬───────────┬──────────┐
   ▼          ▼           ▼       ▼            ▼           ▼          ▼
timeline  assessments   BIRs   opportunities  health    memory     consent
(append)   (append)   (append)  (current+hist) (append)  facts     (append)
   │          │           │       │            │           │          │
   └──────────┴───────────┴───┬───┴────────────┴───────────┴──────────┘
                              │ read
                     ┌────────┴─────────┐
                     ▼                  ▼
              Closing Engine      Lifecycle / Opportunity
              (readiness)         (reassessment, matching)
                     │                  │
                     └────────┬─────────┘
                              ▼
                       Decision Engine → Automation → Exception Manager
```

The record is written by many engines and read by all of them. It never decides
anything itself — it holds the evidence and state that decisions are made from.

---

## 3. Object model

One record per business. Sections declare how they may change:

| Mode | Meaning |
|---|---|
| `append_only` | Entries are added, never edited or removed |
| `current_plus_history` | A current pointer plus an append-only chain |
| `mutable_current` | A working value with a full audit trail of changes |

**Append-only:** assessments, BIRs, recommendations, offers, proposals,
agreements, purchases, payments, communications, AI conversations, memory facts,
health profiles, customer-success metrics, files, timeline, audit history,
consent history, attribution history, offer-match history, exceptions,
source-system references.

**Current plus history:** locations, people, opportunities, subscriptions,
projects, onboarding, integrations, support cases, lifecycle, relationships.

**Mutable current (audited):** identity, reassessment schedule, privacy.

Referenced documents are stored as **pointers with thin summaries**, never
copies. A copy is a second source of truth waiting to disagree with the first.
The summary exists so offer matching can scan a thousand records without
fetching a thousand BIRs.

---

## 4. Identity philosophy

**`businessId` is a UUID. It is permanent, opaque, and meaningless.**

It is never derived from a business attribute, because every business attribute
changes:

| Candidate | Why it fails as identity |
|---|---|
| Email | Shared, reassigned, replaced when staff leave |
| Phone | Reassigned constantly; owner mobile doubles as business line |
| Business name | Not unique; changes on rebrand, sale, or franchise conversion |
| Website domain | Lapses, changes, sits on a shared marketplace page |

Each of these is a **signal** — evidence about identity — never identity itself.
A business that rebrands, changes its number, moves, and sells to a new owner is
still the same business with the same history, and the same `businessId`.

Two consequences the schema enforces:

- **Aliases are never pruned.** Every former name, number, domain, and email is
  retained. Today's stale phone number is tomorrow's successful match.
- **A merged-away record is never a link target.** Its `recordStatus` is
  `merged_away` and callers follow `mergedIntoBusinessId` first.

---

## 5. Identity resolution

The governing asymmetry: **attaching an event to the wrong record is
recoverable; merging two records is not.** Linking may therefore be automatic at
high confidence. Merging never is.

### 5.1 Signals

Signals carry a weight *and* a strength. Strength decides what a match is
permitted to do, not just how much it scores.

| Signal | Weight | Strength |
|---|---|---|
| Google Business Profile id | 0.95 | strong |
| Trusted external customer id | 0.95 | strong |
| Payment customer id | 0.90 | strong |
| Website domain | 0.70 | moderate |
| Phone (E.164) | 0.65 | moderate |
| Address (normalized) | 0.60 | moderate |
| External CRM id | 0.55 | moderate |
| Owner or manager name | 0.40 | weak |
| Business name | 0.35 | weak |
| Email domain | 0.35 | weak |
| Email exact | 0.30 | weak |
| Geo proximity | 0.25 | corroborating only |

Name, email, owner name, and proximity are listed in `INSUFFICIENT_ALONE`: no
combination of them alone can produce a `unique_match`, at any score.

### 5.2 Statuses and actions

| Status | Condition | Action |
|---|---|---|
| `unique_match` | ≥ 0.90 **and** a strong signal **and** no conflicts | Auto-link |
| `probable_match` | ≥ 0.75 | Queue for review |
| `possible_duplicate` | ≥ 0.55, or candidates within 0.15 of each other | Queue for review |
| `no_match` | < 0.55 | Create a new record |
| `manual_review_required` | any conflicting signal ≥ 0.60 | Queue for review |

Candidate separation matters independently of score. Two records both scoring
0.95 is not a confident match — it is a duplicate problem.

A **conflict** is a signal that actively disagrees (same GBP id, different
address), not one that is absent. Missing data lowers confidence; contradiction
routes to a human.

### 5.3 Rules

1. Never merge automatically. Every merge is owner-approved, without exception.
2. Never merge on business name alone, at any score.
3. Never merge on email alone, at any score.
4. A Google Business Profile id or trusted external customer id may serve as a
   strong identifier.
5. Auto-linking requires `unique_match`, confidence ≥ 0.90, at least one strong
   signal, and zero conflicts.
6. Preserve every alias and source record after a merge.
7. Merge history is append-only and auditable.
8. Unmerge only while `unmergeSafe` is true and every post-merge event can be
   explicitly reassigned.
9. Low-confidence identity resolution interrupts an owner. It never guesses.

There is deliberately **no `mayAutoMerge()` function** in the schema. The
capability does not exist, so it cannot be called by mistake.

---

## 6. Merge and correction rules

### 6.1 Merge

A merge produces a `MERGE_RECORD` containing: the surviving id, the merged ids,
who approved it and when, per-field resolutions with discarded values and
reasons, **all** preserved aliases, complete pre-merge snapshots of every source
record, and an `unmergeSafe` flag.

Timelines interleave by `occurredAt`. Event ids never change — a timeline event
belongs to a business, and merging changes which business, not which event.

`unmergeSafe` goes false once post-merge activity makes the original split
unreconstructable: a purchase, an accepted agreement, or an external sync under
the merged identity. Unmerge then requires explicit per-event reassignment.

### 6.2 Correction

**No silent mutation of historical business intelligence.** Two mechanisms, and
an event may use only one:

- **`supersedesEventId`** — the earlier event was right then, and is stale now.
- **`correctionOfEventId`** — the earlier event was wrong. It stays readable;
  `correctionReason` is required.

Both preserve what we believed and when. That matters for a platform that quotes
dollar figures: "we told them $1,680 on 4 August based on these answers" must
remain answerable even after the number changes.

### 6.3 Legacy migration

Artifacts created before `businessId` existed. Nothing is stored yet, so this is
a forward-looking path rather than a data migration — but it must be defined
before the first store, because the first store will immediately create v1-shaped
artifacts if it is not.

**Principle:** a legacy `businessKey` is *evidence*, never an identifier. It is
carried forward as provenance and fed into resolution as one weak signal. It is
never parsed, hashed, or cast into a `businessId`.

**Statuses** (`IDENTITY_LINK_STATUSES`, owned by
[identity-resolution.schema.js](../shared/business-record/identity-resolution.schema.js)
and mirrored in the BIR schema):

| Status | Meaning | `businessId` |
|---|---|---|
| `legacy_unresolved` | Predates `businessId`; carries only a `legacyBusinessKey` | null |
| `resolution_pending` | Resolution running or queued | null |
| `linked` | Attached automatically at high confidence | set |
| `manually_verified` | Attached by a person | set |
| `merge_required` | Duplicate suspected; blocked pending owner approval | null |
| `rejected_match` | A proposed link was reviewed and refused | set or null |

**Paths by artifact kind:**

| Artifact | Path |
|---|---|
| **BIR v1 with `businessKey`** | `legacy_unresolved`; copy to `legacyBusinessKey`; leave `businessId` null; resolve from the source submission's signals. `unique_match` → `identity.linked` and status `linked`. `probable_match` / `possible_duplicate` → `merge_required`, queued. `no_match` → `business.created` then `identity.linked`. The v1 document is never rewritten. |
| **Submission before `businessId`** | Treat as an inbound signal set and resolve normally. `submissionId` is the immutable join key. |
| **Assessment known only by session** | `assessmentSessionId` carries the thread. With no contact signal at all, it stays `resolution_pending` and is not attached. |
| **Unresolved duplicates** | `merge_required`; emit `business.merge_requested`. Never `business.merged` without recorded owner approval. Both records stay independently readable and addressable. |

**Prohibitions during migration:**

- Never reinterpret a `legacyBusinessKey` as a `businessId`.
- Never derive a `businessId` deterministically from an email, phone, or name.
- Never auto-merge during migration, at any confidence.
- Never rewrite a historical event to insert a `businessId` — emit
  `identity.linked` instead.
- Never delete a legacy artifact that failed to resolve; leave it
  `legacy_unresolved` and visible.

---

## 7. Timeline examples

Twenty-five event types across assessment, intelligence, commercial, delivery,
lifecycle, opportunity, success, and business-change categories. Thirteen map to
inter-engine bus events in
[event-catalog.js](../shared/events/event-catalog.js); twelve are
timeline-only — things worth remembering forever that no engine needs to
broadcast.

**A lead that converts:**

```
2026-03-02  assessment.started      session opened from a QR card
2026-03-02  assessment.completed    submissionId abc-123
2026-03-02  bir.generated           confidence medium, readiness "clarify"
2026-03-02  lead.qualified          qualified
2026-06-01  reassessment.due        unconverted lead, 90 days since last contact
2026-06-04  assessment.completed    second assessment — the first is untouched
2026-06-04  bir.generated           supersedes the March BIR, readiness "ask_for_sale"
2026-06-04  offer.presented         Salon Growth, $597/month
2026-06-05  agreement.accepted      v2026-03
2026-06-05  purchase.completed      processorReference pi_xxx
2026-06-05  onboarding.started
```

**A correction:**

```
2026-06-04  bir.generated           opportunity $1,600–$3,000/month
2026-06-06  bir.generated           correctionOfEventId → the 4 June event
                                    correctionReason: "average ticket was entered
                                    as $50 but confirmed at $38 on a follow-up call"
```

The 4 June event stays. Anyone asking what the business was shown on 4 June still
gets the right answer.

**A business change:**

```
2026-09-12  staff.added             3 → 5 technicians
                                    → capacity profile invalidated
                                    → change_triggered reassessment scheduled
```

---

## 8. Reassessment examples

Cadence constants live in `LIFECYCLE_POLICY` in
[report.schema.js](../shared/business-intelligence/report.schema.js) and are
**not** redefined here. The record stores state; that file owns the numbers.

**Active customer, quarterly.** 90 days after the last review, `reassessment.due`
fires with kind `quarterly_review`. The new BIR joins the chain;
`quarterlyReassessmentRefs` gains an entry; the previous BIR is marked
superseded but stays readable. Four quarters later the record can show a real
trend line, because nothing was overwritten.

**Unconverted lead.** The clock runs from `lastMeaningfulInteractionAt`, not the
assessment date. A lead who opened an email last week is not due merely because
they assessed three months ago. A reply is meaningful; a delivery is not.

**Repeated nonresponse.** 90 → 180 → 365 days, then `lead_dormant` and no further
scheduled outreach. Dormant is not deletion — an inbound signal revives it.

**Stale data.** Past 180 days, `quickRecheckRequired` goes true. A quick recheck
confirms only the volatile fields — capacity, staffing, ticket, booking system —
rather than repeating all 24 questions. A close recommendation built on stale
data is capped at `clarify` by the soft blocker `stale_assessment_data`.

---

## 9. Offer-matching examples

Historical matching is the payoff for append-only history.

**Scenario.** In August 2027 a new capability launches: automated waitlist fill.
The Opportunity Engine scans every historical BIR — including businesses that
never converted — for `operationsProfile.waitlistUsage === 'none'` and
`appointmentProtectionScore < 50`.

```
Match:  Polished Nail Studio
        matchedBirId:   bir-2026-06-04
        matchScore:     0.82
        matchReasons:   ["no waitlist in use", "3 cancellations/week",
                         "capacity headroom moderate"]
        birAgeDays:     429
        requiresRecheck: true      ← older than 180 days
```

`requiresRecheck` is not advisory. The Decision Engine must schedule a quick
recheck before presenting anything, because a 429-day-old capacity figure cannot
support a fresh offer.

Each match appends to `offerMatchHistory` with its outcome — including matches
that were declined. Declines are how the Learning Engine calibrates matching.

---

## 10. Automated-close support

The record **does not close the sale**. It guarantees the Closing Engine can
find every input in one known place. `CLOSE_READINESS_INPUT_MAP` in the schema
is that map; abbreviated:

| Input | Where it comes from |
|---|---|
| Package fit | current BIR summary |
| Close readiness | current BIR summary |
| Decision authority | `people[].authority` + memory facts (category `authority`) |
| Budget signal | memory facts (category `budget`) + payment history |
| Urgency | memory facts (category `intent`) + timeline recency |
| Capacity | current BIR capacity band + memory facts (category `capacity`) |
| Implementation compatibility | `integrations[].compatibility` + technology facts |
| Unresolved objections | open risk facts + open support cases |
| Scope standardization | opportunity exclusions + location count |
| Custom blockers | open exceptions + multi-location + unsupported integrations |
| Consent | `consentHistory` resolved per purpose **at send time** |
| Eligibility | lifecycle stage + suppression + open exceptions |
| Existing services | active subscriptions |
| Payment status | most recent payment outcome + subscription status |
| Agreement status | most recent accepted agreement version |

Two safeguards worth stating plainly:

- **Material facts gate automated close.** Decision authority, budget, location
  count, booking platform, and compliance constraints are `MATERIAL_PREDICATES`.
  A model-proposed material fact is *not actionable* until confirmed by a
  deterministic source or a human. `isActionable()` enforces this.
- **The approved close sentence is not duplicated here.**
  `APPROVED_CLOSE_LANGUAGE.ask_for_sale` in
  [report.schema.js](../shared/business-intelligence/report.schema.js) remains
  the only executable copy. For reference, that sentence is:

  > Based on your assessment results, the next logical step is to activate the
  > system and begin onboarding.

  It is used only at the `ask_for_sale` band with no hard blockers.

---

## 11. Owner-interruption policy

The record is designed so routine work happens without anyone being asked.

**Runs automatically:** lead linking at high confidence, reassessment
scheduling, offer matching, package recommendation, zero-touch close when
[AUTOMATION_POLICY.md §3.2](AUTOMATION_POLICY.md#32-gate-conditions) passes,
onboarding, health monitoring, upgrade detection, nurture, reactivation, and
exception creation.

**Requires an owner:** destructive merges, custom pricing, custom contract
language, unsupported integrations, multi-location complexity,
compliance-sensitive exceptions, low-confidence identity resolution, materially
disputed facts, high-value strategic accounts, and system failures after retry
exhaustion.

The list is short on purpose. Every item is either irreversible, legally
binding, or genuinely ambiguous — the three cases where a person's judgment is
worth interrupting them for.

---

## 12. Privacy guardrails

**Nothing here is a claim of legal compliance.** All regulatory and contractual
language in this section requires review by a qualified professional before any
vertical launches. It is flagged rather than assumed.

- **Classification** — every record carries `dataClassification`
  (public/internal/confidential/restricted), defaulting to confidential.
- **Retention categories** — transactional, relationship, analytical, legal
  hold, ephemeral. Server-side retention periods are **undefined and must be set
  before a store exists**.
- **Deletion requests** are append-only: the request survives even after the data
  is removed, and legal hold overrides deletion.
- **Export** is supported per record with a recorded scope.
- **Consent history** is append-only and resolved per purpose at send time. A
  withdrawal is a new entry, never an edit. Marketing consent never covers
  transactional messages, and the reverse is equally forbidden.
- **Provenance** — every imported value records its source system, trust level,
  and sync time.
- **Access boundaries** — owner_only, staff, automation, partner,
  customer_self_service.
- **Minimum necessary storage** — a periodic review records fields removed.
- **Prohibited data** — payment instruments, credentials, government
  identifiers, and sensitive health information never enter the record, in any
  section, including audit entries and timeline payloads. Enforced in
  `memory-fact.schema.js` by pattern.
- **Medical/dental expansion is restricted.** Those verticals must define
  additional handling rules *before* launch. Absence of a restriction is not
  permission.

---

## 13. Open decisions

Ranked by what they block.

1. ~~**`businessKey` vs `businessId`.**~~ **RESOLVED** by
   [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md).
   `businessId` is canonical; `businessKey` is deprecated and survives only as
   `legacyBusinessKey` provenance. BIR schema advanced to v2 and the event
   catalog to v2. What remains is *evidence quality*, item 3 below.
2. **Where records live.** No store exists. Append-only history, supersession,
   and merge auditing all assume durable storage with strong ordering.
3. **Identity signals are mostly uncollected.** GBP id, address, and website are
   never asked for. Today only email, business name, and (optionally) mobile
   exist — and the first two are `INSUFFICIENT_ALONE`. **Every resolution today
   would land in `possible_duplicate` or `no_match`.**
4. **Transactional consent basis.** Automated close needs
   `transactional_service` consent, which the assessment never collects.
5. **Health formula definitions.** Ten dimensions are specified; none has a
   formula. Until they do, every dimension is legitimately `unknown` and overall
   health is `unknown` under `OVERALL_RULES`.
6. **Memory-fact extraction.** Who proposes facts, at what confidence, and what
   the human verification queue looks like.
7. **Timeline visibility defaults.** Which events are ever customer-visible needs
   a decision before any customer-facing timeline is built.
8. **Retention periods.** Categories exist; durations do not.
9. **Merge approval UI.** Merges require owner approval, and no approval surface
   exists.

---

## 14. First implementation milestone

**Milestone: "One business, one record."**

Not intelligence — identity and persistence. Three parts, in order:

1. ~~Decide `businessKey` vs `businessId`.~~ **Done** —
   [ADR-001](decisions/ADR-001-business-identity-and-record-ownership.md).
   `businessId` is canonical; BIR schema is v2; event catalog is v2.
2. **A record store** with append-only semantics for timeline, assessments, and
   BIR references — plus the capture endpoint already specified at the end of
   the lead-capture work, which is still the last thing between the nails
   vertical and launch.
3. **Identity resolution v1** running on the signals that actually exist today
   (email, business name, optional mobile), which means it will correctly and
   loudly report low confidence — proving the model rather than papering over
   the gap.

**Done when:** a completed nail-salon assessment creates or links to exactly one
Business Record; a second assessment from the same business links to the same
`businessId` rather than creating a duplicate; both assessments and both BIRs
remain readable; the timeline shows both in order; and a deliberately ambiguous
third submission lands in a review queue instead of guessing.

**Not in this milestone:** health profiles, opportunity generation, memory-fact
extraction, merges, automated close. Each depends on data or decisions above.
