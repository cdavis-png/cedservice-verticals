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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* The same closed enum the endpoint and the migration filter against, so the
   fake cannot accidentally accept a name real Postgres would drop. */
const { PREFILLED_FIELD_NAMES } =
  require('../../shared/service-mix-engine/offering.schema.js');
/* The continuation conflict rule, CALLED rather than restated, so the fake
   and the browser cannot reach different conclusions. */
const resolveIdentity = require('../../shared/business-record/resolve-identity.js');

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
    business_review_states: [],
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
    /* business_identifiers_value_length is `length(normalized_value) between 1
       and 256`, and PostgreSQL `length()` counts CODE POINTS. `.length` counts
       UTF-16 code units, so an emoji counted twice here and once there — the
       same disagreement the identity predicates had above U+FFFF. */
    const valueLength = typeof row.normalized_value === 'string'
      ? [...row.normalized_value].length : -1;
    if (valueLength < 1 || valueLength > 256) {
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
    /* Mirrors 0004 as widened by 0006: payload versions 2-6 are accepted.
       6 is the Quick Service Mix Review's shape, not a newer Growth one. */
    if (row.payload_schema_version !== null && row.payload_schema_version !== undefined &&
        (row.payload_schema_version < 2 || row.payload_schema_version > 6)) {
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

  const seedSession = (sessionId, businessId, reviewType = 'growth_review') => {
    state.assessment_sessions.push({
      assessment_session_id: sessionId, business_id: businessId,
      first_touch: {},
      /* A session that predates review types is a Growth session — the same
         value migration 0006 backfills, and the column is NOT NULL, so there
         is no such thing as a session without one. */
      review_type: reviewType,
      created_at: now().toISOString(), last_seen_at: now().toISOString()
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

  /* ---------- ingest_review / ingest_assessment ----------
     Mirrors migration 0006, in which ingest_review is the body and
     ingest_assessment is a thin wrapper calling it with 'growth_review'. */

  const ingest = args => {
    const {
      p_idempotency_key: key, p_request_hash: requestHash, p_payload: payload,
      p_signals: signals, p_bir: bir, p_bir_id: birId, p_retention_days: retentionDays,
      p_meta: meta = {},
      p_review_type: reviewTypeArg = 'growth_review',
      p_continuation_business_id: continuationBusinessId = null
    } = args;

    const reviewType = reviewTypeArg || 'growth_review';
    if (!['growth_review', 'service_mix'].includes(reviewType)) {
      throw new Error(`unsupported_review_type: ${reviewType}`);
    }

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
        /* Set on insert and never changed on conflict: a session belongs to
           one review, and relabelling it would move counts already made. */
        review_type: reviewType,
        created_at: nowIso, last_seen_at: nowIso
      };
      state.assessment_sessions.push(session);
    } else {
      session.last_seen_at = nowIso;
    }

    /* A session presented under a different review type is refused rather
       than relabelled or silently accepted — mirrors migration 0006. */
    if (session.review_type !== reviewType) {
      throw new Error(
        `session_review_type_conflict: session ${sessionId} belongs to ` +
        `${session.review_type} and cannot be reused for ${reviewType}`);
    }

    /* 3. Identity resolution — verified strong identifiers only. */
    let businessId = null, identityStatus, resolutionStatus, recommendedAction, linkMethod = null;
    let confidence = 0, createdBusiness = false, candidates = [], contributing = [], conflicting = [];

    /* Rule B0: a PROPOSAL is not a decision.

       Two things can name a Business Record before any identifier is looked
       at — a server-signed continuation context and a client-supplied
       session id — and NEITHER is evidence about the business. Both are
       statements about a browser. Each is compared with what the record it
       names actually holds, and a materially contradicted proposal is set
       aside.

       Mirrors migration 0006 rule B0. The shared rule is CALLED rather than
       restated, so the fake and the browser cannot reach different
       conclusions; only the SQL is a genuine second implementation, and
       tests/identity-proposals.test.mjs runs one case table through all
       three. */
    const liveRecord = id => (id
      ? state.business_records.find(b => b.business_id === id && !b.merged_into_business_id)
      : null) || null;

    const heldBy = businessIdOf => state.business_identifiers
      .filter(bi => bi.business_id === businessIdOf && bi.valid_to === null)
      .map(bi => ({ type: bi.identifier_type, normalizedValue: bi.normalized_value }));

    /* Evidence-bearing proposals. A record that no longer exists is not a
       proposal at all, so it is absent rather than present-and-empty — the
       two are different statements and only one of them may link. */
    const proposalFor = (kind, id) => {
      const record = liveRecord(id);
      if (!record) return null;
      return {
        kind,
        businessId: record.business_id,
        heldIdentifiers: heldBy(record.business_id)
      };
    };

    const proposals = [
      proposalFor('continuation_context', continuationBusinessId),
      proposalFor('session', session.business_id)
    ].filter(Boolean);

    /* ONE call: validate, compare, resolve. The fake used to do the
       comparison itself and hand verdicts to a separate resolver, which is
       exactly the seam an evidence-free link could be composed through.

       `signals` is passed THROUGH, not defaulted. `signals || []` here turned
       "no evidence was supplied" into "there is genuinely nothing to compare"
       before the hardened resolver ever saw it — the same default the resolver
       spent three revisions removing, reintroduced one call further out. The
       resolver refuses null when a proposal exists, and this is where that
       refusal has to be able to fire. The `|| []` further down, on the
       candidate-only path, is a different question and is left alone: that
       path never compares signals against a PROPOSED record. */
    const verdict = resolveIdentity.resolveIdentityProposals({ signals, proposals });
    const contradictedProposals = verdict.judged.filter(p => p.conflict.material);
    const continuationContradicted =
      verdict.vetoedKinds.includes('continuation_context');
    const sessionContradicted = verdict.vetoedKinds.includes('session');

    if (verdict.outcome === 'link') {
      businessId = verdict.businessId;
      identityStatus = 'linked'; resolutionStatus = 'unique_match';
      recommendedAction = 'link_to_existing'; linkMethod = verdict.linkMethod; confidence = 1;
      contributing = verdict.linkMethod === 'continuation_context'
        ? ['server_issued_continuation_context']
        : ['assessment_session_link'];
    } else if (verdict.outcome === 'review') {
      /* A contradicted proposal, or two surviving proposals naming different
         records. Neither is resolved here and neither record is touched. */
      businessId = null;
      identityStatus = 'resolution_pending';
      resolutionStatus = 'manual_review_required';
      recommendedAction = 'queue_for_review'; confidence = 0;
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

      if (candidates.length === 0 && verdict.mayCreate) {
        businessId = randomUUID();
        identityStatus = 'linked'; resolutionStatus = 'no_match';
        recommendedAction = 'create_new_record'; linkMethod = 'auto'; confidence = 0;
        createdBusiness = true;
      } else if (candidates.length === 0 && !verdict.mayCreate) {
        /* Rule B4v: B4 would create, and a vetoed proposal may not create.
           The only evidence that this is a new business is the same evidence
           that just contradicted a saved proposal, and these tables refuse
           DELETE — a wrongly created record is permanent. */
        businessId = null;
        identityStatus = 'resolution_pending';
        resolutionStatus = 'manual_review_required';
        recommendedAction = 'queue_for_review'; confidence = 0;
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

    /* Every vetoed proposal is recorded wherever resolution landed, without
       the identifier values — those belong in the Business Record under its
       own retention rules, not in a review queue. */
    contradictedProposals.forEach(p => {
      conflicting = conflicting.concat([{
        kind: p.kind === 'session'
          ? 'session_contradicted' : 'continuation_context_contradicted',
        proposedBusinessId: p.businessId,
        agreedTypes: p.conflict.agreedTypes,
        contradictedTypes: p.conflict.contradictedTypes,
        reason: p.conflict.reason
      }]);
    });

    /* Two surviving proposals naming different records. Neither contradicts
       the payload, so neither can be dismissed — and choosing one would
       leave the other pointing somewhere else forever. */
    if (verdict.disagreed && !contradictedProposals.length) {
      conflicting = conflicting.concat([{
        kind: 'proposals_disagree',
        proposedBusinessIds: proposals.map(p => p.businessId),
        reason: 'The session and the continuation context name different records.'
      }]);
    }

    const proposalReviewRequired = verdict.outcome === 'review';

    /* 4. Create the record when required. */
    if (createdBusiness) {
      state.business_records.push({
        business_id: businessId, schema_version: 1, identity_status: 'linked',
        display_name: (payload.contact?.salonName || 'Unnamed business').slice(0, 160),
        legal_name: null,
        vertical_id: verticalId, lifecycle_state: 'lead_assessed',
        merged_into_business_id: null, current_bir_id: null,
        metadata: { createdFrom: 'assessment', createdBySubmission: submissionId,
                    createdByReviewType: reviewType }
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
      /* continuationApplied is decided HERE, overwriting the caller's claim:
         the endpoint knows only that it offered a context. Mirrors 0006. */
      ingest_meta: { ...meta, timelineOccurredAt: timelineAt,
                     continuationApplied: linkMethod === 'continuation_context',
                     continuationContradicted, sessionContradicted },
      review_type: reviewType
    };
    checkSubmissionRow(submissionRow);
    state.assessment_submissions.push(submissionRow);

    /* 6. Link session, record identifier evidence, surface claim conflicts. */
    const claimConflicts = [];
    if (businessId) {
      if (!session.business_id) session.business_id = businessId;
      (signals || []).forEach(s => {
        if (CONTEXT_TYPES.includes(s.type)) return;
        /* Code points, matching business_identifiers_value_length above. */
        if (typeof s.normalizedValue !== 'string' ||
            [...s.normalizedValue].length > 256) return;

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

    /* 7. BIR, chained to THIS REVIEW TYPE's previous current report.
       Read from business_review_states, not from business_records —
       reading the legacy Growth pointer here is exactly the defect
       migration 0006 exists to prevent. */
    let previousBirId = null;
    let reviewState = null;
    if (businessId) {
      reviewState = state.business_review_states.find(
        r => r.business_id === businessId && r.review_type === reviewType);
      previousBirId = reviewState?.current_bir_id ?? null;
    }
    const report = clone(bir);
    report.identity.businessId = businessId;
    report.identity.identityStatus = identityStatus;
    if (report.provenance) report.provenance.supersedes = previousBirId;

    /* The related Growth Review reference, written HERE because only the
       database knows which business this is. A reference and nothing more:
       no Growth score, no finding, no opportunity figure, and
       usedInCalculations is false because nothing from the Growth Review
       enters a Service Mix calculation. Mirrors migration 0006 section 7a. */
    if (reviewType === 'service_mix' && businessId) {
      const growthState = state.business_review_states.find(
        r => r.business_id === businessId && r.review_type === 'growth_review');
      const growthBir = growthState && state.business_intelligence_reports
        .find(r => r.bir_id === growthState.current_bir_id);
      if (growthBir) {
        const ageDays = (at.getTime() - Date.parse(growthBir.generated_at)) / 86400000;
        report.relatedGrowthReview = {
          birId: growthBir.bir_id,
          generatedAt: growthBir.generated_at,
          freshness: ageDays <= 90 ? 'fresh' : ageDays <= 180 ? 'aging'
            : ageDays <= 365 ? 'stale' : 'expired',
          /* Revalidated, not carried verbatim — mirrors 0006 section 7a. */
          prefilledFields: PREFILLED_FIELD_NAMES.filter(
            name => (payload.serviceMix?.prefilledFields ?? []).includes(name)),
          usedInCalculations: false
        };
      }
    }

    if (state.business_intelligence_reports.some(r => r.assessment_submission_id === submissionId)) {
      throw new ConstraintViolation('bir_one_per_submission');
    }
    /* Mirrors 0001 as widened by 0004 and then 0006: versions 2-5. */
    if (report.schemaVersion < 2 || report.schemaVersion > 5) {
      throw new ConstraintViolation('bir_schema_version_check');
    }
    /* 0006: a v5 report is a Service Mix report and nothing else, and a
       Service Mix report is never any other version. */
    const versionMatchesReview = reviewType === 'service_mix'
      ? report.schemaVersion === 5
      : report.schemaVersion >= 2 && report.schemaVersion <= 4;
    if (!versionMatchesReview) {
      throw new ConstraintViolation('bir_service_mix_version_check');
    }

    /* Service Mix carries a 0..1 confidence rather than a band, so the column
       keeps one meaning across review types instead of silently defaulting. */
    const confidenceBand = reviewType === 'service_mix'
      ? (() => {
          const c = Number(report.dataConfidence?.confidence ?? 0);
          return c >= 0.80 ? 'high' : c >= 0.50 ? 'medium' : 'low';
        })()
      : report.estimateConfidence?.band ?? 'low';

    if (!['low', 'medium', 'high'].includes(confidenceBand)) {
      throw new ConstraintViolation('bir_confidence_band_check');
    }

    /* 0006 supersession guard: closed within one business AND one review
       type. Enforced here as well as in the engine, because a constraint in
       one layer is a convention and in two it is a rule. */
    if (previousBirId) {
      const previous = state.business_intelligence_reports.find(r => r.bir_id === previousBirId);
      if (!previous) throw new ConstraintViolation('supersedes_unknown_bir');
      if (previous.review_type !== reviewType) {
        throw new ConstraintViolation('supersedes_review_type_mismatch');
      }
      if (!businessId || previous.business_id !== businessId) {
        throw new ConstraintViolation('supersedes_business_mismatch');
      }
    }

    state.business_intelligence_reports.push({
      bir_id: birId, business_id: businessId, assessment_submission_id: submissionId,
      schema_version: report.schemaVersion, generated_at: nowIso, report,
      confidence_band: confidenceBand,
      missing_critical_fields: reviewType === 'service_mix'
        ? (report.measurementGaps ?? []).map(g => ({ offeringId: g.offeringId, measure: g.measure }))
        : report.qualificationProfile?.missingCriticalFields ?? [],
      supersedes_bir_id: previousBirId,
      review_type: reviewType
    });

    if (businessId) {
      /* Per review type — the surface that makes Growth and Service Mix
         independently current. */
      if (!reviewState) {
        reviewState = {
          business_id: businessId, review_type: reviewType,
          current_bir_id: null,
          /* Written once, on the first submission of this review type, and
             never moved: it is the root of the supersession chain. */
          original_submission_id: null, latest_submission_id: null,
          last_completed_at: null,
          next_reassessment_due_at: null, next_reassessment_kind: null,
          completed_count: 0,
          created_at: nowIso, updated_at: nowIso,
          state: { verticalId, lastLinkMethod: linkMethod }
        };
        state.business_review_states.push(reviewState);
      }
      const firstOfType = reviewState.original_submission_id === null;
      reviewState.current_bir_id = birId;
      if (firstOfType) reviewState.original_submission_id = submissionId;
      reviewState.latest_submission_id = submissionId;
      reviewState.last_completed_at = timelineAt;
      /* LIFECYCLE_POLICY: 90 days either way; the kind says which rule. */
      reviewState.next_reassessment_due_at =
        new Date(Date.parse(timelineAt) + 90 * 86400000).toISOString();
      reviewState.next_reassessment_kind = firstOfType ? 'quick_recheck' : 'quarterly_review';
      reviewState.completed_count += 1;
      reviewState.updated_at = nowIso;
      reviewState.state = { ...reviewState.state, verticalId, lastLinkMethod: linkMethod };

      /* The legacy pointer stays a GROWTH pointer. 0006 refuses anything else
         at the database; this mirrors that refusal. */
      const record = state.business_records.find(b => b.business_id === businessId);
      if (record && reviewType === 'growth_review') record.current_bir_id = birId;
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

    /* Mirrors the two AFTER INSERT triggers added by migration 0004. A payload
       or report that declares no stage emits nothing: inventing a stage event
       for a review that had no stages would put a false fact into a store that
       cannot correct one. */
    const declaredStage = Number(payload.assessmentStage?.stage) || null;
    if (declaredStage === 1) {
      appendEvent('stage1.completed', 1, timelineAt, 'assessment-engine', submissionId,
        'Growth Review completed. Preliminary results delivered.',
        { submissionId, assessmentSessionId: sessionId, verticalId,
          assessmentVersion: payload.assessmentVersion,
          trigger: payload.assessmentStage?.trigger ?? null });
    } else if (declaredStage === 2) {
      const startedAt = payload.assessmentStage?.stage2StartedAt;
      const startedMs = startedAt ? Date.parse(startedAt) : NaN;
      const clampedStart = new Date(
        Math.min(Number.isFinite(startedMs) ? startedMs : Date.parse(timelineAt),
          Date.parse(timelineAt))).toISOString();
      appendEvent('stage2.started', 1, clampedStart, 'assessment-engine', submissionId,
        'Fit and Activation Review opened by the visitor.',
        { submissionId, assessmentSessionId: sessionId,
          trigger: payload.assessmentStage?.trigger ?? null,
          continuesSubmissionId: payload.assessmentStage?.supersedesSubmissionId ?? null });
      appendEvent('stage2.completed', 1, timelineAt, 'assessment-engine', submissionId,
        'Fit and Activation Review completed.',
        { submissionId, assessmentSessionId: sessionId, verticalId,
          assessmentVersion: payload.assessmentVersion,
          continuesSubmissionId: payload.assessmentStage?.supersedesSubmissionId ?? null });
    }

    /* stageDeclared, not assessmentStageCompleted: the latter always has a
       value, the former says whether the submission actually named a stage. */
    const reportStage = report.assessmentProgress?.stageDeclared === true
      ? Number(report.assessmentProgress.assessmentStageCompleted) || null
      : null;
    if (reportStage) {
      appendEvent(reportStage === 1 ? 'preliminary_bir.generated' : 'full_bir.generated',
        1, timelineAt, 'business-intelligence-engine', birId,
        reportStage === 1
          ? 'Preliminary Business Intelligence Report generated from the Growth Review.'
          : 'Full Business Intelligence Report generated from the completed Fit and Activation Review.',
        { birId, supersedesBirId: previousBirId, assessmentStageCompleted: reportStage,
          resultState: report.assessmentProgress?.resultState ?? null,
          confidenceKind: report.assessmentProgress?.confidenceKind ?? null,
          closeReadinessProvisional: report.assessmentProgress?.closeReadinessProvisional === true,
          closeReadinessBand: report.closeReadinessProfile?.band ?? null });
    }
    trip('timeline');

    /* 9. Ambiguity or claim conflict -> a case. A vetoed PROPOSAL always makes
       one too, even when resolution succeeded by other means: "a saved
       proposal was set aside" is a fact somebody needs to find. */
    if (identityStatus === 'resolution_pending' || claimConflicts.length ||
        contradictedProposals.length || verdict.disagreed) {
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
        contradictedProposals.length
          ? 'A saved identity proposal was set aside: the submitted identity contradicts the record it named.'
          : verdict.disagreed
            ? 'The session and the continuation context name different records.'
            : claimConflicts.length
              ? 'A claimed identifier is already held, verified, by another business.'
              : 'Identity could not be resolved automatically; queued for review.',
        { identityResolutionId: caseId, resolutionStatus,
          reason: contradictedProposals.length
            ? 'A saved identity proposal was contradicted by submitted identity evidence.'
            : verdict.disagreed
              ? 'Two saved proposals name different Business Records.'
              : claimConflicts.length
                ? 'Cross-business claim on a verified identifier.'
                : 'No unique verified strong identifier among candidates.',
          continuationContradicted,
          sessionContradicted,
          proposalsDisagreed: verdict.disagreed,
          vetoedProposalKinds: verdict.vetoedKinds,
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
        payloadSchemaVersion: schemaVersion, ingestMeta: meta,
        continuationContradicted, sessionContradicted,
        proposalsDisagreed: verdict.disagreed, claimConflicts
      },
      correlation_id: meta.correlationId || submissionId, created_at: nowIso
    });

    /* 11. Response, stored for replay. */
    const response = {
      ok: true, replayed: false, submissionId, assessmentSessionId: sessionId,
      businessId, assessmentId: submissionId, birId, supersedesBirId: previousBirId,
      identityStatus, reviewType, linkMethod, payloadSchemaVersion: schemaVersion,
      /* Reported so the endpoint can log it. Carries no identifier value and
         no business id: the caller learns that a proposal was not applied,
         never whose record it named or what differed. */
      continuationContradicted,
      sessionContradicted,
      proposalsDisagreed: verdict.disagreed,
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
    /* 0006: one body, two names. ingest_assessment is the compatibility
       wrapper and always means growth_review. */
    ingest_review: ingest,
    ingest_assessment: args => ingest({
      ...args, p_review_type: 'growth_review', p_continuation_business_id: null
    }),
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
