# Data retention and redaction

> **This document describes technical behaviour. It is not legal advice and it
> makes no claim that any statute, regulation, or standard is satisfied.**
>
> **Pending professional review.** Retention periods, the deletion workflow,
> the legal-hold rule, and the medical/dental restriction below are engineering
> proposals written to be conservative. Counsel must review them, and may
> change any of them, before this platform holds real personal data at scale.

---

## 1. Why redaction and not deletion

The Business Record is append-only on purpose. `timeline_events` and
`audit_events` refuse `UPDATE` and `DELETE` at the database via trigger;
`assessment_submissions` refuses `DELETE`. That is what makes the history
trustworthy.

It also means the obvious implementation of an erasure request — delete the
rows — is impossible, and would be undesirable even if it were possible:

- Deleting a `business_record` fails anyway. `on delete set null` would null
  `business_id` on linked submissions while `identity_status` stays `linked`,
  violating `assessment_submissions_identity_consistency`.
- Deleting the timeline would destroy the record of what consent was given and
  when — the very evidence that shows the data was collected properly.

So erasure means **destroying the direct identifiers while preserving the
structural record**. `redact_business_pii()` (migration 0003) does exactly
that, reports precisely what it changed, and writes an audit event.

**Anonymisation has limits, and we do not pretend otherwise.** A redacted
record retains an assessment shape, a vertical, a timestamp, a campaign
attribution, and a set of operational answers. For a sufficiently distinctive
business, that combination may still be identifying to someone who already
knows the market. Redaction reduces identifiability; it does not guarantee
anonymity. Anyone told otherwise has been misinformed.

---

## 2. Retention by category

Periods are proposals. None is enforced automatically today except the two
noted as implemented.

| Category | Where | Proposed retention | Status |
|---|---|---|---|
| Raw assessment payload | `assessment_submissions.raw_payload` | 24 months from `received_at`, then redact contact fields in place | **not enforced** |
| Derived BIR | `business_intelligence_reports.report` | Retained for the life of the Business Record; superseded reports kept as history | **not enforced** |
| Identity evidence | `business_identifiers` | Retained while `valid_to is null`; closed rows kept 24 months, then value destroyed | **not enforced** |
| Idempotency keys | `idempotency_records` | `CED_IDEMPOTENCY_RETENTION_DAYS`, default 30 | **implemented** (`purge_expired_idempotency_records`, not scheduled) |
| Rate-limit buckets | `rate_limit_buckets` | Two window lengths | **implemented** (probabilistic sweep + `purge_expired_rate_limit_buckets`) |
| Audit events | `audit_events` | 7 years — the record of who changed what and why | permanent by design |
| Consent records | `assessment_submissions.consent_snapshot`, BIR `lifecycle.consentState` | Retained as long as any record of the business exists, **and beyond a redaction** | permanent by design |
| Timeline skeleton | `timeline_events` | Permanent | permanent by design |
| Browser-local queue | visitor's `localStorage` | 30 days, delivered entries removed immediately | **implemented** |
| Browser-local saved assessment | visitor's `localStorage` | Until the visitor clears it | `clearSavedAssessmentData()` |

**Consent records survive redaction deliberately.** They record the exact
wording shown and the moment it was agreed to. Destroying them would remove
the only proof that the data was collected with permission — which harms the
person the redaction is meant to protect as much as it harms us. They contain
no contact details.

---

## 3. What redaction changes

`redact_business_pii(p_business_id, p_reason, p_actor, p_actor_type)` requires
a reason of at least 8 characters and a named actor. It refuses otherwise.

**Destroyed**

| Surface | Change |
|---|---|
| `business_records.display_name` | replaced with `[redacted]` (the column is `NOT NULL`) |
| `business_records.legal_name` | set to `null` |
| `assessment_submissions.raw_payload.contact.*` | every value replaced, except `preferredContact` |
| `assessment_submissions.raw_payload.answers.*` | the identity answers only: `salonName`, `ownerName`, `email`, `mobile`, `businessName`, `website`, `googlePlaceId`, `externalCustomerId`, `businessPhone` |
| `business_identifiers` (PII types) | `raw_value` nulled, `normalized_value` replaced with a unique meaningless token, `verified` cleared, row closed via `valid_to` |
| `business_intelligence_reports.report.businessProfile.displayName` | replaced with `[redacted]` |

**Preserved**

- The permanent `businessId` — opaque, never derived from contact data.
- Every score, band, estimate, rationale, and package recommendation. The
  operational answers that drive scoring are untouched, so nothing about the
  analysis changes.
- The full timeline and audit history.
- Consent records.
- Campaign attribution.

### The one intelligence field that changes

`businessProfile.displayName` is direct PII sitting inside a BIR. It is
redacted, and that redaction is **declared**: the return value reports
`birDisplayName`, and the audit event records
`reportsDisplayNameRedacted`. Nothing else in the report is altered. This is
the deliberate boundary of the rule "do not silently rewrite historical
business intelligence" — the change is neither silent nor analytical.

### The invariant this depends on

**Timeline and audit payloads must never carry contact data.** Both tables
refuse `UPDATE`, so anything personal that reaches them can never be removed.
Today their payloads hold identifiers, statuses, counts, and bands only, and a
test asserts it.

> Any new timeline or audit event must be checked against this rule before it
> ships. Adding a name or an email to an event payload creates data that
> cannot be erased by any mechanism in this system.

### Attribution

Campaign attribution (`url`, `referrer`, UTMs) is retained, because it is how
a QR card gets credit weeks later. **A URL can in principle carry personal
data in a query parameter.** No current campaign link does. If one ever
might, attribution must be added to the redaction set — flagged here rather
than quietly assumed safe.

---

## 4. Deletion and export requests

No self-service surface exists. The workflow below is manual and must be
followed by a named person.

1. **Receive and log** the request through a channel that records who asked
   and when.
2. **Verify the requester** controls the business. An unverified erasure
   request is itself an attack: acting on it destroys someone else's records.
   Verification method and evidence are recorded in the reason string.
3. **Check for a legal hold** (§5). If one applies, do not redact; record the
   decision and inform the requester of the basis.
4. **Locate the `businessId`.** Never act on an email address alone.
5. **Export first, if requested.** Assemble the submissions, BIRs, timeline,
   and consent records for that `businessId` and deliver them through a
   channel the requester has been verified on.
6. **Run `redact_business_pii`** with a reason naming the request and the
   verification performed, and an actor identifying the operator.
7. **Record the returned summary.** It states what was redacted and what
   remains.
8. **Propagate to external systems separately.** This function does **not**
   touch the payment processor, CRM, email provider, or any other external
   system. Each has its own deletion process and each must be done explicitly.
9. **Confirm to the requester**, describing accurately what was removed and
   what was retained and why.

Both purge functions and the redaction function are **maintenance-role only**;
execute is revoked from `public`, `anon`, and `authenticated`. Neither the
browser nor any anonymous caller can invoke them.

---

## 5. Legal hold

Redaction must **not** run where the records are subject to a preservation
obligation — active or reasonably anticipated litigation, a regulatory
inquiry, a payment dispute or chargeback, or a tax or accounting retention
requirement.

There is **no legal-hold flag implemented.** Until there is, the hold check is
a manual step in the workflow above, performed by the operator before running
the function. A `legal_hold` column on `business_records`, checked inside
`redact_business_pii`, is the obvious next step and is not in this milestone.

---

## 6. Medical and dental restriction

The platform roadmap includes a medical/dental vertical family. Those
verticals are subject to obligations this architecture has not been designed
for.

Until counsel has reviewed and a specific design exists:

- **No medical or dental vertical may launch on this ingestion path.**
- No assessment question may collect health information, patient details,
  treatment history, diagnosis, or anything that could constitute protected
  health information.
- The prohibited-data policy already rejects such fields at the endpoint by
  name pattern, and that pattern **must not be weakened to make a field pass**.
  A vertical that appears to need such a field needs a different design.
- This restriction is a design constraint, not a claim about which laws apply.

---

## 7. Never stored or transmitted, anywhere

Payment details, card numbers, bank or routing numbers, passwords, API keys,
tokens, other credentials, government identifiers, or sensitive health
information.

This is enforced rather than documented: the assessment engine strips matching
fields client-side, and the endpoint rejects a payload containing them with
**422 `prohibited_data`** before anything is written. The challenge token is
caught by the same rule, which is why it is lifted out of the payload before
validation and never persisted.

---

## 8. What is still missing

1. **No automated retention enforcement** for payloads, BIRs, or identity
   evidence. Every period in §2 marked "not enforced" is a policy statement
   with no job behind it.
2. **No legal-hold mechanism** (§5).
3. **No export tooling.** Step 5 above is currently a hand-written query.
4. **No self-service deletion path** for the business owner.
5. **No scheduled maintenance job** for the implemented purge functions.
6. **No counsel review.** Everything here is pending it.
