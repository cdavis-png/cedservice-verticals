/* ============================================================
   CED Intelligence Platform — Relationships
   Canonical schema, v1
   ------------------------------------------------------------
   Edges between entities, with time. A relationship is never
   deleted when it ends — it is closed with a validTo, because
   "who owned this salon in 2026" is a question the platform must
   still be able to answer in 2029.

   Supports multi-location, multi-owner, franchise, parent-child,
   and partner structures.

   SPECIFICATION ONLY. No graph store, no traversal engine.
   ============================================================ */

(() => {
  'use strict';

  const RELATIONSHIP_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  const ENTITY_TYPES = [
    'business', 'person', 'location', 'package', 'service', 'project',
    'ai_agent', 'integration', 'campaign', 'partner', 'referral_source',
    'parent_organization', 'child_organization', 'licensee',
    'account_owner', 'vendor'
  ];

  /* Each type declares what it may connect, so an invalid edge is caught
     structurally rather than by convention. */
  const RELATIONSHIP_TYPES = {
    owns:                 { from: ['person', 'business', 'parent_organization'], to: ['business', 'location'], exclusive: false },
    manages:              { from: ['person'], to: ['business', 'location', 'project'], exclusive: false },
    employs:              { from: ['business'], to: ['person'], exclusive: false },
    located_at:           { from: ['business'], to: ['location'], exclusive: false },
    primary_location_of:  { from: ['location'], to: ['business'], exclusive: true, note: 'A business has exactly one primary location at a time.' },
    subscribes_to:        { from: ['business'], to: ['package'], exclusive: false },
    receives_service:     { from: ['business'], to: ['service'], exclusive: false },
    engaged_in:           { from: ['business'], to: ['project'], exclusive: false },
    parent_of:            { from: ['parent_organization', 'business'], to: ['business', 'child_organization'], exclusive: false },
    child_of:             { from: ['business', 'child_organization'], to: ['parent_organization', 'business'], exclusive: true, note: 'One parent at a time.' },
    franchisee_of:        { from: ['business'], to: ['business', 'parent_organization'], exclusive: true },
    licensee_of:          { from: ['business', 'licensee'], to: ['business', 'parent_organization'], exclusive: false },
    partner_of:           { from: ['business', 'partner'], to: ['business', 'partner'], exclusive: false, symmetric: true },
    referred_by:          { from: ['business'], to: ['referral_source', 'business', 'person'], exclusive: true, note: 'Attribution requires a single referrer.' },
    account_owner_of:     { from: ['person', 'account_owner'], to: ['business'], exclusive: true, note: 'One CED Service account owner at a time.' },
    vendor_to:            { from: ['vendor', 'business'], to: ['business'], exclusive: false },
    assigned_agent:       { from: ['ai_agent'], to: ['business', 'project'], exclusive: false },
    integrated_with:      { from: ['business'], to: ['integration'], exclusive: false },
    targeted_by_campaign: { from: ['campaign'], to: ['business', 'location'], exclusive: false }
  };

  /* Roles qualify a relationship without multiplying types. */
  const ROLES = [
    'primary_owner', 'co_owner', 'silent_partner', 'general_manager',
    'location_manager', 'billing_contact', 'technical_contact',
    'decision_maker', 'influencer', 'implementer', 'referrer', 'reseller'
  ];

  const STATUSES = ['active', 'pending', 'ended', 'disputed', 'superseded'];

  const SOURCES = ['assessment', 'conversation', 'external_system', 'manual_entry', 'inferred', 'public_record'];

  const RELATIONSHIP_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    relationshipId: f('uuid', { required: true, immutable: true }),

    sourceEntity: f('object', { required: true, note: '{ type (ENTITY_TYPES), id }.' }),
    targetEntity: f('object', { required: true, note: '{ type (ENTITY_TYPES), id }.' }),
    relationshipType: f('enum', { required: true, values: Object.keys(RELATIONSHIP_TYPES) }),
    role: f('enum', { nullable: true, values: ROLES }),

    /* Validity is about the real world, not about the row. A relationship that
       ended is still true of the period it covered. */
    validFrom: f('iso8601', { required: true }),
    validTo: f('iso8601', { nullable: true, note: 'Null means currently valid. Never delete to end a relationship; set this.' }),

    status: f('enum', { required: true, values: STATUSES, default: 'active' }),
    confidence: f('number', { required: true, note: '0..1. Inferred relationships are rarely above 0.7.' }),
    source: f('enum', { required: true, values: SOURCES }),
    evidence: f('array<object>', { required: true, note: '{ kind, ref, statement }. An inferred relationship with no evidence is not usable for decisions.' }),

    attributes: f('object', { note: 'Type-specific extras, e.g. { ownershipPercent } for owns, { tier } for partner_of.' }),

    supersedesRelationshipId: f('uuid', { nullable: true, note: 'Corrections create a new row and point back.' }),
    createdAt: f('iso8601', { required: true, immutable: true }),
    updatedAt: f('iso8601', { required: true })
  };

  /* ---------------------------------------------------------
     Structural patterns this model must express
     --------------------------------------------------------- */

  const SUPPORTED_STRUCTURES = {
    multiLocation: 'One business, many located_at edges; exactly one primary_location_of at a time.',
    multiOwner: 'Several owns edges from different persons, each with a role and optional ownershipPercent.',
    franchise: 'franchisee_of from unit to franchisor; the unit keeps its own Business Record and its own assessments.',
    parentChild: 'parent_of / child_of between organizations. A child has at most one parent at any instant.',
    partner: 'partner_of is symmetric — store one edge and treat it as bidirectional rather than writing two.',
    ownershipChange: 'End the old owns edge with validTo, open a new one. Both are retained; ownership change triggers reassessment.'
  };

  /* ---------------------------------------------------------
     Validation
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso8601 = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

  const validateRelationship = rel => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!rel || typeof rel !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Relationship must be an object.' }] };
    }

    if (rel.schemaVersion !== RELATIONSHIP_SCHEMA_VERSION) push('schema_version_mismatch', 'Unexpected schemaVersion.');
    if (!isUuid(rel.relationshipId)) push('invalid_relationship_id', 'relationshipId must be a UUID.');

    const def = RELATIONSHIP_TYPES[rel.relationshipType];
    if (!def) push('unknown_relationship_type', `Unknown relationshipType: ${rel.relationshipType}`);

    const src = rel.sourceEntity || {};
    const tgt = rel.targetEntity || {};
    if (!ENTITY_TYPES.includes(src.type)) push('invalid_source_type', `Unknown sourceEntity.type: ${src.type}`);
    if (!ENTITY_TYPES.includes(tgt.type)) push('invalid_target_type', `Unknown targetEntity.type: ${tgt.type}`);
    if (!src.id) push('missing_source_id', 'sourceEntity.id is required.');
    if (!tgt.id) push('missing_target_id', 'targetEntity.id is required.');

    if (def) {
      if (src.type && !def.from.includes(src.type)) {
        push('illegal_source_type', `${rel.relationshipType} cannot originate from ${src.type}.`);
      }
      if (tgt.type && !def.to.includes(tgt.type)) {
        push('illegal_target_type', `${rel.relationshipType} cannot point to ${tgt.type}.`);
      }
    }

    if (src.type === tgt.type && src.id && src.id === tgt.id) {
      push('self_relationship', 'An entity cannot relate to itself.');
    }

    /* Date consistency. */
    if (!isIso8601(rel.validFrom)) push('invalid_valid_from', 'validFrom must be ISO 8601.');
    if (rel.validTo !== null && rel.validTo !== undefined) {
      if (!isIso8601(rel.validTo)) push('invalid_valid_to', 'validTo must be ISO 8601 or null.');
      else if (isIso8601(rel.validFrom) && Date.parse(rel.validTo) < Date.parse(rel.validFrom)) {
        push('inverted_validity', 'validTo cannot precede validFrom.');
      }
    }
    if (rel.status === 'ended' && !rel.validTo) push('ended_without_valid_to', 'status "ended" requires validTo.');
    if (rel.status === 'active' && rel.validTo && Date.parse(rel.validTo) < Date.now()) {
      push('active_but_expired', 'status "active" conflicts with a validTo in the past.');
    }

    if (rel.role && !ROLES.includes(rel.role)) push('invalid_role', `Unknown role: ${rel.role}`);
    if (rel.status && !STATUSES.includes(rel.status)) push('invalid_status', `Unknown status: ${rel.status}`);
    if (rel.source && !SOURCES.includes(rel.source)) push('invalid_source', `Unknown source: ${rel.source}`);

    if (typeof rel.confidence !== 'number' || rel.confidence < 0 || rel.confidence > 1) {
      push('invalid_confidence', 'confidence must be a number in 0..1.');
    }
    if (rel.source === 'inferred' && (!Array.isArray(rel.evidence) || rel.evidence.length === 0)) {
      push('inferred_without_evidence', 'An inferred relationship requires evidence.');
    }

    return { valid: errors.length === 0, errors };
  };

  /* Exclusive types may not have two simultaneously-valid edges for the same
     source. Pure function over a candidate set; no store access. */
  const findExclusivityViolations = relationships => {
    const violations = [];
    const overlaps = (a, b) => {
      const aFrom = Date.parse(a.validFrom), bFrom = Date.parse(b.validFrom);
      const aTo = a.validTo ? Date.parse(a.validTo) : Infinity;
      const bTo = b.validTo ? Date.parse(b.validTo) : Infinity;
      return aFrom < bTo && bFrom < aTo;
    };

    (relationships || []).forEach((a, i) => {
      const def = RELATIONSHIP_TYPES[a.relationshipType];
      if (!def || !def.exclusive || a.status === 'ended' || a.status === 'superseded') return;
      for (let j = i + 1; j < relationships.length; j++) {
        const b = relationships[j];
        if (b.relationshipType !== a.relationshipType) continue;
        if (b.status === 'ended' || b.status === 'superseded') continue;
        if ((a.sourceEntity || {}).id !== (b.sourceEntity || {}).id) continue;
        if (overlaps(a, b)) {
          violations.push({
            code: 'exclusivity_violation',
            relationshipType: a.relationshipType,
            relationshipIds: [a.relationshipId, b.relationshipId],
            message: `${a.relationshipType} is exclusive but two edges overlap in time.`
          });
        }
      }
    });
    return violations;
  };

  const API = {
    RELATIONSHIP_SCHEMA_VERSION,
    RELATIONSHIP_SCHEMA,
    ENTITY_TYPES,
    RELATIONSHIP_TYPES,
    ROLES,
    STATUSES,
    SOURCES,
    SUPPORTED_STRUCTURES,
    validateRelationship,
    findExclusivityViolations,
    isUuid,
    isIso8601
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDRelationshipSchema = API;
})();
