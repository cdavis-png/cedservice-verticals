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

**The one exception, and it is not a build step in the sense above.**
`tools/build-static.mjs` is a zero-dependency file copier that assembles the
deployment's static output from an explicit allowlist — see section 13. It does
not bundle, transpile, minify, inline, or rewrite anything: every published
file is a byte-for-byte copy of its canonical source, which stays exactly where
it is — with exactly one, named exception: one line of the staff onboarding
page, where the Supabase project origin is generated into its
Content-Security-Policy. See section 13. Nothing imports it, no page depends on it, and a vertical is still
openable by double-clicking `index.html`. It exists because the alternative was
publishing the repository root.

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
privacy rules. See section 11.

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

**Known outstanding gaps:** no production database is connected. Migrations
0006 and 0007 are validated against a disposable local PostgreSQL 18.3 — the
whole chain, a clean install and an upgrade over populated pre-0006 data, with
the full integration suite including sections O through X passing — **and both
are also present on the hosted development project** `qkpptajglstgucadhfwq`,
which runs PostgreSQL 17.6.1.155. That was established on 2026-08-09 by
read-only PostgREST existence-versus-permission probes, and it corrected a
claim this file carried for some time: that neither had ever been hosted.

A read-only hosted preflight has since read
`supabase_migrations.schema_migrations` — **0001–0007 are recorded**, 0008 is
not — and compared the deployed `enforce_bir_supersession_scope()` against
migration 0006, which **matches exactly**. All three of 0008's findings are
confirmed against the real database, including that `service_role` really does
hold EXECUTE on the twelve internal functions from 0001/0004/0006.

What is still open is narrower: no OTHER deployed definition has been diffed
against its committed file, and nothing has been *executed* there. Nothing has
been successfully *called* over PostgREST — the probes were permission
refusals — so section M of the integration suite still has not run there, and
neither have the staff route's five RPCs or its two direct table reads.
Migration **0008 is applied and verified** on that project — ledger version
`20260809173146`. The hosted ledger now records **0001 through 0011**, plus one
entry with no repository file; see section 14 for both. 0008 is
forward-only and repairs three defects in 0006 (see section 14). Beyond the
database: the application is not deployed for public traffic; no challenge
provider has been chosen; and nothing yet reports how many visitors open or
finish the fit review, so there is no evidence about whether the two-stage
split reduced abandonment or merely moved it.

The identity-resolution queue now **has** a working surface — see section 12 —
so ambiguous submissions can be resolved by a provisioned operator. What that
surface has not had is any contact with the real world: no real Supabase Auth
call, no real second factor, and no Vercel build. Section 12 lists that
precisely.

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
| `resultsDeliveryConsent` | Yes | Permission to process the review and show the results on the page |
| `emailMarketingConsent` | No | Optional |
| `smsMarketingConsent` | No | Only offered when a mobile number is given |

Rules that must not be broken:

- **Never bundle them into one checkbox.** Agreeing to receive results is not
  agreeing to marketing.
- **Marketing consent is never a condition of anything.** Declining a marketing
  permission must never block completing the assessment or reaching the
  results. Results are shown on the page whether or not the visitor opts in,
  and the page says so in plain language. That assurance stays; the wording
  follows whatever the delivery method actually is.
- **Never claim a delivery that has not happened.** No page, status message,
  timeline summary or report may say or imply results were emailed unless an
  operational delivery system has accepted the message *and* its state is
  recorded truthfully — with provider acceptance distinguished from confirmed
  delivery. **The current delivery method is on-page**, and there is no email
  provider in this repository. A permission or status that describes a
  behaviour the platform does not have is not consent, and is not information.

  *Why this rule replaced "delivered by email".* This file used to require that
  the page promise delivery by email. Nothing could perform it: the engine
  reported a stored submission as "Results sent." to a visitor who had just
  ticked a consent about their email address. The Service Mix review had
  already corrected its own wording; this rule generalises that correction
  rather than the defect it replaced.
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

## 10. Review types

"Assessment" used to mean one thing. It now means two, and the difference is
a first-class dimension called `review_type`.

| | `growth_review` | `service_mix` |
| --- | --- | --- |
| What it asks | The operational picture, in two stages | Two to five offerings, in one |
| What it produces | BIR **v4** | BIR **v5**, `reportType: "service_mix"` |
| Payload schema | 2–5 | 6 |
| Engine | `shared/business-intelligence/` | `shared/service-mix-engine/` |

`shared/business-intelligence/review-registry.js` is the routing table: which
engine generates, which validator checks, which BIR version each produces.
Nothing else should branch on a review type by hand.

**Growth reports stay at v4 and stay immutable.** `BIR_SCHEMA_VERSION` in
`report.schema.js` is the *Growth* generator's version and was deliberately
not bumped for SM-1. A consumer branches on `reportType`, never on
`schemaVersion` alone.

**Every existing row is `growth_review`**, by column default and by backfill.
Any other default would retroactively relabel history.

**Supersession is closed within one business AND one review type.** A Service
Mix report may *reference* the applicable Growth BIR through
`relatedGrowthReview`; it may never supersede one, and the database refuses
the attempt as well as the engine. `business_records.current_bir_id` keeps
meaning "the current Growth report" — it predates review types and is not
repurposed. `business_review_states`, keyed `(business_id, review_type)`, is
the forward-looking surface and is what makes the two independently current.

**A second review attaches by a server-issued continuation context, never by
a client-supplied Business Record id.** The endpoint signs an opaque,
expiring token with `CED_CONTINUATION_SECRET`, the browser echoes it back
untouched, and `shared/security/continuation.js` verifies it before anything
links. The token is stripped from the payload before hashing or storage, like
the challenge token and for the same reason, and any `businessId` a client
puts in the payload is deleted rather than ignored. Every failure mode falls
through to ordinary identity resolution: a visitor whose token aged out still
gets their results.

**SM-1 never claims profit.** It collects no direct costs, so contribution,
underpricing, add-on and bundle analyses are present in the report and marked
`requires_detailed_review`. The validator refuses a report that marks any of
them available without cost evidence. The approved phrase is *estimated
contribution*, never *profit leader* — `classify.js :: CONTRIBUTION_LANGUAGE`
is the authority and the templates read from it.

**A finding is raised only when its interval clears the threshold**, never its
midpoint. A threshold the interval straddles is not cleared, however
favourable the middle looks. This is what stops the review manufacturing
conclusions to fill a report.

Full detail: [docs/SERVICE_MIX_REVIEW.md](docs/SERVICE_MIX_REVIEW.md) and
[docs/SERVICE_MIX_BIR.md](docs/SERVICE_MIX_BIR.md).

---

## 11. Analytics

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

Migration 0005 **has** been executed against the hosted development
PostgreSQL 17 project, and so, it turns out, have **0006 and 0007** — they are
present on `qkpptajglstgucadhfwq`, confirmed on 2026-08-09 by read-only
PostgREST probes. Both have additionally been executed against a disposable
local PostgreSQL 18.3 through PGlite. What remains unverified is what the
hosted definitions actually *are*, and no analytics function has ever been
successfully **called** through PostgREST — the probes distinguished
"permission denied" from "not found" and nothing more. Migration 0008 is
applied and verified there, at ledger version `20260809173146`. The single
record of what has and has not executed is
[docs/REAL_POSTGRES_VALIDATION.md](docs/REAL_POSTGRES_VALIDATION.md), run 16.

The analytics consent policy is **pending professional review** and no
compliance claim is made anywhere. There is no signed session token, so the
endpoint's only real defences are the origin allowlist and rate limiting.
Abandonment counts are a floor, not a total.

---

## 12. The staff identity-resolution console

The FIRST **authenticated** surface in this repository, and for a long time the
only one. Most of the rest is deliberately public, because the people filling
in an assessment have no account. This one is the opposite, and it exists
because migration 0001 created `identity_resolution_cases`, called it "the
human queue", and gave nobody a way to close one.

It is no longer alone: `POST /api/sales/promote` (§15) authenticates the same
way and reuses the same live `staff_operators` lookup. Everything in this
section about keys, provenance, AAL2 and authorization applies there too — read
it as the pattern, not as a description of one route.

Full runbook — provisioning, revocation, environment, and what an operator can
and cannot do — is
[docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md](docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md).

### Where it lives

| | |
| --- | --- |
| Page | `staff/identity-resolution/` — `index.html`, `page.js`, `auth.js`, `styles.css` |
| Onboarding page | `staff/identity-resolution/` — `accept-invite.html`, `accept-invite.js` |
| Deployment entrypoint | `api/staff/identity-resolution/[...path].mjs` |
| Implementation | `server/staff-identity-resolution.mjs` |
| Migration | `supabase/migrations/0007_staff_identity_resolution.sql` |

**The implementation is outside `api/` on purpose.** Vercel deploys every file
under `api/` as its own function, so while it lived there the same privileged
route deployed **twice** — once through the catch-all the console calls, and
once at its own bare path, absent from `vercel.json` and therefore on platform
defaults. One route, one function. The entrypoint is a catch-all segment
because every path the console calls carries a sub-path, and a plain
`api/<name>.mjs` serves its own path and nothing beneath it.

**`server/` is a new top level, and the dependency direction is the same
one-way rule section 2 states for verticals.** `server/` imports from
`shared/`; `shared/` must never import from, reference, or special-case
`server/`. The imports are static ESM so the platform's file tracer can follow
them by reading the source — the same convention `api/assessments.mjs` and
`api/analytics.mjs` already rely on.

### Supabase Auth runs on the server

The **console** page holds no Supabase client and no key of any kind. It posts
to three same-origin endpoints — `/session`, `/session/refresh`,
`/session/signout` — and the route makes every Auth call with the supported
client, server-side. Nothing is hand-rolled.

The **onboarding** page is deliberately the opposite; see below.

This repository has no build step and no bundler, so putting
`@supabase/supabase-js` in the page would have meant committing a generated
third-party bundle or loading one from a CDN at runtime. Neither belongs in the
sign-in path of a console that performs permanent, unerasable attachments.

### Onboarding runs in the browser, and that is the point

`identity_resolution_cases` had a human queue with nobody able to close one;
the console had a sign-in with nobody able to reach it. `/session` correctly
refuses an account with no verified factor, and nothing here could give an
invited person one. `staff/identity-resolution/accept-invite.html` closes
that.

**The first attempt did it with two CED endpoints that accepted the password
and the invitation token and returned the session, the TOTP secret and the
otpauth URI. That was wrong** — CLAUDE.md §9 says this platform never
transmits or stores passwords, tokens or credentials, and it did all of it.
The reasoning behind it confused two keys: the **secret** key must never reach
a browser; the **publishable** key is designed for one. Avoiding a public key
by routing private credentials through a CED function traded a non-problem for
a real one. Do not reintroduce it — a test names those endpoints and fails if
they come back.

- **No ONBOARDING OR RECOVERY credential touches CED.** The invitation token,
  the recovery token, the password, both session tokens, the TOTP secret, the
  `otpauth://` URI and the six-digit code go from the browser to Supabase Auth
  directly. Those pages' only CED call is `GET …/auth-config`, which returns
  the project origin and the publishable key and takes no body.

  **This is a claim about onboarding and recovery, not about the whole
  route.** The pre-existing console sign-in — `/session`,
  `/session/refresh`, `/session/signout` — is deliberately server-mediated
  and still handles the operator's password, TOTP code, access token and
  refresh token, for the reasons in "Why the two pages differ" above. Those
  endpoints are unchanged here and are out of scope for this rule. Anything
  that reads as "no endpoint in this file accepts a credential" is wrong.
- **The publishable key grants nothing, and that is a catalog fact.**
  `tests/migration/0007-anon-grants.test.mjs` proves in real PostgreSQL that
  `anon` and `authenticated` are refused SELECT, INSERT, UPDATE and DELETE on
  every staff table and EXECUTE on every staff function, with RLS forced and
  no policies. The same test proves `service_role` reaches them, so the
  refusals are about the role rather than a broken fixture.
- **`lowPrivilegeKey` guards the config endpoint,** so a secret key pasted
  into the publishable variable is refused and the endpoint answers
  `503 auth_unavailable` rather than serving an elevated credential.
- **There is no registration path.** `OTP_TYPE` is a constant in the page and
  is never read from the URL; a `type` parameter that is present and is not
  `invite` refuses the link outright. Without a `token_hash`, the page offers
  only recovery, which is a password sign-in against an account that must
  already exist.
- **Enrollment grants nothing.** The page cannot write `staff_operators` — it
  cannot even see the table — and signs out when it finishes. A fully enrolled
  account is refused the queue with `not_an_operator` until an owner
  provisions it, and the page says so instead of letting them discover it.
- **Interruption is recoverable without a second invitation, in both of its
  shapes.** Accepting an invitation is two calls — `verifyOtp` consumes the
  one-time token, then `updateUser` creates the password — and **between them
  the account exists with no usable password**. Supabase cannot re-invite an
  existing user, so:
  - *password already set* → the page resumes with it, clears any abandoned
    *unverified* factor, and re-enrolls;
  - *password never set, or set with its response lost* → a **password
    reset**, requested from the same page and completed on
    `reset-password.html`. It depends on the account rather than the
    invitation, so it works in every state that window can leave behind — and
    the two are indistinguishable from the browser, which is why the reset is
    offered rather than inferred.

  An account that already has a *verified* factor is sent to sign in instead:
  recovery is not a second way in. **The recovery page enrolls no factor,
  writes no `staff_operators` row, and grants no queue access** — it sets a
  password and signs out. The reset request answers identically for a real
  account, an unknown address and an unreachable Supabase, so it is not an
  account oracle.
- **The client is vendored, not loaded from a CDN,** so `script-src` stays
  `'self'`. `connect-src` is the only directive widened, to one exact project
  origin — no wildcard, no `wss:`.
- **That origin is GENERATED per build from `SUPABASE_URL`,** by
  `tools/build-static.mjs`, through the same validator `GET /auth-config`
  uses — so the origin the page is told to call and the origin it is permitted
  to reach cannot diverge. `vercel.json` names no Supabase host at all: a
  placeholder is a deployment waiting to ship a placeholder, and a hardcoded
  development origin would point production at development data. Missing or
  invalid configuration **fails the build**, and the committed page carries
  `connect-src 'self'` with no host, so an unbuilt copy reaches nothing.
- **The header CSP carries no `default-src` and no `connect-src`.** A header
  policy and a meta policy are both enforced and the browser applies their
  intersection, so either directive in the header would block the generated
  origin. Per-page directives live in each page's `<meta>`, first in
  `<head>`; `frame-ancestors` stays in the header, where a meta policy is
  ignored.
- **The invitation travels in the URL FRAGMENT, never the query.** A fragment
  is never transmitted, so the token is absent from the page load itself —
  the one request no page JavaScript could have cleaned up. The page removes
  it with `replaceState` before its first fetch, and **refuses** a
  `token_hash` offered in the query, because by then it has already leaked.
- **`persistSession`, `autoRefreshToken` and `detectSessionInUrl` are all
  off** in the browser client, for the same reasons they are off server-side
  and one more: a persisted session would leave an `aal1` token in storage on
  a shared machine.
- **No QR image.** Supabase returns the QR as a `data:` image and the staff
  CSP is `default-src 'none'` with no `img-src`. The setup key and the URI are
  shown as text. Do not widen the header to render a convenience.

Rules that must not be quietly relaxed:

- **Two keys, kept strictly apart, failing closed in both directions.** The
  publishable key (or the legacy `SUPABASE_ANON_KEY`) does password sign-in,
  factor listing, challenge and verify, refresh, sign-out, and access-token
  verification — *and nothing else*. The secret key (or the legacy
  `SUPABASE_SERVICE_ROLE_KEY`) does the privileged RPC and the two direct table
  reads — *and nothing else*. A secret key pasted into the publishable variable
  is recognised and refused, so the route answers `503 auth_unavailable` rather
  than verifying tokens with an elevated credential; the reverse is refused
  too. Auth running server-side is **not** a reason to reach for the elevated
  key.
- **The Auth client is built per request and never cached.** It carries a
  signed-in session in memory during sign-in, so two concurrent invocations
  sharing one instance would be two operators sharing one session.
  `persistSession`, `autoRefreshToken` and `detectSessionInUrl` are all off.
- **Every `signOut` passes `{ scope: 'local' }`, explicitly.** The library's
  default is `global`, which revokes every refresh token the user holds on
  every device. Three of the four calls sit on the ordinary sign-in path,
  including the one that runs when a correct password is waiting for its code —
  so the default meant somebody holding only the password could evict a live
  AAL2 operator, repeatedly, which is exactly what the second factor exists to
  prevent.
- **AAL2 is confirmed on the token, never assumed from the challenge,** and
  re-confirmed on every refreshed token. Any post-password path that does not
  end in a confirmed AAL2 session revokes the temporary one it created.
- **A claim may decorate the interface and may never be the decision.**
  Authorization is a live `staff_operators` lookup on every request, called
  *before* any case row or stored payload is read. Revocation takes effect on
  the next request, not the next token refresh.
- **Provenance is proved before anything is spent** — before the rate limiter,
  the body, Supabase, the operator guard and every privileged read. A request
  carrying a body must also declare `application/json`. Without this, a `fetch`
  from any page an operator opens is a CORS *simple* request with no preflight
  to fail, and although it cannot read the answer it still consumes the
  operator's budget. `shared/security/origin.js` is the canonical validator.

  **The proof is method-sensitive, because browsers are.** Per the Fetch
  standard an `Origin` header is appended when a request's response tainting is
  `cors` **or** its method is neither `GET` nor `HEAD`. A same-origin `fetch`
  keeps tainting `basic`, so **a same-origin `GET` carries no `Origin` at
  all** — and an `Authorization` header does not change that, because it forces
  a preflight only on a cross-origin request.

  | | `Origin` present | `Origin` absent |
  | --- | --- | --- |
  | Unsafe (`POST`) | exact-matched against the allowlist | **refused** |
  | Safe (`GET`, `HEAD`) | exact-matched against the allowlist | accepted only on `Sec-Fetch-Site: same-origin` or `none` |

  `same-site` is **never** accepted: it means any host under the same
  registrable domain, and this console must not inherit trust from whatever
  else is hosted beside it. A missing, malformed or unrecognised
  `Sec-Fetch-Site` on an absent-`Origin` read is refused rather than guessed
  at. An approved non-browser client that states an exact `Origin` keeps
  working unchanged.

  This replaced a rule that required `Origin` on every method. It read as
  strictly safer and was not: the console signed in, then every queue listing
  and every case read was refused `403 origin_required`, and the queue was
  unreachable in every standards-compliant browser. Nothing caught it because
  the synthetic suites attached an `Origin` by hand and the browser suite
  replaced `window.fetch`. `tests/browser/staff-origin-headers.test.mjs` now
  **observes** the headers a real browser sends, over a real socket, against
  the real entrypoint — do not replace it with a test that asserts them.
- **Four rate-limit buckets, not one.** Pre-authentication (every request),
  sign-in (`/session` only), session maintenance (`/session/refresh` and
  `/session/signout`), and authenticated operator work. Refresh and sign-out
  are not credential attempts and must not share the guessing budget — a
  refused refresh ends the session, so counting them together ejected the
  people the tight bucket protected. Separation lives inside the keyed HMAC,
  never in the database's `scope` column, which keeps the vocabulary migration
  0003 gave it.

### Migration 0007

Adds `staff_operators` (keyed to the immutable `auth.users` UUID, never an
email), `identity_resolution_requests` (the operator-bound idempotency ledger,
one row per case), the masked read surface, and one authoritative mutation that
locks the case, submission, report, target and review state, rechecks every
one, re-runs the conflict rule against the *current* target, and either commits
the whole thing or leaves nothing behind. It writes no identifier, repoints no
session or continuation, and splices no supersession chain. RLS is enabled and
**forced** with no policies, exactly as every table since 0001.

### What has never been validated

Stated precisely, because everything below is still owed:

- **What most of the hosted definitions ARE.** 0007 is present on the hosted
  development project `qkpptajglstgucadhfwq` (PostgreSQL 17.6.1.155) and
  recorded as `20260808201535`, so the two entries that used to head this
  list — "never run on 17", "never applied to a hosted database" — were false
  and are gone. The migration history has been read and **one** deployed
  definition, `enforce_bir_supersession_scope()`, has been compared and
  matches. Every other function in 0006 and 0007 is still undiffed against its
  committed source.
- **PostgREST.** Its objects have been RESOLVED through PostgREST — that is
  what the run 14 probes did — but none of the five functions the route calls
  has ever been successfully **called** through it, and neither have the two
  direct table reads. Local mode reaches them as the database owner, so the
  `service_role` grants they depend on have not been exercised as
  `service_role`.
- **Migration 0008 is no longer on this list.** It is applied, recorded at
  ledger version `20260809173146`, and verified — trigger coverage, all 16
  internal functions' privileges, both pinned search paths, the two
  security-advisor warnings gone, data intact, and the rule exercised
  behaviourally inside a rolled-back transaction. Run 16. What that does *not*
  establish is that any application code has reached the hardened schema; see
  the PostgREST entry above.
- **True multi-connection concurrency.** PGlite is a single connection. The
  *mechanism* that decides a race is proven — a unique index, a `for update`
  on the case, a ledger recheck after the lock — but the race itself has never
  been run.
- **`auth.users`, in PGlite.** Still absent there, so the `staff_operators`
  foreign key and the bootstrap's confirmed-email check remain **skipped, not
  passed**, in every local run.

  **On the hosted project this is no longer true.** One confirmed Auth user
  exists and `bootstrap_staff_owner` has executed against it successfully,
  creating the sole active `owner` — so the foreign key and the
  confirmed-email check have now genuinely run and passed there, and the
  function's refusal to bootstrap twice is the state the project is in. No
  operator identity is recorded in this repository and none may be.
- **Real Supabase Auth and TOTP.** Every Auth call is still covered against a
  stubbed client on the server and a stubbed network in the browser. No real
  access token has been verified, no real factor enrolled or challenged, and
  no real session refreshed or revoked. Bootstrapping an owner is a database
  grant, not a sign-in: it establishes *who may act*, and proves nothing about
  the console's authentication path.
- **Real invitations.** No `verifyOtp` on a token Supabase minted, no real
  password change, no real `mfa.enroll`, and no authenticator app has ever
  read a real secret. The invite email template the runbook specifies is
  written from Supabase's documented variables and **has never been sent**;
  until it is, `{{ .TokenHash }}` reaching `accept-invite.html` is a
  documented behaviour this repository models rather than one it has seen.
  The onboarding browser suite drives the real page and the real vendored
  client over real sockets, but the Auth server it reaches is a fixture
  speaking GoTrue's shape, not Supabase.
- **A real Supabase origin in a real CSP.** The generation is exercised with
  two different project origins and its refusals are pinned, but no
  deployment has set `SUPABASE_URL`, so no browser has been permitted to
  reach a real `*.supabase.co` origin from a staff page. Whether Vercel
  serves the header policy on the generated paths is still the run 8 gap.
- **Vercel.** A Preview build has run on the platform and **failed closed**
  with `SUPABASE_URL is not set.` — see run 13 in
  [docs/REAL_POSTGRES_VALIDATION.md](docs/REAL_POSTGRES_VALIDATION.md). That
  observes that Vercel executes `buildCommand` and that the guard works
  there; it observes nothing downstream, because the build aborted. Routing,
  header rules, function count and file tracing are still asserted against a
  *model* of documented behaviour. That is a check on the configuration, not on the
  platform. What is no longer open is *what would be published*: the
  deployment now has an explicit output directory built from an allowlist
  (section 13). Whether Vercel honours that configuration is still platform
  behaviour and still unobserved.

Do not describe any of these as validated on the strength of a mock, PGlite, a
configuration-model test, or a reading of the source.

---

## 13. What a browser may download

Everything the deployment serves as a static file is named in
[tools/static-manifest.mjs](tools/static-manifest.mjs). Nothing else is
published.

### Why this exists

With no `buildCommand`, no `outputDirectory` and no `public/` directory, the
output directory on Vercel's "Other" preset is the **repository root**. Every
file outside `api/` was therefore a static asset:
`server/staff-identity-resolution.mjs`, every migration, every document
including the staff operations runbook, every test, and `.env.example`.

**No credential was exposed** — `.env.example` holds only variable names with
blank values, and the server modules read their secrets from the environment at
runtime. Readable source is not a credential, and it should not be described as
one. But nothing had *decided* that any of it should be public, and no test
could see the question either way. That is what changed.

### How it works

`vercel.json` sets `"buildCommand": "node tools/build-static.mjs"` and
`"outputDirectory": "dist"`. The build copies exactly the files named in the
manifest into `dist/`, **byte for byte**, at their existing relative paths.

**One line of one file is generated, and that is the whole exception.**
`staff/identity-resolution/accept-invite.html` talks to Supabase Auth
directly, so its `connect-src` must name the exact project origin — which
differs between Preview and Production. `tools/build-static.mjs` reads
`SUPABASE_URL`, validates it as an exact scheme-host-port through
`shared/security/supabase-origin.js` (the same validator `GET /auth-config`
uses, so the two cannot diverge), and replaces one known line. It then proves
the substitution: the base line was present exactly once, it is gone, the new
line is there, the file changed by exactly that delta, and nothing key-shaped
appeared. Missing or invalid configuration fails the build before anything is
deleted or staged.

**No secret is ever substituted.** The publishable key is fetched at run time
from `/auth-config` and is deliberately not built in, so "no secret can be
inlined at build time" remains a property of the build rather than of care.
`SUPABASE_URL` is the only variable read and it reaches only the CSP text —
no path, no output directory and no part of the delete fence can be
influenced by the environment.

**`vercel.json` carries configuration and nothing else.** It is strict JSON
validated against a schema that sets `"additionalProperties": false`, so it can
hold neither comments nor an invented property used as one — an unsupported
key risks the whole file being refused, which would take `buildCommand` and
`outputDirectory` down with it and republish the repository root. Every
explanation lives in
[docs/DEPLOYMENT_CONFIGURATION.md](docs/DEPLOYMENT_CONFIGURATION.md); a test
asserts every top-level key is one Vercel actually defines.

**The build is destructive code and is fenced as such** — one permitted output
name, canonical containment, no environment override, no symlink followed, and
a staging directory that is swapped in only after every file has been copied.
The rules, and the three defects that produced them, are
[docs/STATIC_OUTPUT_SAFETY.md](docs/STATIC_OUTPUT_SAFETY.md).

- **A positive allowlist, never a denylist.** "Copy everything except…" fails
  open: the next file added to the repository is public unless somebody
  remembers to exclude it. This fails closed — a new browser asset is invisible
  until it is named, which is a broken page in review rather than a published
  document in production.
- **Canonical sources do not move.** The manifest names files where they
  already live. `dist/` is generated, git-ignored and disposable; it is never
  an authoritative tree and must never be edited. There is no second copy for
  anyone to change by mistake.
- **Paths are preserved, not rewritten.** Every current URL keeps working with
  no rewrite rule, and no HTML or CSS reference has to change — so the build
  cannot introduce a broken link by construction.
- **It starts from empty.** A file that leaves the manifest leaves the site.
- **No `.vercelignore`.** Excluding `server/` or `shared/` would break the
  function tracer that follows the static ESM imports out of `api/`. Those
  modules must stay traceable *and* stay unpublished — they are, because the
  allowlist decides publication and the tracer reads the source tree.

### `shared/security/` is decided by content, not by directory name

Exactly one file from it is published: **`shared/security/continuation.js`**,
because both public pages load it and `engine.js` and `controller.js` call
`window.CEDContinuation`. Removing it would break both reviews.

It is safe to publish, and that was audited rather than assumed: it holds no
secret and reads no environment variable; `secret` and `hmacFn` are injected by
`api/assessments.mjs`; `issueContinuationContext` returns `null` and
`verifyContinuationContext` returns `not_configured` without them, so the
browser copy can neither mint nor validate a trusted context; and a token
forged with an attacker's own secret fails the server's signature check.

`origin.js`, `rate-limit.js`, `read-body.js`, `staff-note.js`,
`verify-challenge.js` and `limits.js` are server-only and are asserted absent
**by name**. Do not add a file to the manifest because a neighbour is already
there — the directory is not the boundary, the audit is.

### Adding an asset

Add it to the manifest, with a comment saying why a browser needs it. If it is
under `shared/security/`, audit it first and record the audit.
[tests/static-output-contract.test.mjs](tests/static-output-contract.test.mjs)
proves the build is deterministic, that the output is exactly the manifest,
that every referenced asset resolves, and that no forbidden path appears.

**Still unvalidated:** the only platform build so far failed closed at
`tools/build-static.mjs` with `SUPABASE_URL is not set.`, which proves Vercel
runs the `buildCommand` and nothing after it. Whether the platform honours
`outputDirectory`, still discovers `api/` functions alongside a build
command, and still traces `server/` and `shared/` is documented behaviour
that this repository models but has not observed.

---

## 14. Migrations against a hosted database

The hosted development project `qkpptajglstgucadhfwq` already holds migrations
**0001 through 0007**. That is the starting fact, and it was discovered rather
than recorded: this file previously said 0006 and 0007 had never been hosted,
which was false. See run 14 in
[docs/REAL_POSTGRES_VALIDATION.md](docs/REAL_POSTGRES_VALIDATION.md).

### Applied history is never rewritten

A migration that has run against a hosted database is history. Fixing a defect
in it means **a new forward-only migration**, never an edit to the old file.

Editing 0006 to repair a defect would produce a repository whose 0006 has never
run anywhere and a database whose 0006 is unrecoverable — and a `db push`
against a project that already recorded 0006 would skip the edit entirely,
leaving the fix in the file and out of the database. This is the failure mode
that makes the edit worse than the defect.

`supabase/migrations/0008_staff_migration_hardening.sql` is the worked example.
It repairs three defects in 0006 — F3 supersession-scope trigger coverage, F6
`service_role` on the internal helpers, F7 the two unpinned `search_path`s —
and touches neither 0006 nor 0007.

### Present is not the same as known

Run 15's preflight read the history and compared the one function 0008 must
replace. It did not diff the rest, so the working assumption for anything
already hosted stays:

- **Do not assume a deployed object matches the committed file** until it has
  been read. An earlier draft, a hand-edit in the SQL editor, or a
  half-applied file all look identical from outside.
- **Prefer the narrowest instrument.** `alter function … set`, `revoke`,
  `create index if not exists` change one thing and leave a body alone.
  `create or replace function` **overwrites whatever is deployed**, so use it
  only where the body must change, and compare the deployed definition first.
  0008 does this once, and that comparison has been done.
- **Write every statement to be re-runnable.**

### Applying a migration must also RECORD it

`supabase_migrations.schema_migrations` records **0001–0011** — 0008 at version
`20260809173146`, 0011 at `20260815025341`. A migration applied without a history row leaves the two
disagreeing, and nothing downstream can then tell an unrecorded migration from
an unapplied one. 0008 is the worked example of doing it right: one
`apply_migration` call wrote the DDL and the ledger row together.

- **Do not paste a migration into the SQL editor.** It applies the DDL and
  records nothing. Earlier guidance in this repository said to do exactly
  that; it was wrong.
- **Do not use `supabase db push`.**
- **Do not write a history row by hand**, before or after. The apply operation
  writes it; a hand-written row is a record nothing verified.
- **Do not use `supabase migration repair`.** It rewrites history to match an
  assumption, and this project's history has been read and is correct.
- The mechanism is the connected Supabase **MCP `apply_migration`** operation,
  which applies the file and records it in one call, and it requires explicit
  human authorization immediately beforehand.

The full procedure — the exact project ref, migration name and query, the
verification queries, and what to do when something fails — is
[docs/SUPABASE_SETUP.md §2](docs/SUPABASE_SETUP.md).

### Correct forward, and only as far as the defect

A migration that has been applied and recorded is history even when it is
wrong. If 0008 is recorded and its verification fails, the answer is a
forward-only 0009 carrying **only** the corrective change — not deleting a
history row, not marking it reverted, not rerunning it blindly, and not
manually reversing everything it did.

Two limits on any such correction, both learned from a rollback paragraph this
repository actually carried:

- **Independent repairs are not unpicked together.** 0008 fixes three separate
  things; a fault in one is not a reason to reverse the other two.
- **Never restore `service_role` execute on an internal function** unless a
  named caller and a named failure prove that exact grant is needed. The
  retracted rollback would have granted all sixteen internal functions back,
  including four from 0007 that were correctly blocked *before* 0008 ran —
  leaving the database less safe than before the attempt.

**0008 is applied, recorded and verified** on the hosted development project —
ledger version `20260809173146`, run 16. The recovery procedure above was not
needed and is retained for the next migration.

### Applied before committed — 0009 and 0010

`0009_bi_sales_handoff_foundation` (`20260814182709`) and
`0010_sales_handoff_fk_indexes` (`20260814182839`) were applied to
`qkpptajglstgucadhfwq` **before** they existed as repository files. That is the
wrong order. It is recorded here rather than tidied away, because the failure
it risks is specific: a repository whose latest migration is 0008 looks like a
repository where 0009 is unwritten, and the obvious next action — write it,
apply it — would fail against a database that already has it.

Both files now exist and are **records, not pending work**. Their SQL was
recovered from `supabase_migrations.schema_migrations.statements`, which stores
what actually executed, and each file was verified against its stored statement
by comparing a comment-stripped, whitespace-normalised MD5. They match. That is
a stronger guarantee than the usual one in this repository: for 0001–0008 the
committed file is the *intended* definition and only one deployed function has
ever been diffed against it, whereas for 0009 and 0010 the committed file is
provably the *executed* text.

Two consequences, both deliberate:

- **Neither file may be applied to `qkpptajglstgucadhfwq`.** Both carry that
  instruction in their header.
- **0009 is not re-runnable**, and it was not rewritten to become so. Its
  `create table`, `create index` and `create trigger` statements are bare. The
  rule above still stands for new migrations; making an already-applied file
  re-runnable would mean it no longer describes what ran.

### 0011 — committed first, then applied

`0011_promotion_business_serialization` is the counter-example, and the order
it went in is the order this section asks for: written, tested against the
whole chain locally, committed and reviewed, and **then** applied through the
tracked `apply_migration` operation — ledger version `20260815025341`.

It is forward-only and repairs two defects in 0009 without editing it: the
promotion ledger was serialized per handoff rather than per business, and RLS
was enabled but not FORCED on all four tables 0009 created. Both are confirmed
closed on the hosted project — the business-level partial unique index, the
business column and its guard trigger are present, and all four tables now
report `relforcerowsecurity = true`.

Its file is unchanged by the application: blob
`e5cfad4053bf034e60dc55a50357d03679d1641e`, sha256
`067397e58f7bbfdb5b8d870ca2571750529ac4fc447a02fb8db064b613f86631`. Unlike
0009 and 0010, every statement in it is re-runnable.

### One ledger entry has no repository file

`supabase_migrations.schema_migrations` also records
**`20260806171939 create_aeo_answer_visibility_module`**, applied between 0005
and 0006. There is no corresponding file in `supabase/migrations/`. It created
`aeo_targets`, `aeo_competitors`, `aeo_questions`, `aeo_checks` and
`maps_snapshots` — all present, all RLS-enabled, all currently empty.

This is **unreconciled drift and is deliberately left alone.** It is named here
so the next person reads a known gap rather than discovering an unexplained one.
Reconciling it is the same recovery procedure 0009 and 0010 used — recover the
statement, commit it as a numbered file, apply nothing — but it is a separate
decision about a module nothing in the sales lifecycle touches, and it should
not be smuggled into an unrelated change.

### One elevated key, one selector

`SUPABASE_SECRET_KEY` is preferred everywhere;
`SUPABASE_SERVICE_ROLE_KEY` is the legacy name and a fallback only when the
preferred variable is **unset**. All three server surfaces —
`api/assessments.mjs`, `api/analytics.mjs` and
`server/staff-identity-resolution.mjs` — resolve it through
[shared/security/supabase-keys.js](shared/security/supabase-keys.js) and none
reads either variable directly. A test asserts that last part by reading the
sources.

They used to disagree: the staff route preferred the modern name and the two
public endpoints read only the legacy one, so a deployment following current
Supabase documentation brought up the authenticated console while assessment
capture answered `503 not_configured`. **A split credential configuration
fails in the direction that leaves the privileged surface working and the
public one dark**, which is the direction nobody notices. Do not reintroduce a
second place that reads an elevated key variable.

A preferred variable that is set but malformed **fails closed and does not
fall back** — a typo must be a refusal to fix rather than a silent demotion to
the legacy key.

---

## 15. The BI → Sales boundary

The seam between research and selling. Full runbook, including every GHL id
this repository addresses:
[docs/BI_TO_SALES_OPERATIONS.md](docs/BI_TO_SALES_OPERATIONS.md).

| | |
| --- | --- |
| Promotion | `api/sales/promote.mjs` → `server/sales-promotion.mjs` |
| Webhook | `api/webhooks/ghl.mjs` → `server/crm-webhook.mjs` |
| CRM client | `server/ghl-client.mjs` |
| Auth primitives | `server/operator-session.mjs` |
| Migrations | 0009, 0010 (reconciled records), 0011 (applied `20260815025341`) |

### Authority, and the line that must not move

Supabase owns identity, evidence, qualification, cross-system links and
historical milestones. GHL owns communications, sales execution, the CURRENT
opportunity state, and Won/Lost. **Supabase is never authoritative for the live
pipeline stage** — the webhook receiver writes history, never a mirror of
present state. A second copy of live state is a second source of truth, and the
two disagree the first time a delivery is dropped.

**No database trigger calls GHL**, and none may be added. A trigger making an
outbound call puts a network round trip inside a lock and turns a CRM outage
into a failed transaction.

### Two decisions, never one

`qualification_status = 'qualified'` makes a Lead. `pursuit_approved_at` is the
SEPARATE human decision that permits an Opportunity. The schema refuses to let
either imply the other, the route refuses before calling GHL, and
`enforce_external_record_link_handoff` refuses the link even if something got
past both. Qualification alone is explicitly insufficient — do not add a path
that infers pursuit approval from confidence, evidence, or a caller's request.

### Vercel, not an Edge Function

Decided by inspection: all server surfaces here are Vercel Node functions, the
project has zero Edge Functions, and §12 already fixed the shape. An Edge
Function would be a second deployment architecture — a second home for secrets,
a second release path, a second runtime, a second answer to where
authorization happens.

Both sales routes are **plain paths**, not catch-alls: each serves one endpoint
with no sub-paths, so neither needs the bracket segment or the `vercel.json`
rewrite the console required. Do not pre-emptively convert them.

### The webhook is the one route with no origin check

HighLevel is not a browser and holds no session, so the Ed25519 signature is
the ONLY credential. It is therefore absolute: verified over the **unmodified
raw bytes** before parsing, before the database, before a rate-limit bucket;
the deprecated RSA `X-WH-Signature` is not accepted; and **no configuration
flag disables verification**. A "skip in development" switch is exactly the
switch that reaches production.

Re-serialising the body breaks this. Read it once as a Buffer and hand the same
Buffer to both the signature check and the hash.

### Timeline payloads carry no contact data

§9's rule, and this is where it is easiest to break: both surfaces build events
from CRM bodies full of names, emails and phone numbers. Identifiers and keys
only. `timeline_events` refuses UPDATE, so anything personal that reaches it
can never be redacted.

### Promotion is not automation

There is no sweep, no schedule and no trigger. Promotion is an explicit
authenticated call for one handoff. **Do not broadly enable automatic
BI-to-GHL promotion**, and do not build researched-outbound opportunity
automation without deciding to — it is a separate decision, not a natural
next step.

The reason to *wait* has been removed: the Voice AI inbound-call workflow
created duplicate open opportunities because its Create-or-update-opportunity
action had **Allow duplicate opportunities** switched on, which has since been
turned off. That was confirmed by a human reading the workflow screen and
cannot be verified from here — the public API exposes only the workflow list,
never its actions — so nothing in this repository can regression-test it.
Runbook §6 records the settings.
