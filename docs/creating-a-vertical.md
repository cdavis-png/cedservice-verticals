# Creating a Vertical

How to launch a new industry on the CED Service growth platform without
duplicating shared code.

Read [CLAUDE.md](../CLAUDE.md) first. This document is the procedure; CLAUDE.md
is the set of rules the procedure has to satisfy.

---

## Before you start

A vertical is a landing page plus a self-paced assessment for one industry. The
reference implementation is
[verticals/beauty-wellness-fitness/nails/site/](../verticals/beauty-wellness-fitness/nails/site/).

Verticals are grouped into families that share operating characteristics.
`beauty-wellness-fitness` covers appointment-based personal care — those
businesses all book time slots, suffer no-shows, and depend on rebooking, so
their assessments differ mostly in vocabulary. A new vertical inside an existing
family is mostly copy work. A new *family* needs its own assessment design.

> **Current status.**
> Design tokens and the assessment engine are both extracted and shared. A new
> vertical supplies markup, copy, and an `assessment.config.js`; it writes no
> assessment JavaScript of its own.
>
> Lead capture is built, shared, and hardened, but **not connected**: no
> Supabase project exists, the migrations have never been executed, and no
> challenge provider has been chosen. Over `file://` the endpoint resolves to
> `null` and assessments are logged locally; over http(s) it posts to
> `/api/assessments`.
>
> **No vertical can take public traffic yet.** See
> [PRODUCTION_HARDENING.md §14](PRODUCTION_HARDENING.md#14-remaining-launch-blockers)
> for what is outstanding.

---

## Required folder structure

A vertical lives under `verticals/<family>/<industry>/`:

```
verticals/<family>/<industry>/
├── README.md                    what this vertical is, status, live URL
├── assessment.config.js         questions, weights, packages, copy
└── site/
    ├── index.html               landing page + assessment markup
    ├── styles.css               vertical-specific styles only
    └── README.md                local preview + launch notes
```

The matching sales material lives in a parallel tree — the folder shape mirrors
`verticals/` so the two stay findable together:

```
playbooks/<family>/<industry>/   discovery, pricing, objections, onboarding
marketing/<asset-type>/          cards, one-pagers, brochures, QR campaigns
```

Rules:

- Use the existing family folders. Do not invent a new family for an industry
  that fits one that exists.
- Lowercase, hyphenated folder names, matching the terms already in use
  (`personal-trainer`, not `personalTrainer` or `trainers`).
- Remove the `.gitkeep` from any folder once it holds real files.
- No `script.js` in a new vertical. Behavior comes from `shared/`; the vertical
  supplies configuration.

---

## What belongs in shared

Anything a second vertical would also need.

| Location | Contents |
| --- | --- |
| `design-system/standards/` | Design tokens — **the only place tokens are defined** |
| `design-system/ui/` | Reusable component CSS: buttons, cards, modal, forms |
| `design-system/layouts/` | Shell, grids, section rhythm |
| `design-system/animations/` | Ambient effects, transitions, reduced-motion rules |
| `design-system/accessibility/` | Focus styles, skip links, screen-reader utilities |
| `shared/assessment-engine/` | Step navigation, validation, resume, scoring, recommendation, payload building, submission transport |
| `shared/components/` | Markup partials shared across verticals |
| `shared/reports/` | Results rendering and formatting |
| `shared/scripts/` | Site chrome and utilities: header nav, formatting, analytics |
| `ai/prompts/`, `ai/scoring/` | Prompt templates and scoring rules |

Shared code must be industry-agnostic. If a function mentions "salon,"
"technicians," or "appointments," those are parameters, not literals. Shared
code never imports from a vertical.

---

## What belongs in a vertical

Only what genuinely differs by industry:

- **Copy** — headlines, subheads, eyebrow labels, FAQ answers, proof points, and
  the three consent statements (all pending legal review).
- **Assessment configuration** — question text, answer options, weights,
  opportunity coefficients, priority messages.
- **Packages** — tier names, prices, feature lists, recommendation thresholds.
- **Vocabulary** — *appointments* vs. *sessions* vs. *visits*; *technicians* vs.
  *stylists* vs. *trainers*.
- **Imagery and industry-specific trust signals.**
- **Deliberate visual overrides**, each with a comment explaining why.

The test: if the answer to *"would the hair-salon version need this too?"* is
yes, it does not belong in the vertical.

---

## Cloning without duplicating shared logic

### 1. Create the folders

Create `verticals/<family>/<industry>/site/` and the matching
`playbooks/<family>/<industry>/`. Delete any `.gitkeep` you replace.

### 2. Start `index.html` from the nails page

Copy the nails `index.html` as a **structural** starting point, then replace
every industry-specific string. Keep the section order, the semantic markup, and
all ARIA attributes — those are the parts that already work.

Replace: page title and meta description, hero copy, eyebrow labels, the four
capability blocks, package names and prices, the ROI illustration, FAQ entries,
and all assessment question text.

Keep verbatim: every disclaimer. Compliance language is not industry-specific.
See CLAUDE.md section 4.

### 3. Import shared styles; add only what differs

The vertical stylesheet imports shared CSS and then adds only what is unique.
`@import` rules must come first in the file:

```css
@import url("../../../../design-system/standards/tokens.css");
/* additional shared imports as they are extracted */

/* vertical-specific styles below */
```

The path depth is four levels up from `site/` — verify it resolves before
moving on. Never redefine a token here. If this industry genuinely needs a
different accent color, override it in a `:root` block *after* the imports with
a comment explaining why.

### 4. Configure the assessment — do not rewrite it

The vertical supplies an `assessment.config.js` describing its question
inventory, scoring dimensions, opportunity formulas, priority copy, and package
thresholds. The page loads that config and then the shared engine, which reads
`window.CED_ASSESSMENT_CONFIG` and wires everything up. No assessment
JavaScript is written in the vertical.

```html
<script src="../assessment.config.js"></script>
<script src="../../../../shared/assessment-engine/submission.js"></script>
<script src="../../../../shared/assessment-engine/intelligence.js"></script>
<script src="../../../../shared/assessment-engine/engine.js"></script>
<script src="../../../../shared/scripts/site-nav.js"></script>
```

The config also carries a `meta` block (vertical ID and name, assessment
version, package names and prices, contact field names, consent records) and a
`submission` block (endpoint and timeout). Both feed the submission payload.

`meta.consents` declares each permission separately — results delivery
(required), email marketing, SMS marketing — mapping a payload key to a form
field. `requiresField` gates a consent on another answer; SMS marketing uses it
so the option only appears once a mobile number is entered. Bump
`assessmentVersion` whenever questions, weights, or formulas change.

The engine mints an `assessmentSessionId` on first page view and a
`submissionId` per completed result, records first-touch attribution once, and
strips prohibited fields. None of that is a vertical's concern — see CLAUDE.md
section 9 for the rules it enforces.

### 4a. Conditional questions

A vertical declares its own branching; the engine has no idea what a location
or an approval chain is.

```js
branching: {
  steps:     { 13: read => Number(read.val('locationCount')) > 1 },
  questions: { otherApprovers: read => read.val('canApprove') !== '' &&
                                       read.val('canApprove') !== 'yes' }
}
```

Wrap each conditional question in the markup:

```html
<div data-question="otherApprovers">
  <label>Who else would need to agree? <select name="otherApprovers">…</select></label>
</div>
```

Rules worth knowing before writing predicates:

- **An unanswered gate is not a "no".** Test for the answer you want, not for
  the absence of another — `read.val('x') !== 'yes'` is true before `x` is
  answered at all, which shows the question prematurely.
- A hidden question's answer is **cleared** and recorded as stale. Do not rely
  on a value surviving behind a closed branch.
- A step is skipped when every conditional question in it is hidden **and** it
  has no unconditional content.
- Predicates must be pure and cheap; they run on every keystroke.
- **Never branch away a question whose answer could raise a hard blocker.**
  Hiding it does not mean the blocker will not apply — it means nobody will
  find out. `customIntegrationNeeded` is unconditional in the nails vertical
  for exactly this reason.

### 4a-2. The two stages

A review is split by marking each step with `data-stage`, and marking that
stage's results screen with `data-results-for`. The engine reads both out of
the markup; a vertical that declares neither is a single-stage review and
behaves as it always did.

```html
<div class="review-step" data-step="1" data-stage="1" data-stage-name="Growth Review"> … </div>
…
<div class="review-step results-step" data-step="9" data-stage="1"
     data-results-for="1" data-finish-label="See My Results">
  <strong data-result="score">--</strong>
  <strong data-result="opportunity">$0</strong>
  <p data-result="assumptions"></p>
  <div data-result="priorities"></div>
  <p class="results-disclaimer">…</p>
  <button data-stage-action="improve_recommendation">Improve My Recommendation</button>
  <button data-stage-action="see_recommended_system">See the Recommended System</button>
</div>
<div class="review-step" data-step="10" data-stage="2" data-stage-name="Fit and Activation Review">
  <p class="stage-note" data-stage-note hidden></p>
  …
</div>
```

Result hooks are `[data-result="…"]` scoped **inside** the results step, not
ids — there is one results screen per stage and an id may appear only once in a
document.

What each stage must contain:

| Stage 1 must have | Stage 2 must have |
|---|---|
| Every input the Growth Score and opportunity formula read | Everything close-related |
| Anything the package threshold reads | `[data-stage-note]` on its first step |
| `locationCount` and `capacity90Day` | |
| Contact fields and the required results-delivery consent | |

**Stage 1 delivers a real result, so it collects the consent to deliver it.**
Everything Stage 2 asks must be genuinely optional: a visitor who never opens
it still receives a complete Growth Review.

Fields in a stage the visitor has not opened are **disabled**, so they are
absent from the payload rather than present as empty strings. An unasked
question is not a blank answer.

### 4b. Intelligence field names are a shared contract

The fields listed in
[ASSESSMENT_INTELLIGENCE_EXPANSION.md §2](ASSESSMENT_INTELLIGENCE_EXPANSION.md)
— `locationCount`, `capacity90Day`, `canApprove`, `budgetSignal`,
`primaryConcern`, and the rest — are read by both the browser and
`generate-bir.js` through `shared/assessment-engine/intelligence.js`.

**Choose your own question wording. Do not rename these fields.** A vertical
that renames one silently loses the evidence: the report will score it as
unknown and cap readiness accordingly, with nothing to indicate why.

`STAGE1_FIELDS` and `STAGE2_FIELDS` in the same module say which stage owns
which. A vertical may not move a field between stages by itself — the report
would then call evidence outstanding that was already collected, or the reverse.

Script order on the page, and it matters:

```html
<script src="../assessment.config.js"></script>
<script src="../../../../shared/assessment-engine/submission.js"></script>
<script src="../../../../shared/assessment-engine/intelligence.js"></script>
<script src="../../../../shared/business-intelligence/report.schema.js"></script>
<script src="../../../../shared/business-intelligence/generate-bir.js"></script>
<script src="../../../../shared/assessment-engine/engine.js"></script>
```

The two report modules are loaded so the page computes its visible opportunity
range with the **same functions the report uses**. Reimplementing that
arithmetic in the engine is how the figure on screen and the figure in the
report drift apart. Omit them and the engine falls back to the point estimate,
which is a degradation, not a supported configuration.

Add the analytics pair before the engine:

```html
<script src="../../../../shared/analytics/events.js"></script>
<script src="../../../../shared/analytics/analytics-client.js"></script>
<script src="../../../../shared/assessment-engine/engine.js"></script>
```

Both are optional in the strict sense — the assessment works identically with
neither loaded — but a vertical without them is a vertical nobody can measure.
No third-party SDK is ever added here; analytics is first-party and same-origin.

### 4c. Marking controls for analytics

The engine already instruments steps, questions, validation failures, stage
boundaries and result views. A vertical only has to mark its own calls to
action:

```html
<a href="mailto:..." data-analytics-event="assessment.personal_review_clicked"
   data-analytics-label="stage1_results">Request a Personal Review</a>
```

One delegated listener on the modal handles every such control. Rules:

- **Use an existing event name.** They are in
  [ANALYTICS_EVENT_CATALOG.md](ANALYTICS_EVENT_CATALOG.md) and are a shared
  contract; the raw event table is append-only, so a new name orphans nothing
  but a renamed one orphans history.
- **Nothing is prevented.** A marked link is still an ordinary link.
- **Never add a listener per question.** The engine already counts every field
  through one delegated listener.
- **Never put visitor content in `data-analytics-label`.** It is a static
  control name, and the privacy rules will drop it if it looks personal.

Analytics may not carry names, emails, phone numbers, free text, full URLs, or
any close-related answer. See [ANALYTICS_PRIVACY.md](ANALYTICS_PRIVACY.md)
before adding a field to any event's metadata.

Order matters — the config must load before the engine. Start from
[the nails config](../verticals/beauty-wellness-fitness/nails/assessment.config.js)
and replace the numbers and copy; do not edit the engine to accommodate a
vertical.

The engine warns in the console when `fields` names an input the markup does
not contain, which is the usual symptom of a half-renamed clone. Keep that list
in step with the form.

### 5. Write the playbook

Discovery questions, pricing rationale, common objections, and onboarding steps
for this industry. Reuse `playbooks/shared/` for anything method-level rather
than industry-level.

### 6. Verify against the pre-launch checklist

---

## Pre-launch checklist

**Content and compliance**

- [ ] No leftover references to the source industry anywhere — search the page
      for the previous industry's terms.
- [ ] Every dollar figure carries its diagnostic-estimate label.
- [ ] Both results disclaimers present and correct.
- [ ] No guarantees, invented statistics, fake testimonials, or unreal review
      counts.
- [ ] Prices, package names, and inclusions match the current rate card.
- [ ] Contact details correct (currently `cdavis@cedservice.com`,
      `864-999-4430`) and the `mailto:` subject line names this industry.
- [ ] Privacy policy and terms linked — the form collects name and email.

**Assessment**

- [ ] Every question is relevant to this industry and uses its vocabulary.
- [ ] Scoring produces sensible output at the extremes: all-best answers, all-
      worst answers, and zeros.
- [ ] Each package tier is actually reachable from some valid set of answers.
- [ ] Pause and resume works — reload mid-assessment and confirm the answers and
      step are restored.
- [ ] Every branch reaches the results screen. Walk each path end to end; a
      predicate that never passes hides a required question forever.
- [ ] Resuming into a step that a changed answer removed lands somewhere valid.
- [ ] **Stage 1 completes and delivers results without Stage 2.** Walk it end
      to end and stop. One submission, a real Growth Score, a real range, real
      priorities, a package.
- [ ] Stage 1 targets 4–6 minutes; Stage 2 adds 3–5. Count the questions
      actually shown, not the ones in the markup.
- [ ] Stepping back from the first Stage 2 step returns to the Stage 1 results
      **without resubmitting them**.
- [ ] No Stage 2 answer appears in a Stage 1 payload, as an empty string or
      otherwise.
- [ ] Resuming mid-Stage-2 restores the stage, the Stage 1 answers, and the
      Stage 2 answers.
- [ ] The Stage 2 submission carries a **different** `submissionId` and names
      the Stage 1 one in `assessmentStage.supersedesSubmissionId`.
- [ ] The Growth Score, the estimate, and the package are identical in both
      submissions.
- [ ] The visible figure is a **range** and equals the report's
      `financialOpportunityProfile.capacityAdjusted`. Check a capacity-limited
      salon and an unsure one; the assumptions sentence changes and stays
      beside the figure.
- [ ] No intelligence field was renamed (see 4b) — a renamed field is silently
      scored as unknown.
- [ ] The Growth Score is unchanged by any new question. Add the vertical to
      the scoring-parity test if it has its own formulas.
- [ ] `submission.endpoint` resolves to `/api/assessments` on http(s) and stays
      `null` on `file://` — copy the expression from the nails config rather
      than hard-coding a URL. **A vertical must not launch with this always
      `null`**, or every completed assessment is lost.
- [ ] The vertical's production origin is listed in `CED_ALLOWED_ORIGINS`, or
      every submission is rejected with 403.
- [ ] `vertical.id` is added to the endpoint's supported-vertical allowlist in
      [api/assessments.mjs](../api/assessments.mjs), or submissions are
      rejected with `unsupported_vertical`.
- [ ] No credential of any kind appears in the vertical config. Verticals
      configure a path; the server holds the keys.
- [ ] `submission.timeoutMs` is longer than the server's whole operation
      budget (currently 20000ms against a 15s function limit). A client that
      gives up first abandons requests that were about to succeed.
- [ ] A challenge provider is configured, or the vertical is not taking public
      traffic. See
      [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md#3-endpoint-threat-model).
- [ ] **Consent wording reviewed by counsel and `data-legal-review="pending"`
      removed.** A vertical must not launch while that attribute is present.
- [ ] Three separate consent checkboxes, all unticked by default; only results
      delivery is `required`.
- [ ] "Not a condition of purchase" note present and accurate.
- [ ] SMS consent hidden and disabled until a mobile number is entered; STOP and
      HELP wording intact.
- [ ] Declining both marketing consents still produces and delivers results.
- [ ] Honeypot `contactFax` field present, invisible, and `aria-hidden`. Not
      named `website` — the identity roadmap needs that name for a real
      business website, and a trap sharing it would turn bot noise into
      identity evidence. Enforcement is server-side; the field only marks
      `integrity.honeypotFilled`, and its value never travels.
- [ ] No form field collects payment, credential, or health data — check the
      console for the engine's prohibited-field error.
- [ ] `assessmentSessionId` and `submissionId` present in a captured payload;
      `Idempotency-Key` header matches `submissionId`.
- [ ] First-touch attribution survives a second visit from a different campaign
      link, and `latestTouch` reflects the completing visit.
- [ ] A "delete my data" path calls
      `window.CEDAssessment.clearSavedAssessmentData()`.
- [ ] End-to-end submission confirmed against the live endpoint, including a
      forced failure to confirm the entry lands in the retry queue.
- [ ] `meta.packages` prices match the packages section of the page.

**Analytics**

- [ ] `events.js` and `analytics-client.js` are loaded before the engine.
- [ ] The vertical's production origin is in `CED_ALLOWED_ORIGINS`, or every
      event is refused with 403.
- [ ] `CED_RATE_LIMIT_SECRET` is set, or there is no rate limiting at all.
- [ ] Every call to action carries `data-analytics-event` with a name from the
      catalog, and still behaves as an ordinary link or button.
- [ ] A complete run produces `page_viewed`, `started`, `step_viewed` per step,
      `stage1_completed` and `preliminary_results_viewed` — check the console
      in debug mode, or the network tab.
- [ ] No answer value appears in any event except the two allowlisted fields.
      Search a captured batch for the salon name and the email address.
- [ ] Opening from `file://` sends nothing at all.
- [ ] A purge schedule exists: `refresh_assessment_funnel_daily` **then**
      `purge_expired_analytics_events`, in that order.
- [ ] **The analytics consent policy has been reviewed**, or the vertical is in
      a private pilot only. See
      [ANALYTICS_PRIVACY.md](ANALYTICS_PRIVACY.md) section 6.

**Mobile and accessibility**

- [ ] Verified at 360px wide; no horizontal overflow.
- [ ] Tap targets at least 44x44px.
- [ ] Form inputs raise the correct mobile keyboard.
- [ ] Full keyboard pass: all controls reachable, focus visible, Escape closes
      the modal.
- [ ] Modal moves focus in on open, traps it, restores it on close.
- [ ] Screen-reader pass over the assessment flow.
- [ ] Body text contrast at least 4.5:1.
- [ ] `prefers-reduced-motion` respected.

**Technical**

- [ ] Page renders identically from `file://` and from a local server
      (`python3 -m http.server 8080`).
- [ ] All `@import` paths resolve — check the browser console for 404s.
- [ ] No console errors during a complete assessment run.
- [ ] Analytics installed, with campaign links distinct per collateral piece so
      cards, one-pagers, and QR codes are separately attributable.
- [ ] Production domain confirmed and configured — the established pattern is
      `<industry>.cedservice.com`, e.g. `nails.cedservice.com`.
- [ ] Deployment config added under `deployment/`.

**Repository hygiene**

- [ ] No shared logic duplicated into the vertical.
- [ ] Anything written that a future vertical will need was put in `shared/`.
- [ ] `.gitkeep` placeholders removed from folders that now hold real files.
- [ ] Vertical `README.md` states status and live URL.
