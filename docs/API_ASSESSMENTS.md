# `POST /api/assessments`

Capture endpoint for completed assessments. Public and unauthenticated by
necessity — it accepts submissions from business owners who have no account —
and defended in layers rather than by a credential.

Implementation: [api/assessments.mjs](../api/assessments.mjs).
Threat model and rationale: [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md).

---

## Request

| | |
|---|---|
| Methods | `POST`, `OPTIONS`. Anything else → **405** with `Allow: POST, OPTIONS` |
| Content-Type | `application/json` required → otherwise **415** |
| Max body | `CED_MAX_REQUEST_BYTES` (default 65536), enforced by counting bytes as they arrive → **413** |
| `Idempotency-Key` | **required**, and must equal `payload.submissionId` |
| `Origin` | **required** and must be listed in `CED_ALLOWED_ORIGINS` → otherwise **403** |
| `X-CED-Challenge` | optional alternative to `integrity.challengeToken` |

`Origin` is required. A request without one is refused: this endpoint serves
browsers only. Server-to-server ingestion needs its own authenticated route,
which does not exist yet.

### Example

```http
POST /api/assessments HTTP/1.1
Host: nails.cedservice.com
Content-Type: application/json
Origin: https://nails.cedservice.com
Idempotency-Key: 22222222-2222-4222-8222-222222222222
```

```json
{
  "schemaVersion": 3,
  "assessmentVersion": "1.1.0",
  "assessmentSessionId": "11111111-1111-4111-8111-111111111111",
  "submissionId": "22222222-2222-4222-8222-222222222222",
  "vertical": { "id": "nails", "name": "Nail Salons" },
  "submittedAt": "2026-08-04T12:00:00.000Z",
  "integrity": {
    "honeypotFilled": false,
    "challengeToken": "0.abcdef…"
  },
  "attribution": {
    "firstTouch": {
      "url": "https://nails.cedservice.com/?utm_source=qr_card",
      "referrer": "https://qr.example/",
      "utm": { "utm_source": "qr_card" },
      "occurredAt": "2026-07-28T14:02:11.004Z"
    },
    "latestTouch": {
      "url": "https://nails.cedservice.com/", "referrer": null,
      "utm": {}, "occurredAt": "2026-08-04T12:00:00.000Z"
    }
  },
  "contact": {
    "salonName": "Polished Nail Studio", "ownerName": "Test Owner",
    "email": "owner@polished.test", "mobile": "", "preferredContact": "email"
  },
  "consent": {
    "resultsDeliveryConsent": {
      "field": "consentResults", "granted": true, "available": true,
      "statement": "Send my assessment results and directly related follow-up to the email address above. This is required to deliver your results.",
      "recordedAt": "2026-08-04T12:00:00.000Z"
    },
    "emailMarketingConsent": { "granted": false, "available": true, "statement": "…", "recordedAt": "…" },
    "smsMarketingConsent":   { "granted": false, "available": false, "statement": "…", "recordedAt": "…" }
  },
  "answers": { "technicians": "3", "averageTicket": "50", "daysOpen": "24", "…": "24 fields" },
  "results": {
    "opportunity": 1679.7, "opportunityFormatted": "$1,680", "score": 26,
    "dimensions": { "missedOpportunity": 28, "appointmentProtection": 24, "retention": 22, "reputation": 30, "marketing": 30 },
    "priorities": ["Recover missed calls and inquiries automatically.", "…", "…"],
    "recommendedPackage": { "id": "salon-growth", "label": "Salon Growth — $597/month", "price": 597, "currency": "USD", "interval": "month" },
    "disclaimer": "This is a preliminary estimate based on your answers and is not a guarantee of revenue or results."
  }
}
```

### The `integrity` envelope

Introduced in schema 3.

- `honeypotFilled` — a boolean. The trap's **value is never transmitted**, so
  it cannot become a channel for smuggling data into storage. The trap field
  is named `contactFax`, deliberately not `website`, which the identity
  roadmap will use for a real business website.
- `challengeToken` — a short-lived credential. It is **removed from the
  payload before validation, hashing, or any database call** and replaced with
  `challengePresented: true`. It is never stored, never logged, and never
  returned.

Schema 2 payloads have no envelope and are accepted during the migration
window (see [Version compatibility](#version-compatibility)).

---

## Responses

Every response carries `X-Correlation-Id`. Successful bodies include
`correlationId`; error bodies include `error.correlationId`.

### 201 — stored

```json
{
  "ok": true,
  "replayed": false,
  "submissionId": "22222222-2222-4222-8222-222222222222",
  "assessmentSessionId": "11111111-1111-4111-8111-111111111111",
  "businessId": "44444444-4444-4444-8444-444444444444",
  "assessmentId": "22222222-2222-4222-8222-222222222222",
  "birId": "33333333-3333-4333-8333-333333333333",
  "supersedesBirId": null,
  "identityStatus": "linked",
  "payloadSchemaVersion": 3,
  "clockSkewDetected": false,
  "timelineEventIds": ["…×5"],
  "receivedAt": "2026-08-04T12:00:05.000Z",
  "nextAction": "results_ready",
  "correlationId": "…"
}
```

`supersedesBirId` names the business's previous current BIR, or `null` for the
first. `clockSkewDetected` is true when the device clock was more than a
second ahead of the server.

### 200 — replay

Identical body with `"replayed": true` and the **original** identifiers.
Nothing new is created, including no second link in the BIR chain.

### 201 — identity needs a human

```json
{
  "ok": true, "replayed": false,
  "businessId": null,
  "identityStatus": "resolution_pending",
  "supersedesBirId": null,
  "nextAction": "identity_review_pending",
  "…": "…"
}
```

The submission and its BIR are stored; no second Business Record is created; a
resolution case is opened. **This is a success, not an error** — the visitor's
results are unaffected.

### Errors

```json
{
  "ok": false,
  "error": {
    "code": "results_consent_required",
    "message": "resultsDeliveryConsent.granted must be true.",
    "correlationId": "…",
    "retryAfterSeconds": 60
  }
}
```

| Status | Codes |
|---|---|
| 400 | `malformed_json`, `invalid_body`, `invalid_encoding`, `body_read_failed`, `unsupported_version`, `invalid_assessment_version`, `invalid_submission_id`, `invalid_session_id`, `missing_section`, `unsupported_vertical`, `invalid_submitted_at`, `submitted_at_in_future`, `submitted_at_too_old`, `invalid_contact_email`, `invalid_score`, `invalid_opportunity`, `invalid_dimensions`, `invalid_dimension_value`, `invalid_priorities`, `missing_disclaimer`, `invalid_package`, `invalid_package_price`, `missing_idempotency_key`, `challenge_invalid` |
| 403 | `origin_required`, `origin_not_allowed`, `challenge_rejected` |
| 405 | `method_not_allowed` |
| 409 | `idempotency_key_mismatch`, `idempotency_key_conflict`, `request_in_flight` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `results_consent_required`, `consent_statement_missing`, `prohibited_data`, `payload_limit_exceeded` |
| 429 | `rate_limited` |
| 500 | `bir_generation_failed`, `internal_error` |
| 502 | `ingestion_failed` |
| 503 | `not_configured`, `challenge_unavailable` |
| 504 | `ingestion_timeout` |

`payload_limit_exceeded` includes `error.details.violations[]`, each naming a
`category`, `path`, `limit`, and `actual` **length**. The offending value is
never echoed back. `prohibited_data` likewise names paths only.

No response ever contains a stack trace, SQL, a credential, a challenge token,
or a database detail.

---

## Retry classification

The client decides by **structured code first**, status only as a fallback.
This matters most for 409, which carries two opposite meanings.

| Code | Status | Retry? |
|---|---|---|
| `request_in_flight` | 409 | **yes** — a concurrent holder clears |
| `idempotency_key_conflict` | 409 | **no** — the same key with different content cannot succeed |
| `rate_limited` | 429 | yes, after `Retry-After` |
| `challenge_unavailable` | 503 | yes — a provider outage is not the visitor's fault |
| `challenge_invalid` | 400 | yes — the submission becomes challenge-exempt once it ages past 15 minutes |
| `challenge_rejected` | 403 | no |
| `ingestion_failed`, `ingestion_timeout`, `not_configured` | 502/504/503 | yes |
| every validation code | 4xx | no — retained for inspection, never discarded |

`Retry-After` is sent on 429, 503, 504, 502, and 409 `request_in_flight`, and
mirrored in `error.retryAfterSeconds`. The client honours whichever is longer
and never shortens its own backoff.

---

## Version compatibility

- Current: **3**. Supported: **2 and 3**.
- When the current version moves forward, the previous stays accepted, so
  assessments queued by a page cached before the deploy are still delivered.
- Anything else → **400 `unsupported_version`** with
  `details.{received, supported, current, reason}`; `reason` is `retired`
  below the minimum, `unrecognised` above it.

---

## Semantics worth knowing

**Idempotency.** The key is the `submissionId` — immutable, never a contact
field. Same key + same body → the original response replayed. Same key +
different body → **409 `idempotency_key_conflict`**; the first write stands.
Concurrent requests on one key → **409 `request_in_flight`**; retry.

**Identity.** `businessId` is null only when `identityStatus` is
`resolution_pending`. Clients should treat null as "not yet known", never as
an error. A strong identifier links automatically **only when it is verified
and from a trusted source**; a value typed into the form is evidence, not a
decision.

**Timestamps.** `submittedAt` is the visitor's completion time and is stored
verbatim. `receivedAt` is when the server got it. The timeline records
`least(submittedAt, now())`, so a fast device clock cannot abort ingestion.

**Atomicity.** Everything the request creates happens in one transaction. A
failure mid-way leaves nothing behind — not even the idempotency claim — so
the same key can be retried cleanly. A 504 `ingestion_timeout` may still
commit afterwards; the retry collapses into a replay.

**Consent.** Only `resultsDeliveryConsent.granted === true` gates ingestion.
Marketing consents are recorded, never required. The exact statement shown
must be present, so what the visitor agreed to is stored with the record.

**Client behaviour.** The assessment engine retries with exponential backoff
and reuses one `submissionId` across attempts, so a transient failure is
delivered later under the same key and collapses into one record.
