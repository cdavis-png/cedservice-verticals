/* ============================================================
   CED Intelligence Platform — Service Mix value contract
   ------------------------------------------------------------
   An owner rarely knows a number exactly. A review that forces
   them to pretend produces confident nonsense, so every numeric
   figure in a Service Mix review is a MEASURED VALUE that carries
   how well it is known:

     { kind, value, low, high }

   kind ∈ exact | range | estimate | unknown | not_applicable

   Two rules do most of the work here:

     · unknown and not_applicable are never collapsed. An unknown
       is a measurement gap and lowers completeness. A
       not_applicable is a correct answer and leaves the
       denominator entirely — a retail product with no
       appointment time is not an unmeasured service.

     · any unknown operand makes the result unknown. There is no
       imputed median and no "assume the average". This is the
       arithmetic form of the rule that SM-1 never fabricates a
       figure it did not measure.

   Uncertainty constants are VERSIONED so they can be recalibrated
   against real data later without archaeology. Every report
   stamps the version it was generated under.

   Full rationale: docs/SERVICE_MIX_REVIEW.md section 4.

   Classic script on purpose — see the note in
   shared/assessment-engine/engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* ---------- evidence kinds ---------- */

  const VALUE_KINDS = ['exact', 'range', 'estimate', 'unknown', 'not_applicable'];

  /* Kinds that contribute a usable interval. */
  const MEASURED_KINDS = ['exact', 'range', 'estimate'];

  /* How much each kind is worth when completeness is measured. Three
     offerings priced exactly and three priced by estimate are both "complete"
     in the naive sense, and only one supports a firm conclusion. */
  const EVIDENCE_WEIGHT = {
    exact: 1.00,
    range: 0.80,
    estimate: 0.60,
    unknown: 0.00,
    not_applicable: null   /* null = leaves the denominator, never scores 0 */
  };

  /* ---------- versioned uncertainty ----------

     Changing any of these changes every interval the engine produces, which
     is why they live in exactly one place behind a version string.

     Volume is the widest band deliberately. Owners estimate "what do I
     charge" far better than "how many did I do last month", and a band that
     pretends otherwise understates the real spread. */
  const UNCERTAINTY = {
    version: 'service-mix-uncertainty-v1',
    sellingPrice: 0.10,
    /* Declared for SM-2. SM-1 collects no direct cost at all — the constant
       exists so the contract is complete and the recalibration surface is
       one object rather than two. */
    directCost: 0.20,
    duration: 0.15,
    monthlyVolume: 0.25
  };

  /* Which constant governs which measure. A measure with no entry here
     cannot be an `estimate`, because there would be no defensible band. */
  const MEASURE_UNCERTAINTY = {
    sellingPrice: 'sellingPrice',
    directCost: 'directCost',
    durationMinutes: 'duration',
    monthlyVolume: 'monthlyVolume'
  };

  const MEASURE_NAMES = Object.keys(MEASURE_UNCERTAINTY);

  /* ---------- helpers ---------- */

  const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);
  const round2 = n => Math.round(n * 100) / 100;
  const round4 = n => Math.round(n * 10000) / 10000;

  /* ---------- construction ---------- */

  const UNKNOWN = Object.freeze({ kind: 'unknown', value: null, low: null, high: null });
  const NOT_APPLICABLE = Object.freeze({ kind: 'not_applicable', value: null, low: null, high: null });

  const exact = value => ({ kind: 'exact', value, low: null, high: null });
  const range = (low, high) => ({ kind: 'range', value: null, low, high });
  const estimate = value => ({ kind: 'estimate', value, low: null, high: null });

  /* Builds a measured value from whatever a form produced. Anything that
     cannot be read as the declared kind becomes `unknown` — never a guess,
     and never a silent zero. */
  const measured = (kind, { value = null, low = null, high = null } = {}) => {
    switch (kind) {
      case 'exact':
        return isFiniteNumber(value) && value >= 0 ? exact(value) : UNKNOWN;
      case 'range': {
        if (!isFiniteNumber(low) || !isFiniteNumber(high)) return UNKNOWN;
        if (low < 0 || high < 0) return UNKNOWN;
        /* A range given backwards is a data-entry slip, not a refusal.
           Ordering it is the conservative reading and loses nothing. */
        return low <= high ? range(low, high) : range(high, low);
      }
      case 'estimate':
        return isFiniteNumber(value) && value >= 0 ? estimate(value) : UNKNOWN;
      case 'not_applicable':
        return NOT_APPLICABLE;
      case 'unknown':
      default:
        return UNKNOWN;
    }
  };

  const isMeasured = v => Boolean(v) && MEASURED_KINDS.includes(v.kind);
  const isUnknown = v => !v || v.kind === 'unknown';
  const isNotApplicable = v => Boolean(v) && v.kind === 'not_applicable';

  /* ---------- intervals ----------

     An interval is { low, high, known }. `known: false` is the single
     representation of "no usable interval", whatever produced it. */

  const NO_INTERVAL = Object.freeze({ low: null, high: null, known: false });

  const interval = (low, high) => ({ low: round4(low), high: round4(high), known: true });

  /* Resolves a measured value to an interval under the uncertainty constant
     for its measure. An `estimate` with no governing constant resolves to
     unknown rather than to a fabricated band. */
  const toInterval = (value, measureName) => {
    if (!isMeasured(value)) return NO_INTERVAL;
    if (value.kind === 'exact') return interval(value.value, value.value);
    if (value.kind === 'range') return interval(value.low, value.high);

    const constantName = MEASURE_UNCERTAINTY[measureName];
    if (!constantName) return NO_INTERVAL;
    const u = UNCERTAINTY[constantName];
    if (!isFiniteNumber(u)) return NO_INTERVAL;
    return interval(value.value * (1 - u), value.value * (1 + u));
  };

  /* ---------- conservative interval arithmetic ----------

     Every operand is non-negative by construction, which keeps these rules
     simple and keeps the direction of conservatism honest. */

  const bothKnown = (a, b) => Boolean(a && b && a.known && b.known);

  const add = (a, b) => (bothKnown(a, b) ? interval(a.low + b.low, a.high + b.high) : NO_INTERVAL);

  const multiply = (a, b) => (bothKnown(a, b) ? interval(a.low * b.low, a.high * b.high) : NO_INTERVAL);

  /* A divisor whose interval touches zero has no finite quotient. Returning
     an enormous number instead would be a fabricated finding. */
  const divide = (a, b) => {
    if (!bothKnown(a, b)) return NO_INTERVAL;
    if (b.low <= 0 || b.high <= 0) return NO_INTERVAL;
    return interval(a.low / b.high, a.high / b.low);
  };

  const scale = (a, factor) =>
    (a && a.known && isFiniteNumber(factor) ? interval(a.low * factor, a.high * factor) : NO_INTERVAL);

  /* A share is bounded by definition; an interval that escapes [0,1] is an
     artefact of dividing two independent intervals, not a finding. */
  const share = (part, total) => {
    const raw = divide(part, total);
    if (!raw.known) return NO_INTERVAL;
    return interval(Math.max(0, Math.min(1, raw.low)), Math.max(0, Math.min(1, raw.high)));
  };

  /* Sums only the known intervals and reports how many were skipped. A total
     built by treating unknown as zero would read as a measurement. */
  const sumKnown = list => {
    const usable = (list || []).filter(i => i && i.known);
    const skipped = (list || []).length - usable.length;
    if (!usable.length) return { total: NO_INTERVAL, counted: 0, skipped };
    const total = usable.reduce((acc, i) => (acc === null ? i : add(acc, i)), null);
    return { total, counted: usable.length, skipped };
  };

  /* The single point a human reads when one is unavoidable. Always the
     midpoint of the interval, never a re-derived figure, so the point and the
     range can never disagree.

     Rounded to four places, not two: this returns dollars in one place and
     shares in another, and two places is coarse enough on a 0..1 ratio that
     three shares of one portfolio stop adding up. Display rounding belongs to
     whatever is displaying it. */
  const midpoint = i => (i && i.known ? round4((i.low + i.high) / 2) : null);

  /* Strictly-below and strictly-above tests. These are what stop SM-1
     manufacturing findings: a threshold the interval straddles is not
     cleared, however favourable the midpoint looks. */
  const entirelyBelow = (i, threshold) =>
    Boolean(i && i.known && isFiniteNumber(threshold) && i.high < threshold);

  const entirelyAbove = (i, threshold) =>
    Boolean(i && i.known && isFiniteNumber(threshold) && i.low > threshold);

  /* ---------- evidence quality ---------- */

  /* Completeness over a set of measured values, weighted by evidence kind.
     not_applicable leaves the denominator entirely; unknown stays in it and
     scores zero, because a gap is a gap. */
  const completenessOf = values => {
    const applicable = (values || []).filter(v => !isNotApplicable(v));
    if (!applicable.length) return { completeness: 0, applicable: 0, unknown: 0, notApplicable: (values || []).length };
    const scored = applicable.reduce((sum, v) => {
      const weight = EVIDENCE_WEIGHT[v && v.kind ? v.kind : 'unknown'];
      return sum + (weight === null ? 0 : weight);
    }, 0);
    return {
      completeness: round4(scored / applicable.length),
      applicable: applicable.length,
      unknown: applicable.filter(isUnknown).length,
      notApplicable: (values || []).length - applicable.length
    };
  };

  const describeKind = kind => {
    switch (kind) {
      case 'exact': return 'an exact figure';
      case 'range': return 'a range';
      case 'estimate': return 'an owner estimate';
      case 'not_applicable': return 'not applicable';
      default: return 'not known';
    }
  };

  const API = {
    VALUE_KINDS,
    MEASURED_KINDS,
    EVIDENCE_WEIGHT,
    UNCERTAINTY,
    MEASURE_UNCERTAINTY,
    MEASURE_NAMES,

    UNKNOWN,
    NOT_APPLICABLE,
    NO_INTERVAL,
    exact,
    range,
    estimate,
    measured,
    isMeasured,
    isUnknown,
    isNotApplicable,

    interval,
    toInterval,
    add,
    multiply,
    divide,
    scale,
    share,
    sumKnown,
    midpoint,
    entirelyBelow,
    entirelyAbove,

    completenessOf,
    describeKind,
    round2,
    round4
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDServiceMixValue = API;
})();
