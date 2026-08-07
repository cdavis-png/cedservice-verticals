/* ============================================================
   SM-1 — the value contract and interval arithmetic
   ------------------------------------------------------------
   The rule these tests exist to hold: an unknown operand
   produces an unknown result. There is no imputed median
   anywhere in the engine, and adding one would turn a
   diagnostic into a guess.

   docs/SERVICE_MIX_REVIEW.md section 4.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import values from '../shared/service-mix-engine/value.schema.js';

/* ---------- the five kinds ---------- */

test('every value kind resolves the way the contract says it does', () => {
  const exact = values.measured('exact', { value: 100 });
  assert.deepEqual(values.toInterval(exact, 'sellingPrice'), { low: 100, high: 100, known: true });

  const range = values.measured('range', { low: 80, high: 120 });
  assert.deepEqual(values.toInterval(range, 'sellingPrice'), { low: 80, high: 120, known: true });

  /* ±10% on a selling price — the v1 constant, applied and not invented. */
  const estimate = values.measured('estimate', { value: 100 });
  assert.deepEqual(values.toInterval(estimate, 'sellingPrice'), { low: 90, high: 110, known: true });

  assert.equal(values.toInterval(values.UNKNOWN, 'sellingPrice').known, false);
  assert.equal(values.toInterval(values.NOT_APPLICABLE, 'sellingPrice').known, false);
});

test('each measure uses its own uncertainty constant', () => {
  const hundred = values.measured('estimate', { value: 100 });
  assert.deepEqual(values.toInterval(hundred, 'sellingPrice'), { low: 90, high: 110, known: true });
  assert.deepEqual(values.toInterval(hundred, 'durationMinutes'), { low: 85, high: 115, known: true });
  assert.deepEqual(values.toInterval(hundred, 'monthlyVolume'), { low: 75, high: 125, known: true });
});

test('volume carries the widest band, because owners estimate it worst', () => {
  const u = values.UNCERTAINTY;
  assert.ok(u.monthlyVolume > u.directCost);
  assert.ok(u.directCost > u.duration);
  assert.ok(u.duration > u.sellingPrice);
  assert.equal(u.version, 'service-mix-uncertainty-v1',
    'the constants are versioned so they can be recalibrated without archaeology');
});

test('an estimate with no governing constant is unknown, never a fabricated band', () => {
  const estimate = values.measured('estimate', { value: 50 });
  assert.equal(values.toInterval(estimate, 'somethingUnmeasured').known, false);
});

test('unknown and not_applicable are never collapsed into one another', () => {
  assert.notEqual(values.UNKNOWN.kind, values.NOT_APPLICABLE.kind);
  assert.equal(values.isUnknown(values.UNKNOWN), true);
  assert.equal(values.isUnknown(values.NOT_APPLICABLE), false);
  assert.equal(values.isNotApplicable(values.NOT_APPLICABLE), true);
  /* The weights say why it matters: an unknown scores zero and stays in the
     denominator; a not-applicable leaves it entirely. */
  assert.equal(values.EVIDENCE_WEIGHT.unknown, 0);
  assert.equal(values.EVIDENCE_WEIGHT.not_applicable, null);
});

/* ---------- construction is defensive ---------- */

test('anything that cannot be read as the declared kind becomes unknown', () => {
  assert.equal(values.measured('exact', { value: 'sixty' }).kind, 'unknown');
  assert.equal(values.measured('exact', { value: NaN }).kind, 'unknown');
  assert.equal(values.measured('exact', { value: -5 }).kind, 'unknown');
  assert.equal(values.measured('range', { low: 10 }).kind, 'unknown');
  assert.equal(values.measured('estimate', {}).kind, 'unknown');
  assert.equal(values.measured('nonsense', { value: 5 }).kind, 'unknown');
});

test('a range typed backwards is ordered rather than refused', () => {
  const backwards = values.measured('range', { low: 120, high: 80 });
  assert.equal(backwards.kind, 'range');
  assert.equal(backwards.low, 80);
  assert.equal(backwards.high, 120);
});

/* ---------- conservative arithmetic ---------- */

test('multiplication and division widen conservatively', () => {
  const a = values.interval(10, 20);
  const b = values.interval(2, 4);
  assert.deepEqual(values.multiply(a, b), { low: 20, high: 80, known: true });
  /* low/high and high/low — the widest honest quotient. */
  assert.deepEqual(values.divide(a, b), { low: 2.5, high: 10, known: true });
  assert.deepEqual(values.add(a, b), { low: 12, high: 24, known: true });
});

test('any unknown operand makes the whole result unknown', () => {
  const known = values.interval(10, 20);
  [values.add, values.multiply, values.divide, values.share].forEach(op => {
    assert.equal(op(known, values.NO_INTERVAL).known, false);
    assert.equal(op(values.NO_INTERVAL, known).known, false);
    assert.equal(op(values.NO_INTERVAL, values.NO_INTERVAL).known, false);
  });
});

test('dividing by an interval that touches zero is unknown, not infinity', () => {
  const numerator = values.interval(100, 200);
  assert.equal(values.divide(numerator, values.interval(0, 10)).known, false);
  assert.equal(values.divide(numerator, values.interval(0, 0)).known, false);
  /* An enormous number here would be a fabricated finding, which is exactly
     what the engine must never produce. */
});

test('a share is bounded to 0..1 even when two independent intervals escape it', () => {
  const part = values.interval(80, 120);
  const total = values.interval(90, 110);
  const s = values.share(part, total);
  assert.ok(s.known);
  assert.ok(s.low >= 0 && s.high <= 1);
});

test('summing skips unknowns and says how many it skipped', () => {
  const result = values.sumKnown([
    values.interval(10, 20), values.NO_INTERVAL, values.interval(5, 5)
  ]);
  assert.deepEqual(result.total, { low: 15, high: 25, known: true });
  assert.equal(result.counted, 2);
  assert.equal(result.skipped, 1,
    'a total built by treating unknown as zero would read as a measurement');
});

test('summing nothing usable produces no total at all', () => {
  const result = values.sumKnown([values.NO_INTERVAL, values.NO_INTERVAL]);
  assert.equal(result.total.known, false);
  assert.equal(result.counted, 0);
});

/* ---------- threshold tests ---------- */

test('a threshold the interval straddles is not cleared in either direction', () => {
  const straddling = values.interval(40, 60);
  assert.equal(values.entirelyBelow(straddling, 50), false);
  assert.equal(values.entirelyAbove(straddling, 50), false);

  assert.equal(values.entirelyBelow(values.interval(10, 20), 50), true);
  assert.equal(values.entirelyAbove(values.interval(80, 90), 50), true);

  /* An unknown clears nothing. */
  assert.equal(values.entirelyBelow(values.NO_INTERVAL, 50), false);
  assert.equal(values.entirelyAbove(values.NO_INTERVAL, 50), false);
});

test('the midpoint is the interval midpoint and never a re-derived figure', () => {
  assert.equal(values.midpoint(values.interval(10, 20)), 15);
  assert.equal(values.midpoint(values.NO_INTERVAL), null);
});

/* ---------- completeness ---------- */

test('completeness is weighted by evidence kind, not by presence', () => {
  const allExact = [
    values.measured('exact', { value: 1 }),
    values.measured('exact', { value: 2 })
  ];
  assert.equal(values.completenessOf(allExact).completeness, 1);

  const allEstimated = [
    values.measured('estimate', { value: 1 }),
    values.measured('estimate', { value: 2 })
  ];
  assert.equal(values.completenessOf(allEstimated).completeness, 0.6,
    'both sets are "complete" in the naive sense and only one supports a firm conclusion');

  const allRanges = [
    values.measured('range', { low: 1, high: 2 }),
    values.measured('range', { low: 3, high: 4 })
  ];
  assert.equal(values.completenessOf(allRanges).completeness, 0.8);
});

test('not_applicable leaves the denominator; unknown stays in it and scores zero', () => {
  const withNa = values.completenessOf([
    values.measured('exact', { value: 1 }),
    values.NOT_APPLICABLE
  ]);
  assert.equal(withNa.completeness, 1, 'a correct "does not apply" is not a gap');
  assert.equal(withNa.applicable, 1);
  assert.equal(withNa.notApplicable, 1);

  const withUnknown = values.completenessOf([
    values.measured('exact', { value: 1 }),
    values.UNKNOWN
  ]);
  assert.equal(withUnknown.completeness, 0.5);
  assert.equal(withUnknown.unknown, 1);
});

test('a set with nothing applicable is zero rather than a division by zero', () => {
  const result = values.completenessOf([values.NOT_APPLICABLE, values.NOT_APPLICABLE]);
  assert.equal(result.completeness, 0);
  assert.equal(result.applicable, 0);
});
