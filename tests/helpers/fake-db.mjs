/* In-memory stand-in for Supabase + the migration functions.
   Mirrors supabase/migrations/0002 + 0003 step for step so the endpoint can be
   tested without a database.

   IMPORTANT: this proves the CONTRACT, not the SQL. The PL/pgSQL itself needs
   a live Postgres to verify — see docs/PRODUCTION_HARDENING.md,
   "Real-Postgres test plan".

   It DOES enforce the CHECK constraints that ingestion can violate, because
   the Milestone 1 review found a live conflict between the endpoint's
   clock-skew allowance and timeline_events.recorded_at >= occurred_at that
   the previous double could not see. A double that only mirrors the happy
   path is a double that hides constraint bugs. */

import { randomUUID } from 'node:crypto';

const STRONG_TYPES = ['gbp_place_id', 'external_customer_id', 'payment_customer_id'];
const CONTEXT_TYPES = ['vertical', 'locality'];
const TRUSTED_SOURCES = ['trusted_integration', 'verified_enrichment',
  'authenticated_customer', 'manual_verification', 'seed'];
const PII_IDENTIFIER_TYPES = ['email_exact', 'email_domain', 'mobile_phone',
  'business_phone', 'business_name', 'website_domain'];

const clone = v => JSON.parse(JSON.stringify(v));

class ConstraintViolation extends Error {}

export function createFakeDb(options = {}) {
  const { failAt = null, now = () => new Date('2026-08-04T12:00:05.000Z') } = options;

  const state = {
    business_records: [],
    business_identifiers: [],
    assessment_sessions: [],
    assessment_submissions: [],
    business_intelligence_reports: [],
    timeline_events: [],
    identity_resolution_cases: [],
    idempotency_records: [],
    audit_events: [],
    rate_limit_buckets: []
  };

  const snapshot = () => clone(state);
  const restore = snap => Object.keys(state).forEach(k => { state[k] = snap[k]; });

  const trip = stage => { if (failAt === stage) throw new Error(`injected_failure_at_${stage}`); };

  /* ---------- constraint enforcement ---------- */

  const checkIdentifierRow = row => {
    if (CONTEXT_TYPES.includes(row.identifier_type)) {
      throw new ConstraintViolation('business_identifiers_no_context_types');
    }
    if (typeof row.normalized_value !== 'string' ||
        row.normalized_value.length < 1 || row.normalized_value.length > 256) {
      throw new ConstraintViolation('business_identifiers_value_length');
    }
    if (row.verified === true &&
        (!TRUSTED_SOURCES.includes(row.source) || row.verification_method === 'none')) {
      throw new ConstraintViolation('business_identifiers_verified_requires_trust');
    }
  };

  const checkSubmissionRow = row => {
    const linked = ['linked', 'manually_verified'].includes(row.identity_status);
    if (linked !== (row.business_id !== null && row.business_id !== undefined)) {
      throw new ConstraintViolation('assessment_submissions_identity_consistency');
    }
    if (row.payload_schema_version !== null && row.payload_schema_version !== undefined &&
        (row.payload_schema_version < 2 || row.payload_schema_version > 3)) {
      throw new ConstraintViolation('assessment_submissions_payload_version_check');
    }
  };

  /* The constraint the previous double did not model. */
  const checkTimelineRow = row => {
    if (Date.parse(row.recorded_at) < Date.parse(row.occurred_at)) {
      throw new ConstraintViolation('timeline_recorded_after_occurred');
    }
    if (state.timeline_events.some(e =>
      e.event_name === row.event_name && e.idempotency_key === row.idempotency_key)) {
      throw new ConstraintViolation('timeline_events_idempotency');
    }
  };

  /* ---------- seeding ---------- */

  const seedBusiness = ({ businessId = randomUUID(), displayName = 'Seeded Salon',
                          verticalId = 'nails', identifiers = [] } = {}) => {
    state.business_records.push({
      business_id: businessId, schema_version: 1, identity_status: 'linked',
      display_name: displayName, legal_name: null, vertical_id: verticalId,
      lifecycle_state: 'lead_assessed', merged_into_business_id: null,
      current_bir_id: null, metadata: {}
    });
    identifiers.forEach(i => {
      const verified = i.verified === true;
      const row = {
        identifier_id: randomUUID(), business_id: businessId,
        identifier_type: i.type, normalized_value: i.normalizedValue,
        raw_value: i.rawValue ?? null,
        source: i.source ?? (verified ? 'seed' : 'visitor_supplied'),
        confidence: verified ? 0.95 : 0.35,
        verified,
        verification_method: i.verificationMethod ?? (verified ? 'operator_review' : 'none'),
        verification_evidence: i.verificationEvidence ?? null,
        valid_to: null
      };
      checkIdentifierRow(row);
      /* Global uniqueness applies to VERIFIED strong identifiers only. */
      if (verified && STRONG_TYPES.includes(row.identifier_type) &&
          state.business_identifiers.some(bi => bi.valid_to === null && bi.verified &&
            bi.identifier_type === row.identifier_type &&
            bi.normalized_value === row.normalized_value)) {
        throw new ConstraintViolation('business_identifiers_verified_strong_unique');
      }
      state.business_identifiers.push(row);
    });
    return businessId;
  };

  const seedSession = (sessionId, businessId) => {
    state.assessment_sessions.push({
      assessment_session_id: sessionId, business_id: businessId,
      first_touch: {}, created_at: now().toISOString(), last_seen_at: now().toISOString()
    });
  };

  /* ---------- check_rate_limit ---------- */

  const checkRateLimit = ({ p_keys, p_window_seconds, p_max_requests }) => {
    const windowSeconds = p_window_seconds > 0 ? p_window_seconds : 900;
    const maxRequests = p_max_requests > 0 ? p_max_requests : 20;
    const at = now();
    const epoch = Math.floor(at.getTime() / 1000);
    const windowStart = Math.floor(epoch / windowSeconds) * windowSeconds;
    const expiresAt = new Date((windowStart + windowSeconds * 2) * 1000).toISOString();

    let worst = 0;
    let worstScope = null;

    (p_keys || []).forEach(entry => {
      if (!entry || !entry.scope || !entry.key) return;
      let bucket = state.rate_limit_buckets.find(b =>
        b.scope === entry.scope && b.bucket_key === entry.key && b.window_start === windowStart);
      if (!bucket) {
        bucket = {
          scope: entry.scope, bucket_key: entry.key, window_start: windowStart,
          request_count: 0, expires_at: expiresAt
        };
        state.rate_limit_buckets.push(bucket);
      }
      bucket.request_count += 1;
      if (bucket.request_count > worst) {
        worst = bucket.request_count;
        worstScope = entry.scope;
      }
    });

    if (worst > maxRequests) {
      return {
        allowed: false, scope: worstScope, limit: maxRequests, count: worst,
        windowSeconds,
        retryAfterSeconds: Math.max(1, (windowStart + windowSeconds) - epoch)
      };
    }
    return {
      allowed: true, scope: worstScope, limit: maxRequests, count: worst,
      remaining: Math.max(0, maxRequests - worst), windowSeconds
    };
  };

  /* ---------- purge_expired_idempotency_records ---------- */

  const purgeIdempotency = ({ p_now, p_limit } = {}) => {
    const cutoff = Date.parse(p_now || now().toISOString());
    const limit = p_limit > 0 ? p_limit : 10000;
    const doomed = state.idempotency_records
      .filter(r => Date.parse(r.expires_at) < cutoff)
      .slice(0, limit);
    const keys = new Set(doomed.map(r => r.idempotency_key));
    state.idempotency_records = state.idempotency_records.filter(r => !keys.has(r.idempotency_key));
    return doomed.length;
  };

  /* ---------- redact_business_pii ---------- */

  const redact = ({ p_business_id, p_reason, p_actor, p_actor_type = 'human' }) => {
    if (!p_reason || p_reason.trim().length < 8) throw new Error('redaction_reason_required');
    if (!p_actor || !p_actor.trim()) throw new Error('redaction_actor_required');
    if (!['human', 'engine', 'integration', 'system'].includes(p_actor_type)) {
      throw new Error('redaction_actor_type_invalid');
    }
    const record = state.business_records.find(b => b.business_id === p_business_id);
    if (!record) throw new Error('business_not_found');

    const at = now().toISOString();
    const TOKEN = '[redacted]';

    record.display_name = TOKEN;
    record.legal_name = null;
    record.metadata = { ...record.metadata, redactedAt: at, redactionReason: p_reason };

    const submissions = state.assessment_submissions.filter(s => s.business_id === p_business_id);
    submissions.forEach(s => {
      const payload = s.raw_payload;
      if (payload.contact) {
        Object.keys(payload.contact).forEach(k => {
          if (k !== 'preferredContact') payload.contact[k] = TOKEN;
        });
      }
      if (payload.answers) {
        ['salonName', 'ownerName', 'email', 'mobile', 'businessName',
          'website', 'googlePlaceId', 'externalCustomerId', 'businessPhone'].forEach(k => {
          if (k in payload.answers) payload.answers[k] = TOKEN;
        });
      }
      s.ingest_meta = { ...(s.ingest_meta || {}), redactedAt: at };
      checkSubmissionRow(s);
    });

    let identifiers = 0;
    state.business_identifiers
      .filter(bi => bi.business_id === p_business_id && PII_IDENTIFIER_TYPES.includes(bi.identifier_type))
      .forEach(bi => {
        bi.raw_value = null;
        bi.normalized_value = `redacted:${bi.identifier_id}`;
        bi.verified = false;
        bi.valid_to = bi.valid_to || at;
        identifiers++;
        checkIdentifierRow(bi);
      });

    let reports = 0;
    state.business_intelligence_reports
      .filter(r => r.business_id === p_business_id)
      .forEach(r => {
        if (r.report?.businessProfile && 'displayName' in r.report.businessProfile &&
            r.report.businessProfile.displayName !== TOKEN) {
          r.report.businessProfile.displayName = TOKEN;
          reports++;
        }
      });

    const auditId = randomUUID();
    state.audit_events.push({
      audit_event_id: auditId, business_id: p_business_id, action: 'business.pii_redacted',
      actor_type: p_actor_type, actor_id: p_actor, reason: p_reason, previous_value: null,
      new_value: {
        submissionsRedacted: submissions.length,
        identifiersRedacted: identifiers,
        reportsDisplayNameRedacted: reports,
        redactedAt: at
      },
      correlation_id: `redaction:${p_business_id}`, created_at: at
    });

    return {
      businessId: p_business_id,
      redactedAt: at,
      auditEventId: auditId,
      redacted: {
        businessRecordDisplayName: true,
        businessRecordLegalName: true,
        assessmentSubmissionContact: submissions.length,
        assessmentSubmissionIdentityAnswers: submissions.length,
        identityEvidenceRows: identifiers,
        birDisplayName: reports
      },
      preserved: {
        businessId: 'permanent, opaque, not derived from contact data',
        timelineEvents: 'append-only skeleton retained; payloads carry no contact data',
        auditEvents: 'append-only, retained in full',
        assessmentScoresAndAnswers: 'operational answers and all scoring retained',
        birAnalysis: 'every score, band, estimate, and rationale retained unchanged',
        consentRecords: 'retained as proof of what was shown and agreed',
        attribution: 'campaign attribution retained; review separately if a URL can carry contact data'
      },
      notes: [
        'Timeline and audit history cannot be updated by design; they are retained in structural form.',
        'External systems (payment processor, CRM, email provider) are NOT touched by this function.',
        'This function makes no claim of compliance with any law or regulation.'
      ]
    };
  };

  /* ---------- ingest_assessment ---------- */

  const ingest = args => {
    const {
      p_idempotency_key: key, p_request_hash: requestHash, p_payload: payload,
      p_signals: signals, p_bir: bir, p_bir_id: birId, p_retention_days: retentionDays,
      p_meta: meta = {}
    } = args;

    const at = now();
    const nowIso = at.toISOString();
    const submissionId = payload.submissionId;
    const sessionId = payload.assessmentSessionId;
    const verticalId = payload.vertical?.id ?? 'unknown';
    const schemaVersion = payload.schemaVersion ?? 2;

    /* Clamped: a fast device clock must never abort ingestion. The visitor's
       own submittedAt is preserved verbatim on the submission row. */
    const submittedAtMs = Date.parse(payload.submittedAt);
    const timelineAt = new Date(Math.min(submittedAtMs, at.getTime())).toISOString();

    /* 1. Claim the key. */
    const existing = state.idempotency_records.find(r => r.idempotency_key === key);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error('idempotency_key_conflict');
      if (existing.response_body) return { ...clone(existing.response_body), replayed: true };
      throw new Error('request_in_flight');
    }
    state.idempotency_records.push({
      idempotency_key: key, submission_id: submissionId, request_hash: requestHash,
      response_status: null, response_body: null, created_at: nowIso,
      expires_at: new Date(at.getTime() + retentionDays * 86400000).toISOString()
    });
    trip('claim');

    /* 2. Session. */
    let session = state.assessment_sessions.find(s => s.assessment_session_id === sessionId);
    if (!session) {
      session = {
        assessment_session_id: sessionId, business_id: null,
        first_touch: payload.attribution?.firstTouch ?? {},
        created_at: nowIso, last_seen_at: nowIso
      };
      state.assessment_sessions.push(session);
    } else {
      session.last_seen_at = nowIso;
    }

    /* 3. Identity resolution — verified strong identifiers only. */
    let businessId = null, identityStatus, resolutionStatus, recommendedAction, linkMethod = null;
    let confidence = 0, createdBusiness = false, candidates = [], contributing = [], conflicting = [];

    if (session.business_id) {
      businessId = session.business_id;
      identityStatus = 'linked'; resolutionStatus = 'unique_match';
      recommendedAction = 'link_to_existing'; linkMethod = 'session'; confidence = 1;
      contributing = ['assessment_session_link'];
    } else {
      const matchable = (signals || []).filter(s => !CONTEXT_TYPES.includes(s.type));
      const byBusiness = new Map();
      state.business_identifiers
        .filter(bi => bi.valid_to === null)
        .forEach(bi => {
          const record = state.business_records.find(b => b.business_id === bi.business_id);
          if (!record || record.merged_into_business_id) return;
          const hit = matchable.some(s => s.type === bi.identifier_type &&
            s.normalizedValue === bi.normalized_value);
          if (!hit) return;
          if (!byBusiness.has(bi.business_id)) {
            byBusiness.set(bi.business_id, { matched: new Set(), verifiedStrong: new Set(), claimedStrong: new Set() });
          }
          const bucket = byBusiness.get(bi.business_id);
          bucket.matched.add(bi.identifier_type);
          if (STRONG_TYPES.includes(bi.identifier_type)) {
            (bi.verified ? bucket.verifiedStrong : bucket.claimedStrong).add(bi.identifier_type);
          }
        });

      candidates = [...byBusiness.entries()].map(([id, b]) => ({
        businessId: id,
        matchedTypes: [...b.matched],
        verifiedStrongTypes: [...b.verifiedStrong],
        claimedStrongTypes: [...b.claimedStrong]
      }));
      const verifiedStrong = candidates.filter(c => c.verifiedStrongTypes.length > 0);
      const anyClaimed = candidates.some(c => c.claimedStrongTypes.length > 0);

      if (candidates.length === 0) {
        businessId = randomUUID();
        identityStatus = 'linked'; resolutionStatus = 'no_match';
        recommendedAction = 'create_new_record'; linkMethod = 'auto'; confidence = 0;
        createdBusiness = true;
      } else if (verifiedStrong.length === 1) {
        businessId = verifiedStrong[0].businessId;
        identityStatus = 'linked'; resolutionStatus = 'unique_match';
        recommendedAction = 'link_to_existing'; linkMethod = 'auto'; confidence = 0.95;
        contributing = verifiedStrong[0].matchedTypes;
      } else {
        businessId = null;
        identityStatus = 'resolution_pending';
        resolutionStatus = verifiedStrong.length > 1 ? 'possible_duplicate'
          : anyClaimed ? 'manual_review_required'
          : candidates.length === 1 ? 'probable_match' : 'possible_duplicate';
        recommendedAction = 'queue_for_review';
        confidence = verifiedStrong.length > 1 ? 0.75 : 0.6;
        conflicting = candidates;
      }
    }

    /* 4. Create the record when required. */
    if (createdBusiness) {
      state.business_records.push({
        business_id: businessId, schema_version: 1, identity_status: 'linked',
        display_name: (payload.contact?.salonName || 'Unnamed business').slice(0, 160),
        legal_name: null,
        vertical_id: verticalId, lifecycle_state: 'lead_assessed',
        merged_into_business_id: null, current_bir_id: null,
        metadata: { createdFrom: 'assessment', createdBySubmission: submissionId }
      });
    }
    trip('business');

    /* 5. Submission. */
    if (state.assessment_submissions.some(s => s.submission_id === submissionId)) {
      throw new Error('duplicate key value violates unique constraint');
    }
    const submissionRow = {
      submission_id: submissionId, assessment_session_id: sessionId, business_id: businessId,
      assessment_version: payload.assessmentVersion, vertical_id: verticalId,
      raw_payload: clone(payload), identity_status: identityStatus,
      submitted_at: payload.submittedAt, received_at: nowIso,
      payload_hash: requestHash, consent_snapshot: payload.consent ?? {},
      attribution_snapshot: payload.attribution ?? {},
      payload_schema_version: schemaVersion,
      ingest_meta: { ...meta, timelineOccurredAt: timelineAt }
    };
    checkSubmissionRow(submissionRow);
    state.assessment_submissions.push(submissionRow);

    /* 6. Link session, record identifier evidence, surface claim conflicts. */
    const claimConflicts = [];
    if (businessId) {
      if (!session.business_id) session.business_id = businessId;
      (signals || []).forEach(s => {
        if (CONTEXT_TYPES.includes(s.type)) return;
        if (typeof s.normalizedValue !== 'string' || s.normalizedValue.length > 256) return;

        if (STRONG_TYPES.includes(s.type)) {
          const holder = state.business_identifiers.find(bi =>
            bi.valid_to === null && bi.verified === true &&
            bi.identifier_type === s.type && bi.normalized_value === s.normalizedValue &&
            bi.business_id !== businessId);
          if (holder) {
            claimConflicts.push({
              identifierType: s.type,
              heldByBusinessId: holder.business_id,
              claimedBySubmissionId: submissionId,
              claimSource: s.source || 'visitor_supplied'
            });
            return;                    /* reported, never written */
          }
        }

        const already = state.business_identifiers.some(bi =>
          bi.valid_to === null && bi.business_id === businessId &&
          bi.identifier_type === s.type && bi.normalized_value === s.normalizedValue);
        if (already) return;

        const row = {
          identifier_id: randomUUID(), business_id: businessId, identifier_type: s.type,
          normalized_value: s.normalizedValue, raw_value: s.rawValue ?? null,
          source: s.source || 'visitor_supplied',
          confidence: s.verified === true ? 0.95 : s.strength === 'moderate' ? 0.5 : 0.35,
          verified: s.verified === true,
          verification_method: s.verificationMethod || 'none',
          verification_evidence: s.verificationEvidence ?? null,
          valid_to: null
        };
        checkIdentifierRow(row);
        state.business_identifiers.push(row);
      });
    }

    /* 7. BIR, chained to the business's previous current BIR. */
    let previousBirId = null;
    if (businessId) {
      const record = state.business_records.find(b => b.business_id === businessId);
      previousBirId = record?.current_bir_id ?? null;
    }
    const report = clone(bir);
    report.identity.businessId = businessId;
    report.identity.identityStatus = identityStatus;
    if (report.provenance) report.provenance.supersedes = previousBirId;

    if (state.business_intelligence_reports.some(r => r.assessment_submission_id === submissionId)) {
      throw new ConstraintViolation('bir_one_per_submission');
    }
    state.business_intelligence_reports.push({
      bir_id: birId, business_id: businessId, assessment_submission_id: submissionId,
      schema_version: report.schemaVersion, generated_at: nowIso, report,
      confidence_band: report.estimateConfidence?.band ?? 'low',
      missing_critical_fields: report.qualificationProfile?.missingCriticalFields ?? [],
      supersedes_bir_id: previousBirId
    });
    if (businessId) {
      const record = state.business_records.find(b => b.business_id === businessId);
      if (record) record.current_bir_id = birId;
    }
    trip('bir');

    /* 8. Timeline — occurred_at is the CLAMPED timestamp. */
    const eventIds = [];
    const appendEvent = (name, version, occurredAt, producer, idemKey, summary, eventPayload) => {
      const id = randomUUID();
      const row = {
        event_id: id, business_id: businessId, event_name: name, event_version: version,
        occurred_at: occurredAt, recorded_at: nowIso, producer, source_system: 'cip',
        idempotency_key: String(idemKey), summary, payload: eventPayload,
        correlation_id: submissionId, supersedes_event_id: null, correction_of_event_id: null
      };
      checkTimelineRow(row);
      state.timeline_events.push(row);
      eventIds.push(id);
      return id;
    };

    if (createdBusiness) {
      appendEvent('business.created', 1, timelineAt, 'business-record-engine', businessId,
        'Business Record created from a completed assessment.',
        { createdFrom: 'assessment', verticalId });
    }
    appendEvent('identity.resolved', 1, timelineAt, 'business-record-engine', submissionId,
      `Identity resolution: ${resolutionStatus}.`,
      { resolutionStatus, resolutionConfidence: confidence, recommendedAction,
        candidateCount: candidates.length });
    if (businessId) {
      appendEvent('identity.linked', 1, timelineAt, 'business-record-engine', `submission:${submissionId}`,
        'Assessment submission linked to this Business Record.',
        { linkedBusinessId: businessId, linkedArtifactKind: 'assessment_submission',
          linkedArtifactId: submissionId, linkMethod });
    }
    appendEvent('assessment.completed', 2, timelineAt, 'assessment-engine', submissionId,
      'Assessment completed.',
      { assessmentSessionId: sessionId, submissionId, verticalId,
        assessmentVersion: payload.assessmentVersion,
        payloadSchemaVersion: schemaVersion,
        reportedSubmittedAt: payload.submittedAt,
        clockSkewDetected: meta.clockSkewDetected === true });
    appendEvent('bir.generated', 1, timelineAt, 'business-intelligence-engine', birId,
      'Business Intelligence Report generated.',
      { birId, supersedesBirId: previousBirId, confidenceBand: report.estimateConfidence?.band,
        closeReadinessBand: report.closeReadinessProfile?.band });
    trip('timeline');

    /* 9. Ambiguity or claim conflict -> a case. */
    if (identityStatus === 'resolution_pending' || claimConflicts.length) {
      const caseId = randomUUID();
      state.identity_resolution_cases.push({
        identity_resolution_id: caseId, assessment_submission_id: submissionId,
        candidate_business_ids: candidates, contributing_signals: contributing,
        conflicting_signals: claimConflicts.length ? [...conflicting, ...claimConflicts] : conflicting,
        confidence, resolution_status: identityStatus === 'resolution_pending'
          ? resolutionStatus : 'manual_review_required',
        recommended_action: 'queue_for_review', created_at: nowIso,
        resolved_at: null, resolved_by: null
      });
      appendEvent('identity.review_required', 1, timelineAt, 'business-record-engine', caseId,
        claimConflicts.length
          ? 'A claimed identifier is already held, verified, by another business.'
          : 'Identity could not be resolved automatically; queued for review.',
        { identityResolutionId: caseId, resolutionStatus,
          reason: claimConflicts.length
            ? 'Cross-business claim on a verified identifier.'
            : 'No unique verified strong identifier among candidates.',
          candidateBusinessIds: candidates, claimConflicts });
    }

    /* 10. Audit. */
    state.audit_events.push({
      audit_event_id: randomUUID(), business_id: businessId, action: 'assessment.ingested',
      actor_type: 'engine', actor_id: 'business-record-engine',
      reason: `Ingested submission ${submissionId} with identity status ${identityStatus}.`,
      previous_value: null,
      new_value: {
        submissionId, birId, supersedesBirId: previousBirId, identityStatus, resolutionStatus,
        payloadSchemaVersion: schemaVersion, ingestMeta: meta, claimConflicts
      },
      correlation_id: meta.correlationId || submissionId, created_at: nowIso
    });

    /* 11. Response, stored for replay. */
    const response = {
      ok: true, replayed: false, submissionId, assessmentSessionId: sessionId,
      businessId, assessmentId: submissionId, birId, supersedesBirId: previousBirId,
      identityStatus, payloadSchemaVersion: schemaVersion,
      clockSkewDetected: meta.clockSkewDetected === true,
      timelineEventIds: eventIds, receivedAt: nowIso,
      nextAction: identityStatus === 'resolution_pending' ? 'identity_review_pending' : 'results_ready'
    };
    const claim = state.idempotency_records.find(r => r.idempotency_key === key);
    claim.response_status = 201;
    claim.response_body = clone(response);
    return response;
  };

  const HANDLERS = {
    ingest_assessment: ingest,
    check_rate_limit: checkRateLimit,
    purge_expired_idempotency_records: purgeIdempotency,
    redact_business_pii: redact
  };

  const db = {
    state,
    seedBusiness,
    seedSession,
    async rpc(name, args) {
      const handler = HANDLERS[name];
      if (!handler) return { data: null, error: { message: `unknown function ${name}` } };
      const before = snapshot();
      try {
        return { data: handler(args), error: null };
      } catch (err) {
        restore(before);            // one call = one transaction
        return { data: null, error: { message: err.message } };
      }
    }
  };
  return db;
}
