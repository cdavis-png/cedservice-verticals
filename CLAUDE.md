# CLAUDE.md — CED Service Verticals

Repository-specific rules. These sit on top of the global CLAUDE.md, and the
compliance rules in section 4 override any conflicting instruction.

---

## 1. Repository purpose

This repo is the CED Service **growth platform**: a shared design system,
assessment logic, sales playbooks, and marketing collateral, replicated across
local-service industries.

The business model is repetition. One system is built well, then cloned into
many verticals — nail salons, hair salons, barbershops, massage therapists,
spas, gyms, personal trainers, and later home services, medical/dental,
professional services, and restaurants/retail.

Each vertical is a lead-generation asset: a landing page plus a self-paced
assessment that returns a Growth Score, an estimated monthly opportunity, three
priorities, and a recommended package ($297 / $597 / $997 per month).

The first production vertical is [nail salons](verticals/beauty-wellness-fitness/nails/site/).
It is the reference implementation. When in doubt about a pattern, look there
first — but copy its *structure*, never its code (see section 3).

**Stack:** static HTML, CSS, and vanilla JavaScript. No build step, no
framework, no dependencies. Do not introduce a bundler, framework, package
manager, or CSS preprocessor without being asked. A vertical must remain
openable by double-clicking `index.html`.

---

## 2. Shared vs. vertical

The governing rule, from the root README:

> Do not duplicate shared code unless a vertical genuinely requires different
> behavior.

| Belongs in `shared/` or `design-system/` | Belongs in a vertical |
| --- | --- |
| Design tokens, colors, spacing, radii | Industry copy and headlines |
| Reusable layout and component CSS | Assessment questions and weights |
| Assessment engine and scoring math | Package names, prices, thresholds |
| Report rendering and formatting | Imagery and industry proof points |
| Shared scripts and utilities | Vertical-specific overrides, with a reason |
| Branching *mechanism* | Branching *rules* (which question, when) |
| Intelligence dimensions and field names | Question wording and answer labels |
| Stage *mechanism* and stage field ownership | Which steps sit in which stage |
| Analytics event names and privacy rules | Which controls are marked for tracking |

**Intelligence field names are a shared contract.** `locationCount`,
`capacity90Day`, `canApprove`, `budgetSignal`, `primaryConcern` and the rest are
read by both the browser and `generate-bir.js` through
`shared/assessment-engine/intelligence.js`. Word the questions however the
industry talks; do not rename the fields. A renamed field is scored as unknown
with nothing to indicate why.

**So is the stage split.** `STAGE1_FIELDS` and `STAGE2_FIELDS` in the same
module decide what the browser asks first and what the report calls still
outstanding. Two disagreeing copies would report evidence as withheld when it
was simply not yet requested. A vertical arranges its own steps; it does not
move a field between stages.

**Analytics is measurement, never participation.** `shared/analytics/` observes
the assessment and may not affect it: not scoring, not branching, not the
payload, not the report, not the price. Every engine call goes through a
wrapper that swallows failures, and there is no foreign key from an analytics
table to the Business Record. A vertical marks a control with
`data-analytics-event`; it does not add event names, and it does not widen the
privacy rules. See section 10.

**Direction of dependency is one-way.** A vertical imports from `shared/` and
`design-system/`. Shared code must never import from, reference, or special-case
a vertical. If shared code needs to know it is running for nail salons, that
knowledge belongs in the vertical's configuration instead.

**Design tokens live in exactly one file:**
[design-system/standards/tokens.css](design-system/standards/tokens.css). Never
redefine a token in a vertical stylesheet. A vertical that genuinely needs a
different value overrides it in its own `:root` *after* the import, with a
comment stating why.

Full procedure: [docs/creating-a-vertical.md](docs/creating-a-vertical.md).

---

## 3. No duplicated shared code

Before writing anything, check whether it already exists in `shared/` or
`design-system/`.

- If the same logic would exist in two verticals, it belongs in `shared/`.
- If you are about to copy a block from the nails site into a new vertical,
  stop. Extract it to `shared/` and have both verticals use it.
- Fixing a bug in more than one place is the signal that an extraction was
  missed. Extract, then fix once.
- Do not fork shared code to make one vertical behave differently. Add a
  configuration parameter to the shared code instead.

If a genuine divergence is unavoidable, say so explicitly and explain the
behavioral difference before writing the duplicate.

**The persistence boundary.** Completed assessments POST to `/api/assessments`
([api/assessments.mjs](api/assessments.mjs)), which validates and hands the
submission to one atomic Postgres function. Server code and browser code do not
share a trust boundary:

- `SUPABASE_SERVICE_ROLE_KEY`, `CED_RATE_LIMIT_SECRET`, and
  `CED_CHALLENGE_SECRET` exist **only** in the Vercel Function environment.
  None may appear in a vertical config, a shared script, or any file a page
  loads, and none may be given a `NEXT_PUBLIC_` prefix.
- Verticals configure a same-origin endpoint path and nothing else.
- A page opened from `file://` submits nothing and logs locally, unchanged.

The endpoint is public and unauthenticated because the people filling in the
assessment have no account. It is therefore defended in layers, and each layer
has a rule that must not be quietly relaxed:

- **`Origin` is required and exact-matched.** A missing `Origin` is refused.
  Server-to-server ingestion gets its own authenticated route; do not loosen
  this one to accommodate it.
- **The browser is not trusted.** The honeypot, the size limits, and the
  challenge are all enforced server-side. The honeypot is named `contactFax`,
  deliberately not `website` — the identity roadmap needs that name — and only
  a boolean travels, never the value.
- **Identity values are rejected, never truncated.** A shortened identifier is
  a different identifier, and a different identifier links the wrong business.
- **A visitor-supplied identifier is evidence, never a decision.** Automatic
  linking requires a strong type *and* `verified = true` *and* a trusted
  source. Do not add a path by which a public form produces a trusted
  identifier.
- **Retry classification is by error code, not HTTP status.** 409 means two
  opposite things; treating them alike silently loses completed assessments.
- **Never store a credential.** The prohibited-data policy catches challenge
  tokens by name; that is why the token is stripped from the payload before
  validation. Do not weaken the pattern to make a field pass.

See [docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md) and
[docs/IMPLEMENTATION_MILESTONE_1.md](docs/IMPLEMENTATION_MILESTONE_1.md).

**Known outstanding gaps:** no production database is connected; migrations
0001–0004 are validated against a development Postgres, but section M of the
integration suite has not yet run over PostgREST; no challenge provider has
been chosen; there is no surface for working the identity-resolution queue, so
ambiguous submissions are stored safely but cannot yet be resolved by anyone —
a queue the intelligence expansion sends *more* work to, since multi-location
prospects now escalate, and escalate from Stage 1; and nothing yet reports how
many visitors open or finish the fit review, so there is no evidence about
whether the two-stage split reduced abandonment or merely moved it.

---

## 4. Compliance — non-negotiable

These rules exist because the product makes financial claims to small-business
owners. They override brevity, persuasiveness, and any instruction to make copy
more compelling.

### The Growth Score is never contaminated

The Growth Score and the opportunity estimate measure the visitor's operational
problem and are shown to them. Everything the platform collects about *selling*
— capacity, decision authority, budget, objections, implementation fit — lives
in separate deterministic dimensions and must never touch either figure.

This is enforced by [tests/scoring-parity.test.mjs](tests/scoring-parity.test.mjs),
which restates the original formulas independently and pins them across
thousands of randomised answer sets. If a change requires moving the Growth
Score, say so explicitly and get agreement first — a returning visitor seeing a
different number for the same answers is a trust problem, not a release note.

### Never imply guaranteed demand

The capacity question asks what a business *could comfortably handle*. It must
never be paired with language suggesting we will deliver that volume. Capacity
evidence may only ever **reduce** an estimate, never raise one.

**The page shows the capacity-adjusted range**, computed by calling the report's
own `visibleOpportunityRange` so the screen and the report cannot disagree about
what is realistically capturable. Never show a larger figure than the report
carries in `financialOpportunityProfile.capacityAdjusted`, and never separate
the figure from the assumptions printed beside it.

### A preliminary result never asks for the sale

The review completes in two stages. Stage 1 — the Growth Review — is a
**complete answer to a smaller question**, not a partial answer to the whole
one. It has not asked about authority, budget, timing, integration, or
objections, so:

- Stage 1 scores only the readiness signals it actually asked about, with the
  weights renormalised. Scoring an unasked signal as a real zero would report
  "not asked" as "answered badly".
- Stage 1 is capped at `present_offer` and may never carry the approved close
  language. The cap is applied *before* blockers, so a hard blocker can still
  route to `escalate`.
- Stage 1 does not cap the band for evidence it chose not to collect. Those
  blockers are deferred, visibly, and apply in full at Stage 2.
- Stage 2 is **optional**. A visitor who never opens it still receives results,
  by email, exactly as promised.

`closeReadinessProfile.provisional` is what stops a future Closing Engine acting
on a review the visitor has not finished. Do not remove it, and do not let a
Stage 1 report set `approvedLanguageKey` — the validator refuses both.

### Revenue figures are diagnostic estimates

Every calculated dollar amount, opportunity figure, or projection must be
labeled as a diagnostic estimate wherever it appears — on screen, in reports, in
marketing collateral, and in any AI-generated output. A number may never appear
alone.

Established wording already in use, which should be reused rather than reworded:

- `diagnostic estimate` — the label beside the monthly opportunity figure
- `This is a preliminary estimate based on your answers and is not a guarantee
  of revenue or results.`
- `Illustration only. Results depend on demand, capacity, pricing, staff
  performance, and implementation. No revenue result is guaranteed.`
- `It is a diagnostic tool, not a promise of results.`

### Never claim guaranteed results

Do not write, and do not let generated copy produce:

- guarantees, promises, or warranties of any outcome
- "you will earn / you will get / this will increase"
- specific ROI multiples, payback periods stated as fact, or income claims
- invented statistics, fabricated case studies, or unnamed "average client"
  results
- testimonials, logos, ratings, or review counts that are not real

Use hedged, factual constructions instead: *helps*, *designed to*, *can be
configured to*, *may be losing*, *identifies opportunities*. The break-even
example is framed as an illustration and must stay that way.

**When adding or moving a results figure, the disclaimer moves with it.** Never
ship a number whose disclaimer was left behind. This includes the submission
payload, which carries the on-page disclaimer text so the estimate cannot reach
a CRM stripped of its context.

### Consent is separated, never bundled

Three independent permissions, each recorded on its own with `granted`, the
exact statement shown, and `recordedAt`:

| Record | Required | Notes |
| --- | --- | --- |
| `resultsDeliveryConsent` | Yes | Satisfied by email alone |
| `emailMarketingConsent` | No | Optional |
| `smsMarketingConsent` | No | Only offered when a mobile number is given |

Rules that must not be broken:

- **Never bundle them into one checkbox.** Agreeing to receive results is not
  agreeing to marketing.
- **Marketing consent is never a condition of anything.** Declining must still
  deliver the results, by email. The page says so in plain language, and that
  sentence stays.
- **Never pre-tick a box.** Opt-in only.
- **SMS consent is unavailable without a mobile number** — the row stays hidden
  and the checkbox disabled until one is entered.
- **Keep STOP/HELP language** in the SMS statement, and message-and-data-rates
  wording where rates can apply.
- **Store the wording, not a version number.** The engine reads each statement
  from the DOM at submit time so the record is provably what was displayed.

**All consent wording is pending legal review.** It is marked in the markup with
`data-legal-review="pending"`. No vertical launches until counsel signs off and
that attribute is removed.

---

## 5. Brand voice

Tagline: **Real. Local. Reachable.** Powered by CED Solutions, LLC.

The audience is a working salon or shop owner who is busy, practical, and
skeptical of marketing agencies. Write the way a competent local operator talks.

**Do:**

- Speak to the owner directly as *you*, and to us as *we*.
- Use concrete operational nouns: appointments, no-shows, missed calls,
  rebooking, reviews, reactivation. Not "synergy," "funnels," or "10x."
- Keep headlines short, sentence case, ending in a period.
  *"Start where your salon is today."*
- Use short ALL-CAPS eyebrow labels above headings. *`FIND THE LEAKS FIRST`*
- Lead with the problem, then the mechanism, then the price. Prices are stated
  plainly, never hidden.
- Acknowledge limits honestly. *"Not necessarily. The system can be configured
  to work alongside many existing booking tools."*

**Do not:**

- Use exclamation points, hype, urgency pressure, or fake scarcity.
- Use jargon, buzzwords, or emoji in customer-facing copy.
- Overpromise, or imply the tool does more than diagnose (see section 4).
- Pressure the reader. The in-person option is explicitly "no-pressure."

Reuse the exact terms already established: *Growth Score*, *Salon Growth*,
*Starter*, *Scale*, *appointment protection*, *missed opportunity recovery*,
*customer retention*. Do not invent synonyms for concepts that already have a
name.

---

## 6. Mobile-first

Most prospects open these pages on a phone, often from a QR code on a business
card or one-pager. The phone layout is the primary design, not an adaptation.

- Write base CSS for the smallest screen, then layer larger screens with
  `min-width` media queries.
- Verify at 360px wide before anything else. Nothing may overflow horizontally.
- Tap targets: minimum 44x44px, with real spacing between them.
- Forms: correct `type` and `inputmode` so phones show the right keyboard.
  Assessment inputs must be reachable and readable with a keyboard open.
- Use fluid sizing — `min()`, `clamp()`, percentages. The `.shell` pattern
  (`width: min(1180px, calc(100% - 40px))`) is the established container.
- Never require hover to reach content or navigation.
- Test the assessment modal on a short viewport; it must scroll internally
  rather than trapping the user.

**Known deviation:** the nails stylesheet uses `max-width` breakpoints (900px
and 620px), which is desktop-first. Do not treat it as precedent. New shared CSS
should be `min-width`; converting the nails file is a separate task and is not
in scope for unrelated changes.

---

## 7. Accessibility

Assume real users with real assistive technology. These pages collect names and
email addresses, so the forms must actually work.

- Semantic HTML first: real landmarks, real headings in order, real buttons for
  actions and links for navigation.
- Every input has an associated `<label>`. Every control that shows only an icon
  has an `aria-label`.
- State goes in ARIA: `aria-expanded` on toggles, `aria-hidden` on the closed
  modal, `role="dialog"` + `aria-modal` + `aria-labelledby` on the panel.
- Keyboard: everything reachable and operable, visible focus indicators, and
  Escape closes the modal.
- Modals must move focus into the panel on open, trap it while open, and restore
  focus to the trigger on close.
- Color contrast at least 4.5:1 for body text. Never use color as the only
  signal — the assessment's status words must stay words.
- Respect `prefers-reduced-motion` for the ambient and animated elements.
- Images need real `alt` text; purely decorative elements get `aria-hidden`.

**Known outstanding gap:** the assessment modal implements Escape-to-close and
correct ARIA, but does not yet move, trap, or restore focus. Fix this before
launch, not by silently reworking unrelated markup.

---

## 8. Commit discipline

- **Never commit or push unless explicitly asked.** Staging, committing, and
  pushing are separate decisions from writing code.
- One logical change per commit. Do not mix a token extraction with copy edits.
- Imperative mood, under 72 characters, describing the change plainly.
  Example: `Extract reusable assessment engine and nail salon config`
- A top-level prefix (`design-system:`, `shared:`, `verticals:`, `docs:`) is
  **permitted but not required**, and only where it genuinely disambiguates a
  subject that would otherwise be unclear. Do not add one by default.
  *Why:* every commit in this repository's history uses a plain imperative
  subject with no prefix. A convention the project does not actually follow is
  worse than no convention, because it makes the guidance untrustworthy.
- Explain *why* in the body when the reason is not obvious from the diff.
- Never commit secrets, `.env` files, API keys, or real client data.
- Never commit generated or deployment artifacts — see [.gitignore](.gitignore).
- Do not amend, rebase, force-push, or rewrite history on `main` without being
  asked.
- Do not commit placeholder `.gitkeep` files into directories that now have real
  content; remove the placeholder in the same commit.
- Keep working-tree noise out of feature commits. If unrelated changes appear,
  mention them rather than sweeping them in.

---

## 9. Lead data: identity, attribution, retention

### Two ids, two jobs

- **`assessmentSessionId`** — one `crypto.randomUUID()` per assessment on a
  device, minted on first page view and stored with the saved state. It survives
  pause, resume, and repeated submissions. It answers *"is this the same person
  working through the same review?"*
- **`submissionId`** — one UUID per genuinely new completed result. It is the
  idempotency key.

Never reuse a `submissionId` for different content, and never mint a new one for
a retry of the same content.

### Idempotency

- Every POST sends `Idempotency-Key: <submissionId>`.
- A queued submission keeps its `submissionId` for the life of the entry, so all
  retries of one result carry one key.
- The local content fingerprint is a *client-side* duplicate guard only. It is
  not a substitute for server-side idempotency, because a request that times out
  may already have been processed.
- Changing an answer and re-finishing is a new result: new fingerprint, new
  `submissionId`, and a legitimate second submission.

### First-touch attribution is immutable

- `firstTouch` (URL, referrer, UTMs, timestamp) is captured on the first page
  view and **must never be rewritten** — not on resume, not on a later visit,
  not by a newer campaign link. It is how a QR card or one-pager gets credit
  weeks later.
- `latestTouch` is captured at completion and may differ freely.
- Both travel in every payload under `attribution`.
- Known limit: attribution is per-device `localStorage`. A visitor who starts on
  a phone and finishes on a laptop is two sessions.

### Server retention and erasure

The Business Record is append-only, so erasure cannot mean `DELETE` —
`timeline_events` and `audit_events` refuse it at the database. It means
**redaction**: `redact_business_pii()` destroys direct identifiers in the
mutable surfaces, preserves the structural record, scoring, and consent
evidence, and writes an audit event stating exactly what changed.

This depends on one invariant. **Timeline and audit payloads must never carry
contact data.** Both tables refuse `UPDATE`, so anything personal that reaches
them can never be removed. Check every new event payload against this before
shipping it.

Retention periods, the deletion workflow, the legal-hold rule, and the
medical/dental restriction live in
[docs/DATA_RETENTION_AND_REDACTION.md](docs/DATA_RETENTION_AND_REDACTION.md).
**All of it is pending professional review, and nothing in this repository
claims compliance with any law or regulation.** Do not add such a claim.

### Local retention limits

Everything the platform stores on the visitor's own device lives in
`localStorage`:

- Retry queue entries expire **30 days** after being queued.
- Delivered submissions are deleted **immediately**.
- Permanently rejected and retry-exhausted entries are retained until they
  expire, so nothing is silently discarded.
- The queue is capped at **25 entries**; overflow drops the oldest and logs it.
- Retries back off exponentially (1 min, doubling, capped at 6 hours) for at
  most **8 attempts**, and a server `Retry-After` may lengthen but never
  shorten the wait.
- The server's `CED_SUBMISSION_MAX_AGE_DAYS` must stay **at least** as long as
  this 30-day window. A shorter server window permanently rejects assessments
  the browser is still faithfully retrying.
- `window.CEDAssessment.clearSavedAssessmentData()` removes the saved
  assessment, the submission record, and the queue. Wire it to any
  user-facing "delete my data" control.

### Never store or transmit

Payment details, card numbers, bank or routing numbers, passwords, API keys,
tokens, other credentials, government identifiers, or sensitive health
information. This is enforced, not just documented: the engine matches form
field names against a prohibited pattern, logs an error, and strips them from
the payload. Do not weaken that pattern to make a field pass — if a vertical
seems to need such a field, it needs a different design. This matters most for
the planned medical/dental family, where the temptation is highest.

---

## 10. Analytics

First-party, pseudonymous, and strictly observational. Full detail in
[docs/ASSESSMENT_ANALYTICS.md](docs/ASSESSMENT_ANALYTICS.md),
[docs/ANALYTICS_EVENT_CATALOG.md](docs/ANALYTICS_EVENT_CATALOG.md), and
[docs/ANALYTICS_PRIVACY.md](docs/ANALYTICS_PRIVACY.md).

### Analytics never affects the assessment

Not scoring, not branching, not the payload, not the report, not the price.
Every call from the engine goes through a wrapper that swallows anything
thrown, and a failed flush costs a measurement rather than the visitor's work.
Two tests hold the line: a complete two-stage journey against a client that
throws on every call, and a payload comparison with and without a client
attached.

Nothing analytics writes is ever read back. There is **no foreign key** from an
analytics table to the Business Record, and no function in migration 0005
writes outside the analytics tables. That isolation is what makes an
unauthenticated analytics endpoint an acceptable risk: the worst outcome of
forged events is a wrong funnel.

### What analytics may never carry

Names, email addresses, phone numbers, free-text answers, full URLs, referrer
paths, challenge tokens, consent statement text, payment data, health data,
user agent strings, or exact viewport pixels. Also excluded, though the
platform collects them: **budget signal, decision authority, objections,
urgency and timing** — they live in the Business Record under its consent and
retention rules, and a second copy in a funnel would have a different lifetime
and no owner.

Enforcement is token-based, not substring-based, and runs on **both** sides of
the wire. Do not switch it back to a substring test: `capacity90Day` contains
"city", and that is the bug the token approach exists to prevent.

An answer's **value** never travels unless its question is on
`SAFE_VALUE_ALLOWLIST`, which holds exactly two coarse branch-deciding fields.
The allowlist can widen what is kept; it can never override the prohibition.

### Adding a measurement

Mark the control with `data-analytics-event="assessment.…"`. One delegated
listener handles every control, and one handles every question — do not add a
listener per field. Event names are a shared contract and the raw table is
append-only, so a rename orphans history rather than migrating it: add a new
name, never repurpose an old one.

### Reporting honesty

Postgres counts; `shared/analytics/funnel.js` divides, so every rate has one
definition. A ratio with a zero denominator is `null`, never zero. A rate below
the sample floor is withheld with its sample size attached, because "60% of 5
people" reads as a finding and is noise. The drop-off report names the worst
step and **makes no recommendation**.

### Known outstanding gaps

Migration 0005 has never been executed. The analytics consent policy is
**pending professional review** and no compliance claim is made anywhere. There
is no signed session token, so the endpoint's only real defences are the origin
allowlist and rate limiting. Abandonment counts are a floor, not a total.
