/* ============================================================
   SM-1 — offering identity and payload validation
   ------------------------------------------------------------
   The identity rules are the load-bearing part of the review:
   renaming keeps an id, replacing mints one, removing before
   submission leaves nothing, and nothing is ever merged on a
   name.

   docs/SERVICE_MIX_REVIEW.md section 5.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import values from '../shared/service-mix-engine/value.schema.js';
import offerings from '../shared/service-mix-engine/offering.schema.js';
import { makeOffering, makePortfolio } from './helpers/service-mix-fixtures.mjs';

/* ---------- identity ---------- */

test('an offeringId is minted once and survives renaming', () => {
  const original = offerings.createOffering({ name: 'Gel manicure', source: 'starter' });
  assert.ok(offerings.isUuid(original.offeringId));

  const renamed = offerings.renameOffering(original, 'Gel set');
  assert.equal(renamed.offeringId, original.offeringId,
    'a new label is not a new offering, and its history must stay attached');
  assert.equal(renamed.name, 'Gel set');
});

test('a rename is bounded rather than truncating silently into a different name', () => {
  const original = offerings.createOffering({ name: 'A' });
  const long = 'x'.repeat(200);
  const renamed = offerings.renameOffering(original, long);
  assert.equal(renamed.name.length, offerings.OFFERING_LIMITS.nameMaxLength);
});

test('replacing mints a new offeringId and records what it replaced', () => {
  const previous = offerings.createOffering({ name: 'Acrylic fill' });
  const next = offerings.replaceOffering(previous, { name: 'Structured gel fill' });

  assert.notEqual(next.offeringId, previous.offeringId,
    'a discontinued service and its successor are not one thing averaged together');
  assert.equal(next.replacesOfferingId, previous.offeringId);
  assert.equal(next.offeringSnapshotId, null, 'a snapshot id is minted at submission, not at creation');
});

test('every submitted version gets its own snapshot id', () => {
  const offering = offerings.createOffering({ name: 'Pedicure' });
  const first = offerings.snapshotOffering(offering);
  const second = offerings.snapshotOffering(offering);

  assert.equal(first.offeringId, second.offeringId);
  assert.notEqual(first.offeringSnapshotId, second.offeringSnapshotId,
    'two submissions six months apart are two snapshots of one offering');
});

test('nothing merges two offerings that merely have similar names', () => {
  const a = offerings.createOffering({ name: 'Gel mani' });
  const b = offerings.createOffering({ name: 'Gel manicure' });
  assert.notEqual(a.offeringId, b.offeringId);

  /* And the validator does not object to both being present: they may be one
     service or two price points, and only the owner knows which. */
  const result = offerings.validateOfferings([
    offerings.snapshotOffering(a), offerings.snapshotOffering(b)
  ].map(o => ({ ...o, sellingPrice: values.measured('exact', { value: 40 }) })));
  assert.equal(result.valid, true);
});

test('an offering is usable only when it can contribute at least one figure', () => {
  const named = offerings.createOffering({ name: 'Nail art' });
  assert.equal(offerings.isUsableOffering(named), false,
    'a name with no figures names something without measuring it');

  named.sellingPrice = values.measured('exact', { value: 25 });
  assert.equal(offerings.isUsableOffering(named), true);

  const unnamed = offerings.createOffering({ name: '  ' });
  unnamed.sellingPrice = values.measured('exact', { value: 25 });
  assert.equal(offerings.isUsableOffering(unnamed), false);
});

/* ---------- duration applicability ---------- */

test('a retail product has no appointment time, and that is not a gap', () => {
  const product = offerings.createOffering({ name: 'Cuticle oil', category: 'retail_product' });
  assert.equal(offerings.durationApplies(product), false);
  assert.equal(offerings.measureValue(product, 'durationMinutes').kind, 'not_applicable');

  const service = offerings.createOffering({ name: 'Pedicure', category: 'core_service' });
  assert.equal(offerings.durationApplies(service), true);
  assert.equal(offerings.measureValue(service, 'durationMinutes').kind, 'unknown');
});

test('changing a category corrects the evidence rather than stranding an old answer', () => {
  const offering = offerings.createOffering({ name: 'Memberships', category: 'core_service' });
  offering.durationMinutes = values.measured('exact', { value: 30 });
  assert.equal(offerings.measureValue(offering, 'durationMinutes').kind, 'exact');

  offering.category = 'membership';
  assert.equal(offerings.measureValue(offering, 'durationMinutes').kind, 'not_applicable');
});

/* ---------- limits ---------- */

test('two offerings is accepted and one is refused', () => {
  const two = offerings.validateOfferings([makeOffering(), makeOffering({ name: 'Pedicure' })]);
  assert.equal(two.valid, true);

  const one = offerings.validateOfferings([makeOffering()]);
  assert.equal(one.valid, false);
  assert.ok(one.errors.some(e => e.code === 'too_few_offerings'));
});

test('five offerings is accepted and six is refused', () => {
  const five = Array.from({ length: 5 }, (_, i) => makeOffering({ name: `Service ${i}` }));
  assert.equal(offerings.validateOfferings(five).valid, true);

  const six = Array.from({ length: 6 }, (_, i) => makeOffering({ name: `Service ${i}` }));
  const result = offerings.validateOfferings(six);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'too_many_offerings'));
});

test('three is the recommendation and sits between the floor and the ceiling', () => {
  const { min, max, recommended } = offerings.OFFERING_LIMITS;
  assert.equal(min, 2);
  assert.equal(max, 5);
  assert.equal(recommended, 3);
  assert.ok(recommended > min && recommended < max);
});

/* ---------- payload validation ---------- */

test('a valid portfolio passes and reports no errors', () => {
  const result = offerings.validateServiceMix({
    coverage: 'all_offerings', offerings: makePortfolio()
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('the coverage declaration is required, because every share needs a denominator', () => {
  const missing = offerings.validateServiceMix({ offerings: makePortfolio() });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(e => e.code === 'invalid_coverage'));

  const invented = offerings.validateServiceMix({
    coverage: 'most_of_it', offerings: makePortfolio()
  });
  assert.equal(invented.valid, false);
});

test('a manipulated payload is refused rather than analysed', () => {
  const cases = [
    { label: 'no offeringId', mutate: o => { o.offeringId = 'not-a-uuid'; }, code: 'invalid_offering_id' },
    { label: 'no snapshot id', mutate: o => { o.offeringSnapshotId = null; }, code: 'invalid_snapshot_id' },
    { label: 'snapshot equals offering', mutate: o => { o.offeringSnapshotId = o.offeringId; }, code: 'snapshot_equals_offering' },
    { label: 'self replacement', mutate: o => { o.replacesOfferingId = o.offeringId; }, code: 'self_replacement' },
    { label: 'empty name', mutate: o => { o.name = '   '; }, code: 'missing_offering_name' },
    { label: 'invented category', mutate: o => { o.category = 'wizardry'; }, code: 'invalid_category' },
    { label: 'invented demand', mutate: o => { o.demand = 'enormous'; }, code: 'invalid_demand' },
    { label: 'invented role', mutate: o => { o.role = 'vibes'; }, code: 'invalid_role' },
    { label: 'invented source', mutate: o => { o.source = 'imported'; }, code: 'invalid_source' },
    { label: 'negative price', mutate: o => { o.sellingPrice = { kind: 'exact', value: -10, low: null, high: null }; }, code: 'negative_measure' },
    { label: 'absurd price', mutate: o => { o.sellingPrice = { kind: 'exact', value: 1e9, low: null, high: null }; }, code: 'measure_out_of_range' },
    { label: 'a day longer than a day', mutate: o => { o.durationMinutes = { kind: 'exact', value: 100000, low: null, high: null }; }, code: 'measure_out_of_range' },
    { label: 'reversed range', mutate: o => { o.monthlyVolume = { kind: 'range', value: null, low: 90, high: 10 }; }, code: 'range_out_of_order' },
    { label: 'invented value kind', mutate: o => { o.sellingPrice = { kind: 'vibes', value: 10 }; }, code: 'invalid_measure_kind' },
    { label: 'a direct cost SM-1 never collects', mutate: o => { o.directCost = { kind: 'exact', value: 5 }; }, code: 'direct_cost_not_collected' }
  ];

  cases.forEach(({ label, mutate, code }) => {
    const portfolio = makePortfolio();
    mutate(portfolio[0]);
    const result = offerings.validateServiceMix({ coverage: 'all_offerings', offerings: portfolio });
    assert.equal(result.valid, false, `${label} must be refused`);
    assert.ok(result.errors.some(e => e.code === code),
      `${label} expected ${code}, got ${result.errors.map(e => e.code).join(', ')}`);
  });
});

test('one offeringId may not appear twice in one submission', () => {
  const portfolio = makePortfolio();
  portfolio[1].offeringId = portfolio[0].offeringId;
  const result = offerings.validateServiceMix({ coverage: 'all_offerings', offerings: portfolio });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'duplicate_offering_id'),
    'two entries under one id would make every share ambiguous');
});

test('one snapshot id may not appear twice either', () => {
  const portfolio = makePortfolio();
  portfolio[1].offeringSnapshotId = portfolio[0].offeringSnapshotId;
  const result = offerings.validateServiceMix({ coverage: 'all_offerings', offerings: portfolio });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'duplicate_snapshot_id'));
});

test('validation reports every problem rather than the first', () => {
  const portfolio = makePortfolio();
  portfolio[0].name = '';
  portfolio[0].category = 'wizardry';
  portfolio[1].demand = 'enormous';
  const result = offerings.validateServiceMix({ coverage: 'nonsense', offerings: portfolio });
  assert.ok(result.errors.length >= 4,
    'a client author should see the whole picture in one response');
});

test('a coverage declaration maps to how far shares can be trusted', () => {
  const { COVERAGE_FACTOR } = offerings;
  assert.equal(COVERAGE_FACTOR.all_offerings, 1);
  assert.ok(COVERAGE_FACTOR.most_revenue > COVERAGE_FACTOR.selected_sample);
  assert.ok(COVERAGE_FACTOR.selected_sample > COVERAGE_FACTOR.unknown,
    'a selected sample describes the sample; unknown describes nothing we can name');
});
