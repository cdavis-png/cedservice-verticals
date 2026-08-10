# Nail Salon Business Intelligence Review — Replacement Specification

**Owner:** CED Solutions, LLC (Chris Davis)
**Target market for v1:** Easley, SC. Liberty, SC follows as a separate authorized batch.
**Status:** Panel v1 frozen. BUILD-READY.
**Version:** 1.7 — the version of record is this field, not the filename or the
title. Engine mechanisms remain provisional pending clean-surface validation; immutable
engine configurations are pinned to panel versions.
**Date:** 2026-08-09

---

## 0. How to use this document

This replaces the existing Service Mix / Growth questionnaire experience. It is a build
instruction, not a discussion document.

**Do not re-litigate the decisions in sections 4, 5, 7, 11, and 15.** Each one was
settled by hand-run experiments against live answer engines (approximately 15 observations
across 5 engines and 2 question types). The evidence behind each decision is recorded
inline so that it is clear what would have to change to reopen it.

Where something is genuinely undecided, it appears in section 19 marked as deferred. If a
build decision is required that is not covered here, stop and ask rather than inventing a
policy.

**Repairing an internal contradiction is permitted and expected. Redesigning a frozen
product decision is not.** If implementing this specification appears to require changing a
frozen decision, stop and report the conflict rather than resolving it unilaterally. The
same applies to surface capture: if the exact consumer surface cannot be captured cleanly,
stop and report the limitation — do not substitute a different configuration (see 4.4).

### Authority

This document is **not** the sole build authority. Order of precedence:

1. **`CLAUDE.md`** — governs compliance rules, consent handling, protected engine behavior,
   the review-type registry, and anything its own text declares overriding. It is checked in
   and test-enforced.
2. **This specification** — governs the new owner-facing review experience, the scanning and
   evidence layer, authorization, and report structure, **beneath** that authority.

Where the two disagree, `CLAUDE.md` governs and the conflict is reported, not resolved
locally.

### Environmental claims in this document are unverified unless stated otherwise

A prior draft asserted that the deployment foundation was Cloudflare Workers + D1 and that
`aeo-scanner-v2` existed as the scanning core. **Both were inferences from the author's
other projects, written as fact, and both were wrong.** They were caught only because the
implementer checked the repository instead of trusting the document.

Treat every statement in this specification about the existing codebase, infrastructure, or
available tooling as a claim to verify against the repository before relying on it. If a
claim is false, report it — do not build a workaround for a dependency that does not exist.
This is the same standard sections 6 and 10 impose on the product's own evidence handling,
applied to the specification itself.

---

## 1. Product definition

**Public name:** Nail Salon Business Intelligence Review

**Promise:** A salon owner receives a report that tells her something important about her
own business and what to do next — at the quality of a paid consulting engagement, given
away free.

**Core mechanic:** Research first. Ask only what public research cannot answer. Deliver
decisions, not scores.

**Two things the owner learns that nobody else is telling her:**

1. Whether AI systems recommend her salon when local customers ask where to get their
   nails done — measured, repeated, and compared against named competitors.
2. Where her published prices sit against the observed local market.

Neither requires a single answer from her. Both are produced before she is asked anything.

**Do not lead the product with "AI."** The owner wants better business decisions. The AEO
finding belongs inside the report under market position and discoverability. AI and
automation recommendations come after the business findings, never before them.

---

## 2. What is preserved, what is replaced

**Repository:** `cdavis-png/cedservice-verticals`
**Existing foundation:** Vercel Functions + Supabase Postgres.

**Preserve:**
- The existing database and identity system (`business_records`, `identity_resolution_cases`,
  applied migrations)
- Review history
- The existing deployment foundation — **Vercel Functions + Supabase Postgres**
- Deterministic analysis engines, including the Growth Score engine and its parity tests

**Build new (no existing implementation to port):**
- The scanning layer. A prior draft of this specification named `aeo-scanner-v2` as an
  existing dependency to preserve and integrate. **That was incorrect.** A repository search
  found no scanner implementation. `aeo-scanner-v2` is an unverified design reference, not a
  dependency. The scanning layer is built inside `cedservice-verticals` on its existing
  Vercel/Supabase architecture. If scanner code surfaces later it may be evaluated as source
  material — never automatically ported.

**Replace:**
- The two separate **questionnaires** (Growth, Service Mix) → one adaptive review.
  This replaces the owner-facing *experience only*. The underlying Growth Score engine,
  Service Mix engine, and their parity tests are preserved and remain immutable per
  `CLAUDE.md`. If implementing this appears to require changing protected engine behavior,
  that is a conflict to report, not to resolve.
- Static form → research-confirm-ask flow
- Summary output → consultation report
- Any calculation that can produce a contradictory percentage
- Any message claiming an email was sent when it was not

**Fix before anything else ships (see section 18, step 1):**
- Contradictory arithmetic
- False email delivery messaging

Those two are trust failures. No pilot report goes to a real salon owner until both are gone.

---

## 3. Architecture: four research objects

The single most expensive mistake this system could make is re-buying the same market
intelligence per visitor. Store four distinct object types with different scopes and
refresh cadences.

| Object | Scope | Refresh | Cost driver |
|---|---|---|---|
| AEO panel observation set | market + category + panel version | Monthly for clients; on authorization for prospects | LLM/API calls |
| Local comparable set | market + category | Monthly or quarterly | Research/collection |
| Salon public profile | individual business | 30–90 day cooldown | Collection per business |
| Owner interview | individual business | On completion or reassessment | Free |

**Key insight that makes the economics work:** "What are the best nail salons in Easley?"
is a question about the *market*, not about one salon. One panel run scores every salon in
the market — claimed, unclaimed, and not yet discovered. A market scan is shared
infrastructure amortized across 20–30 businesses, not a per-salon cost.

---

## 4. AEO Panel v1 — FROZEN

### 4.1 Questions

Six questions. First-person buyer phrasing (how a customer actually asks), not
publisher phrasing. `{city}` and `{state}` are the only variables. **Wording is frozen.**
Month-over-month comparison is invalid if wording drifts.

| # | Intent | Question |
|---|---|---|
| Q1 | General discovery | `What are the best nail salons in {city}, {state}?` |
| Q2 | Reputation / trust | `Which nail salon in {city}, {state} has the best reputation?` |
| Q3 | Service — gel | `Where should I go for a gel manicure in {city}, {state}?` |
| Q4 | Service — acrylic | `Where should I go for acrylic nails in {city}, {state}?` |
| Q5 | Service — pedicure | `Where should I go for a pedicure in {city}, {state}?` |
| Q6 | Booking convenience | `Which nail salon in {city}, {state} is easiest to book an appointment with?` |

**Why six and not two.** Service-specific questions demonstrably reshuffle the results.
On Grok, Lily Nails moved from #6 on the general question to #1 on the gel question, and
the engine stated the reason in its own text: Lily publishes gel pricing. General-question
results alone would have produced a materially wrong picture for four of the salons
observed.

**Market-specific optional questions** (max 3 additional, per market, versioned the same
way): luxury, walk-in, open late, bridal, budget, nail art. Add only when a market
justifies it. Never let a visitor generate a prompt.

### 4.2 Engines and run counts

Run counts are set by *measured* repeatability, not by uniformity. A volatile engine needs
more runs to produce a defensible number.

| Engine | Runs per question | Tier | Basis |
|---|---|---|---|
| Google AI Overview | 3 | Consumer (primary) | 2/2 identical set and order |
| ChatGPT | 8 | Consumer (primary) | Slot occupants rotate heavily; leader stable at 4/5 |
| Gemini | 5 | Consumer (primary) | Core stable, tail position churned between runs |
| Claude | 5 | Secondary | Not yet validated at n>1 — start at 5, adjust after first batch |
| Perplexity | 3 | Diagnostic | 5/5 set retention; only ranks 1–2 exchanged |
| Grok | manual, optional | Secondary | No clean automated path; question-sensitive |

**Scheduled observation counts — these are ceilings, not denominators.**

| Scope | Scheduled per question | Scheduled across the 6-question panel |
|---|---|---|
| Consumer tier (Google AI 3 + ChatGPT 8 + Gemini 5) | 16 | 96 |
| Secondary tier (Claude 5) | 5 | 30 |
| Diagnostic tier (Perplexity 3) | 3 | 18 |
| All tiers | 24 | 144 |

**The eligible denominator for any metric includes only admissible `response_observed`
observations** (see section 6). Scheduled counts are what the harness attempts; observed
counts are what it got.

**Every visibility figure reports both:**

> "Named in 9 of 14 observed consumer responses. 14 of 16 scheduled observations produced
> admissible responses."

This is not pedantry. Without it, a non-triggered AI Overview or a collection failure shows
up as a visibility change — the system would manufacture month-over-month movement out of
its own collection behavior. Owner-facing claims use the **consumer tier**; never quote an
all-tier figure as consumer reach.

144 scheduled observations per market scan is market infrastructure. It is not incurred per
salon.

### 4.3 Tier rules

- **Consumer tier** carries the stakes. It is what a local customer plausibly sees.
- **Diagnostic tier (Perplexity)** carries the explanation. It cites its sources, which is
  the only direct window into *why* a salon does or does not appear.
- **Secondary tier** adds coverage.

**Never blend tiers into a single weighted visibility score.** Weighting requires defending
arbitrary coefficients, and the tiers measure different things. Count within tiers and
report per-tier, with both denominators: *"named in 2 of 15 observed consumer responses;
15 of 16 scheduled observations produced admissible responses."* That requires no defended
assumption.

**Never present Perplexity performance as consumer reach.** Correct framing:
*"Perplexity shows us which sources the engines read. It is not where most of your
customers are."*

### 4.4 Surface fidelity — an API is not a consumer product

**The panel measures consumer surfaces, not models.** ChatGPT's API is not consumer
ChatGPT. Gemini's API is not the Gemini app. Google AI Overview is not an LLM API response
at all. Different retrieval, different grounding, different results.

**Rules:**

1. Capture the closest **unpersonalized version of the actual consumer surface**.
2. If that surface cannot be captured cleanly, an API result may be used **only** as a
   separate, explicitly labeled `proxy` configuration — never as a silent substitute.
3. Owner-facing claims may describe only the surface actually observed. A proxy observation
   may inform internal analysis; it may not be reported as consumer visibility.
4. **Surface type is pinned per market at panel freeze and never mixed across months.** A
   January proxy compared against an April live-surface capture produces a meaningless
   before/after — which destroys the one deliverable the recurring fee rests on.

Note that collection vendors expose both kinds of endpoint for the same engine (for example
a ChatGPT *scraper* alongside a ChatGPT *API model* endpoint). The distinction is real in
the plumbing, not just in theory. Record which one produced every observation.

If the exact consumer surface cannot be captured, **stop and report the limitation.** Do not
substitute a different configuration.

### 4.5 Google AI Overview is mandatory in the consumer tier

The highest-reach AI surface for a local buyer is not a chatbot. It is the AI answer that
appears above ordinary Google results. The customer does not have to change her behavior at
all — Google puts the AI answer in front of her. Any panel that omits this surface measures
the wrong market.

It is also a distinct product from the Gemini app: different triggering, different
grounding, different results. Testing one does not tell you about the other.

---

## 5. Engine profiles — measured, provisional

These profiles came from hand-runs on personalized consumer accounts. **They are evidence-
backed hypotheses, not settled facts.** The harness's first batch (section 18, step 3)
re-validates them using clean, unpersonalized captures of the **defined surfaces**. API
configurations are separate proxies and cannot validate claims about consumer surfaces (see
4.4). Do not print any of these mechanisms in a customer-facing report until clean-path
validation on the actual surface confirms them.

| Engine | Stability | Apparent ranking mechanism | Implied remedy |
|---|---|---|---|
| Google AI Overview | Deterministic | **Strong provisional hypothesis** — results are consistent with a ≥4.8 rating gate followed by review-volume ordering within tier (see Appendix A). Not yet causally established. | GBP strength; possibly rating repair *before* review volume — **do not state as advice until validated** |
| Perplexity | High; question-insensitive | Live web crawl + citations: own site, Yelp, Booksy/Square/Vagaro, local Facebook groups | Site structure, booking platforms, review platforms, community presence |
| Gemini | Core stable, tail churns | Mixed | Both workstreams |
| ChatGPT | Leader stable, cast rotates | Fills *slots* (best overall / value / designs / boutique); occupants cited via published menus | Publish priced service pages; claim an unowned slot |
| Grok | Question-sensitive | Google-weighted, responsive to published service pricing | Priced menus |

### 5.1 Observed consequences worth building around

**Supply chains, not one index.** Sorting engines by what they read explains nearly all
observed variance:

- Google presence *and* own website → named by every engine (2 salons out of ~25 observed)
- High Google review volume, weak web footprint → named only by Google-fed engines
- Website present, weaker rating → named only by web-crawling engines
- Weak on both → invisible everywhere

**Coverage does not require a decade of reviews.** One observed salon with roughly a
quarter of the market leader's review count appeared on every engine, because its web
footprint was strong. This is what makes the offer deliverable in months rather than years.

**Slot competition beats rank competition.** On ChatGPT, salons that own a slot own it
consistently; the unowned slots rotate through a different name every run. Claiming an
unowned slot with a priced service page is cheaper than displacing an entrenched leader.

**Engines pad thin categories.** A pedicure-and-foot-spa business was seated in a gel
manicure answer. Where the engine is stretching to fill a list, the seats are cheap.

**Engines recommend individual technicians by name.** This is a finding type nobody is
telling owners about, and a real retention risk: the AI can keep recommending a technician
who no longer works there.

---

## 6. Evidence store and provenance rules

Provenance failed three times in eleven hand-run observations while two analysts worked
from pasted text. At 144 observations per market per month, hand-mediated evidence handling
is not difficult — it is impossible. The evidence store is the reason the harness exists.

**Every observation record MUST carry:**

- `engine` and, where applicable, model/config identifier
- `question_id` and `panel_version`
- `market_id` and location context sent
- `run_index` within the scan batch
- `requested_at` and `received_at` (UTC)
- `raw_response` — complete, unmodified
- `citations[]` — every source URL the engine returned
- `personalization_state` — must be `clean` for any observation used in a report
- `surface_type` — `consumer_surface` or `proxy` (see 4.4)
- `observation_status` — one of:

| Status | Meaning | Counts in appearance denominators? |
|---|---|---|
| `response_observed` | The surface returned an answer | **Yes** |
| `surface_not_triggered` | The surface did not render (e.g. Google showed no AI Overview) | **No** |
| `collection_failed` | Request or parse failure | No |
| `inadmissible` | Missing provenance, or personalized | No |

**Only `response_observed` enters any denominator.** Counting a non-triggered surface as
"absent" would score a salon as invisible on a query where the AI product never appeared at
all.

`surface_not_triggered` is itself a finding, not a null. If AI Overviews rarely fire for
nail queries in a market, the AI layer is not intercepting that search — which is honest,
useful information about what the pitch is worth on that query. Report the trigger rate.

**Hard rules:**

1. An observation with missing engine, question, version, or timestamp is **inadmissible**
   and must never enter a report.
2. Raw responses are immutable. Parsed results are derived artifacts and may be
   recomputed; raw text is never edited.
3. Observations from personalized consumer accounts may be used for internal validation
   only, and must be flagged. They can never be cited to an owner.
4. One evidence store. Both analysis and reporting read from it. Nothing is reconciled by
   hand.

**Personalization is a real contaminant, not a theoretical one.** In testing, one engine
answered a market question with knowledge of the operator's own business. Consumer engines
answer through the lens of the account's history. **A clean, unpersonalized capture of the
defined surface is the valid baseline. An API path is admissible only as a separately
labeled proxy** (see 4.4).

**This also arms the field objection.** A salon owner will say "but I asked ChatGPT and it
named me." Of course it did — it has watched her search for her own salon for years. The
scan measures the clean baseline, which is what a new customer with no history most closely
resembles. Script this answer.

---

## 7. Scoring schema

### 7.1 Visibility states (per salon, per question, per engine, per run)

| State | Definition |
|---|---|
| `primary` | Named as a recommendation with position in the main list |
| `peripheral` | Mentioned outside the main list (secondary options, community footnote) |
| `cited_not_named` | The business's site appears in citations but the business is not named |
| `absent` | Not present in the response |

`cited_not_named` is a distinct and commercially valuable state: the engine already knows
the business and something in the content lost the cut. These are often the best prospects.

### 7.2 Metrics (per salon, per question, per engine, per scan)

- Appearance frequency (`n` of `runs`)
- First-position frequency
- Median rank (only where `primary`)
- Rank range
- Prominence distribution across the four states

**Report frequency, not single-run rank.** Never: *"You rank #1 on Perplexity."*
Always the generic format: *"Named in {observed_appearances} of {observed_runs} observed
responses ({observed_runs} of {scheduled_runs} scheduled produced admissible responses),
ranked {rank_low}–{rank_high}, first in {first_place_count}."*

(The five-run phrasing used during validation was a historical artifact of the Perplexity
stability test. Panel v1 schedules 3 Perplexity runs. Do not hardcode any run count into
report copy — render from the actual observed and scheduled counts.)

### 7.3 Classification

**Evaluate in order. First match wins — each result receives exactly one primary class.**

| # | Class | Rule |
|---|---|---|
| 1 | Consistent leader | `primary` in all runs **and** median rank 1–2 |
| 2 | Core recommendation | `primary` in ≥ 80% of runs |
| 3 | Peripheral | `primary` or `peripheral` in 40–79% of runs |
| 4 | Occasional | `primary` or `peripheral` in > 0% and < 40% of runs |
| 5 | Cited, not recommended | Never `primary` or `peripheral`, `cited_not_named` in ≥ 1 run |
| 6 | Not observed | Absent from all runs |

All percentages use `response_observed` runs as the denominator.

**Minimum observations.** A primary classification requires **at least 2** `response_observed`
runs for that engine-question combination. The strongest class — *consistent leader* —
requires **at least 3**, because "first in 1 of 1 runs" is technically consistent and
statistically worthless.

Below the threshold, classify as `insufficient_observations` and report the raw observations
only. A scan is **incomplete** until each engine-question pair meets its configured run count
or the shortfall is disclosed in the report.

Classification is computed per engine and per question. A salon can be a consistent leader
on one surface and not observed on another — this is the normal case, and it is the finding.

### 7.4 Rank reporting

**Never report a single observation as the salon's rank.** Where ordering varies, report the
rank *distribution* — rank frequency, median, and range — when sample size permits. This is
the measurement the design exists to produce; do not suppress it.

A qualitative rank **band** ("consistently top three") may be used only where the current
scan demonstrates sufficiently stable ordering on that engine. Where ordering is unstable,
report the distribution and say so — not a band, and not silence.

---

## 8. Accuracy audit — a separate dimension

Visibility and accuracy are independent measurements. A confidently repeated error is
commercially more important than a one-off hallucination: it is stable, attributable, and
provably fixable in the next rescan.

**Observed error classes to detect and store:**

- Conflicting addresses for the same business across engines
- Conflicting ratings and review counts (one business varied roughly 2× in reported review
  count between engines)
- Ratings or claims attributed to citations that do not support them
- Business hours stated inconsistently or self-contradictorily
- Service types conflated (standard gel, structured gel, hard gel, Gel-X, gel pedicure
  treated as interchangeable)
- Prices quoted that do not match the published menu
- Technicians named who no longer work there
- Positioning claims ("luxury") with no evident support

**Claims are distributions, not facts.** Descriptive blurbs churned between runs even on
engines where the ranking was frozen — one engine rewrote every salon's description between
two runs minutes apart, and a praised technician's name changed. Therefore:

> Never quote to an owner what an engine "says about you" based on a single run. Accuracy
> findings require the same frequency framing as visibility findings.

**Ground truth** comes from DataForSEO collection (ratings, review counts, addresses, hours)
and from the owner's own confirmation. Engine claims are compared against ground truth;
divergence is the finding.

**Named-business queries** (`Tell me about {business} in {city}`) are **client-only**, run
in the monthly rescan. Prospect economics stay market-scoped. Note that market responses
already yield free accuracy data for the businesses they name; named queries are needed
only for businesses that are invisible.

---

## 9. Local comparable set

**Purpose:** local empirical benchmarks. National nail-salon benchmarks are thin, and an
owner who lives this business will spot one wrong number instantly. Local observed data is
verifiable, defensible, and cannot be disputed by someone who knows the market better than
we do.

**Collect per market (10–12 comparable salons minimum):**
published service prices, service positioning, appointment durations where published,
booking availability and platform, review volume and rating, promotions/packages/
memberships, hours, booking friction.

**Source priority:** booking platforms first (Booksy, Square, GlossGenius, Vagaro), then
own website, then aggregators. Nail salons publish structured menus on booking platforms far
more reliably than on their own sites — and the engines demonstrably read those platforms.

**Every comparison MUST state:** geographic radius, number of comparable salons, data date,
observed range, median, and any comparability limitation.

Example of correct output:

> Eleven nearby salons publish gel manicure prices. Observed range $30–$65, median $40.
> Your published price is $35. Before changing it, confirm whether your service duration and
> materials are comparable.

**A new price-position finding type is now available:** what the engines *tell customers* a
service costs in this market. A salon priced well above the range the AI quotes is meeting
pre-anchored customers.

**For the Easley pilot: seed the comparable set by hand, once.** One afternoon covers the
market and it serves every Easley scan. Automate collection when the second metro is added
— that is when "more than once" applies.

---

## 10. Salon public profile

Built before the owner is asked anything. Collected per business, 30–90 day cooldown.

Business identity and location · hours · contact channels · website and booking access ·
service menu · published prices · appointment durations where published · packages and
promotions · review rating and volume · recurring review themes · social positioning ·
booking friction · obvious inconsistencies.

**Every field carries a provenance label:** `publicly_observed`, `owner_confirmed`,
`owner_corrected`, `calculated`, `inferred`, `unknown`. Every public fact retains its source
URL and retrieval date.

**Entity identity:** use the Google Knowledge Graph ID (`kgmid`) as the canonical entity key
where available — the Google AI surface returns it directly, which solves alias matching on
that surface. Maintain an alias table for everything else; engines vary business names
materially and have been observed hedging their own name matches. Hand-confirm aliases during
the first 20 manual report reviews, then encode the rules.

Deduplicate by kgmid, then website, then phone, then address.

---

## 11. Owner interview

**Design constraint: completion rate.** The owner takes this on her own time, on her phone,
likely at night after a shift. Self-serve forms bleed hard after 5–7 questions. Completion
rate outranks question quality as a design constraint.

**Order of the experience:**

1. **Research profile first.** "Here is what we found about your salon." People will scroll
   through someone else's research about themselves. This creates the momentum that carries
   into the questions.
2. **Confirm-or-correct taps.** These should outnumber open questions. Confirming research
   is fast and flattering; answering from scratch is homework.
3. **Three essential questions** unlock the preliminary report.
4. **Up to three adaptive follow-ups** unlock the full report.

### 11.1 The three essential questions

All tappable. None answerable from public research. Together they diagnose whether this is a
demand problem, a conversion problem, or a retention problem.

**Q1 — Goal.** *"What do you most want to improve in the next 90 days?"*
More new customers · Fill slow times · Get customers coming back more often · Raise average
ticket · Fewer no-shows · Something else

**Q2 — Capacity.** *"If more customers came in this week, could you take them?"*
Yes, plenty of room · Some room · Only at certain times · No, we're full

**Q3 — Retention mechanism.** *"When a customer checks out, does someone book her next
visit?"*
Every time · Sometimes · Rarely · Depends on the tech · Not sure

New-customer source is inferred from research. "Biggest current frustration" becomes the
**first adaptive follow-up** (free text, optional) — free text cannot live in a tap-only
minimum.

### 11.2 Mechanics

- Save after **every** answer, not per page
- Stable continuation link (critical, not optional — partial completion is the normal case)
- "Not sure" is always available and always a first-class answer
- Ranges as buttons; typing only where unavoidable
- Short pages, plain language, short sentences. A meaningful share of owner-operators in
  this vertical speak English as a second language. This is completion mechanics, not polish.
- **Each answer visibly increases readiness, without disclosing analysis.** Show what the
  answer unlocks and how complete the review is — *"This lets us assess your capacity.
  3 findings ready."* — never the finding itself. Counts and coverage motivate; content is
  gated until verification (15.1). The earlier design showing findings sharpen live on
  screen is **withdrawn**: it disclosed interview-derived judgment to an unverified user.

### 11.3 CED-assisted mode

There is no separate UI. It is the same self-serve form, tapped through beside an owner or
on a call. Zero additional code.

---

## 12. Analysis engines and calculation rules

Six analysis areas, run behind one coherent experience:

1. Customer acquisition and response
2. Booking and conversion
3. Capacity and scheduling
4. Retention and rebooking
5. Service mix and pricing
6. Reputation and market positioning

AEO belongs in area 6. AI and CED recommendations come after all six.

**Calculation gates — deterministic, non-negotiable:**

- Unknown never becomes zero
- Partial data is labeled partial
- Incompatible inputs are never combined
- A share cannot exceed 100%; comparable shares must total approximately 100%
- Ranges remain ranges through the entire calculation
- A finding derived from four offerings cannot claim to describe five
- Unsupported financial calculations are **suppressed**, not estimated
- No recommendation rests solely on an industry benchmark

Every calculation records: inputs used, denominator, data coverage, assumptions, confidence,
and whether values were exact, ranged, or estimated.

When data is insufficient, say so plainly:

> There is not enough comparable information to estimate revenue contribution reliably.
> Based on demand, appointment time, published pricing and your answers, these services
> deserve closer review.

That is still useful, and it is honest.

---

## 13. Report specification

### 13.1 Preliminary report (3 questions answered)

**Requires verification (15.1) before display.** Public research findings · AEO visibility ·
local price position · evidence limitations · two preliminary decisions · the three remaining
questions that would deepen the analysis.

### 13.2 Full report

1. **Executive judgment.** Lead with the answer, not scores. *"Your clearest near-term
   opportunity is rebooking and weekday capacity. More advertising is not the first move,
   because you appear to have demand and an inconsistent process for converting visits into
   future appointments."*
2. **Business snapshot.** Model, stated goal, market position, capacity condition, customer
   flow, evidence coverage, material uncertainties.
3. **What appears to be working.** Credit where supported.
4. **What deserves attention.** Each finding carries: the finding · why it matters ·
   evidence used · confidence · what remains uncertain · the recommended decision.
5. **Market position and AI discoverability.** Questions tested, engines tested, geography,
   panel version, run counts, appearance frequency, competitors named, accuracy findings,
   scan date, raw evidence retained.
6. **Service positioning.** Roles, not a single ranked number: demand leader · contribution
   leader · retention driver · capacity-heavy · add-on opportunity · bundle opportunity ·
   pricing-review candidate · strategic specialty · measurement gap. A service may hold
   several roles.
7. **The three most important decisions.** Not ten tips. Each with: action · expected effect
   · why it ranks here · effort · cost level · confidence · owner · success measure.
8. **What not to do yet.** Mandatory. At least one. This section does more for trust than
   any other.
9. **90-day action plan.** Days 1–7 corrections and measurement; 8–30 the highest-priority
   operational fix; 31–90 measure, refine, decide the next investment.
10. **Best-practice recommendations.** Non-technical operational improvements first.
11. **AI and automation opportunities.** Each classified: use now · automate with controls ·
    fix the process first · keep human-controlled · not currently recommended.
12. **CED Service fit.** One of three honest conclusions: strong fit · possible fit ·
    no current fit. Required wording pattern: *"CED Service can help implement this, but the
    business improvement is the priority. You can also implement this internally."*
13. **What would improve the analysis.** Two or three items maximum. Never a bookkeeping
    assignment.

### 13.3 Findings are reusable sales assets

Each finding gets a stable link and feeds the five-touch outreach sequence: AEO visibility,
price position, booking friction, review themes, retention opportunity. An abandoned
questionnaire is also a touch: *"Three questions left and your report is ready."*

### 13.4 Delivery

Renders immediately in browser · saved to the permanent business record · stable
continuation link · downloadable PDF.

**Email status is four distinct stored states — provider acceptance is not delivery:**

| State | Meaning | What the UI may say |
|---|---|---|
| `accepted` | Provider accepted the message | "Sent to your email provider" |
| `delivered` | Delivery confirmed by provider callback | "Delivered" |
| `bounced` | Rejected by the recipient's server | "Could not be delivered" |
| `failed` | Send attempt failed | "Could not be sent" |

Never display "delivered" on acceptance alone. On bounce or failure: *"Your report is ready,
but the email could not be delivered. Download it now or retry delivery."*

The report never depends on email.

---

## 14. Free / paid boundary

**Give away the knowing. Sell the doing.**

**Free** (the full report, including the 90-day plan): cached market AEO position, cached
local price position, public research findings, three decisions, at least one "do not do
yet," best-practice guidance, honest CED fit, and the 90-day action plan.

The 90-day plan stays free. It is what makes *"you can also implement this internally"*
credible, and credibility is the entire mechanism of this offer.

**Paid:** fresh market scans on demand · **monthly rescans and the before/after proof loop**
· trend reporting · named-business accuracy audits · custom competitor sets · implementation
· consultant review.

**The monthly rescan is the product that defends a recurring fee.** Both denominators travel
with every comparison:

> "January: named in 1 of 14 observed consumer responses (14 of 16 scheduled).
> April: 11 of 16 observed (16 of 16 scheduled)."

That comparison only works if the panel version, wording, engines, run counts, location
context, **and surface type** never drift — and if collection shortfalls are visible rather
than absorbed into the numerator. This is why section 4 is frozen.

---

## 15. Access, authorization, and cost control

### 15.0 Authentication is not authorization

Identifying a user does not establish that they may see a given business's report. These are
two separate controls, and v1 needs both:

- **Authentication** — who is this person?
- **Authorization** — which business records may this person access?

**The v1.2 rule "first completion claims the record" is a loophole and is withdrawn.**
Holding the link must not confer ownership.

**Public / private boundary:**

| May be public | Requires verified authorization |
|---|---|
| Basic public business profile | Full visibility report |
| Facts already available from public sources | Specific weaknesses and corrective recommendations |
| Limited visibility preview | 90-day action plan |
| General market trends | Owner-confirmed facts and corrections |
| Aggregate or anonymized benchmarks | Interview answers, service mix, capacity |
| | Report history and CED implementation recommendations |

**Blunt rule:** *Public facts may be compared. Private intelligence belongs exclusively to
the verified business that supplied or received it.*

Note this rule governs the **base product**, not merely a future benchmark offering. Every
report names competitors by design — the AEO finding is inherently comparative. That is
legitimate: those are public observations. The line is not "never mention another business."
The line is "never expose another business's private data."

### 15.1 Claim and verification flow

1. CED creates an unclaimed Business Record from public evidence.
2. CED prepares the private report for that business.
3. The QR code **identifies** the record. It does not unlock it.
4. The recipient verifies authority to represent the business.
5. Access is granted to **that record only**.
6. All other records remain inaccessible.

**Verify late, not early.** Verification before the interview destroys the completion rate
the entire interview design exists to protect. But **no interview-derived judgment may be
displayed before verification.** The single unambiguous rule:

> Verification occurs **after** the owner submits the three essential questions and
> **before** any personalized report — preliminary or full — is displayed.

**Ordered flow:**

| # | Stage | Verification | What the user sees |
|---|---|---|---|
| 1 | Public snapshot | No | Public research, AEO position, price position |
| 2 | Three essential questions | No | Progress and readiness counts only (11.2) |
| 3 | Readiness confirmation | No | *"Your personalized findings are ready."* No content. |
| 4 | **Verification gate** | **Yes** | — |
| 5 | Preliminary report | Verified | Full preliminary report |
| 6 | Adaptive follow-ups → full report | Verified | Full report |

Before verification the user may see the public snapshot and confirmation that answers were
saved. They may **not** see interview-derived judgments, weaknesses, recommendations, or
plans. Placing the gate after the interview means the owner has already invested effort,
which makes her more likely to complete verification.

**Verification methods, in priority order for this vertical:**

1. **Operator attestation** — CED delivered the QR to the owner in person and confirms it.
   Primary path for the pilot, first-class rather than a fallback. **Attestation authorizes a
   specific authenticated person, not the holder of the QR code.** Record who was met and
   bind the grant to that person's phone-verified account; otherwise the QR remains
   transferable after CED leaves.
2. **Code to the publicly listed business phone** — most nail salons publish a phone, not an
   email. Phone-first is correct for this market.
3. Invitation to an email published on the business's official website or Google profile.
4. Matching company-domain email.
5. Manual review where automation is inconclusive.

"I work there" is never sufficient. Employees may not be authorized to receive strategic
findings.

**Handoff wording.** Not *"Log in to retrieve it."* Instead:

> *"Verify that you're authorized to represent the salon, and the report will be added to
> your private business account."*

### 15.2 Unverified submissions are quarantined

An unverified link holder — a competitor, a passing employee, or simply the wrong staff
member — must not be able to write into a real salon's permanent record. Deferring
verification without quarantining input would let anyone poison the Business Record with
answers like *"we're full"* or *"we never rebook."*

> Before verification, interview answers and proposed corrections are stored as **unverified
> session submissions**. They must not update owner-confirmed facts, permanent interview
> history, calculations, or reports. On successful authorization the submission is bound to
> the verified user and **promoted** into the Business Record. Rejected or abandoned
> submissions remain quarantined and expire per retention policy.

Never write into `interviews` or `business_profiles` before verification succeeds. This also
protects against the far more common accidental case: the wrong person at the salon filling
it out with wrong information.

**Retention — 30 days.** Long enough to survive a busy week and support the Day 5 / Day 10
follow-up touches; short enough that unverified, possibly hostile submissions do not sit
around until the 90-day reassessment.

> Unverified sessions expire **30 days after the most recent user activity**. Each saved
> answer, proposed correction, or verification attempt updates `last_activity_at` and
> recalculates `expires_at`. **Automated reminders and link opens do not extend retention.**
> On expiry, the session's answers, proposed corrections, and continuation token are
> permanently deleted. Minimal non-content audit data may be retained for security and funnel
> measurement. A returning user begins a new session against the current public profile.

**Promotion is atomic, and leaves no second copy.**

> After verified answers and corrections are successfully written to the Business Record, the
> quarantined payload is deleted in the same transaction. Retain only
> `promoted_from_session_id` and minimal promotion audit metadata.

Two copies of the same private information is a needless second exposure surface. There
should never be a window where the record and the quarantine both hold it.

### 15.3 Cross-tenant data firewall — MANDATORY

This is the most dangerous leak path in the system, and no access control prevents it.

Once several salons in one market complete interviews, the platform holds private
operational data about multiple direct competitors in a small geography. An analysis engine
with unrestricted read access could emit a sentence like *"unlike other salons nearby, you
have weekday capacity"* — which discloses another owner's answer inside a report she never
consented to.

**Rules:**

1. **The report-generation and AI-analysis components never receive an unrestricted database
   connection or arbitrary query capability.** "Enforce at the query layer" means this
   specifically — a promise to filter responsibly inside a component that *can* read
   everything is not enforcement.
2. They receive a server-built **`ReportContext` scoped to one `business_id`**:

```
ReportContext
  subject_private_data     # X's verified interview, corrections, private findings
  subject_public_data      # X's public profile, ground truth, mentions
  market_public_data       # AEO observations, comparable set, competitor PUBLIC facts
  evidence_provenance      # sources, timestamps, admissibility
```

   There is **no `competitor_private_data` property at all.** Another business's private
   records must be structurally unreachable through this interface, not merely unselected.
3. Aggregate benchmarks derived from interview data are prohibited in v1. Revisit only with a
   documented minimum-cohort threshold and explicit owner consent.
4. Whether a competitor opened, completed, or acted on their report is never exposed.

**Canary acceptance test — required, and it must pass before pilot:**

Seed a distinctive private value into competitor B's interview. Generate every report and
analysis artifact for business A. Assert that B's interview row was never queried or loaded,
and that the canary string appears in **none** of: the generation context, the report, the
PDF, application logs, model prompts, or traces.

Detecting a leak by reading the finished report is too late — by then the model has already
been handed the data. The test verifies the boundary, not the output.

### 15.4 Trigger and cost control

**Lock the trigger, not the links.** If the only way a scan runs is an authorized batch,
there is no endpoint a stranger can make expensive. A leaked link cannot spend anything — it
can only open a report that already exists.

**Three access states:**

1. **Pre-researched prospect.** Claim link opens an already-complete public snapshot. No live
   scan ever fires on link open. The full private report requires verification (15.1).
2. **Unknown salon in a researched market.** Capture, verify, notify the operator, one-tap
   approve into the next batch. (v1 does not auto-collect on link open — that reintroduces
   an enumeration surface. Automate on the second occurrence, not the first.)
3. **Salon in an unresearched market.** Preliminary review from public data plus the three
   questions, and honest labeling: *"We have not yet completed our local AI visibility and
   pricing study for your market."* Then capture demand — notify me, request priority,
   refer a local salon, schedule a review.

**A leaked link is one salon owner showing your work to another. That is the referral you
want.** The fix is not prevention; it is making sure the landing spot captures demand instead
of spending money.

**v1 controls — exactly three:**

1. Admin-only scan execution
2. Cost estimate and explicit approval before every batch: *"18 salons, existing Easley
   market scan, 18 profile collections. Estimated maximum: $X. Approve?"*
3. Verification before creating any unknown-salon record

**Deferred to v2** (enterprise budget machinery for a system with zero users): demand
thresholds, referral credits, markets-per-month caps, automatic budget shutdown.

**Reality check on cost:** a 144-observation market scan is small money. The lock exists for
funnel control, evidence hygiene, and clean comparables — not primarily for the bill.

**Batch timing:** scan a market roughly one week before walking it, so report dates read
fresh.

**City sequencing:** Easley now. Liberty when the route moves. City gating falls out of
"which list was authorized," not a feature.

---

## 16. Report acceptance

### 16.1 Deterministic gate (build now)

Before any report is released, verify automatically:

- All arithmetic valid; percentages use consistent denominators
- Every personalized claim has evidence attached
- Facts, inferences, and estimates are distinguished
- No unknown was converted to zero
- Partial coverage disclosed
- Recommendations do not contradict stated capacity
- Every AEO claim traces to admissible observations with `personalization_state = clean`
- No single-run rank is asserted anywhere
- Every visibility figure carries both observed and scheduled counts
- No classification is asserted below its minimum-observation threshold (7.3)
- Any engine-question pair short of its configured run count is disclosed in the report
- **No private data belonging to another business appears anywhere in the report** — every
  comparative statement traces to a public-source record (15.3)
- The report was generated from a `ReportContext` scoped to this `business_id`; the canary
  test passes for the current build (15.3)
- No unpromoted session submission contributed to any finding (15.2)
- The recipient's authorization for this business record is verified and current (15.1)
- Report contains ≥ 3 business-specific findings, 3 decisions, ≥ 1 "do not do yet", and a
  90-day plan
- CED fit corresponds to a documented need
- Email status is truthful

On failure: hold and regenerate, or escalate. The owner must never be the QC tester.

### 16.2 Human gate (first 20 reports)

The operator reviews every one of the first 20 reports before delivery, and **logs every
correction made**. Those logged corrections become the automated acceptance rules. Encoding
QC before observing a real failure is automating a process that has never been run.

---

## 17. Data model — new entities only

**This is not a replacement schema.** These are the *minimum new entities* the review
requires, expressed generically. Map each onto the existing Supabase schema rather than
creating a parallel one:

- `businesses` here corresponds to the existing **`business_records`** — extend it; do not
  create a second business table.
- `users`, `reports`, and `interviews` must likewise be reconciled with existing equivalents
  before any migration is written.
- The genuinely new areas are **scans, engine configurations, observations, mentions,
  ground truth, review sessions, and authorizations.**

Field names below are indicative. Conform to the repository's existing naming and migration
conventions. Report any collision that cannot be resolved by extension.

```
markets(id, city, state, status, authorized_at)
panel_versions(id, category, version, frozen_at, notes)
panel_questions(id, panel_version_id, question_key, intent, template)
engines(id, key, tier, default_runs_per_question)

-- Configuration records are IMMUTABLE. If a product, model, vendor, or
-- capture method changes, create a NEW configuration row. Never edit an
-- existing one — month-over-month comparison depends on knowing exactly
-- what produced each observation.
engine_configurations(id, engine_id, surface_type, product_name,
                      model_identifier, capture_method, collector_version,
                      configuration_json, created_at)

-- Pins which configurations a frozen panel version uses, and at what volume.
panel_engine_configurations(panel_version_id, engine_configuration_id, tier,
                            scheduled_runs_per_question)

scan_batches(id, market_id, panel_version_id, status, estimated_cost,
             approved_by, approved_at, started_at, completed_at)
observations(id, scan_batch_id, engine_configuration_id, panel_question_id,
             run_index, market_id, location_context, personalization_state,
             surface_type, observation_status,
             requested_at, received_at, raw_response, citations_json)

-- ADMISSIBILITY IS DERIVED, never stored independently. Evidence
-- admissibility is derived from: required provenance completeness,
-- personalization_state, observation_status, and configuration validity.
-- Owner-facing CONSUMER visibility metrics additionally require
-- surface_type = 'consumer_surface' AND the panel's pinned engine
-- configuration. Any manual override requires a logged reason.
businesses(id, kgmid, name, address, phone, website, booking_url, market_id)
business_aliases(id, business_id, alias, source, confirmed_by, confirmed_at)
mentions(id, observation_id, business_id, state, rank, blurb, claims_json)
business_profiles(id, business_id, collected_at, fields_json, provenance_json)
comparable_sets(id, market_id, category, collected_at, method, notes)
comparable_items(id, comparable_set_id, business_id, service, price,
                 duration, source_url, retrieved_at)
ground_truth(id, business_id, field, value, source, retrieved_at)
claims(id, mention_id, field, engine_value, ground_truth_value, verdict)
-- QUARANTINE. Nothing is written to interviews/business_profiles until
-- verification succeeds and the session is promoted (15.2).
review_sessions(id, business_id, continuation_token_hash, started_at,
                last_activity_at, completed_at, verification_status,
                verified_user_id, promoted_at, expires_at)
-- expires_at = last_activity_at + 30 days, recalculated on each user action.
-- Reminders and link opens are NOT user actions.
session_answers(id, review_session_id, question_key, value_json, answered_at)
proposed_corrections(id, review_session_id, field, proposed_value, status)
-- status: pending | promoted | rejected | expired

interviews(id, business_id, started_at, completed_at, answers_json, status,
           promoted_from_session_id)

-- AUTHORIZATION. Access is per business record, never global.
users(id, email, phone, created_at)
business_authorizations(id, business_id, user_id, role, verification_method,
                        verified_by, verified_at, revoked_at)
-- verification_method: operator_attested | phone_code | published_email |
--                      domain_email | manual_review
-- role: owner | manager | authorized_rep
-- Grants are per business_id. There is no cross-record grant.
reports(id, business_id, level, generated_at, gate_result, content_json,
        pdf_url, email_status)
report_reviews(id, report_id, reviewer, corrections_json, reviewed_at)
```

---

## 18. Build order

1. **Repair the two trust failures.** Contradictory arithmetic, and false email messaging.
   (The email failure is confirmed: the platform tells visitors results are delivered by
   email while no email provider exists in the repository.) Nothing ships before this.
2. **Build the minimum scan harness and evidence store.** Admin-triggered, cost-estimated,
   provenance-complete, on Vercel Functions + Supabase Postgres. This is the unblocking
   dependency for everything else, and it is built here — there is no scanner to port.
3. **Run consumer-surface capture validation** for Easley — Panel v1, full run counts, no
   personalization, using the closest unpersonalized version of **each defined consumer
   surface** (see 4.4). Do not substitute an API model for a consumer product without
   recording it as a separate configuration labeled `proxy`.
4. **STOP AND REPORT — mandatory gate.** Report which required consumer surfaces are
   reproducibly capturable, the capture method, personalization controls, configuration
   identifiers, repeatability evidence, and any limitations. Confirm or correct the engine
   profiles in section 5. **If any required surface is not reproducibly capturable, stop and
   report the limitation rather than redesigning the measurement method.** Note that §19
   already flags Google AI Overview capture as open and Grok as having no clean automated
   path — a negative finding here is a valid and useful outcome, not a failure.
5. **Proceed to downstream interfaces only after explicit approval** of the step 4 report.
6. **Seed the Easley comparable set** by hand (one afternoon, 10–12 salons).
7. **Build the snapshot** — public research + AEO position + price position.
8. **Build the interview** — research profile, confirm-or-correct, 3 essential + adaptive
   follow-ups, save-per-answer, quarantined submissions, stable continuation link.
9. **Build the report** — judgment first, three decisions, what-not-to-do, 90-day plan,
   honest CED fit. Deterministic acceptance gate and canary test wired in.
10. **Generate and manually review the first 20 reports.** Log every correction.
11. **Pilot with five Easley salons.** Record reactions and questions verbatim. **Instrument
    this funnel from day one:** essential questions completed -> verification started ->
    verification completed -> adaptive follow-ups completed. Withdrawing the live
    finding-sharpening mechanic (11.2) weakened the pull toward questions 4-6, and
    verification is the only deliberate friction in the flow. This funnel shows which one is
    actually costing completions. Fix with better gate copy — not by reopening the
    pre-verification disclosure rule.
12. **Encode repeated corrections** as automated acceptance rules.
13. **Expand** — Liberty batch, then a second vertical, only after the launch standard is met.

---

## 19. Deferred / open

- **Meta AI** — demographically right for this market, but account-bound personalization
  makes a clean baseline impossible today. Park it; revisit if an unpersonalized path appears.
- **Grok** — no clean automated path. Manual spot-checks only; never a scored channel in v1.
- **Claude run count** — set at 5 provisionally; not validated at n>1. Adjust after the
  first clean batch.
- **AI search volume** — pull estimated AI search volume for the panel keywords via
  DataForSEO so the pitch claims what the data supports rather than what the demo implies.
  Verify field availability at build time.
- **Google AI Overview capture path** — verify current DataForSEO SERP field coverage for AI
  Overview content and citations before committing to the collection method.
- **Second-vertical generalization** — explicitly out of scope until the launch standard is met.
- **v2 budget machinery** — demand thresholds, referral credits, market caps, auto-shutdown.
- **Tiered access matrix** — a formal public / verified-owner / benchmark-customer / admin
  matrix is v2. v1 needs exactly two states: public snapshot, and verified access to one
  business record.
- **Competitive benchmark product** — a paid product comparing a client against named
  competitors on *public* observations only (recommendation frequency, published prices,
  ratings and review volume, website clarity, booking visibility, public positioning,
  information consistency) is legally and ethically clean, and there is real demand for it.
  It must exclude the private data defined in 15.0 and protected by 15.3.

  **Deferred past the pilot for a business reason, not a legal one.** Easley is small and
  these salons sit on the same highway. If Salon A learns CED sold analysis of them to
  Salon B, A is lost permanently — and trust is the entire basis of the offer. Selling to
  both sides of a small market is a reputational trade. Decide it with owner relationships
  in hand, not in advance.
- **Aggregate benchmarks from interview data** — prohibited in v1 (15.3). Requires a
  documented minimum-cohort threshold and explicit owner consent before reconsideration.

---

## 20. Launch standard

Build this for nail salons only. Do not generalize to another vertical — including dental —
until Easley salon owners consistently say:

> *"This told me something important about my business, and I know what to do next."*

That is the bar. Nothing else — not report volume, not deploy count, not a finished feature
list — substitutes for it.

---

## Appendix A — Easley ground-truth snapshot

**Source:** Google Business listings via DataForSEO. **Retrieved 2026-08-09.**
Review counts drift; every ground-truth record carries its own retrieval timestamp and is
never treated as permanent.

| Salon | Rating | Reviews | Website | Named by Google AI? |
|---|---|---|---|---|
| TLC Nails & Spa | 4.8 | 2,002 | no | yes (#2) |
| The Nail Zone | 5.0 | 1,528 | no | yes (#1) |
| VIP Nails & Spa | 4.2 | 1,443 | yes | no |
| Super Nails & Spa | 4.7 | 1,230 | no | no |
| Pro Nail | 4.8 | 1,117 | yes | yes (#3) |
| Solar Nails | 4.4 | 663 | yes | no |
| Angel Nails | 4.6 | 450 | yes | no |
| Lily Nails | 4.8 | 364 | yes | yes (#4) |
| I Luv Nails | 4.8 | 256 | yes | no |
| Nail Tech Academy | 4.7 | 215 | yes | no |

### What this establishes — and what it does not

**Verified:** the ratings, review counts, addresses, and website presence above are ground
truth as of the retrieval date. These are facts.

**Strong provisional hypothesis — NOT confirmed:** sorting by rating tier, then by review
volume within tier, reproduces the four-salon Google AI output in exact order. VIP is absent
at 4.2 despite 1,443 reviews; Super Nails is absent at 4.7 despite 1,230. That pattern is
*consistent with* a ≥4.8 rating gate followed by volume ordering.

It does not prove the mechanism. It rests on two observations from a personalized account,
and a matching pattern is not a demonstrated cause. **Confirm through the clean validation
batch before printing the mechanism — or the "rating repair before review volume" remedy —
in any owner-facing report.**

(I Luv Nails at 4.8/256 did not appear in either observed run, which is consistent with
volume ordering inside the tier. Also n=2. Same gate applies.)

**Supply-chain pattern, also provisional but strongly indicated.** The two review leaders —
TLC (2,002) and Nail Zone (1,528) — have **no website**, and both appeared only on
Google-fed engines while absent from the web-crawling engines. Pro Nail and Lily have strong
Google presence *and* a website, and were the only two salons named across every engine
tested. All ten businesses fit the 2×2 in section 5.1. Validate on clean surfaces before
building advice on it.

**Engine claims drift from ground truth — this part is verified.** Engines cited Nail Zone
at 1,585 and 4.9 where Google reports 1,528 and 5.0; I Luv Nails was cited at both ~260 and
~500. Accuracy findings are real and measurable, and ground truth must be re-pulled per scan,
never cached indefinitely.

**Commercial read for the Easley route (planning use, not report copy).** Every salon in this
table except Pro Nail and Lily shows a gap on at least one major surface, and the two largest
businesses in the market show the largest gaps.
