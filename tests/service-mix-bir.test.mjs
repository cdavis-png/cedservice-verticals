/* ============================================================
   SM-1 — the Service Mix BIR v5
   ------------------------------------------------------------
   Two things these tests exist to hold:

     · a Service Mix report is v5 with reportType service_mix,
       and the GROWTH report stays at v4 and stays immutable
     · no analysis that needs direct costs may ever be marked
       available, because SM-1 collects none

   docs/SERVICE_MIX_BIR.md.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import bir from '../shared/service-mix-engine/generate-service-mix-bir.js';
import growthSchema from '../shared/business-intelligence/report.schema.js';
import growthEngine from '../shared/business-intelligence/generate-bir.js';
import registry from '../shared/business-intelligence/review-registry.js';
import classify from '../shared/service-mix-engine/classify.js';
import guidance from '../shared/service-mix-engine/guidance.js';
import offerings from '../shared/service-mix-engine/offering.schema.js';
import continuation from '../shared/security/continuation.js';
import { makeServiceMixPayload, makeOffering, makePortfolio } from './helpers/service-mix-fixtures.mjs';
import { makePayload } from './helpers/fixtures.mjs';

const GENERATED_AT = '2026-08-05T12:00:00.000Z';

const generate = (overrides = {}, input = {}) => bir.generateServiceMixBir({
  submission: makeServiceMixPayload(overrides),
  birId: randomUUID(),
  businessId: null,
  identityStatus: 'resolution_pending',
  generatedAt: GENERATED_AT,
  ...input
});

/* ---------- the envelope ---------- */

test('a Service Mix report is v5 with reportType service_mix and reportVersion 1', () => {
  const report = generate();
  assert.equal(report.schemaVersion, 5);
  assert.equal(report.reportType, 'service_mix');
  assert.equal(report.reportVersion, 1);
  assert.equal(report.identity.reviewType, 'service_mix');
  assert.equal(bir.validateServiceMixBir(report).valid, true);
});

test('the Growth BIR stays at v4 — nothing here bumped the shared constant', () => {
  assert.equal(growthSchema.BIR_SCHEMA_VERSION, 4,
    'BIR_SCHEMA_VERSION is the Growth generator’s version and must not move for SM-1');
  const growth = growthEngine.generateBir({
    submission: makePayload(),
    birId: randomUUID(),
    generatedAt: GENERATED_AT
  });
  assert.equal(growth.schemaVersion, 4);
  assert.equal(growthEngine.validateGeneratedBir(growth).valid, true,
    'existing Growth reports must remain valid and unchanged');
});

test('a consumer branches on reportType, and the registry says which version each produces', () => {
  assert.equal(registry.birSchemaVersionFor('growth_review'), 4);
  assert.equal(registry.birSchemaVersionFor('service_mix'), 5);
  assert.deepEqual(registry.REVIEW_TYPES, ['growth_review', 'service_mix']);
  assert.equal(registry.DEFAULT_REVIEW_TYPE, 'growth_review');
});

test('the registry routes generation to the right engine', () => {
  const routed = registry.generateReport({
    reviewType: 'service_mix',
    submission: makeServiceMixPayload(),
    birId: randomUUID(),
    generatedAt: GENERATED_AT
  });
  assert.equal(routed.reportType, 'service_mix');
  assert.equal(registry.validateReport('service_mix', routed).valid, true);
});

test('an unknown review type is refused rather than defaulted', () => {
  assert.throws(() => registry.entryFor('vibes_review'), /unknown reviewType/);
});

/* ---------- sections ---------- */

test('every section the contract names is present', () => {
  const report = generate();
  bir.REQUIRED_SECTIONS.forEach(section => {
    assert.notEqual(report[section], undefined, `missing section: ${section}`);
  });
});

test('a report missing a section fails validation', () => {
  bir.REQUIRED_SECTIONS.forEach(section => {
    const report = generate();
    delete report[section];
    const result = bir.validateServiceMixBir(report);
    assert.equal(result.valid, false, `${section} must be required`);
  });
});

test('deferred Detailed Review evidence is named, so "not asked" is not "would not say"', () => {
  const report = generate();
  assert.ok(report.assessmentProgress.deferredToDetailedReview.includes('directCost'));
  assert.ok(report.assessmentProgress.deferredToDetailedReview.includes('seasonality'));
  assert.equal(report.assessmentProgress.reviewType, 'service_mix');
});

test('portfolio coverage says whether shares describe the business or only what was entered', () => {
  const whole = generate();
  assert.equal(whole.portfolioCoverage.declared, 'all_offerings');
  assert.match(whole.portfolioCoverage.note, /whole business/);

  const sample = generate({ serviceMix: { coverage: 'selected_sample' } });
  assert.match(sample.portfolioCoverage.note, /not of the whole business/);
});

/* ---------- the no-profit guarantee ---------- */

test('every cost-dependent analysis is declared unavailable', () => {
  const report = generate();
  classify.UNAVAILABLE_ANALYSES.forEach(key => {
    assert.equal(report.unavailableAnalyses[key].available, false);
    assert.equal(report.unavailableAnalyses[key].reason, 'requires_detailed_review');
  });
});

test('marking one available without cost evidence fails validation', () => {
  const report = generate();
  report.unavailableAnalyses.contributionLeaders = { available: true, reason: null };
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'analysis_without_cost_evidence'),
    'this is the structural guarantee behind "do not claim true profit"');
});

test('dropping a declaration entirely also fails, so silence is never a finding of none', () => {
  const report = generate();
  delete report.unavailableAnalyses.bundleOpportunities;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'missing_unavailable_analysis'));
});

test('the word "profit" never appears except to deny that one was calculated', () => {
  const report = generate();

  /* Collected sentence by sentence rather than as one blob: the report is
     allowed — required, even — to say that no profit figure exists. What it
     may never do is state one. */
  const sentences = [];
  const walk = (node, depth = 0) => {
    if (depth > 10 || node === null || node === undefined) return;
    if (typeof node === 'string') { sentences.push(node); return; }
    if (typeof node !== 'object') return;
    Object.values(node).forEach(v => walk(v, depth + 1));
  };
  walk(report);

  const claims = sentences
    .filter(s => /profit/i.test(s))
    .filter(s => !/(not|cannot|without|excludes|does not)/i.test(s));

  assert.deepEqual(claims, [],
    'every mention of profit must be a denial that one was calculated');
  assert.equal(report.disclaimer.includes('not a calculation of profit'), true);
});

/* ---------- the disclaimer ---------- */

test('the disclaimer travels verbatim and an altered one is refused', () => {
  const report = generate();
  assert.equal(report.disclaimer, bir.SERVICE_MIX_DISCLAIMER);
  assert.match(report.disclaimer, /diagnostic analysis based on the information provided/);
  assert.match(report.disclaimer, /excludes labor expense, overhead, occupancy, taxes/);

  report.disclaimer = 'This is a diagnostic analysis.';
  assert.equal(bir.validateServiceMixBir(report).valid, false);

  const missing = generate();
  delete missing.disclaimer;
  assert.equal(bir.validateServiceMixBir(missing).valid, false);
});

test('the vertical config carries the same disclaimer the engine requires', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../verticals/beauty-wellness-fitness/nails/service-mix/service-mix.config.js', import.meta.url),
    'utf8');
  /* Compared on the distinctive clauses rather than on whitespace, because
     the config wraps the string across lines. */
  ['This is a diagnostic analysis based on the information provided.',
   'Estimated contribution excludes labor expense, overhead, occupancy, taxes,',
   'of profit or accounting, tax, legal, or regulatory advice.']
    .forEach(clause => assert.ok(source.includes(clause),
      `the vertical disclaimer must match the engine's: missing "${clause}"`));
});

/* ---------- offerings ---------- */

test('a report carries between two and five offering analyses', () => {
  const two = generate({ serviceMix: { offerings: makePortfolio().slice(0, 2) } });
  assert.equal(bir.validateServiceMixBir(two).valid, true);

  const one = generate({ serviceMix: { offerings: makePortfolio().slice(0, 1) } });
  const oneResult = bir.validateServiceMixBir(one);
  assert.equal(oneResult.valid, false);
  assert.ok(oneResult.errors.some(e => e.code === 'too_few_offerings'));

  const six = generate({
    serviceMix: { offerings: Array.from({ length: 6 }, (_, i) => makeOffering({ name: `S${i}` })) }
  });
  const sixResult = bir.validateServiceMixBir(six);
  assert.equal(sixResult.valid, false);
  assert.ok(sixResult.errors.some(e => e.code === 'too_many_offerings'));
});

test('every offering analysis carries both identifiers, and no id appears twice', () => {
  const report = generate();
  report.offeringAnalyses.forEach(a => {
    assert.ok(offerings.isUuid(a.offeringId));
    assert.ok(offerings.isUuid(a.offeringSnapshotId));
  });

  report.offeringAnalyses[1].offeringId = report.offeringAnalyses[0].offeringId;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'duplicate_offering_id'));
});

test('an interval with low above high fails validation', () => {
  const report = generate();
  report.offeringAnalyses[0].monthlyRevenue = { low: 500, high: 100, known: true };
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'interval_out_of_order'));
});

/* ---------- findings ---------- */

test('a finding missing any of its eleven approved fields fails validation', () => {
  assert.deepEqual(guidance.REQUIRED_FINDING_FIELDS, [
    'findingId', 'findingType', 'offeringIds', 'meaning', 'whyItMatters',
    'evidenceRefs', 'assumptions', 'missingInformation', 'confidence',
    'test', 'disclaimerKey'
  ]);

  guidance.REQUIRED_FINDING_FIELDS.forEach(field => {
    const report = generate();
    assert.ok(report.findings.length, 'the fixture must produce a finding to strip');
    delete report.findings[0][field];
    const result = bir.validateServiceMixBir(report);
    assert.equal(result.valid, false, `${field} must be required on a finding`);
  });
});

test('finding and test identifiers are deterministic, well formed, and unique', () => {
  const submission = makeServiceMixPayload();
  const once = bir.generateServiceMixBir({
    submission, birId: randomUUID(), generatedAt: GENERATED_AT });
  const twice = bir.generateServiceMixBir({
    submission, birId: randomUUID(), generatedAt: GENERATED_AT });

  /* Regenerating the same report must produce the same ids. An unseeded
     random id would make `inputHash` meaningless and every regeneration look
     like a change. */
  assert.deepEqual(once.findings.map(f => f.findingId), twice.findings.map(f => f.findingId));
  assert.deepEqual(once.findings.map(f => f.test.testId), twice.findings.map(f => f.test.testId));

  once.findings.forEach(f => {
    assert.match(f.findingId, guidance.FINDING_ID_PATTERN);
    assert.match(f.test.testId, guidance.FINDING_ID_PATTERN);
    assert.notEqual(f.findingId, f.test.testId, 'a finding and its test are two things');
  });

  const ids = once.findings.map(f => f.findingId);
  assert.equal(new Set(ids).size, ids.length);
});

test('a duplicate finding id, or a duplicate test id, is refused', () => {
  const report = generate();
  assert.ok(report.findings.length >= 1);

  /* One finding, cloned. Two findings that cannot be told apart are two
     findings nothing downstream can store or act on separately. */
  report.findings.push({ ...report.findings[0] });
  report.thirtyDayTests.push({ ...report.thirtyDayTests[0] });
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'duplicate_finding_id'));
  assert.ok(result.errors.some(e => e.code === 'duplicate_test_id'));
});

test('a malformed finding id is refused even when everything else is present', () => {
  const report = generate();
  report.findings[0].findingId = 'finding-1';
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'invalid_finding_id'));
});

test('a finding must name a rule the classifier can produce and an offering in the report', () => {
  const invented = generate();
  invented.findings[0].findingType = 'prices_are_wrong';
  const byType = bir.validateServiceMixBir(invented);
  assert.equal(byType.valid, false);
  assert.ok(byType.errors.some(e => e.code === 'unknown_finding_type'));

  const stranger = generate();
  stranger.findings[0].offeringIds = [randomUUID()];
  const byOffering = bir.validateServiceMixBir(stranger);
  assert.equal(byOffering.valid, false);
  assert.ok(byOffering.errors.some(e => e.code === 'finding_offering_unknown'));
});

test('every disclaimerKey resolves, and an invented one is refused', () => {
  const report = generate();
  report.findings.forEach(f =>
    assert.ok(bir.DISCLAIMERS[f.disclaimerKey], `${f.disclaimerKey} must resolve`));

  report.findings[0].disclaimerKey = 'no_such_disclaimer';
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'unknown_disclaimer_key'));
});

test('the 30-day tests are a view of the findings and cannot drift from them', () => {
  const report = generate();
  assert.equal(report.thirtyDayTests.length, report.findings.length);

  report.thirtyDayTests[0].testId = 'tst_00000000deadbeef';
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'test_id_mismatch'));
});

/* ---------- the Growth reference ---------- */

test('a standalone review carries no Growth reference, and that is not a gap', () => {
  const report = generate();
  assert.equal(report.relatedGrowthReview, null);
  assert.equal(bir.validateServiceMixBir(report).valid, true);
});

test('a Growth reference uses the approved contract and copies nothing', () => {
  const growthBirId = randomUUID();
  const report = generate({}, {
    relatedGrowthReview: {
      birId: growthBirId, generatedAt: GENERATED_AT, freshness: 'fresh',
      prefilledFields: ['salonName', 'email']
    }
  });

  assert.deepEqual(report.relatedGrowthReview, {
    birId: growthBirId,
    generatedAt: GENERATED_AT,
    freshness: 'fresh',
    prefilledFields: ['salonName', 'email'],
    usedInCalculations: false
  });
  assert.deepEqual(bir.RELATED_GROWTH_FIELDS,
    ['birId', 'generatedAt', 'freshness', 'prefilledFields', 'usedInCalculations']);

  /* No Growth analysis is copied in. */
  assert.equal(report.closeReadinessProfile, undefined);
  assert.equal(report.financialOpportunityProfile, undefined);
  assert.equal(report.packageRecommendation, undefined);
  assert.equal(bir.validateServiceMixBir(report).valid, true);
});

test('a Growth score smuggled in beside the reference is refused', () => {
  const report = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
    }
  });
  report.relatedGrowthReview.growthScore = 62;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'related_review_extra_field'),
    'a reference that carries a score has become a copy');
});

test('claiming a Growth figure was used in a calculation is refused', () => {
  const report = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
    }
  });
  assert.equal(report.relatedGrowthReview.usedInCalculations, false);

  report.relatedGrowthReview.usedInCalculations = true;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'growth_used_in_calculations'));
});

test('an incomplete or malformed Growth reference is refused', () => {
  bir.RELATED_GROWTH_FIELDS.forEach(field => {
    const report = generate({}, {
      relatedGrowthReview: {
        birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
      }
    });
    delete report.relatedGrowthReview[field];
    const result = bir.validateServiceMixBir(report);
    assert.equal(result.valid, false, `${field} must be required`);
  });

  const badFreshness = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
    }
  });
  badFreshness.relatedGrowthReview.freshness = 'quite recent';
  assert.ok(bir.validateServiceMixBir(badFreshness).errors
    .some(e => e.code === 'invalid_related_freshness'));
});

/* The approved contract names five fields. An earlier revision added a sixth,
   reviewType, which restated the name of the field it sat inside; it was
   removed rather than kept, and the validator refuses it like any other
   addition — a contract that quietly grows is not a contract. */
test('a sixth field in the Growth reference is refused, reviewType included', () => {
  ['reviewType', 'growthScore', 'notes'].forEach(field => {
    const report = generate({}, {
      relatedGrowthReview: {
        birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
      }
    });
    report.relatedGrowthReview[field] = 'growth_review';
    const result = bir.validateServiceMixBir(report);
    assert.equal(result.valid, false, `${field} must not be permitted`);
    assert.ok(result.errors.some(e => e.code === 'related_review_extra_field'));
  });
});

test('the generator never emits a sixth field, whatever it is handed', () => {
  const report = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh',
      prefilledFields: ['email'],
      reviewType: 'growth_review', growthScore: 62, usedInCalculations: true
    }
  });
  assert.deepEqual(Object.keys(report.relatedGrowthReview).sort(),
    ['birId', 'freshness', 'generatedAt', 'prefilledFields', 'usedInCalculations']);
  assert.equal(report.relatedGrowthReview.usedInCalculations, false,
    'a caller cannot assert that a Growth figure was used, because none is');
  assert.equal(bir.validateServiceMixBir(report).valid, true);
});

/* prefilledFields names FIELDS. A list of field names that accepts any string
   is a place to put an email address under a name that promises none. */
test('a prefilledFields entry outside the approved enum is refused', () => {
  const report = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
    }
  });
  report.relatedGrowthReview.prefilledFields = ['salonName', 'owner@example.com'];
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'unknown_prefilled_field'));
  assert.equal(result.errors.some(e => /owner@example\.com/.test(e.message)), false,
    'the error must not echo the value it exists to keep out');
});

test('a repeated or oversized prefilledFields list is refused', () => {
  const withDuplicate = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
    }
  });
  withDuplicate.relatedGrowthReview.prefilledFields = ['email', 'email'];
  assert.ok(bir.validateServiceMixBir(withDuplicate).errors
    .some(e => e.code === 'duplicate_prefilled_field'));

  const tooMany = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh', prefilledFields: []
    }
  });
  tooMany.relatedGrowthReview.prefilledFields =
    bir.PREFILLED_FIELD_NAMES.concat(['salonName']);
  assert.ok(bir.validateServiceMixBir(tooMany).errors
    .some(e => e.code === 'too_many_prefilled_fields'));
});

test('the prefilled enum is one list, shared by every layer that reads it', () => {
  assert.deepEqual(bir.PREFILLED_FIELD_NAMES,
    ['salonName', 'businessName', 'ownerName', 'email']);
  assert.deepEqual(offerings.PREFILLED_FIELD_NAMES, bir.PREFILLED_FIELD_NAMES,
    'the endpoint and the report validator must agree on what a field name is');
  assert.deepEqual(continuation.PREFILL_FIELDS, bir.PREFILLED_FIELD_NAMES,
    'the continuation context prefills exactly the fields the report may name');
});

test('the generator drops a prefilled name it does not recognise', () => {
  const report = generate({}, {
    relatedGrowthReview: {
      birId: randomUUID(), generatedAt: GENERATED_AT, freshness: 'fresh',
      prefilledFields: ['email', 'owner@example.com', 'salonName', 'salonName']
    }
  });
  assert.deepEqual(report.relatedGrowthReview.prefilledFields, ['salonName', 'email'],
    'kept in enum order, de-duplicated, with the unrecognised entry gone');
  assert.equal(bir.validateServiceMixBir(report).valid, true);
});

test('supersession is closed within a review type', () => {
  const growthReport = { reviewType: 'growth_review', businessId: 'b1' };
  const serviceMixReport = { reviewType: 'service_mix', businessId: 'b1' };

  assert.equal(registry.maySupersede(serviceMixReport, growthReport).allowed, false);
  assert.equal(registry.maySupersede(serviceMixReport, growthReport).reason, 'review_type_mismatch');
  assert.equal(registry.maySupersede(serviceMixReport, serviceMixReport).allowed, true);
  assert.equal(
    registry.maySupersede(serviceMixReport, { reviewType: 'service_mix', businessId: 'b2' }).reason,
    'business_mismatch');
  assert.equal(registry.maySupersede(serviceMixReport, null).allowed, true,
    'the first report of a review type supersedes nothing');
});

/* ---------- provenance and reserved inputs ---------- */

test('provenance stamps every version the report was produced under', () => {
  const report = generate();
  assert.equal(report.provenance.generatedBy, bir.SERVICE_MIX_ENGINE_VERSION);
  assert.equal(report.provenance.uncertaintyVersion, 'service-mix-uncertainty-v1');
  assert.equal(report.provenance.classifierVersion, 'service-mix-health-v1');
  assert.equal(report.provenance.calculationVersion, 'service-mix-calc-v1');
  assert.ok(report.provenance.inputHash);
});

test('identical inputs produce an identical hash', () => {
  /* One payload, generated twice — the fixture mints fresh offering ids on
     every call, and two different sets of ids are two different inputs. */
  const submission = makeServiceMixPayload();
  const once = bir.generateServiceMixBir({
    submission, birId: randomUUID(), generatedAt: GENERATED_AT });
  const twice = bir.generateServiceMixBir({
    submission, birId: randomUUID(), generatedAt: GENERATED_AT });
  assert.equal(once.provenance.inputHash, twice.provenance.inputHash);

  const changed = bir.generateServiceMixBir({
    submission: { ...submission, serviceMix: { ...submission.serviceMix, coverage: 'selected_sample' } },
    birId: randomUUID(), generatedAt: GENERATED_AT });
  assert.notEqual(once.provenance.inputHash, changed.provenance.inputHash);
});

test('the AI inputs are reserved, structural, and carry no names or figures', () => {
  const report = generate();
  const inputs = report.aiOpportunityInputs;
  assert.equal(inputs.reserved, true);
  assert.equal(inputs.consumedBy, null);

  const text = JSON.stringify(inputs);
  assert.equal(text.includes('Gel manicure'), false, 'no offering names');
  assert.equal(text.includes('sellingPrice'), false, 'no commercial figures');
  inputs.signals.forEach(s => {
    assert.deepEqual(Object.keys(s).sort(), ['id', 'kind', 'offeringId']);
  });
});

test('identity validation accepts v5 for Service Mix and still refuses it for Growth', () => {
  const identity = {
    birId: randomUUID(), businessId: null, identityStatus: 'resolution_pending'
  };
  assert.equal(
    growthSchema.validateBirIdentity(identity, 5, { supportedVersions: [5] }).valid, true);
  assert.equal(growthSchema.validateBirIdentity(identity, 5).valid, false,
    'the default remains the Growth version, so every existing call site is unchanged');
  assert.equal(growthSchema.validateBirIdentity(identity, 4).valid, true);
});
