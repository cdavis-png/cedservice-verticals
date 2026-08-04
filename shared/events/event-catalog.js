/* ============================================================
   CED Intelligence Platform — Event Catalog, v2
   ------------------------------------------------------------
   The contract between engines. Engines communicate by emitting
   and consuming these events; they do not call each other
   directly. Adding a field is a minor change. Removing or
   retyping one requires a new event version, with both versions
   published until every consumer has migrated.

   v2 CHANGES (identity reconciliation — see docs/decisions/ADR-001):
     - correlation.businessKey REMOVED. correlation.businessId
       (UUID) is canonical.
     - Identity moved OUT of event payloads and INTO the envelope.
       Events that previously required businessKey in their payload
       are now version 2 and carry identity in correlation only.
     - businessId may be null ONLY before identity resolution
       completes; assessmentSessionId and identityResolutionId
       carry the thread until then.
     - legacyBusinessKey is provenance only and must never be
       reinterpreted as a businessId.
     - Every event declares a `channel`: bus, timeline, or both.
     - Added the identity.* and business.* event families.

   This file is a SPECIFICATION. No bus, no transport, no
   emitter — those belong to implementation, which does not
   exist yet.

   Every event carries the same envelope:

     {
       eventId:     uuid,            // unique per emission
       name:        string,          // catalog key
       version:     integer,         // catalog version of THIS event
       catalogVersion: integer,      // envelope contract version
       occurredAt:  iso8601,
       recordedAt:  iso8601,
       producer:    string,          // engine id
       idempotencyKey: string,       // see each event's guidance
       correlation: {
         businessId,                 // canonical; null only pre-resolution
         identityResolutionId,       // set while identity is being resolved
         legacyBusinessKey,          // provenance only, never an identifier
         assessmentSessionId,
         submissionId,
         birId,
         customerId,
         correlationId,
         causationId
       },
       payload:     object           // per definition below
     }

   Idempotency rules:
     - A consumer that has already processed an envelope with a
       given (name, idempotencyKey) must treat a repeat as a
       no-op and return its earlier outcome.
     - An idempotency key must NEVER be derived from a mutable
       contact field — no email, phone, business name, or domain.
       Those change; the key must not.
     - Keys are built from immutable ids (submissionId, birId,
       processorReference, businessId) plus a discriminator.
   ============================================================ */

(() => {
  'use strict';

  const CATALOG_VERSION = 2;

  const CATALOG_VERSION_HISTORY = [
    { version: 1, status: 'legacy', note: 'correlation.businessKey; identity in payloads.' },
    { version: 2, status: 'current', note: 'correlation.businessId canonical; identity in envelope; identity.* family added.' }
  ];

  const ENGINES = {
    ASSESSMENT: 'assessment-engine',
    RECORD: 'business-record-engine',        /* NEW in v2: owns identity resolution and record custody */
    BI: 'business-intelligence-engine',
    DECISION: 'decision-engine',
    QUALIFICATION: 'qualification-engine',
    CLOSING: 'closing-engine',
    LIFECYCLE: 'lifecycle-engine',
    OPPORTUNITY: 'opportunity-engine',
    SUCCESS: 'customer-success-engine',
    AUTOMATION: 'automation-engine',
    KNOWLEDGE: 'knowledge-engine',
    ANALYTICS: 'analytics-engine',
    LEARNING: 'learning-engine',
    EXCEPTION: 'exception-manager'
  };

  const ENVELOPE_FIELDS = [
    'eventId', 'name', 'version', 'catalogVersion', 'occurredAt', 'recordedAt',
    'producer', 'idempotencyKey', 'correlation', 'payload'
  ];

  const CORRELATION_FIELDS = [
    'businessId', 'identityResolutionId', 'legacyBusinessKey',
    'assessmentSessionId', 'submissionId', 'birId', 'customerId',
    'correlationId', 'causationId'
  ];

  /* Where an event lives.
       bus      — transient inter-engine message, not kept as history
       timeline — durable business history only
       both     — emitted on the bus AND written to the Business Record timeline */
  const CHANNELS = ['bus', 'timeline', 'both'];

  /* Events that may legitimately carry a null businessId, because they occur
     before or during identity resolution. Every other event requires one. */
  const PRE_IDENTITY_EVENTS = [
    'assessment.started',
    'assessment.partial_saved',
    'assessment.completed',
    'identity.resolution_started',
    'identity.review_required'
  ];

  const EVENTS = {

    /* ---------------- assessment ---------------- */

    'assessment.started': {
      version: 1, channel: 'both', producer: ENGINES.ASSESSMENT,
      description: 'A visitor opened the review and a session identity exists.',
      required: ['assessmentSessionId', 'verticalId', 'assessmentVersion', 'firstTouch'],
      optional: ['latestTouch'],
      consumers: [ENGINES.ANALYTICS, ENGINES.LIFECYCLE],
      idempotencyKey: 'assessmentSessionId — exactly one start per session, even if the modal is reopened.',
      notes: 'businessId is null here. Identity is not yet known.'
    },

    'assessment.partial_saved': {
      version: 1, channel: 'bus', producer: ENGINES.ASSESSMENT,
      description: 'Progress persisted mid-review. Signals engagement, not intent.',
      required: ['assessmentSessionId', 'stepReached', 'stepCount'],
      optional: ['answeredFieldCount'],
      consumers: [ENGINES.ANALYTICS, ENGINES.LIFECYCLE],
      idempotencyKey: 'assessmentSessionId + stepReached — repeated saves on one step collapse to one.',
      notes: 'High volume, not durable history. Consumers should aggregate rather than react per event.'
    },

    'assessment.completed': {
      version: 2, channel: 'both', producer: ENGINES.ASSESSMENT,
      description: 'A finished review with a full submission payload. The entry point to the platform.',
      required: [
        'assessmentSessionId', 'submissionId', 'verticalId', 'assessmentVersion',
        'payloadSchemaVersion', 'contact', 'consent', 'answers', 'results', 'attribution'
      ],
      consumers: [ENGINES.RECORD, ENGINES.BI, ENGINES.ANALYTICS, ENGINES.LIFECYCLE],
      idempotencyKey: 'submissionId — the same key the client sends as Idempotency-Key.',
      notes: 'businessId is null. This event triggers identity resolution. Answers arrive raw here; this is the ONLY event downstream engines may read raw answers from.'
    },

    'assessment.reassessment_due': {
      version: 2, channel: 'both', producer: ENGINES.LIFECYCLE,
      description: 'A reassessment window opened under LIFECYCLE_POLICY.',
      required: ['reassessmentKind', 'dueAt', 'basisBirId'],
      optional: ['lastMeaningfulInteractionAt', 'suppressedUntil'],
      consumers: [ENGINES.DECISION, ENGINES.AUTOMATION, ENGINES.ANALYTICS],
      idempotencyKey: 'businessId + reassessmentKind + dueAt (date precision) — one notice per window.'
    },

    /* ---------------- identity ---------------- */

    'identity.resolution_started': {
      version: 1, channel: 'bus', producer: ENGINES.RECORD,
      description: 'Identity resolution began for an inbound signal set.',
      required: ['identityResolutionId', 'assessmentSessionId', 'signalKinds'],
      optional: ['submissionId', 'verticalId'],
      consumers: [ENGINES.ANALYTICS],
      idempotencyKey: 'identityResolutionId.',
      notes: 'businessId is null by definition. signalKinds lists signal NAMES, never signal values — no contact data on the bus.'
    },

    'identity.resolved': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'Identity resolution produced a decision.',
      required: ['identityResolutionId', 'resolutionStatus', 'resolutionConfidence', 'recommendedAction'],
      optional: ['candidateCount', 'contributingSignals', 'conflictingSignals'],
      consumers: [ENGINES.BI, ENGINES.ANALYTICS, ENGINES.DECISION],
      idempotencyKey: 'identityResolutionId.',
      notes: 'businessId is set when resolutionStatus is unique_match; otherwise still null.'
    },

    'identity.review_required': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'Identity could not be resolved safely and needs a person.',
      required: ['identityResolutionId', 'resolutionStatus', 'reason'],
      optional: ['candidateBusinessIds', 'conflictingSignals'],
      consumers: [ENGINES.EXCEPTION, ENGINES.ANALYTICS],
      idempotencyKey: 'identityResolutionId.',
      notes: 'Always produces an exception. businessId stays null until a human decides.'
    },

    'identity.linked': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'A previously unresolved artifact was attached to a Business Record.',
      required: ['identityResolutionId', 'linkedBusinessId', 'linkedArtifactKind', 'linkedArtifactId', 'linkMethod'],
      optional: ['previousIdentityStatus', 'legacyBusinessKey'],
      consumers: [ENGINES.BI, ENGINES.LIFECYCLE, ENGINES.ANALYTICS],
      idempotencyKey: 'linkedArtifactKind + linkedArtifactId — one link per artifact.',
      notes: 'This event is how linking is recorded. The ORIGINAL event is never rewritten to insert a businessId. linkMethod is auto | manual | migration.'
    },

    /* ---------------- business record ---------------- */

    'business.created': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'A new permanent Business Record exists.',
      required: ['createdFrom', 'verticalId'],
      optional: ['identityResolutionId', 'displayName'],
      consumers: [ENGINES.BI, ENGINES.LIFECYCLE, ENGINES.ANALYTICS],
      idempotencyKey: 'businessId — a record is created exactly once.',
      notes: 'createdFrom is assessment | manual | import | merge.'
    },

    'business.merge_requested': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'A merge has been proposed and awaits owner approval.',
      required: ['mergeId', 'survivingBusinessId', 'candidateBusinessIds', 'proposedBy'],
      optional: ['identityResolutionId', 'matchScore', 'rationale'],
      consumers: [ENGINES.EXCEPTION, ENGINES.ANALYTICS],
      idempotencyKey: 'mergeId.',
      notes: 'A proposal only. No merge occurs on this event. Automatic merging does not exist in this platform.'
    },

    'business.merged': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'An owner-approved merge was applied.',
      required: ['mergeId', 'survivingBusinessId', 'mergedBusinessIds', 'approvedBy', 'approvedAt', 'unmergeSafe'],
      optional: ['preservedAliasCount', 'fieldResolutionCount'],
      consumers: [ENGINES.BI, ENGINES.LIFECYCLE, ENGINES.OPPORTUNITY, ENGINES.ANALYTICS],
      idempotencyKey: 'mergeId.',
      notes: 'correlation.businessId is the SURVIVING id. Merged-away records keep their own timeline entries pointing here.'
    },

    'business.unmerged': {
      version: 1, channel: 'both', producer: ENGINES.RECORD,
      description: 'A previous merge was reversed. Emitted only when the merge was still technically safe to reverse.',
      required: ['unmergeId', 'mergeId', 'restoredBusinessIds', 'approvedBy', 'postMergeEventDisposition'],
      consumers: [ENGINES.BI, ENGINES.LIFECYCLE, ENGINES.ANALYTICS, ENGINES.EXCEPTION],
      idempotencyKey: 'unmergeId.',
      notes: 'Permitted only while the merge record has unmergeSafe true and every post-merge event has an explicit reassignment.'
    },

    /* ---------------- intelligence ---------------- */

    'bir.generated': {
      version: 2, channel: 'both', producer: ENGINES.BI,
      description: 'A new Business Intelligence Report revision is current. The fan-out point of the platform.',
      required: ['birId', 'schemaVersion', 'isCurrent', 'estimateConfidence', 'lifecycleStageSnapshot'],
      optional: ['supersedes', 'changedSections', 'identityStatus'],
      consumers: [
        ENGINES.QUALIFICATION, ENGINES.CLOSING, ENGINES.LIFECYCLE, ENGINES.OPPORTUNITY,
        ENGINES.SUCCESS, ENGINES.DECISION, ENGINES.RECORD, ENGINES.ANALYTICS
      ],
      idempotencyKey: 'birId — immutable per revision.',
      notes: 'lifecycleStageSnapshot is what the BIR OBSERVED, not current truth — the Business Record owns current lifecycle state. Carries identifiers and summary only; consumers fetch the full BIR.'
    },

    'lead.qualified': {
      version: 2, channel: 'both', producer: ENGINES.QUALIFICATION,
      description: 'Qualification outcome decided for the current BIR.',
      required: ['birId', 'outcome', 'score'],
      optional: ['segment', 'disqualifiers', 'missingCriticalFields'],
      consumers: [ENGINES.DECISION, ENGINES.CLOSING, ENGINES.ANALYTICS],
      idempotencyKey: 'birId — one qualification per BIR revision.',
      notes: 'outcome may be disqualified or insufficient_data; the name reflects the decision point, not a positive result.'
    },

    'lead.close_ready': {
      version: 2, channel: 'both', producer: ENGINES.CLOSING,
      description: 'Close readiness computed. Band determines what may happen next.',
      required: ['birId', 'band', 'score'],
      optional: ['bandBeforeBlockers', 'hardBlockers', 'softBlockers', 'packageId'],
      consumers: [ENGINES.DECISION, ENGINES.AUTOMATION, ENGINES.EXCEPTION, ENGINES.ANALYTICS],
      idempotencyKey: 'birId + band — a recomputation that lands on the same band is not news.',
      notes: 'band = escalate must always reach the Exception Manager.'
    },

    /* ---------------- offer and purchase ---------------- */

    'offer.presented': {
      version: 2, channel: 'both', producer: ENGINES.CLOSING,
      description: 'An approved offer was shown to the business.',
      required: ['birId', 'packageId', 'priceMonthly', 'presentedAt', 'channel'],
      optional: ['approvedLanguageKey', 'offerExpiresAt', 'offerId'],
      consumers: [ENGINES.DECISION, ENGINES.ANALYTICS, ENGINES.LIFECYCLE],
      idempotencyKey: 'birId + packageId + channel — re-sends of one offer collapse.',
      notes: 'Price and wording must come from vertical config and the Knowledge Engine. Never model-generated.'
    },

    'checkout.started': {
      version: 2, channel: 'bus', producer: ENGINES.CLOSING,
      description: 'The business entered checkout for a presented offer.',
      required: ['birId', 'packageId', 'checkoutId'],
      optional: ['offerEventId'],
      consumers: [ENGINES.ANALYTICS, ENGINES.DECISION, ENGINES.EXCEPTION],
      idempotencyKey: 'checkoutId.',
      notes: 'No payment instrument data may appear in the payload — only a processor reference.'
    },

    'purchase.completed': {
      version: 2, channel: 'both', producer: ENGINES.AUTOMATION,
      description: 'Payment captured and subscription created.',
      required: ['packageId', 'subscriptionId', 'processorReference', 'amount', 'currency', 'interval'],
      optional: ['birId', 'checkoutId'],
      consumers: [ENGINES.SUCCESS, ENGINES.LIFECYCLE, ENGINES.RECORD, ENGINES.ANALYTICS, ENGINES.DECISION],
      idempotencyKey: 'processorReference — the processor is the source of truth for whether money moved.',
      notes: 'processorReference is an opaque handle. Card data never enters CIP.'
    },

    'agreement.accepted': {
      version: 2, channel: 'both', producer: ENGINES.AUTOMATION,
      description: 'The business accepted the service agreement.',
      required: ['agreementId', 'agreementVersion', 'acceptedAt', 'acceptanceMethod'],
      optional: ['packageId', 'subscriptionId', 'ipAddress'],
      consumers: [ENGINES.SUCCESS, ENGINES.RECORD, ENGINES.ANALYTICS, ENGINES.EXCEPTION],
      idempotencyKey: 'agreementId.',
      notes: 'agreementVersion must reference approved contract text. AI may never author or alter it.'
    },

    /* ---------------- onboarding and customer ---------------- */

    'onboarding.started': {
      version: 2, channel: 'both', producer: ENGINES.SUCCESS,
      description: 'Onboarding began for a new customer.',
      required: ['customerId', 'packageId', 'startedAt'],
      optional: ['birId', 'checklistId', 'onboardingId'],
      consumers: [ENGINES.AUTOMATION, ENGINES.ANALYTICS, ENGINES.LIFECYCLE],
      idempotencyKey: 'customerId + packageId — one onboarding per subscription start.'
    },

    'onboarding.blocked': {
      version: 2, channel: 'both', producer: ENGINES.SUCCESS,
      description: 'Onboarding cannot proceed without intervention.',
      required: ['customerId', 'blockerType', 'detectedAt'],
      optional: ['detail', 'attemptedRemediation', 'onboardingId'],
      consumers: [ENGINES.EXCEPTION, ENGINES.AUTOMATION, ENGINES.ANALYTICS],
      idempotencyKey: 'customerId + blockerType — one open block per type at a time.',
      notes: 'Must always produce an exception. A blocked onboarding is never allowed to sit silently.'
    },

    'customer.quarterly_review_due': {
      version: 2, channel: 'bus', producer: ENGINES.LIFECYCLE,
      description: 'A customer reached a quarterly review window.',
      required: ['customerId', 'dueAt', 'lastReviewBirId'],
      optional: ['suppressedUntil'],
      consumers: [ENGINES.SUCCESS, ENGINES.DECISION, ENGINES.AUTOMATION],
      idempotencyKey: 'businessId + dueAt (date precision).'
    },

    'customer.upgrade_ready': {
      version: 2, channel: 'both', producer: ENGINES.OPPORTUNITY,
      description: 'A customer now fits a higher package on current evidence.',
      required: ['customerId', 'currentPackageId', 'proposedPackageId', 'birId', 'fitScore'],
      optional: ['triggerSignals', 'capacityHeadroomBand'],
      consumers: [ENGINES.DECISION, ENGINES.CLOSING, ENGINES.ANALYTICS],
      idempotencyKey: 'businessId + proposedPackageId + birId.',
      notes: 'Must respect capacity: proposing growth a customer cannot serve is an overselling failure.'
    },

    'offer.match_found': {
      version: 2, channel: 'both', producer: ENGINES.OPPORTUNITY,
      description: 'A new or changed offer matches a historical BIR.',
      required: ['offerId', 'matchedBirId', 'matchScore', 'matchReasons'],
      optional: ['birAgeDays', 'requiresRecheck'],
      consumers: [ENGINES.DECISION, ENGINES.LIFECYCLE, ENGINES.ANALYTICS],
      idempotencyKey: 'offerId + matchedBirId.',
      notes: 'requiresRecheck must be true when the matched BIR is older than LIFECYCLE_POLICY.quickRecheckRequiredAfterDays.'
    },

    /* ---------------- failure and exception ---------------- */

    'integration.failed': {
      version: 2, channel: 'bus', producer: ENGINES.AUTOMATION,
      description: 'An outbound call to an external system failed after its retry budget.',
      required: ['integrationId', 'operation', 'attempts', 'lastError', 'failedAt'],
      optional: ['customerId', 'httpStatus', 'permanent', 'nextRetryAt'],
      consumers: [ENGINES.EXCEPTION, ENGINES.ANALYTICS],
      idempotencyKey: 'integrationId + operation + correlationId — repeated failures of one operation collapse into one open issue.',
      notes: 'Emitted after retries are exhausted, not on the first failure. Transient errors must not page anyone.'
    },

    'exception.created': {
      version: 2, channel: 'bus', producer: ENGINES.EXCEPTION,
      description: 'Work that automation may not complete has been routed to a human.',
      required: ['exceptionId', 'category', 'severity', 'summary', 'createdAt', 'requiredAction'],
      optional: ['customerId', 'birId', 'sourceEventId', 'suggestedResolution', 'dueBy', 'identityResolutionId'],
      consumers: [ENGINES.ANALYTICS, ENGINES.DECISION],
      idempotencyKey: 'category + businessId (or integrationId when no business is known) — one open exception per category per subject.',
      notes: 'severity drives notification bundling. Only critical severity may interrupt an owner immediately.'
    }
  };

  /* ---------------------------------------------------------
     Deterministic checks over the catalog itself
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

  /* Contact-shaped fragments that must never appear in an idempotency key. */
  const MUTABLE_KEY_FRAGMENTS = /(email|phone|mobile|business_?name|displayname|domain|website|address)/i;

  const requiresBusinessId = name => !PRE_IDENTITY_EVENTS.includes(name);

  const validateEnvelope = envelope => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!envelope || typeof envelope !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Envelope must be an object.' }] };
    }

    const def = EVENTS[envelope.name];
    if (!def) push('unknown_event', `Unknown event name: ${envelope.name}`);
    else if (envelope.version !== def.version) {
      push('event_version_mismatch', `${envelope.name} expects version ${def.version}, got ${envelope.version}.`);
    }

    if (envelope.catalogVersion !== CATALOG_VERSION) {
      push('catalog_version_mismatch', `Expected catalogVersion ${CATALOG_VERSION}, got ${envelope.catalogVersion}.`);
    }
    if (!isUuid(envelope.eventId)) push('invalid_event_id', 'eventId must be a UUID.');
    if (!envelope.idempotencyKey) push('missing_idempotency_key', 'idempotencyKey is required.');

    const corr = envelope.correlation || {};
    if (corr.businessKey !== undefined) {
      push('deprecated_business_key', 'correlation.businessKey was removed in catalog v2. Use businessId, or legacyBusinessKey for provenance.');
    }

    const needsId = requiresBusinessId(envelope.name);
    if (corr.businessId === null || corr.businessId === undefined) {
      if (needsId) push('missing_business_id', `${envelope.name} requires correlation.businessId once identity is resolved.`);
      else if (!corr.assessmentSessionId && !corr.identityResolutionId) {
        push('no_identity_thread', 'A pre-identity event must carry assessmentSessionId or identityResolutionId.');
      }
    } else if (!isUuid(corr.businessId)) {
      push('invalid_business_id', 'correlation.businessId must be a UUID.');
    }

    if (corr.legacyBusinessKey && corr.legacyBusinessKey === corr.businessId) {
      push('legacy_key_reinterpreted', 'legacyBusinessKey must never be reused as businessId.');
    }

    if (def && Array.isArray(def.required)) {
      const payload = envelope.payload || {};
      def.required.forEach(key => {
        if (payload[key] === undefined || payload[key] === null) {
          push('missing_payload_field', `${envelope.name} requires payload.${key}`);
        }
      });
      if (def.required.includes('businessId') || def.required.includes('businessKey')) {
        push('identity_in_payload', 'Identity belongs in the envelope correlation, not the payload.');
      }
    }

    return { valid: errors.length === 0, errors };
  };

  /* Catalog self-consistency. Runs over the definitions, not over an instance. */
  const validateCatalog = () => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });
    const engineIds = Object.values(ENGINES);

    Object.entries(EVENTS).forEach(([name, def]) => {
      if (!CHANNELS.includes(def.channel)) push('invalid_channel', `${name}: unknown channel ${def.channel}`);
      if (!engineIds.includes(def.producer)) push('unknown_producer', `${name}: unknown producer ${def.producer}`);
      (def.consumers || []).forEach(c => {
        if (!engineIds.includes(c)) push('unknown_consumer', `${name}: unknown consumer ${c}`);
      });
      if (!def.idempotencyKey) push('missing_idempotency_guidance', `${name}: idempotencyKey guidance is required.`);
      else if (MUTABLE_KEY_FRAGMENTS.test(def.idempotencyKey)) {
        push('mutable_idempotency_key', `${name}: idempotency key must not depend on mutable contact fields.`);
      }
      (def.required || []).forEach(field => {
        if (field === 'businessKey' || field === 'businessId') {
          push('identity_in_payload', `${name}: identity must live in the envelope, not payload.${field}`);
        }
      });
    });

    return { valid: errors.length === 0, errors };
  };

  const API = {
    CATALOG_VERSION,
    CATALOG_VERSION_HISTORY,
    ENGINES,
    ENVELOPE_FIELDS,
    CORRELATION_FIELDS,
    CHANNELS,
    PRE_IDENTITY_EVENTS,
    EVENTS,
    requiresBusinessId,
    validateEnvelope,
    validateCatalog,
    isUuid
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDEventCatalog = API;
})();
