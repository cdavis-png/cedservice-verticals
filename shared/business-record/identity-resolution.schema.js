/* ============================================================
   CED Intelligence Platform — Identity Resolution
   Schema and deterministic model, v1
   ------------------------------------------------------------
   Decides whether an inbound signal belongs to an existing
   Business Record, a new one, or a human's queue.

   The governing asymmetry: attaching an event to the wrong
   record is recoverable; merging two records is not. Linking is
   therefore allowed to be automatic at high confidence. Merging
   never is.

   SPECIFICATION ONLY. Pure scoring and validation helpers, no
   store, no lookups, no side effects.
   ============================================================ */

(() => {
  'use strict';

  const IDENTITY_RESOLUTION_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  const RESOLUTION_STATUSES = [
    'unique_match',            /* one record, high confidence, safe to link */
    'probable_match',          /* one leading candidate, not enough to act destructively */
    'possible_duplicate',      /* two or more plausible records; a human decides */
    'no_match',                /* create a new record */
    'manual_review_required'   /* conflicting or untrustworthy signals */
  ];

  const RECOMMENDED_ACTIONS = [
    'link_to_existing',        /* attach the event to the matched record */
    'create_new_record',
    'queue_for_review',
    'request_more_signal',     /* ask a disambiguating question before deciding */
    'propose_merge'            /* always owner-approved; never executed automatically */
  ];

  /* ---------------------------------------------------------
     Identity link status — AUTHORITY
     How any artifact (BIR, assessment, submission, timeline
     event) is attached to a permanent Business Record.
     report.schema.js VOCAB.identityStatus mirrors this list; the
     cross-file consistency check asserts they stay identical.
     --------------------------------------------------------- */

  const IDENTITY_LINK_STATUSES = [
    'legacy_unresolved',   /* predates businessId; carries only a legacyBusinessKey */
    'resolution_pending',  /* resolution running or queued */
    'linked',              /* attached automatically at high confidence */
    'manually_verified',   /* attached by a person */
    'merge_required',      /* duplicate suspected; blocked pending owner approval */
    'rejected_match'       /* a proposed link was reviewed and refused */
  ];

  /* Statuses in which businessId is legitimately absent. Anything else with a
     null businessId is a defect, not a state. */
  const STATUSES_WITHOUT_BUSINESS_ID = ['legacy_unresolved', 'resolution_pending'];

  /* Terminal for automation: no further automatic attempts. */
  const STATUSES_REQUIRING_HUMAN = ['merge_required', 'rejected_match'];

  /* ---------------------------------------------------------
     Legacy migration
     Artifacts created before businessId existed.
     --------------------------------------------------------- */

  const LEGACY_MIGRATION = {
    principle:
      'A legacy businessKey is evidence, never an identifier. It is carried forward as ' +
      'provenance and fed into resolution as ONE weak signal. It is never parsed, hashed, ' +
      'or cast into a businessId.',

    artifactKinds: [
      'bir_v1',                 /* a BIR with identity.businessKey */
      'submission_pre_identity',/* a submission captured before businessId existed */
      'assessment_session_only',/* an assessment known only by assessmentSessionId */
      'unresolved_duplicate'    /* two or more records that may be the same business */
    ],

    /* Deterministic path per artifact kind. No step merges anything. */
    path: {
      bir_v1: [
        'Set identityStatus = legacy_unresolved and copy businessKey to legacyBusinessKey.',
        'Do NOT populate businessId.',
        'Run identity resolution using the signals recoverable from the source submission.',
        'unique_match with a strong signal -> emit identity.linked, set businessId, status = linked.',
        'probable_match / possible_duplicate -> status = merge_required, queue for review.',
        'no_match -> create a Business Record, emit business.created then identity.linked, status = linked.',
        'The v1 BIR document itself is never rewritten; the link is recorded as a new event.'
      ],
      submission_pre_identity: [
        'Treat as an inbound signal set; resolve as normal.',
        'Retain submissionId as the immutable join key.'
      ],
      assessment_session_only: [
        'assessmentSessionId carries the thread until resolution completes.',
        'If no contact signal exists at all, status stays resolution_pending and the artifact is not attached.'
      ],
      unresolved_duplicate: [
        'status = merge_required.',
        'Emit business.merge_requested. Never business.merged without recorded owner approval.',
        'Both records remain independently readable and independently addressable while unresolved.'
      ]
    },

    prohibitions: [
      'Never reinterpret a legacyBusinessKey as a businessId.',
      'Never derive a businessId deterministically from an email, phone, or name.',
      'Never auto-merge during migration, at any confidence.',
      'Never rewrite a historical event to insert a businessId — emit identity.linked instead.',
      'Never delete a legacy artifact that failed to resolve; leave it legacy_unresolved and visible.'
    ]
  };

  /* POLARITY — which direction is "good" for the scales in this file. */
  const POLARITY = {
    'resolutionConfidence': { higherIs: 'better', range: '0..1' },
    'SIGNALS[].weight':     { higherIs: 'stronger evidence', range: '0..1' },
    'resolutionStatus':     { higherIs: 'n/a', note: 'Not a scale. manual_review_required is an exit to a human, not a rank between statuses — the same shape as readinessBand "escalate".' },
    'candidateSeparation':  { higherIs: 'better', note: 'Small separation means ambiguity even when the top score is high.' }
  };

  /* ---------------------------------------------------------
     Signals
     strength drives what a match is allowed to do, not just how
     much it scores. A "strong" signal is one issued by a system
     that already did identity work we trust.
     --------------------------------------------------------- */

  const SIGNAL_STRENGTH = ['strong', 'moderate', 'weak', 'corroborating_only'];

  const SIGNALS = {
    googleBusinessProfileId: {
      weight: 0.95, strength: 'strong', normalization: 'exact placeId or cid',
      note: 'Google already resolved this identity against a physical location.'
    },
    trustedExternalCustomerId: {
      weight: 0.95, strength: 'strong', normalization: 'exact, scoped by system',
      note: 'Only systems marked trustLevel "trusted". An untrusted CRM id is moderate at best.'
    },
    paymentCustomerId: {
      weight: 0.90, strength: 'strong', normalization: 'exact, scoped by processor',
      note: 'Money changed hands under this id.'
    },
    websiteDomain: {
      weight: 0.70, strength: 'moderate', normalization: 'registrable domain, strip www and scheme',
      note: 'Strong in practice for small businesses; shared hosting and marketplace pages weaken it.'
    },
    phoneNormalized: {
      weight: 0.65, strength: 'moderate', normalization: 'E.164',
      note: 'Numbers get reassigned and shared between a business and its owner.'
    },
    addressNormalized: {
      weight: 0.60, strength: 'moderate', normalization: 'USPS-style normalization, unit preserved',
      note: 'Suite numbers matter: two salons in one plaza are not one business.'
    },
    externalCrmId: {
      weight: 0.55, strength: 'moderate', normalization: 'exact, scoped by system',
      note: 'Untrusted CRM ids are frequently duplicated at source.'
    },
    ownerOrManagerName: {
      weight: 0.40, strength: 'weak', normalization: 'normalized personal name',
      note: 'One owner may run several businesses.'
    },
    businessNameNormalized: {
      weight: 0.35, strength: 'weak', normalization: 'lowercase, strip punctuation and legal suffixes',
      note: 'NEVER sufficient alone. "Nail Studio" is not a fingerprint.'
    },
    emailDomain: {
      weight: 0.35, strength: 'weak', normalization: 'domain only; free-mail domains score 0',
      note: 'A custom domain corroborates. gmail.com says nothing.'
    },
    emailExact: {
      weight: 0.30, strength: 'weak', normalization: 'lowercase, strip plus-addressing',
      note: 'NEVER sufficient alone. Shared and reassigned constantly.'
    },
    geoProximity: {
      weight: 0.25, strength: 'corroborating_only', normalization: 'metres between geocoded points',
      note: 'Supports another signal. Never carries a match on its own.'
    }
  };

  /* Signals that can never, alone, justify an automatic link or a merge
     proposal — regardless of how confident the arithmetic looks. */
  const INSUFFICIENT_ALONE = ['businessNameNormalized', 'emailExact', 'emailDomain', 'ownerOrManagerName', 'geoProximity'];

  /* At least one of these must agree before a match may be linked
     automatically. */
  const STRONG_SIGNALS = ['googleBusinessProfileId', 'trustedExternalCustomerId', 'paymentCustomerId'];

  /* ---------------------------------------------------------
     Thresholds
     --------------------------------------------------------- */

  const THRESHOLDS = {
    uniqueMatch: 0.90,
    probableMatch: 0.75,
    possibleDuplicate: 0.55,
    /* Automatic linking additionally requires a strong signal and no conflicts. */
    autoLinkMinimum: 0.90,
    /* The gap between the best and second-best candidate below which the
       result is ambiguous no matter how high the top score is. */
    minimumCandidateSeparation: 0.15,
    /* Any conflicting signal at or above this weight forces review. */
    conflictReviewWeight: 0.60
  };

  /* A conflict is a signal that actively disagrees, not one that is absent.
     Missing data lowers confidence; contradiction routes to a human. */
  const CONFLICT_KINDS = [
    'different_gbp_id',
    'different_payment_customer',
    'different_address_same_name',
    'different_owner',
    'business_permanently_closed',
    'record_already_merged',
    'vertical_mismatch'
  ];

  /* ---------------------------------------------------------
     Result shape
     --------------------------------------------------------- */

  const IDENTITY_RESOLUTION_RESULT_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    resolutionId: f('uuid', { required: true }),
    requestedAt: f('iso8601', { required: true }),
    inputSignals: f('array<object>', { required: true, note: '{ signal, value, normalizedValue, sourceSystem }.' }),

    candidateBusinessIds: f('array<object>', {
      required: true,
      note: '{ businessId, matchScore (0..1), contributingSignals[], conflictingSignals[], rank }. Ordered best first. May be empty.'
    }),
    contributingSignals: f('array<string>', { required: true, note: 'Signals that supported the leading candidate.' }),
    conflictingSignals: f('array<object>', { required: true, note: '{ signal, kind (CONFLICT_KINDS), detail }. Empty array, never null.' }),

    resolutionConfidence: f('number', { required: true, note: '0..1 for the leading candidate. 0 when there is none.' }),
    resolutionStatus: f('enum', { required: true, values: RESOLUTION_STATUSES }),
    recommendedAction: f('enum', { required: true, values: RECOMMENDED_ACTIONS }),
    candidateSeparation: f('number', { note: 'Top score minus runner-up. Small separation means ambiguity.' }),
    requiresOwnerApproval: f('boolean', { required: true }),
    rationale: f('string', { required: true, note: 'Plain language, for the review queue.' }),
    evidenceRefs: f('array<string>'),
    resolvedBy: f('object', { note: '{ kind (engine|human), id }. Set when a decision is actually taken.' }),
    resolvedAt: f('iso8601', { nullable: true })
  };

  /* ---------------------------------------------------------
     Merge
     --------------------------------------------------------- */

  const MERGE_RECORD_SCHEMA = {
    mergeId: f('uuid', { required: true }),
    survivingBusinessId: f('uuid', { required: true }),
    mergedBusinessIds: f('array<uuid>', { required: true }),
    proposedAt: f('iso8601', { required: true }),
    proposedBy: f('object', { required: true, note: '{ kind, id }.' }),
    approvedAt: f('iso8601', { required: true, note: 'Merges are always owner-approved. No approval, no merge.' }),
    approvedBy: f('object', { required: true, note: '{ kind: "human", id, displayName }.' }),
    resolutionId: f('uuid', { note: 'The resolution that prompted this.' }),
    fieldResolutions: f('array<object>', { required: true, note: '{ path, survivingValue, discardedValues[], reason }.' }),
    preservedAliases: f('array<object>', { required: true, note: 'Every name, phone, email, and domain from every merged record. Nothing is dropped.' }),
    sourceRecordSnapshots: f('array<object>', { required: true, note: 'Complete pre-merge copies. This is what makes unmerge possible.' }),
    timelineStrategy: f('enum', { values: ['interleave_by_occurredAt'], note: 'Timelines combine by occurrence time; event ids never change.' }),
    unmergeSafe: f('boolean', { required: true, note: 'False once post-merge writes make the original split unreconstructable.' }),
    unmergeBlockers: f('array<string>', { note: 'e.g. purchase_after_merge, agreement_after_merge, external_sync_after_merge.' }),
    notes: f('string')
  };

  const UNMERGE_RECORD_SCHEMA = {
    unmergeId: f('uuid', { required: true }),
    mergeId: f('uuid', { required: true }),
    performedAt: f('iso8601', { required: true }),
    approvedBy: f('object', { required: true }),
    restoredBusinessIds: f('array<uuid>', { required: true }),
    postMergeEventDisposition: f('array<object>', { required: true, note: '{ eventId, assignedToBusinessId, decidedBy }. Every post-merge event must be explicitly assigned.' }),
    rationale: f('string', { required: true })
  };

  /* ---------------------------------------------------------
     Rules — the non-negotiables
     --------------------------------------------------------- */

  const RULES = [
    'Never merge automatically. Every merge is owner-approved, without exception.',
    'Never merge on business name alone, at any score.',
    'Never merge on email alone, at any score.',
    'A Google Business Profile id or a trusted external customer id may serve as a strong identifier.',
    'Automatic linking of a new event to an existing record is permitted at or above THRESHOLDS.autoLinkMinimum, with at least one strong signal and zero conflicting signals.',
    'Any conflicting signal at or above THRESHOLDS.conflictReviewWeight forces manual_review_required.',
    'Candidate separation below THRESHOLDS.minimumCandidateSeparation forces possible_duplicate regardless of the top score.',
    'Preserve every alias and every source record after a merge. Nothing is discarded.',
    'Merge history is append-only and auditable.',
    'Unmerge is supported only while unmergeSafe is true and every post-merge event can be explicitly reassigned.',
    'A record whose recordStatus is merged_away is never a link target; follow mergedIntoBusinessId first.',
    'Low-confidence identity resolution is an owner-interruption trigger, not a guess.'
  ];

  /* ---------------------------------------------------------
     Deterministic helpers
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

  /* Maps a score plus context to a status. Deterministic and total: every
     input lands in exactly one status. */
  const classifyResolution = ({ topScore = 0, separation = 1, strongSignals = [], conflicts = [], contributingSignals = [] }) => {
    const hasBlockingConflict = conflicts.some(c => (SIGNALS[c.signal] || {}).weight >= THRESHOLDS.conflictReviewWeight);
    if (hasBlockingConflict) return 'manual_review_required';

    const onlyInsufficient = contributingSignals.length > 0 &&
      contributingSignals.every(s => INSUFFICIENT_ALONE.includes(s));
    if (onlyInsufficient && topScore >= THRESHOLDS.probableMatch) return 'possible_duplicate';

    if (topScore < THRESHOLDS.possibleDuplicate) return 'no_match';
    if (separation < THRESHOLDS.minimumCandidateSeparation) return 'possible_duplicate';
    if (topScore >= THRESHOLDS.uniqueMatch && strongSignals.length > 0) return 'unique_match';
    if (topScore >= THRESHOLDS.probableMatch) return 'probable_match';
    return 'possible_duplicate';
  };

  const mayAutoLink = result =>
    result.resolutionStatus === 'unique_match' &&
    result.resolutionConfidence >= THRESHOLDS.autoLinkMinimum &&
    Array.isArray(result.conflictingSignals) && result.conflictingSignals.length === 0 &&
    Array.isArray(result.contributingSignals) &&
    result.contributingSignals.some(s => STRONG_SIGNALS.includes(s));

  /* There is no mayAutoMerge(). Merging is never automatic. */

  /* Validates how an artifact is attached to a Business Record. Applies to
     BIRs, submissions, assessments, and timeline events alike. */
  const validateIdentityLink = ({ identityStatus, businessId, legacyBusinessKey, identityResolutionId } = {}) => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!IDENTITY_LINK_STATUSES.includes(identityStatus)) {
      push('invalid_identity_status', `Unknown identityStatus: ${identityStatus}`);
      return { valid: false, errors };
    }

    const hasId = businessId !== null && businessId !== undefined;
    if (hasId && !isUuid(businessId)) push('invalid_business_id', 'businessId must be a UUID.');
    if (!hasId && !STATUSES_WITHOUT_BUSINESS_ID.includes(identityStatus)) {
      push('missing_business_id', `businessId may be null only while identityStatus is ${STATUSES_WITHOUT_BUSINESS_ID.join(' or ')}.`);
    }
    if (hasId && identityStatus === 'legacy_unresolved') {
      push('legacy_with_business_id', 'legacy_unresolved means not yet attached; it must not carry a businessId.');
    }
    if (identityStatus === 'legacy_unresolved' && !legacyBusinessKey) {
      push('legacy_without_key', 'legacy_unresolved requires the original businessKey as provenance.');
    }
    if (legacyBusinessKey && legacyBusinessKey === businessId) {
      push('legacy_key_reinterpreted', 'legacyBusinessKey must never be reused as businessId.');
    }
    if (identityStatus === 'linked' && !identityResolutionId) {
      push('linked_without_resolution', 'An automatic link must cite the identityResolutionId that produced it.');
    }
    if (identityStatus === 'merge_required' && hasId) {
      push('merge_required_with_id', 'merge_required means the correct record is undecided; it must not claim one.');
    }

    return { valid: errors.length === 0, errors };
  };

  const validateResolutionResult = result => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!result || typeof result !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Result must be an object.' }] };
    }
    if (result.schemaVersion !== IDENTITY_RESOLUTION_SCHEMA_VERSION) push('schema_version_mismatch', 'Unexpected schemaVersion.');
    if (!isUuid(result.resolutionId)) push('invalid_resolution_id', 'resolutionId must be a UUID.');
    if (!RESOLUTION_STATUSES.includes(result.resolutionStatus)) push('invalid_status', `Unknown resolutionStatus: ${result.resolutionStatus}`);
    if (!RECOMMENDED_ACTIONS.includes(result.recommendedAction)) push('invalid_action', `Unknown recommendedAction: ${result.recommendedAction}`);

    const c = result.resolutionConfidence;
    if (typeof c !== 'number' || c < 0 || c > 1) push('invalid_confidence', 'resolutionConfidence must be a number in 0..1.');
    if (!Array.isArray(result.conflictingSignals)) push('conflicts_not_array', 'conflictingSignals must be an array, empty rather than null.');
    if (!Array.isArray(result.candidateBusinessIds)) push('candidates_not_array', 'candidateBusinessIds must be an array.');
    else {
      result.candidateBusinessIds.forEach((cand, i) => {
        if (!isUuid(cand.businessId)) push('invalid_candidate_id', `candidateBusinessIds[${i}].businessId must be a UUID.`);
        if (typeof cand.matchScore !== 'number' || cand.matchScore < 0 || cand.matchScore > 1) {
          push('invalid_match_score', `candidateBusinessIds[${i}].matchScore must be in 0..1.`);
        }
      });
    }

    /* Rule invariants. */
    if (result.resolutionStatus === 'no_match' && (result.candidateBusinessIds || []).length > 0 &&
        result.recommendedAction === 'link_to_existing') {
      push('contradictory_action', 'no_match cannot recommend link_to_existing.');
    }
    if (result.recommendedAction === 'propose_merge' && result.requiresOwnerApproval !== true) {
      push('merge_without_approval', 'propose_merge must set requiresOwnerApproval true.');
    }
    if (result.recommendedAction === 'link_to_existing' && !mayAutoLink(result)) {
      push('auto_link_not_permitted', 'link_to_existing requires unique_match, no conflicts, and at least one strong signal.');
    }
    if (Array.isArray(result.contributingSignals) &&
        result.contributingSignals.length > 0 &&
        result.contributingSignals.every(s => INSUFFICIENT_ALONE.includes(s)) &&
        ['unique_match'].includes(result.resolutionStatus)) {
      push('insufficient_signal_basis', 'A unique_match cannot rest only on name, email, owner name, or proximity.');
    }
    if (!result.rationale) push('missing_rationale', 'rationale is required — a review queue entry without a reason is unusable.');

    return { valid: errors.length === 0, errors };
  };

  const API = {
    IDENTITY_RESOLUTION_SCHEMA_VERSION,
    IDENTITY_RESOLUTION_RESULT_SCHEMA,
    MERGE_RECORD_SCHEMA,
    UNMERGE_RECORD_SCHEMA,
    SIGNALS,
    SIGNAL_STRENGTH,
    STRONG_SIGNALS,
    INSUFFICIENT_ALONE,
    THRESHOLDS,
    CONFLICT_KINDS,
    RESOLUTION_STATUSES,
    RECOMMENDED_ACTIONS,
    IDENTITY_LINK_STATUSES,
    STATUSES_WITHOUT_BUSINESS_ID,
    STATUSES_REQUIRING_HUMAN,
    LEGACY_MIGRATION,
    POLARITY,
    RULES,
    classifyResolution,
    mayAutoLink,
    validateIdentityLink,
    validateResolutionResult,
    isUuid
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDIdentityResolutionSchema = API;
})();
