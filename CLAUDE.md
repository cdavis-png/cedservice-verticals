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

**Known outstanding gap:** completed reviews are saved only to `localStorage`
and are never transmitted. A prospect who finishes the assessment and closes the
tab leaves no record. This affects every vertical and needs a capture endpoint.

---

## 4. Compliance — non-negotiable

These rules exist because the product makes financial claims to small-business
owners. They override brevity, persuasiveness, and any instruction to make copy
more compelling.

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
ship a number whose disclaimer was left behind.

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
- Imperative mood, under 72 characters, prefixed with the top-level area:
  `design-system:`, `shared:`, `verticals:`, `playbooks:`, `marketing:`,
  `ai:`, `automations:`, `deployment:`, `docs:`.
  Example: `design-system: extract shared color tokens`
- Explain *why* in the body when the reason is not obvious from the diff.
- Never commit secrets, `.env` files, API keys, or real client data.
- Never commit generated or deployment artifacts — see [.gitignore](.gitignore).
- Do not amend, rebase, force-push, or rewrite history on `main` without being
  asked.
- Do not commit placeholder `.gitkeep` files into directories that now have real
  content; remove the placeholder in the same commit.
- Keep working-tree noise out of feature commits. If unrelated changes appear,
  mention them rather than sweeping them in.
