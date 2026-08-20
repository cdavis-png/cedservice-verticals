/* ============================================================
   CED Intelligence Platform — AEO scan harness (minimum)
   ------------------------------------------------------------
   Build order step 2 of BIR-replacement-spec.md v1.7. It executes
   the attempts an owner already approved and records EVERY one —
   including the ones that fail, are blocked, or have no provider
   at all.

   WHAT IT DOES NOT DO, deliberately.

   It captures nothing. No vendor, endpoint, credential or
   collection code appears here, because spec section 19 still
   lists the Google AI Overview capture path as open and gives Grok
   no clean automated path at all. Committing to a collection
   method now would decide by accident the thing section 18 step 4
   exists to decide on evidence. Providers are REGISTERED by a
   caller; with none registered — the state of this repository
   today — every attempt records `collection_failed` with a reason,
   which is an honest result rather than an empty batch.

   It does not PLAN, and it does not render questions. Migration
   0009 materializes the attempt list from versioned configuration,
   hashes it, and freezes it at approval; the harness reads that
   list back and executes it. A second renderer here could drift
   from the one the plan hash was computed over, and a plan hash
   that describes different text than what was asked is worse than
   no hash at all.

   It scores nothing, parses nothing out of a raw response, and
   makes no visibility claim. Section 7 scoring and the `mentions`
   join are step 3 and later.

   WHY FAILURES ARE WRITTEN RATHER THAN SKIPPED. Section 6: a
   non-triggered surface is "a finding, not a null", and only
   `response_observed` enters a denominator. A dropped failure
   turns a collection problem into an apparent visibility change,
   so the harness would manufacture month-over-month movement out
   of its own behaviour. Every approved attempt produces exactly
   one row.

   Dependency direction matches CLAUDE.md section 12: server/
   imports from shared/; shared/ never imports from server/.
   ============================================================ */

/* The four values section 6 freezes. Anything else is a bug, not a
   new category — blocked and unsupported attempts are
   `collection_failed` carrying a reason. */
export const OBSERVATION_STATUS = Object.freeze({
  RESPONSE_OBSERVED: 'response_observed',
  SURFACE_NOT_TRIGGERED: 'surface_not_triggered',
  COLLECTION_FAILED: 'collection_failed',
  INADMISSIBLE: 'inadmissible'
});

/* Where a row of evidence came from. Only `live_capture` can ever be
   admissible or count toward consumer reach — a fixture may prove that
   recording works and may never prove a customer saw anything. The batch
   declares this once and the database refuses any observation that
   disagrees, so these names are a convenience here, not the control. */
export const EVIDENCE_ORIGIN = Object.freeze({
  LIVE_CAPTURE: 'live_capture',
  FIXTURE: 'fixture',
  REPLAY: 'replay'
});

/* 256 KiB. Reported here for callers that want to state the limit; it is
   ENFORCED in exactly one place, aeo_record_observation, which hashes and
   sizes a payload before deciding whether to store it. Enforcing it here
   as well is what previously made the stored result depend on which
   entrypoint was used. */
export const PAYLOAD_MAX_BYTES = 262144;

const VALID_STATUS = new Set(Object.values(OBSERVATION_STATUS));
const VALID_ORIGIN = new Set(Object.values(EVIDENCE_ORIGIN));
const VALID_PERSONALIZATION = new Set(['clean', 'personalized', 'unknown']);

/* A provider captures ONE attempt. It returns a result; it never
   writes. Registration is explicit and keyed by capture_method, so a
   configuration whose method nobody registered is reported as
   unsupported rather than quietly skipped. */
export const createProviderRegistry = () => {
  const providers = new Map();
  return {
    register(captureMethod, provider) {
      if (typeof captureMethod !== 'string' || !captureMethod.trim()) {
        throw new Error('aeo-scan-harness: a capture method name is required');
      }
      if (typeof provider !== 'function') {
        throw new Error('aeo-scan-harness: a provider must be a function');
      }
      providers.set(captureMethod, provider);
      return this;
    },
    get: captureMethod => providers.get(captureMethod) || null,
    has: captureMethod => providers.has(captureMethod),
    methods: () => [...providers.keys()]
  };
};

/* Normalises whatever a provider returned into a recordable observation.
   Anything a provider gets wrong becomes a recorded failure rather than
   an exception that loses the attempt. */
const toObservation = (attempt, evidenceOrigin, requestedAt, outcome, error) => {
  const base = {
    scan_attempt_id: attempt.scan_attempt_id,
    evidence_origin: evidenceOrigin,
    requested_at: requestedAt,
    received_at: null,
    raw_response: null,
    content_type: 'text/plain',
    citations: [],
    failure_reason: null,
    personalization_state: 'unknown',
    observation_status: OBSERVATION_STATUS.COLLECTION_FAILED
  };

  if (error) {
    return { ...base, failure_reason: `provider_threw: ${error.message || String(error)}` };
  }
  if (!outcome || typeof outcome !== 'object') {
    return { ...base, failure_reason: 'provider_returned_nothing' };
  }
  if (!VALID_STATUS.has(outcome.observationStatus)) {
    return { ...base, failure_reason: `provider_returned_invalid_status: ${String(outcome.observationStatus)}` };
  }

  const record = {
    ...base,
    observation_status: outcome.observationStatus,
    /* An unstated personalization state is `unknown`, never `clean`.
       Section 6 requires `clean` for anything used in a report, and
       defaulting a silent provider to it would launder unverified
       evidence into the reportable set. */
    personalization_state: VALID_PERSONALIZATION.has(outcome.personalizationState)
      ? outcome.personalizationState
      : 'unknown',
    received_at: outcome.receivedAt ?? null,
    raw_response: typeof outcome.rawResponse === 'string' ? outcome.rawResponse : null,
    content_type: outcome.contentType === 'application/json' ? 'application/json' : 'text/plain',
    citations: Array.isArray(outcome.citations) ? outcome.citations : [],
    failure_reason: outcome.failureReason ?? null
  };

  /* OVERSIZED CONTENT IS NOT DROPPED HERE, deliberately.

     An earlier version discarded it before recording, which produced
     two different stored results for the same response depending on
     which entrypoint was used: through the harness the byte count and
     hash were null, and through aeo_record_observation they were kept.
     Evidence that differs by route is not evidence.

     aeo_record_observation is the single canonical recorder. It hashes
     and sizes the payload BEFORE deciding whether to persist it, so an
     oversized response is refused storage while its true size, its
     SHA-256 and its content type are all preserved. The harness passes
     the response through and lets that one implementation decide.
     PAYLOAD_MAX_BYTES is exported for callers that want to report the
     limit; it is not enforced twice. */

  /* The database enforces both of these too. Catching them here turns a
     lost batch into one recorded, explained failure. */
  if (record.observation_status === OBSERVATION_STATUS.RESPONSE_OBSERVED
      && (!record.received_at || !record.raw_response || !record.raw_response.trim())) {
    return { ...base, failure_reason: 'claimed_response_observed_without_a_response' };
  }
  if (record.observation_status === OBSERVATION_STATUS.COLLECTION_FAILED && !record.failure_reason) {
    record.failure_reason = 'provider_reported_failure_without_a_reason';
  }
  return record;
};

/* Executes an APPROVED batch's materialized attempts.

   `attempts` comes from aeo_scan_attempts — the frozen workload — and
   `evidenceOrigin` must be the batch's declared execution_mode; the
   database refuses any disagreement. `recordObservation` is the only
   writer and is injected, so this module never holds a database handle
   or a credential. `now` is injected for the same reason the report
   engine has no clock of its own: a deterministic fixture run must be
   re-runnable. */
export const executeBatch = async ({
  attempts,
  configurationsById,
  registry,
  recordObservation,
  evidenceOrigin,
  now = () => new Date().toISOString()
}) => {
  if (!Array.isArray(attempts)) throw new Error('aeo-scan-harness: attempts must be an array');
  if (typeof recordObservation !== 'function') {
    throw new Error('aeo-scan-harness: recordObservation is required');
  }
  if (!VALID_ORIGIN.has(evidenceOrigin)) {
    /* Refused rather than defaulted. A run whose origin nobody stated
       must not be guessed at, in either direction. */
    throw new Error(
      `aeo-scan-harness: evidenceOrigin must be one of ${[...VALID_ORIGIN].join(', ')}`);
  }

  const recorded = [];
  const tally = {
    attempted: attempts.length, recorded: 0, write_failed: 0,
    response_observed: 0, surface_not_triggered: 0, collection_failed: 0, inadmissible: 0
  };

  for (const attempt of attempts) {
    const requestedAt = now();
    const config = configurationsById?.get?.(attempt.engine_configuration_id) ?? null;
    const captureMethod = config?.capture_method ?? null;
    const provider = captureMethod ? registry?.get?.(captureMethod) : null;

    let observation;
    if (!config) {
      observation = toObservation(attempt, evidenceOrigin, requestedAt, null, null);
      observation.failure_reason = `unknown_configuration: ${attempt.engine_configuration_id}`;
    } else if (!provider) {
      /* The state of this repository today, recorded as evidence
         rather than treated as an empty result. */
      observation = toObservation(attempt, evidenceOrigin, requestedAt, null, null);
      observation.failure_reason = `unsupported_capture_method: ${captureMethod}`;
    } else {
      let outcome = null;
      let error = null;
      try {
        outcome = await provider({
          questionText: attempt.question_text,
          locationContext: attempt.location_context,
          configuration: config,
          runIndex: attempt.run_index
        });
      } catch (err) {
        error = err;
      }
      observation = toObservation(attempt, evidenceOrigin, requestedAt, outcome, error);
    }

    /* A write that fails must not abort the batch and lose every
       remaining attempt, but it must not be silent either. */
    try {
      const saved = await recordObservation(observation);
      recorded.push(saved ?? observation);
      tally.recorded += 1;
      tally[observation.observation_status] += 1;
    } catch (err) {
      tally.write_failed += 1;
      recorded.push({ ...observation, write_error: err.message || String(err) });
    }
  }

  return { observations: recorded, tally };
};

export default {
  OBSERVATION_STATUS, EVIDENCE_ORIGIN, PAYLOAD_MAX_BYTES,
  createProviderRegistry, executeBatch
};
