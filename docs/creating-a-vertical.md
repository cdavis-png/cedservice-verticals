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
> Still outstanding platform-wide: completed reviews are stored only in
> `localStorage` and are never sent anywhere. Every vertical inherits this
> until a capture endpoint exists.

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
| `shared/assessment-engine/` | Step navigation, validation, resume, scoring, recommendation |
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

- **Copy** — headlines, subheads, eyebrow labels, FAQ answers, proof points.
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
<script src="../../../../shared/assessment-engine/engine.js"></script>
<script src="../../../../shared/scripts/site-nav.js"></script>
```

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
- [ ] Results are captured somewhere durable, not only in `localStorage`.
      *(Currently unresolved platform-wide — the nails prototype loses every
      completed assessment unless the visitor clicks the mailto link.)*

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
