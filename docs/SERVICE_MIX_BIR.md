# Service Mix BIR v5

The point-in-time report a Quick Service Mix Review produces. Companion to
[BUSINESS_INTELLIGENCE_REPORT.md](BUSINESS_INTELLIGENCE_REPORT.md), which
describes the Growth BIR and remains the authority for it.

> Every figure here is a diagnostic estimate. Nothing in this document is
> accounting, tax, legal, or regulatory advice, and no claim of compliance
> with any law or regulation is made.

---

## 1. Why a second version rather than a second section

The Growth BIR is at `schemaVersion: 4` and describes an operational
diagnosis: a Growth Score, an opportunity range, close readiness, a package.
None of that applies to a service-mix portfolio, and bolting an optional
`serviceMix` block onto v4 would mean every Growth report gaining a section
that is always null and every consumer learning to ignore it.

So Service Mix is `schemaVersion: 5` with `reportType: "service_mix"`, and
**Growth reports stay at v4 and stay immutable**. `BIR_SCHEMA_VERSION` in
`report.schema.js` is still `4`; it is the Growth generator's version and was
not bumped. The version a review type produces is declared by the review
registry, not by a single global constant.

`reportVersion: 1` is separate again: it is the version of the *Service Mix
analysis*, and it moves when the calculations or the classifier change, which
is more often than the structural schema will.

---

## 2. Envelope

```js
{
  schemaVersion: 5,
  reportType: 'service_mix',
  reportVersion: 1,
  …
}
```

`reportType` is what a consumer must branch on. A reader that assumes
`schemaVersion >= 5` implies service mix will break the first time the Growth
BIR reaches v5 for an unrelated reason.

---

## 3. Sections

| Section | Holds |
| --- | --- |
| `identity` | `birId`, `businessId`, `identityStatus`, `verticalId`, `assessmentSessionId`, `submissionId`, `reviewType` |
| `provenance` | `generatedAt`, `generatedBy`, engine and uncertainty versions, `inputHash`, `supersedes`, `isCurrent` |
| `assessmentProgress` | stage completed (always 1 in SM-1), `resultState`, `confidenceKind`, what Stage 2 would add |
| `portfolioCoverage` | the coverage declaration, offering count, how many offerings were usable |
| `dataConfidence` | completeness, confidence, per-measure evidence quality, the reasons behind each |
| `serviceMixHealth` | classification, the rule version, and why that classification and not another |
| `offeringAnalyses` | one entry per offering: identity, snapshot, inputs, intervals, shares |
| `revenueLeaders` | ordered by monthly revenue interval, ties broken deterministically |
| `capacityHeavyOfferings` | ordered by share of entered capacity |
| `measurementGaps` | every unknown, named, with what it prevents |
| `findings` | evidence-supported concerns and opportunities, in the shape of §4 |
| `immediateActions` | what to do now, none of which is "buy something" |
| `thirtyDayTests` | what to try, for how long, and what result means what |
| `relatedGrowthReview` | a reference to the applicable Growth BIR, or null |
| `aiOpportunityInputs` | reserved, deterministic inputs for a future analysis |
| `assumptions` | every assumption the arithmetic rests on |
| `missingInformation` | what was not collected and what it would change |
| `disclaimer` | the exact wording in §6 |
| `unavailableAnalyses` | contribution, underpricing, add-on, bundle — each with a reason |

---

## 4. The shape of a finding

Every finding carries **exactly** these eleven fields. Not at least eleven —
exactly. A finding missing one fails validation, because a conclusion an owner
cannot audit is a conclusion they should not act on; a finding carrying a
twelfth fails too, because a contract that quietly grows is not a contract,
and the reader of a stored report has no way to tell an approved field from
one somebody added in a hurry.

```js
{
  findingId,           // deterministic: fnd_<16 hex>, stable for the same evidence
  findingType,         // which finding this is, from a closed vocabulary
  offeringIds,         // the offerings it concerns; [] for a portfolio-level finding
  meaning,             // plain language, no jargon
  whyItMatters,        // the operational consequence
  evidenceRefs,        // exactly which measures and snapshots, with their kinds
  assumptions,         // what had to be true for this to hold
  missingInformation,  // what would sharpen or overturn it
  confidence,          // 0..1, this finding's own
  test,                // the change to try, how long, and what each result means
  disclaimerKey        // which disclaimer must appear with it
}
```

`test` is an object, not a sentence, and it carries exactly these eight
fields — the ones `guidance.js :: buildFinding` actually emits:

```js
{
  testId,              // deterministic: tst_<16 hex>
  what,                // one concrete change
  durationDays,        // how long before the result means anything
  measure,             // what to watch, and what to compare it against
  keepIf,              // the result that justifies keeping the change
  changeIf,            // the result that justifies adjusting it
  reverseIf,           // the result that justifies putting it back
  caution              // why the result is a signal rather than a verdict
}
```

The field is `what`, not `whatToTest`. An earlier revision of this document
said `whatToTest` and omitted `measure` and `caution` entirely; the
implementation never emitted that shape.

`keepIf` / `changeIf` / `reverseIf` exist so a test has a decision rule
written **before** the data arrives. A test with no pre-agreed reversal
condition is not a test; it is a change with a story attached. `caution` is
there for the same reason from the other direction: one month of a small
salon's bookings is a small sample, and a report that presents it as a
settled answer is making a claim the arithmetic does not support.

`evidenceRefs` is where snapshot evidence lives:

```js
{
  measures,            // the measured values the finding rests on
  evidenceKinds,       // how well each of them was known
  offeringIds,
  offeringSnapshotIds, // which snapshot of each offering was read
  calculationVersion,
  uncertaintyVersion,
  classifierVersion
}
```

Snapshot ids sit **inside** `evidenceRefs` rather than beside it as a twelfth
top-level field. They are evidence — which version of an offering was read —
and evidence has a place in this structure already.

---

## 5. What is deliberately empty

`unavailableAnalyses` always contains these four in SM-1:

```js
{ contributionLeaders:   { available: false, reason: 'requires_detailed_review' },
  underpricingCandidates:{ available: false, reason: 'requires_detailed_review' },
  addOnOpportunities:    { available: false, reason: 'requires_detailed_review' },
  bundleOpportunities:   { available: false, reason: 'requires_detailed_review' } }
```

They are present-and-unavailable rather than absent so that no consumer can
read an empty array as "we looked and found none". The validator refuses a
Service Mix BIR that marks any of them `available: true` while
`directCostEvidence` is absent — which is the structural guarantee behind
"do not claim true profit".

---

## 6. The disclaimer

Carried verbatim in `disclaimer`, and shown on screen beside any figure:

> This is a diagnostic analysis based on the information provided. Estimated
> contribution excludes labor expense, overhead, occupancy, taxes, financing,
> and other costs unless explicitly stated. It is not a calculation of profit
> or accounting, tax, legal, or regulatory advice.

The validator refuses a report whose disclaimer is missing or altered. It
moves with the number, always — the same rule §4 of
[CLAUDE.md](../CLAUDE.md) applies to the Growth opportunity figure.

---

## 7. Relationship to the Growth BIR

`relatedGrowthReview` is either `null` or **exactly** these five fields:

```js
{
  birId,               // which Growth report this continues from
  generatedAt,         // when that report was generated
  freshness,           // fresh | aging | stale | expired, from its age
  prefilledFields,     // FIELD NAMES the visitor did not retype — never values
  usedInCalculations   // always false; nothing from Growth enters a calculation
}
```

A **reference**. The Service Mix BIR does not copy the Growth analysis, does
not recompute it, does not mutate it, and does not supersede it. The
supersession chain is closed within a review type, in the database as well as
in the engine — see §8 of [SERVICE_MIX_REVIEW.md](SERVICE_MIX_REVIEW.md).

There is no sixth field, and in particular no `reviewType`. The field is
called `relatedGrowthReview`; a `reviewType: 'growth_review'` inside it
restates its own name and buys nothing. There is no `growthScore` either — a
Growth figure copied into a Service Mix report is no longer a reference, and
the validator refuses it as an extra field.

`prefilledFields` is a **closed enum**: `salonName`, `businessName`,
`ownerName`, `email`. It names fields, never values, and it is filtered
against that enum in three places — the assessment endpoint, `ingest_review`
in migration 0006, and the report generator. Three because a list of field
names that accepts arbitrary strings is a place to put an email address under
a key that promises none, and only one of those three layers is on the path
that a future server-to-server caller would take.

The reference is populated only when the Business Record is already resolved
and already holds a current Growth BIR. It is written by the DATABASE, after
identity resolution, because only the database knows which business this is.
A standalone Service Mix review carries `null`, and that is not a gap.

---

## 8. Validation

`validateServiceMixBir()` refuses a report that:

- is not `schemaVersion: 5` with `reportType: 'service_mix'`
- is missing any section in §3
- carries fewer than 2 or more than 5 offering analyses
- has an offering analysis with no `offeringId` or no `offeringSnapshotId`
- has two offering analyses sharing an `offeringId`
- has any interval whose `low` exceeds its `high`
- has a finding missing any of the eleven fields in §4, **or carrying a
  twelfth**
- has two findings sharing a `findingId`, or a `findingId` that does not match
  `fnd_<16 hex>`
- marks a contribution, underpricing, add-on, or bundle analysis available
  without direct-cost evidence
- has a missing or altered disclaimer
- claims a health classification outside the vocabulary
- carries a `relatedGrowthReview` with any field beyond the five in §7,
  including `reviewType` and `growthScore`
- carries a `relatedGrowthReview` whose `prefilledFields` names something
  outside the enum, repeats a name, or lists more than four
- carries a `relatedGrowthReview` claiming `usedInCalculations: true`

Structural validation proves shape, not correctness. It is the same
limitation `validateGeneratedBir` carries for the Growth report and is stated
here for the same reason.
