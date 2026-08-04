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
