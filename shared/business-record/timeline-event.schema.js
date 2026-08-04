/* ============================================================
   CED Intelligence Platform — Timeline Event
   Canonical schema, v1
   ------------------------------------------------------------
   The durable narrative of a business relationship. Append-only.
   A timeline event, once written, is never edited or deleted.
   Something wrong gets a NEW event that corrects it, so the
   record of what we believed and when survives intact.

   Relationship to the event catalog:
     shared/events/event-catalog.js is the INTER-ENGINE BUS
     contract — transient messages between engines.
     This file is the BUSINESS HISTORY projection — what happened
     to a business, kept forever.
   They overlap but are not the same set. TIMELINE_TO_CATALOG
   below maps every timeline event to its bus counterpart, or to
   null where the timeline records something the bus never
   carried. The catalog is unchanged by this file.

   SPECIFICATION ONLY. No bus, no store, no emitter.
   ============================================================ */

(() => {
  'use strict';

  const TIMELINE_EVENT_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  /* Who may see an entry. Timelines get shown to customers eventually;
     classification at write time avoids a painful audit later. */
  const VISIBILITY = ['internal', 'owner_only', 'customer_visible', 'partner_visible'];

  const ACTOR_KINDS = ['human', 'engine', 'integration', 'system', 'business'];

  /* ---------------------------------------------------------
     Envelope
     --------------------------------------------------------- */

  const TIMELINE_EVENT_SCHEMA = {
    eventId: f('uuid', { required: true, immutable: true }),
    eventName: f('enum', { required: true, note: 'Key of TIMELINE_EVENTS.' }),
    eventVersion: f('integer', { required: true, note: 'Version of that event definition.' }),
    schemaVersion: f('integer', { required: true, note: 'Version of this envelope.' }),

    /* The permanent Business Record id. Never a name, email, or phone.
       May be null ONLY for events in PRE_IDENTITY_EVENTS, which occur before
       identity resolution completes. Once resolved, an identity.linked event
       records the attachment — the original event is NEVER rewritten. */
    businessId: f('uuid', { required: true, nullable: true }),
    identityStatus: f('enum', { required: true, note: 'Vocabulary owned by identity-resolution.schema.js :: IDENTITY_LINK_STATUSES.' }),
    identityResolutionId: f('uuid', { nullable: true, note: 'Carries the thread while businessId is still null.' }),
    legacyBusinessKey: f('string', { deprecated: true, nullable: true, note: 'Provenance only, on migrated pre-identity events. Never an identifier.' }),

    /* Two clocks, deliberately. occurredAt is when it happened in the world;
       recordedAt is when we learned. Backfilled history has an old occurredAt
       and a recent recordedAt, and conflating them corrupts every cadence
       calculation that depends on "last meaningful interaction". */
    occurredAt: f('iso8601', { required: true }),
    recordedAt: f('iso8601', { required: true }),

    producer: f('string', { required: true, note: 'Engine id, from event-catalog.js ENGINES where applicable.' }),
    sourceSystem: f('string', { required: true, note: 'System of origin: "cip", a CRM, a processor, "manual".' }),
    sourceRecordId: f('string', { nullable: true, note: 'Id in that system, for reconciliation.' }),

    actor: f('object', { required: true, note: '{ kind (ACTOR_KINDS), id, displayName }. Who caused it.' }),

    correlationId: f('string', { nullable: true, note: 'Groups everything belonging to one workflow run.' }),
    causationId: f('string', { nullable: true, note: 'The event id that directly caused this one. Correlation groups; causation chains.' }),
    idempotencyKey: f('string', { required: true, note: 'Replays with the same key are a no-op. Guidance per event below.' }),

    visibility: f('enum', { required: true, values: VISIBILITY, default: 'internal' }),
    summary: f('string', { required: true, note: 'One plain-language line. What a person reading the timeline sees.' }),
    payload: f('object', { required: true, note: 'Event-specific fields. Never contains prohibited data.' }),
    evidenceRefs: f('array<string>', { note: 'Pointers to assessments, BIRs, files, messages that substantiate this.' }),

    /* Corrections never mutate. Exactly one of these may be set. */
    supersedesEventId: f('uuid', { nullable: true, note: 'This event replaces an earlier one that is now stale but was not wrong.' }),
    correctionOfEventId: f('uuid', { nullable: true, note: 'This event corrects an earlier one that was wrong. The original stays readable.' }),
    correctionReason: f('string', { nullable: true, note: 'Required when correctionOfEventId is set.' })
  };

  /* ---------------------------------------------------------
     Event definitions
     --------------------------------------------------------- */

  /* Timeline events that may legitimately carry a null businessId, because they
     happen before or during identity resolution. Everything else requires one. */
  const PRE_IDENTITY_EVENTS = [
    'assessment.started', 'assessment.completed',
    'identity.review_required', 'identity.linked'
  ];

  const TIMELINE_EVENTS = {
    /* ---- identity and record custody ---- */

    'identity.resolved': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['identityResolutionId', 'resolutionStatus', 'resolutionConfidence'],
      optional: ['candidateCount', 'contributingSignals'],
      idempotencyKey: 'identityResolutionId'
    },
    'identity.review_required': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['identityResolutionId', 'resolutionStatus', 'reason'],
      optional: ['candidateBusinessIds', 'exceptionId'],
      idempotencyKey: 'identityResolutionId',
      note: 'businessId is null; the artifact is not yet attached to any record.'
    },
    'identity.linked': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['linkedBusinessId', 'linkedArtifactKind', 'linkedArtifactId', 'linkMethod'],
      optional: ['identityResolutionId', 'previousIdentityStatus', 'legacyBusinessKey'],
      idempotencyKey: 'linkedArtifactKind + linkedArtifactId',
      note: 'The record of attachment. Historical events are never rewritten to insert a businessId — this event is written instead. linkMethod is auto | manual | migration.'
    },
    'business.created': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['createdFrom', 'verticalId'],
      optional: ['identityResolutionId', 'displayName'],
      idempotencyKey: 'businessId'
    },
    'business.merge_requested': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['mergeId', 'survivingBusinessId', 'candidateBusinessIds', 'proposedBy'],
      optional: ['matchScore', 'rationale'],
      idempotencyKey: 'mergeId',
      note: 'A proposal awaiting owner approval. No merge happens on this event.'
    },
    'business.merged': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['mergeId', 'survivingBusinessId', 'mergedBusinessIds', 'approvedBy', 'approvedAt', 'unmergeSafe'],
      idempotencyKey: 'mergeId',
      note: 'Written to the surviving record AND to each merged-away record, so both remain walkable.'
    },
    'business.unmerged': {
      version: 1, category: 'identity', visibilityDefault: 'internal',
      required: ['unmergeId', 'mergeId', 'restoredBusinessIds', 'approvedBy'],
      optional: ['postMergeEventDisposition'],
      idempotencyKey: 'unmergeId'
    },

    /* ---- assessment ---- */

    'assessment.started': {
      version: 1, category: 'assessment', visibilityDefault: 'internal',
      required: ['assessmentSessionId', 'verticalId'],
      idempotencyKey: 'assessmentSessionId'
    },
    'assessment.completed': {
      version: 1, category: 'assessment', visibilityDefault: 'customer_visible',
      required: ['assessmentSessionId', 'submissionId', 'verticalId', 'assessmentVersion'],
      idempotencyKey: 'submissionId'
    },
    'bir.generated': {
      version: 1, category: 'intelligence', visibilityDefault: 'internal',
      required: ['birId', 'confidenceBand'],
      optional: ['supersedesBirId', 'closeReadinessBand', 'opportunityRange'],
      idempotencyKey: 'birId'
    },
    'lead.qualified': {
      version: 1, category: 'intelligence', visibilityDefault: 'internal',
      required: ['birId', 'outcome'],
      idempotencyKey: 'birId'
    },
    'lead.close_ready': {
      version: 1, category: 'intelligence', visibilityDefault: 'internal',
      required: ['birId', 'band', 'score'],
      optional: ['hardBlockers', 'softBlockers'],
      idempotencyKey: 'birId + band'
    },
    'offer.presented': {
      version: 1, category: 'commercial', visibilityDefault: 'customer_visible',
      required: ['offerId', 'packageId', 'priceMonthly', 'channel'],
      idempotencyKey: 'offerId + channel'
    },
    'proposal.generated': {
      version: 1, category: 'commercial', visibilityDefault: 'customer_visible',
      required: ['proposalId', 'packageId', 'generatedFromBirId'],
      idempotencyKey: 'proposalId'
    },
    'agreement.accepted': {
      version: 1, category: 'commercial', visibilityDefault: 'customer_visible',
      required: ['agreementId', 'agreementVersion', 'acceptanceMethod'],
      idempotencyKey: 'agreementId'
    },
    'purchase.completed': {
      version: 1, category: 'commercial', visibilityDefault: 'customer_visible',
      required: ['processorReference', 'packageId', 'amount', 'currency', 'interval'],
      idempotencyKey: 'processorReference',
      note: 'No payment instrument data. The processor reference is the only financial identifier stored.'
    },
    'onboarding.started': {
      version: 1, category: 'delivery', visibilityDefault: 'customer_visible',
      required: ['onboardingId', 'packageId'],
      idempotencyKey: 'onboardingId'
    },
    'onboarding.blocked': {
      version: 1, category: 'delivery', visibilityDefault: 'internal',
      required: ['onboardingId', 'blockerType'],
      optional: ['detail', 'exceptionId'],
      idempotencyKey: 'onboardingId + blockerType'
    },
    'integration.connected': {
      version: 1, category: 'delivery', visibilityDefault: 'internal',
      required: ['integrationId', 'system'],
      optional: ['compatibility'],
      idempotencyKey: 'integrationId'
    },
    'campaign.launched': {
      version: 1, category: 'delivery', visibilityDefault: 'customer_visible',
      required: ['campaignId', 'campaignType'],
      idempotencyKey: 'campaignId'
    },
    'reassessment.due': {
      version: 1, category: 'lifecycle', visibilityDefault: 'internal',
      required: ['reassessmentKind', 'dueAt', 'basisBirId'],
      idempotencyKey: 'reassessmentKind + dueAt (date precision)'
    },
    'reassessment.completed': {
      version: 1, category: 'lifecycle', visibilityDefault: 'internal',
      required: ['reassessmentKind', 'newBirId'],
      optional: ['previousBirId', 'changedSections'],
      idempotencyKey: 'newBirId'
    },
    'upgrade.recommended': {
      version: 1, category: 'opportunity', visibilityDefault: 'internal',
      required: ['currentPackageId', 'proposedPackageId', 'birId', 'fitScore'],
      idempotencyKey: 'birId + proposedPackageId'
    },
    'offer.matched': {
      version: 1, category: 'opportunity', visibilityDefault: 'internal',
      required: ['offerId', 'matchedBirId', 'matchScore'],
      optional: ['requiresRecheck', 'matchReasons'],
      idempotencyKey: 'offerId + matchedBirId'
    },
    'health.changed': {
      version: 1, category: 'success', visibilityDefault: 'internal',
      required: ['dimension', 'previousBand', 'newBand', 'healthProfileId'],
      idempotencyKey: 'healthProfileId + dimension'
    },
    'support.case_opened': {
      version: 1, category: 'success', visibilityDefault: 'customer_visible',
      required: ['caseId', 'category'],
      optional: ['severity'],
      idempotencyKey: 'caseId'
    },
    'business.expanded': {
      version: 1, category: 'business_change', visibilityDefault: 'internal',
      required: ['expansionKind'],
      optional: ['detail'],
      idempotencyKey: 'expansionKind + occurredAt (date precision)',
      note: 'A meaningful business change. Triggers change_triggered reassessment.'
    },
    'staff.added': {
      version: 1, category: 'business_change', visibilityDefault: 'internal',
      required: ['newStaffCount'],
      optional: ['previousStaffCount', 'personId'],
      idempotencyKey: 'businessId + newStaffCount + occurredAt (date precision)',
      note: 'Changes capacity. Invalidates capacity-derived profiles.'
    },
    'location.opened': {
      version: 1, category: 'business_change', visibilityDefault: 'internal',
      required: ['locationId'],
      optional: ['address'],
      idempotencyKey: 'locationId',
      note: 'Moving to more than one location is a close-readiness hard blocker.'
    },
    'churn.risk_detected': {
      version: 1, category: 'success', visibilityDefault: 'internal',
      required: ['riskLevel', 'signals'],
      optional: ['healthProfileId'],
      idempotencyKey: 'businessId + riskLevel + occurredAt (date precision)'
    },
    'customer.churned': {
      version: 1, category: 'lifecycle', visibilityDefault: 'internal',
      required: ['subscriptionId', 'reason', 'voluntary'],
      idempotencyKey: 'subscriptionId'
    },
    'customer.reactivated': {
      version: 1, category: 'lifecycle', visibilityDefault: 'customer_visible',
      required: ['subscriptionId', 'previousChurnedAt'],
      idempotencyKey: 'subscriptionId'
    }
  };

  /* Timeline event -> inter-engine bus event, or null where the timeline
     records something the bus does not carry. Nothing here modifies the
     catalog; this is a reconciliation table. */
  const TIMELINE_TO_CATALOG = {
    'identity.resolved': 'identity.resolved',
    'identity.review_required': 'identity.review_required',
    'identity.linked': 'identity.linked',
    'business.created': 'business.created',
    'business.merge_requested': 'business.merge_requested',
    'business.merged': 'business.merged',
    'business.unmerged': 'business.unmerged',
    'assessment.started': 'assessment.started',
    'assessment.completed': 'assessment.completed',
    'bir.generated': 'bir.generated',
    'lead.qualified': 'lead.qualified',
    'lead.close_ready': 'lead.close_ready',
    'offer.presented': 'offer.presented',
    'proposal.generated': null,
    'agreement.accepted': 'agreement.accepted',
    'purchase.completed': 'purchase.completed',
    'onboarding.started': 'onboarding.started',
    'onboarding.blocked': 'onboarding.blocked',
    'integration.connected': null,
    'campaign.launched': null,
    'reassessment.due': 'assessment.reassessment_due',
    'reassessment.completed': null,
    'upgrade.recommended': 'customer.upgrade_ready',
    'offer.matched': 'offer.match_found',
    'health.changed': null,
    'support.case_opened': null,
    'business.expanded': null,
    'staff.added': null,
    'location.opened': null,
    'churn.risk_detected': null,
    'customer.churned': null,
    'customer.reactivated': null
  };

  /* Events that invalidate derived intelligence and force reassessment. */
  const MEANINGFUL_BUSINESS_CHANGES = [
    'business.expanded', 'staff.added', 'location.opened', 'integration.connected'
  ];

  /* ---------------------------------------------------------
     Validation
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso8601 = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

  const validateTimelineEvent = event => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!event || typeof event !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Event must be an object.' }] };
    }

    if (!isUuid(event.eventId)) push('invalid_event_id', 'eventId must be a UUID.');

    /* Identity: required unless this event legitimately precedes resolution. */
    const preIdentity = PRE_IDENTITY_EVENTS.includes(event.eventName);
    const hasBusinessId = event.businessId !== null && event.businessId !== undefined;
    if (hasBusinessId) {
      if (!isUuid(event.businessId)) push('invalid_business_id', 'businessId must be a UUID.');
    } else if (!preIdentity) {
      push('missing_business_id', `${event.eventName} requires a businessId; only ${PRE_IDENTITY_EVENTS.join(', ')} may defer it.`);
    } else if (!event.identityResolutionId && !(event.payload || {}).assessmentSessionId) {
      push('no_identity_thread', 'A pre-identity event must carry identityResolutionId or payload.assessmentSessionId.');
    }
    if (event.businessKey !== undefined) {
      push('deprecated_business_key', 'businessKey is deprecated. Use businessId, or legacyBusinessKey for provenance only.');
    }
    if (event.legacyBusinessKey && event.legacyBusinessKey === event.businessId) {
      push('legacy_key_reinterpreted', 'legacyBusinessKey must never be reused as businessId.');
    }

    const def = TIMELINE_EVENTS[event.eventName];
    if (!def) push('unknown_event_name', `Unknown eventName: ${event.eventName}`);
    else if (event.eventVersion !== def.version) {
      push('event_version_mismatch', `${event.eventName} expects version ${def.version}, got ${event.eventVersion}.`);
    }

    if (event.schemaVersion !== TIMELINE_EVENT_SCHEMA_VERSION) push('schema_version_mismatch', 'Unexpected envelope schemaVersion.');
    if (!isIso8601(event.occurredAt)) push('invalid_occurred_at', 'occurredAt must be ISO 8601.');
    if (!isIso8601(event.recordedAt)) push('invalid_recorded_at', 'recordedAt must be ISO 8601.');
    if (isIso8601(event.occurredAt) && isIso8601(event.recordedAt) &&
        Date.parse(event.recordedAt) < Date.parse(event.occurredAt)) {
      push('recorded_before_occurred', 'recordedAt cannot precede occurredAt.');
    }

    if (!event.producer) push('missing_producer', 'producer is required.');
    if (!event.sourceSystem) push('missing_source_system', 'sourceSystem is required.');
    if (!event.idempotencyKey) push('missing_idempotency_key', 'idempotencyKey is required — replays must be safe.');
    if (!event.summary) push('missing_summary', 'summary is required.');
    if (!event.actor || !ACTOR_KINDS.includes((event.actor || {}).kind)) {
      push('invalid_actor', `actor.kind must be one of: ${ACTOR_KINDS.join(', ')}`);
    }
    if (event.visibility && !VISIBILITY.includes(event.visibility)) {
      push('invalid_visibility', `Unknown visibility: ${event.visibility}`);
    }

    if (def && Array.isArray(def.required)) {
      const payload = event.payload || {};
      def.required.forEach(key => {
        if (payload[key] === undefined || payload[key] === null) {
          push('missing_payload_field', `${event.eventName} requires payload.${key}`);
        }
      });
    }

    /* Correction discipline. */
    if (event.supersedesEventId && event.correctionOfEventId) {
      push('ambiguous_correction', 'An event may supersede or correct, not both.');
    }
    if (event.correctionOfEventId) {
      if (!isUuid(event.correctionOfEventId)) push('invalid_correction_target', 'correctionOfEventId must be a UUID.');
      if (!event.correctionReason) push('missing_correction_reason', 'correctionOfEventId requires correctionReason.');
      if (event.correctionOfEventId === event.eventId) push('self_correction', 'An event cannot correct itself.');
    }
    if (event.supersedesEventId) {
      if (!isUuid(event.supersedesEventId)) push('invalid_supersedes_target', 'supersedesEventId must be a UUID.');
      if (event.supersedesEventId === event.eventId) push('self_supersede', 'An event cannot supersede itself.');
    }
    if (event.causationId && event.causationId === event.eventId) {
      push('self_causation', 'An event cannot cause itself.');
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    TIMELINE_EVENT_SCHEMA_VERSION,
    TIMELINE_EVENT_SCHEMA,
    TIMELINE_EVENTS,
    TIMELINE_TO_CATALOG,
    PRE_IDENTITY_EVENTS,
    MEANINGFUL_BUSINESS_CHANGES,
    VISIBILITY,
    ACTOR_KINDS,
    validateTimelineEvent,
    isUuid,
    isIso8601
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDTimelineEventSchema = API;
})();
