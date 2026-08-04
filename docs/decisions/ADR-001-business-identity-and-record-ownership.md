# ADR-001 — Business identity and record ownership

- **Status:** Accepted (design). Nothing is implemented.
- **Date:** 2026-08-04
- **Supersedes:** the `businessKey` placeholder introduced with the BIR schema
- **Affects:** BIR schema (v1 → v2), event catalog (v1 → v2), all Business Record
  schemas, CIP architecture

---

## Context

CIP grew in two passes that did not agree with each other.

The **BIR** came first and needed something to hang a report on, so it declared
`identity.businessKey` — a string with no defined resolution rule, flagged at the
time as unresolved. The event catalog inherited it as `correlation.businessKey`.

The **Business Record** came second and defined `businessId`, a permanent UUID,
with an explicit argument for why identity must be opaque: every business
attribute (email, phone, name, domain) changes while the business stays the same.

Two identifiers for one concept is not a naming problem. It is two different
theories of identity in one system:

- `businessKey` implies identity is *derivable* from attributes.
- `businessId` asserts identity is *assigned* and attributes are only evidence.

Only one can be true. Left unreconciled, engines would disagree about whether two
assessments describe the same business — which breaks reassessment, offer
matching, and merge safety simultaneously.

Three smaller conflicts surfaced with it:

1. **Ownership.** Lifecycle state, reassessment schedule, opportunity, and risk
   appear in both the BIR and the Business Record, with no rule for which wins.
2. **Capacity polarity.** `CAPACITY_HEADROOM_BANDS.none` means *no headroom*
   (worst case); `CAPACITY_CONSTRAINT_LEVELS.none` meant *no constraint* (best
   case). Same word, opposite meaning, one field apart.
3. **No owner for identity.** No engine in the thirteen-engine roster was
   responsible for resolving identity or writing the Business Record.

---

## Decision

### 1. `businessId` is canonical

A UUID, permanent, opaque, assigned once and never derived from any business
attribute. It is the only identifier engines use to mean "this business."

### 2. `businessKey` is deprecated

Removed from the BIR schema and the event envelope in their v2 contracts. It
survives only as `legacyBusinessKey`, a read-only provenance field.

**A legacy `businessKey` is never reinterpreted as a `businessId`.** Not parsed,
not hashed, not cast. It enters identity resolution as one weak signal like any
other piece of evidence, and nothing more.

### 3. Schema versions advance

- **BIR schema v1 → v2.** The identity contract changed, so the version must
  change. v1 reports remain readable and are held to the v1 contract, not v2.
- **Event catalog v1 → v2.** `correlation.businessId` replaces
  `correlation.businessKey`; identity moved out of event payloads into the
  envelope. Events that previously required `businessKey` in their payload are
  now version 2.

### 4. The Business Record is longitudinal authority; the BIR is point-in-time authority

| Business Record owns | BIR owns |
|---|---|
| Permanent identity | Point-in-time intelligence from one evidence set |
| Current lifecycle state | Point-in-time capacity, risk, opportunity |
| Reassessment schedule | Point-in-time confidence and qualification |
| Longitudinal opportunity history | Point-in-time recommendation |
| Longitudinal health | A *snapshot* of lifecycle and business state as it was |
| Relationship, consent, attribution history | |
| Timeline, merge and correction history | |

Rules:

- A BIR must never overwrite Business Record state.
- Where they disagree about *current* state, the record wins — a BIR describes
  the moment it was generated.
- The record may summarize the latest BIR but retains references to all prior
  BIRs.
- Downstream engines receive both `businessId` and `birId`.
- A single-assessment recommendation may use one BIR. A longitudinal decision
  must use the record plus relevant BIR history.

Encoded as `RECORD_AUTHORITY` and `BIR_AUTHORITY`, with a consistency check
asserting the two lists do not overlap.

### 5. Destructive merges require owner approval

Automatic merging does not exist. There is deliberately no `mayAutoMerge()`
function, so the capability cannot be called by mistake. Automatic *linking* is
permitted at ≥ 0.90 confidence with at least one strong signal and zero
conflicts, because linking is reversible and merging is not.

### 6. A Business Record Engine owns identity

A fourteenth engine, `business-record-engine`, owns identity resolution, record
custody, linking, merges, and timeline writes. Identity resolution was previously
unowned; folding it into the Business Intelligence Engine would have given that
engine two unrelated jobs and blurred its "only translator" boundary.

### 7. Capacity constraint renamed

`CAPACITY_CONSTRAINT_LEVELS.none` → `unconstrained`. Every enum in CIP now
declares its polarity in a `POLARITY` block, including which values are
orthogonal rather than ranked.

---

## Alternatives considered

**Keep `businessKey`, define it as a normalized email.** Rejected. Emails are
shared between owner and business, reassigned when staff leave, and changed on
rebrand. It would have produced silent cross-business data leakage the first time
two salons shared an owner's Gmail address — the worst possible failure, because
it looks like success.

**Keep both identifiers, `businessKey` for lookup and `businessId` for storage.**
Rejected. Two identifiers means a rule about which is authoritative, and that
rule would be applied inconsistently across fourteen engines. Cheaper to have one.

**Make `businessId` a deterministic hash of strong signals (GBP id, domain).**
Tempting, because it would make identity reproducible without a store. Rejected:
strong signals are absent for most businesses today, and a business that later
acquires a GBP id would get a *different* id than the one it already had.
Identity must survive the acquisition of better evidence.

**Let the BIR own current lifecycle state.** Rejected. A BIR is generated per
assessment; current state changes between assessments. Ownership would have meant
the state is only as current as the last report.

**Fold identity resolution into the Business Intelligence Engine.** Rejected as
above — it would have made the "reads raw answers" chokepoint also the identity
authority, and the two have different lifetimes.

**Rename `CAPACITY_HEADROOM_BANDS.none` instead.** Rejected: that vocabulary is
older, referenced in more documents, and "none" is genuinely correct there
(*no headroom*). The newer, less-referenced enum moves.

---

## Consequences

**Good**

- One identity, one theory, one authority per fact.
- Linking may be automatic where it is safe; merging cannot be, anywhere.
- Historical events are never rewritten — attachment is recorded as a new
  `identity.linked` event, so history stays immutable.
- Polarity collisions are now documented and testable rather than latent.

**Costs**

- Two schema version bumps before anything is built, plus permanent v1 handling.
- Every engine must carry both `businessId` and `birId`.
- Pre-identity events carry a null `businessId`, so consumers must handle it
  rather than assuming presence.
- A fourteenth engine to specify and eventually build.

**Accepted risk**

Identity resolution will be *weak in practice* until stronger signals are
collected. Today's assessment yields at best `probable_match` — never
`unique_match` — so **no auto-linking is possible at all**. Early operation will
route more work to human review than steady state. That is the correct failure
mode: loud, visible, and reversible, rather than a confident wrong merge.

---

## Migration implications

Nothing is stored yet, so this is a forward-looking path, not a data migration.

| Artifact | Path |
|---|---|
| BIR v1 with `businessKey` | `identityStatus = legacy_unresolved`; copy to `legacyBusinessKey`; leave `businessId` null; resolve from the source submission's signals |
| Submission before `businessId` existed | Treat as an inbound signal set; `submissionId` is the immutable join key |
| Assessment known only by session | `assessmentSessionId` carries the thread; stays `resolution_pending` if no contact signal exists |
| Unresolved duplicates | `merge_required`; emit `business.merge_requested`; both records stay independently readable |

Statuses: `legacy_unresolved`, `resolution_pending`, `linked`,
`manually_verified`, `merge_required`, `rejected_match`.

Prohibitions during migration: never reinterpret a `legacyBusinessKey` as a
`businessId`; never derive an id from email, phone, or name; never auto-merge at
any confidence; never rewrite a historical event to insert an id; never delete a
legacy artifact that failed to resolve.

---

## Unresolved questions

1. **Where do records live?** No store exists. Append-only history, supersession,
   and merge auditing all assume durable storage with strong ordering.
2. **When is a `businessId` minted?** On first `no_match`, or only once a human
   confirms? Minting eagerly risks duplicate records; minting lazily leaves
   assessments unattached. Current lean: mint on `no_match` and rely on merge to
   reconcile, since merge is owner-approved anyway.
3. **Franchise identity.** Is a franchise unit one business or a child of the
   franchisor? The relationship schema supports both; the identity rule does not
   say which is correct.
4. **Merge approval surface.** Merges require owner approval and no approval UI
   exists.
5. **Server-side retention.** Categories exist; durations do not.
6. **Legal basis for transactional communications.** Documented in
   AUTOMATION_POLICY.md §10 and explicitly pending professional review.
