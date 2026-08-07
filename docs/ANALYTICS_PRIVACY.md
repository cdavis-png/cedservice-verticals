# Analytics data boundaries

What analytics may hold, what it may never hold, and how that is enforced
rather than merely intended.

> **No claim of legal compliance is made here or anywhere in this repository.**
> This document describes engineering decisions. The consent model below is a
> mechanism, not a legal position, and every item in §6 is **pending
> professional review**.

---

## 1. Three kinds of analytics

The distinction that matters, stated plainly, because "analytics" is used to
mean all three and they carry very different obligations.

| | What it is | Do we do it? |
|---|---|---|
| **Functional** | The platform cannot do what the visitor asked without it. Saving their progress so they can pause and return is functional. | **One event.** `assessment.clear_saved_data`, so an erasure is auditable. |
| **Product** | First-party, pseudonymous observation of our own product, to find where people get stuck. Never shared, never sold, never joined to an advertising identifier. | **Yes — this is the whole milestone.** 18 of the 19 events. |
| **Marketing** | Attributing a visitor to a campaign in order to *target* them, or sending anything to an advertising platform. | **No. Not built, and no third-party SDK is loaded anywhere.** |

Every event carries a `reviewType` — `growth_review` or `service_mix` — so the
two funnels are separable. The classification above applies identically to
both: a second review type widened what is measured, and widened nothing about
what may be carried.

The campaign fields analytics carries (`utm_source` and friends) are **product**
data here: they answer "does the QR card convert better than the one-pager?"
for our own reporting. They are not passed to any ad platform, and there is no
code path that could.

Each event declares its category. The client drops any event whose category
exceeds the permission in force, and `product_allowed` never implies
`marketing_allowed` — asserted by a test.

---

## 2. What is excluded, deliberately

None of this can reach an analytics row:

| Excluded | Why |
|---|---|
| Names — salon, owner, anyone | Identifies a person or a business. |
| Email addresses | Same, and a join key to everything else. |
| Phone numbers, mobile or business | Same. |
| Free-text answers | `changeReason`, `concernDetail`, `openQuestions`. A visitor typing "we were burned by X in 2023" has told us something in confidence, in a system with consent and retention rules. Analytics has neither. |
| Full URLs | A query string can carry a token, an email, or a one-time link. Reduced to a **path**. |
| Referrer paths | `mail.example.com/inbox/message/123` names what someone clicked from. Reduced to a **host**. |
| Challenge tokens | A short-lived credential. |
| Consent statement text | It is evidence, and evidence belongs in the consent record where it can be produced. |
| Payment or bank details | Never collected anywhere in this platform. |
| Health data | Never collected. Named here because medical/dental is a planned vertical family. |
| User agent strings | High entropy, fingerprints, and answers no question we are asking. |
| Exact viewport pixels | A surprisingly strong fingerprint. Bucketed to 40px. |
| IP addresses | Never stored. Rate limiting uses a keyed HMAC, and the key lives only in the function environment. |

### Sensitive business facts

Budget signal, decision authority, objections, urgency, timing — all **excluded
from analytics**, though the platform does collect them.

They live in the Business Record under its consent and retention rules.
Copying them into a funnel would create a second, weaker copy of the sales
intelligence with a different lifetime and no owner. If a question needs those
answers, it is a Business Record question, not an analytics one.

### The Quick Service Mix Review's commercial figures

Added with SM-1, and excluded for the same reason. What a business charges,
how long it takes, how many it sells, and what that earns are the entire
substance of the review:

| Excluded | Why |
|---|---|
| Offering names | "Bridal party gel set" names what a salon does and, with a vertical and a locality, starts to name the salon. |
| `offeringId`, `offeringSnapshotId`, `replacesOfferingId` | Opaque, but the offering id is **stable across submissions by design** — which makes it a join key between a funnel and a Business Record. The absence of any such key is what keeps the two apart. |
| Selling price, direct cost | Commercially sensitive, and the basis of everything the review concludes. |
| Monthly volume, appointment duration, capacity hours | The same fact in a different unit. |
| Monthly revenue, revenue per hour, shares of either | Derived from all of the above, and no less sensitive for being derived. |

What analytics **is** told about an offering, and all it is told:
`offeringSource` (starter or custom) and `offeringCountBand` — a band, not a
count, because two to five is a small range and an exact count plus a vertical
plus a timestamp starts to identify a session.

Enforcement is both tokenised and named outright. `offering` cannot be a
prohibited **token**: `offeringCountBand` and `offeringSource` are exactly what
analytics is permitted to know, and prohibiting the word would refuse them
along with the identifiers. So the identifiers are named, and the commercial
words — `price`, `cost`, `revenue`, `volume`, `duration`, `hours`, `minutes`,
`margin`, `contribution`, `ticket`, `earnings` — are tokens.

---

## 3. How the exclusion is enforced

Three layers, because a rule that lives only in a comment is a rule that lasts
until the next contributor.

**1. Token matching on field names**, at any depth, in both the client and the
endpoint.

Field names are split into words and compared whole. A substring test looks
simpler and is wrong in both directions — `capacity90Day` contains "city" and
was refused by the first implementation, which is exactly the bug this
approach prevents:

```
ownerName     → owner, name     → refused
capacity90Day → capacity, 90, day → allowed
utm_source    → utm, source     → allowed
SSN           → ssn             → refused
```

**2. An explicit name list** for fields no token rule can catch. `openQuestions`
tokenizes to *open* + *questions*, and "question" cannot be prohibited because
`questionId` and `visibleQuestionCount` are legitimate. It is named outright.
A test asserts that every field in `limits.js :: FREE_TEXT_ANSWERS` is refused,
so a vertical adding a new "in your own words" box fails the build until
analytics is told about it.

**2b. Every close-related answer is prohibited as a field name**, derived from
`intelligence.js :: ALL_FIELDS` rather than copied, so a vertical adding a new
close-related question gets it excluded from analytics automatically.

`questionId: "budgetSignal"` stays legal — it names *which question* was
answered, which is what a funnel needs. `metadata: { budgetSignal: "budgeted" }`
does not, because that is the answer.

> Real-Postgres validation on 2026-08-05 found this section describing a
> protection the code did not have. `budgetSignal`, `canApprove`,
> `primaryConcern`, `urgency`, `referrerPath` and `userAgent` were all
> documented as excluded and all travelled. They are enforced now, and a
> regression test asserts every claim on this page against the implementation.

**3. An allowlist for answer values**, which is empty by default in spirit and
tiny in practice.

`question_answered` records *that* a question was answered, *which* one, and
how long it took — never what was said. Two exceptions:

| Field | Why |
|---|---|
| `locationCount` | Decides the multi-location branch. "40% abandon at step 11" means one thing for single-site salons and another for multi-site ones. |
| `capacity90Day` | Decides the clamp path, and the visitor sees a materially different figure either way. |

Both are coarse buckets with no commercial sensitivity. **The allowlist can
widen what is kept; it can never override the prohibition** — a test adds
`ownerName` to the allowlist and asserts it is still refused.

### Enforced twice, on purpose

The client scrubs before queuing and the endpoint scrubs again before storing.
The browser copy is a courtesy to the network. The server copy is the boundary,
because the browser can be tampered with and a request can be forged.

A batch whose **envelope** is shaped like a contact record is refused whole
rather than trimmed — a deliberate attempt should be visible, not quietly
tidied.

---

## 4. Pseudonymous identifiers

Analytics reuses identifiers the assessment already produced. It mints none and
resolves none.

| Identifier | Where it comes from |
|---|---|
| `assessmentSessionId` | Minted by the engine per assessment per device. The key for everything here. |
| `submissionId` | Learned after a stage is submitted. |
| `businessId` | Learned from the capture endpoint's response. **Analytics never performs identity resolution.** |

`business_id` and `submission_id` are stored as plain UUIDs with **no foreign
key** to the Business Record. That is deliberate: analytics must never be able
to block or cascade a deletion of a record holding a real person's data, and
Business Record redaction must not require walking an analytics table.

---

## 5. Retention

| Data | Kept | Rationale |
|---|---|---|
| Raw events | 400 days, then deleted | Long enough for a full year of seasonality plus a margin. |
| Session summaries | 400 days, then deleted | Same window. |
| Daily aggregates | **Indefinitely** | Counters with no session identifier and no path to a person. This is the long-lived record. |

**Order matters.** `refresh_assessment_funnel_daily` must run before
`purge_expired_analytics_events` for any day about to expire. Once the events
are gone, that day can never be recomputed.

Raw analytics rows **can** be deleted, unlike `timeline_events` and
`audit_events`, which refuse `DELETE` entirely. That difference is the point:
the timeline holds evidence, and analytics holds measurements.

`window.CEDAssessment.clearSavedAssessmentData()` clears the analytics queue on
the device as well as the saved assessment. It does **not** delete rows already
sent — a device-side control cannot reach the server, and pretending otherwise
would be worse than saying so.

---

## 6. Pending professional review

Every item below is an open question, not a settled position.

1. **Is a consent control needed before this runs at all?** The current default
   is `product_allowed`: first-party, pseudonymous, no vendor, no sharing. That
   is the mechanism's default, not an assertion that it is lawful.
2. **Where would an analytics consent control go?** The assessment's three
   existing consents cover results delivery and marketing messages. Analytics
   is neither, and bolting it on would violate the rule that consents are never
   bundled.
3. **Is campaign attribution product or marketing** where the visitor never
   consented to marketing? It is used only for our own reporting today, which
   is why it is classified as product.
4. **Does an inferred `assessment.abandoned` event need disclosure?** It is a
   guess about behaviour, recorded as a guess.
5. **Retention period.** 400 days is an engineering choice, not a reviewed one.
6. **Does a redaction request need to reach analytics?** Today it does not:
   there is nothing personal to redact and no foreign key to follow. If a
   reviewer disagrees, the session summary is the surface to change, since it
   is the only mutable analytics table.

Until these are answered, analytics should run **in a private pilot only** —
see [ASSESSMENT_ANALYTICS.md](ASSESSMENT_ANALYTICS.md), "Before a pilot".

---

## 7. What the database does and does not enforce

Worth stating plainly, because the layers are not equal.

**The endpoint is the privacy boundary.** `api/analytics.mjs` validates every
event, refuses prohibited field names, scrubs metadata, re-buckets viewport
dimensions, and rebuilds attribution from scratch. Nothing personal gets past
it.

**The database is not.** `ingest_analytics_events` stores the jsonb it is
given. A caller holding the service role could write personal data into
`metadata` directly, and Postgres would accept it.

That is a deliberate division rather than an oversight: the service-role key
exists only in the Vercel Function environment, and the only code there that
reaches this function is the endpoint that scrubs. Adding a CHECK constraint on
jsonb keys was considered and rejected — it would need an immutable helper,
would reject legitimate future fields, and would duplicate a rule that already
exists in one place.

The consequence to know: **a future server-to-server writer must repeat the
endpoint's scrubbing.** It cannot rely on the database to catch it. Verified
against real Postgres on 2026-08-05.
