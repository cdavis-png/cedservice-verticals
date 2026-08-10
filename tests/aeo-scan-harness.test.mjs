/* ============================================================
   The AEO scan harness
   ------------------------------------------------------------
   THE RULE THIS FILE DEFENDS. Every approved attempt produces
   exactly one recorded observation — including the ones that fail,
   are blocked, or have no capture provider at all.

   Spec section 6 is the reason. Only `response_observed` enters a
   denominator, and a non-triggered surface is "a finding, not a
   null". A harness that silently drops a failure turns a
   collection problem into an apparent visibility change, so the
   system would manufacture month-over-month movement out of its
   own behaviour.

   The harness captures nothing today — no provider is registered
   anywhere in this repository, because spec section 19 leaves the
   Google AI Overview capture path open. The no-provider path is
   therefore the LIVE path, not a hypothetical one.

   The harness does NOT plan or render: migration 0009 materializes
   the attempt list and hashes it, and a second renderer here could
   drift from the text the hash was computed over. These tests feed
   it materialized attempts, which is what it will receive.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import harness, {
  OBSERVATION_STATUS, EVIDENCE_ORIGIN, PAYLOAD_MAX_BYTES,
  createProviderRegistry, executeBatch
} from '../server/aeo-scan-harness.mjs';

const CONSUMER = {
  engine_configuration_id: 'cfg-consumer', capture_method: 'vendor_scraper',
  surface_type: 'consumer_surface'
};
const CONFIGS = new Map([[CONSUMER.engine_configuration_id, CONSUMER]]);

/* Rows as aeo_scan_attempts returns them. */
const ATTEMPTS = [
  { scan_attempt_id: 'a-1', engine_configuration_id: 'cfg-consumer', run_index: 1,
    question_text: 'What are the best nail salons in Easley, SC?', location_context: {} },
  { scan_attempt_id: 'a-2', engine_configuration_id: 'cfg-consumer', run_index: 2,
    question_text: 'What are the best nail salons in Easley, SC?', location_context: {} }
];

const fixedClock = () => '2026-08-10T12:00:00.000Z';

const collect = () => {
  const rows = [];
  return { rows, record: async row => { rows.push(row); return row; } };
};

const run = (over = {}) => executeBatch({
  attempts: ATTEMPTS, configurationsById: CONFIGS,
  registry: createProviderRegistry(), evidenceOrigin: EVIDENCE_ORIGIN.FIXTURE,
  now: fixedClock, ...over
});

/* ---------- evidence origin ---------- */

test('an unstated evidence origin is refused, never guessed', () => {
  /* Guessing in either direction is wrong: guessing `fixture` silently
     discards real evidence, guessing `live_capture` fabricates it. */
  return assert.rejects(
    () => run({ evidenceOrigin: undefined, recordObservation: async r => r }),
    /evidenceOrigin must be one of/);
});

test('an invented evidence origin is refused', () => assert.rejects(
  () => run({ evidenceOrigin: 'looks_live_to_me', recordObservation: async r => r }),
  /evidenceOrigin must be one of/));

test('the declared origin is stamped on every observation', async () => {
  const sink = collect();
  await run({ recordObservation: sink.record, evidenceOrigin: EVIDENCE_ORIGIN.REPLAY });
  assert.equal(sink.rows.length, 2);
  sink.rows.forEach(r => assert.equal(r.evidence_origin, 'replay'));
});

/* ---------- the live no-provider path ---------- */

test('with no provider registered every attempt is still recorded', async () => {
  const sink = collect();
  const { tally } = await run({ recordObservation: sink.record });

  assert.equal(tally.attempted, 2);
  assert.equal(tally.recorded, 2, 'every approved attempt must produce a row');
  assert.equal(tally.collection_failed, 2);
  sink.rows.forEach(row => {
    assert.equal(row.observation_status, OBSERVATION_STATUS.COLLECTION_FAILED);
    assert.match(row.failure_reason, /unsupported_capture_method: vendor_scraper/);
    assert.equal(row.raw_response, null);
  });
});

test('an unknown configuration is recorded, not skipped', async () => {
  const sink = collect();
  await run({ configurationsById: new Map(), recordObservation: sink.record });
  assert.equal(sink.rows.length, 2);
  assert.match(sink.rows[0].failure_reason, /unknown_configuration/);
});

/* ---------- providers behaving and misbehaving ---------- */

const providerReturning = outcome =>
  createProviderRegistry().register('vendor_scraper', async () => outcome);

test('a successful capture is recorded with its provenance', async () => {
  const sink = collect();
  const { tally } = await run({
    registry: providerReturning({
      observationStatus: OBSERVATION_STATUS.RESPONSE_OBSERVED,
      personalizationState: 'clean',
      receivedAt: '2026-08-10T12:00:03.000Z',
      rawResponse: 'TLC Nails, The Nail Zone, Pro Nail.',
      citations: ['https://example.test/a']
    }),
    recordObservation: sink.record
  });

  assert.equal(tally.response_observed, 2);
  assert.equal(sink.rows[0].personalization_state, 'clean');
  assert.equal(sink.rows[0].requested_at, '2026-08-10T12:00:00.000Z');
  assert.deepEqual(sink.rows[0].citations, ['https://example.test/a']);
});

test('a provider that throws loses the response, never the attempt', async () => {
  const sink = collect();
  await run({
    registry: createProviderRegistry().register('vendor_scraper', async () => {
      throw new Error('socket hang up');
    }),
    recordObservation: sink.record
  });
  assert.equal(sink.rows.length, 2);
  sink.rows.forEach(r => assert.match(r.failure_reason, /provider_threw: socket hang up/));
});

test('a provider cannot claim a response it did not return', async () => {
  const sink = collect();
  await run({
    registry: providerReturning({
      observationStatus: OBSERVATION_STATUS.RESPONSE_OBSERVED,
      personalizationState: 'clean', receivedAt: null, rawResponse: '   '
    }),
    recordObservation: sink.record
  });
  sink.rows.forEach(r => {
    assert.equal(r.observation_status, OBSERVATION_STATUS.COLLECTION_FAILED);
    assert.match(r.failure_reason, /claimed_response_observed_without_a_response/);
  });
});

test('an invented status is refused', async () => {
  const sink = collect();
  await run({
    registry: providerReturning({
      observationStatus: 'looked_fine_to_me', rawResponse: 'x',
      receivedAt: '2026-08-10T12:00:03.000Z'
    }),
    recordObservation: sink.record
  });
  sink.rows.forEach(r => assert.match(r.failure_reason, /invalid_status: looked_fine_to_me/));
});

test('an unstated personalization state is unknown, never clean', async () => {
  const sink = collect();
  await run({
    registry: providerReturning({ observationStatus: OBSERVATION_STATUS.SURFACE_NOT_TRIGGERED }),
    recordObservation: sink.record
  });
  sink.rows.forEach(r => assert.equal(r.personalization_state, 'unknown'));
});

/* ---------- payload limit ---------- */

test('an oversized payload is passed through to the canonical recorder', async () => {
  /* The harness must NOT decide this. Dropping it here produced a null
     hash and null byte count, while the same response sent straight to
     aeo_record_observation kept both — evidence that differed by route.
     aeo_record_observation hashes and sizes before deciding to store,
     so it is the only place the limit is applied. Parity between the
     two paths is proved in tests/migration/0009-*.test.mjs. */
  const oversized = 'x'.repeat(PAYLOAD_MAX_BYTES + 1);
  const sink = collect();
  await run({
    registry: providerReturning({
      observationStatus: OBSERVATION_STATUS.RESPONSE_OBSERVED,
      personalizationState: 'clean',
      receivedAt: '2026-08-10T12:00:03.000Z',
      rawResponse: oversized
    }),
    recordObservation: sink.record
  });
  sink.rows.forEach(r => {
    assert.equal(r.raw_response.length, PAYLOAD_MAX_BYTES + 1,
      'the harness must hand the recorder what the provider returned');
    assert.equal(r.observation_status, OBSERVATION_STATUS.RESPONSE_OBSERVED,
      'the status is the recorder’s decision, not the harness’s');
  });
});

/* ---------- write failures ---------- */

test('a write failure is counted, and the batch continues', async () => {
  let calls = 0;
  const { tally, observations } = await run({
    recordObservation: async row => {
      calls += 1;
      if (calls === 1) throw new Error('deadlock detected');
      return row;
    }
  });
  assert.equal(tally.write_failed, 1);
  assert.equal(tally.recorded, ATTEMPTS.length - 1);
  assert.ok(observations.some(o => o.write_error), 'a failed write must be visible, not silent');
});

/* ---------- what the harness must NOT contain ---------- */

test('no capture provider is registered by default', () => {
  assert.deepEqual(createProviderRegistry().methods(), [],
    'a registry must start empty — a default provider would capture without a decision');
  assert.deepEqual(Object.keys(harness).sort(),
    ['EVIDENCE_ORIGIN', 'OBSERVATION_STATUS', 'PAYLOAD_MAX_BYTES',
     'createProviderRegistry', 'executeBatch']);
});

test('the harness neither plans nor renders questions', () => {
  /* Materialization in 0009 is the only renderer and the only planner.
     A second implementation here could drift from the text the approved
     plan hash was computed over. */
  assert.equal(harness.planBatch, undefined);
  assert.equal(harness.renderQuestion, undefined);
  const source = readFileSync(new URL('../server/aeo-scan-harness.mjs', import.meta.url), 'utf8');
  assert.ok(!/\{city\}|\{state\}/.test(source),
    'the harness references a question placeholder — rendering belongs to materialization');
});

test('the harness source ships no vendor, endpoint or credential', () => {
  /* Section 19 leaves the Google AI Overview capture path open and gives
     Grok none at all; section 18 step 4 decides both on evidence. A
     vendor committed here would decide it by accident, and a credential
     would breach CLAUDE.md section 9 outright. */
  const source = readFileSync(new URL('../server/aeo-scan-harness.mjs', import.meta.url), 'utf8');
  [
    /https?:\/\/(?!$)[a-z]/i,
    /\bfetch\s*\(/,
    /process\.env/,
    /dataforseo|serpapi|scrapingbee|brightdata|oxylabs|openai|anthropic/i
  ].forEach(pattern => {
    assert.ok(!pattern.test(source),
      `the harness contains ${pattern} — step 2 adds no collection code`);
  });
});
