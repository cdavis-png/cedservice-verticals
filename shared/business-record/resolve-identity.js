/* ============================================================
   CED Intelligence Platform — Identity Resolution v2
   ------------------------------------------------------------
   Pure, deterministic. No I/O, no store access, no clock.
   Callers supply the signals and the candidate rows; this module
   decides. That keeps the decision testable and keeps the same
   rules in front of both the endpoint and the SQL ingestion
   function.

   Model and thresholds: identity-resolution.schema.js.
   Decision record: docs/decisions/ADR-001.

   ------------------------------------------------------------
   v2 — the trust model (production hardening, Milestone 1.1)

   v1 treated a strong identifier as authoritative regardless of
   where it came from. On a public, unauthenticated endpoint that
   is not safe: anyone can type a Google Business Profile id into
   a form, and if that alone linked records, anyone could attach
   themselves to any business.

   Strength and trust are now two different axes:

     · STRENGTH  — how discriminating the identifier is by
                   nature. A place id is strong; a first name is
                   not. This is intrinsic to the type.
     · TRUST     — whether we have any reason to believe this
                   claim. Intrinsic to the SOURCE.

   Automatic linking requires BOTH. A visitor-supplied place id
   is strong-but-unverified: it is recorded as evidence, it can
   raise a case for a human, and it can never link a record on
   its own.

   Consequences that are deliberate, not accidental:

     · Claimed identifiers do NOT reserve a value. The database
       uniqueness backstop covers verified identifiers only, so
       squatting a place id blocks nobody.
     · A claimed identifier that collides with someone else's
       verified one is a conflict to be reviewed, never a silent
       link and never a silent discard.

   Nothing here merges anything, ever.
   ============================================================ */

(() => {
  'use strict';

  /* Strength is DATA, not logic. The SQL ingestion function reads the same
     classification from business_identifiers.identifier_type, so the two
     implementations cannot disagree about what counts as strong. */
  const IDENTIFIER_TYPES = {
    gbp_place_id:         { strength: 'strong',   unique: true,  note: 'Google Business Profile place id. Auto-links only when verified.' },
    external_customer_id: { strength: 'strong',   unique: true,  note: 'Trusted external system id. Auto-links only when verified.' },
    payment_customer_id:  { strength: 'strong',   unique: true,  note: 'Processor customer handle. Auto-links only when verified.' },
    website_domain:       { strength: 'moderate', unique: false, note: 'Registrable domain. Not collected yet.' },
    business_phone:       { strength: 'moderate', unique: false, note: 'Business line, E.164. Not collected yet.' },
    mobile_phone:         { strength: 'weak',     unique: false, note: 'Owner mobile. Optional today.' },
    email_exact:          { strength: 'weak',     unique: false, note: 'Contact email.' },
    email_domain:         { strength: 'weak',     unique: false, note: 'Custom domains only; free-mail scores nothing.' },
    business_name:        { strength: 'weak',     unique: false, note: 'Never sufficient alone.' },
    vertical:             { strength: 'context',  unique: false, note: 'Narrows candidates; never matches, never persisted as an identifier.' },
    locality:             { strength: 'context',  unique: false, note: 'Broad location when available.' }
  };

  const STRONG_TYPES = Object.keys(IDENTIFIER_TYPES).filter(t => IDENTIFIER_TYPES[t].strength === 'strong');
  const CONTEXT_TYPES = Object.keys(IDENTIFIER_TYPES).filter(t => IDENTIFIER_TYPES[t].strength === 'context');

  /* Where a claim came from. Only the trusted set may support an automatic
     link, and only in combination with verified = true. */
  const SOURCES = {
    visitor_supplied:     { trusted: false, note: 'Typed into a public form by whoever was at the keyboard.' },
    trusted_integration:  { trusted: true,  note: 'Received from a system we authenticate to.' },
    verified_enrichment:  { trusted: true,  note: 'Third-party enrichment we have accepted as authoritative.' },
    authenticated_customer: { trusted: true, note: 'Asserted by an authenticated customer about their own record.' },
    manual_verification:  { trusted: true,  note: 'Confirmed by a named operator, with evidence.' },
    seed:                 { trusted: true,  note: 'Fixture and migration data.' }
  };

  const TRUSTED_SOURCES = Object.keys(SOURCES).filter(s => SOURCES[s].trusted);

  const VERIFICATION_METHODS = [
    'none', 'integration_callback', 'enrichment_provider', 'authenticated_session',
    'operator_review', 'domain_control', 'payment_instrument'
  ];

  const RESOLUTION_ACTIONS = ['link_to_existing', 'create_new_record', 'queue_for_review'];

  /* Free-mail domains carry no identity information. */
  const FREE_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
    'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me',
    'protonmail.com', 'gmx.com', 'mail.com', 'comcast.net', 'att.net', 'verizon.net'
  ]);

  const LEGAL_SUFFIX = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|pc)\b\.?/gi;

  /* Bounds every normalized value before it can reach an indexed column.
     Kept in step with shared/security/limits.js; duplicated as a constant
     rather than imported so this file stays loadable as a classic script. */
  const MAX_IDENTIFIER_LENGTH = 256;

  const IDENTIFIER_FORMATS = {
    gbp_place_id: /^[A-Za-z0-9_\-]{6,128}$/,
    external_customer_id: /^[A-Za-z0-9_\-:.]{4,128}$/,
    payment_customer_id: /^[A-Za-z0-9_\-]{4,128}$/
  };

  const isAcceptableValue = (type, value) => {
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
    const format = IDENTIFIER_FORMATS[type];
    return format ? format.test(value) : true;
  };

  const normalizeEmail = value => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
    const [local, domain] = trimmed.split('@');
    return `${local.split('+')[0]}@${domain}`;
  };

  const emailDomain = value => {
    const normalized = normalizeEmail(value);
    if (!normalized) return null;
    const domain = normalized.split('@')[1];
    return FREE_MAIL.has(domain) ? null : domain;
  };

  /* North-America oriented; enough for this milestone, and deliberately
     conservative — anything it cannot confidently normalize returns null
     rather than a guess. */
  const normalizePhone = value => {
    if (typeof value !== 'string') return null;
    const digits = value.replace(/\D+/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
    return null;
  };

  const normalizeDomain = value => {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .split('?')[0];
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned) ? cleaned : null;
  };

  const normalizeName = value => {
    if (typeof value !== 'string') return null;
    const cleaned = value.toLowerCase()
      .replace(LEGAL_SUFFIX, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    return cleaned.length >= 3 ? cleaned : null;
  };

  /* Every signal carries its provenance. A signal without provenance is not
     representable — that is the point of building them here. */
  const makeSignal = ({ type, rawValue, normalizedValue, source, verified,
                        verificationMethod, verificationEvidence }) => ({
    type,
    rawValue: rawValue === undefined ? null : rawValue,
    normalizedValue,
    strength: IDENTIFIER_TYPES[type].strength,
    source,
    verified: verified === true,
    verificationMethod: verificationMethod || 'none',
    verificationEvidence: verificationEvidence || null,
    /* Precomputed so the SQL and the JS cannot reach different conclusions. */
    autoLinkable: canAutoLink({ type, source, verified: verified === true })
  });

  /* The single rule that decides whether an identifier may move a record by
     itself. Strong by nature AND verified AND from a source we trust. */
  const canAutoLink = ({ type, source, verified }) =>
    STRONG_TYPES.includes(type) && verified === true && TRUSTED_SOURCES.includes(source);

  const push = (list, type, rawValue, normalizedValue, provenance) => {
    if (!normalizedValue) return;
    if (!isAcceptableValue(type, normalizedValue)) return;   /* never store a malformed identifier */
    list.push(makeSignal({
      type,
      rawValue,
      normalizedValue,
      source: provenance.source,
      verified: provenance.verified,
      verificationMethod: provenance.verificationMethod,
      verificationEvidence: provenance.verificationEvidence
    }));
  };

  /* Extracts only what the payload actually contains. Absent fields produce no
     signal — never a placeholder, never a guess.

     Everything from an assessment payload is visitor_supplied and unverified,
     including the roadmap identity fields. There is no path by which a public
     form submission produces a trusted identifier, and there must not be. */
  const VISITOR = {
    source: 'visitor_supplied',
    verified: false,
    verificationMethod: 'none',
    verificationEvidence: null
  };

  const extractIdentitySignals = (payload, provenance = VISITOR) => {
    const signals = [];
    if (!payload || typeof payload !== 'object') return signals;

    const contact = payload.contact || {};
    const answers = payload.answers || {};
    const vertical = payload.vertical || {};

    /* Roadmap fields: read if present, never required, never trusted. */
    push(signals, 'gbp_place_id', contact.googlePlaceId,
      typeof contact.googlePlaceId === 'string' ? contact.googlePlaceId.trim() : null, provenance);
    push(signals, 'external_customer_id', contact.externalCustomerId,
      typeof contact.externalCustomerId === 'string' ? contact.externalCustomerId.trim() : null, provenance);
    push(signals, 'website_domain', contact.website, normalizeDomain(contact.website), provenance);
    push(signals, 'business_phone', contact.businessPhone, normalizePhone(contact.businessPhone), provenance);

    /* Collected today. */
    push(signals, 'email_exact', contact.email, normalizeEmail(contact.email), provenance);
    push(signals, 'email_domain', contact.email, emailDomain(contact.email), provenance);
    push(signals, 'mobile_phone', contact.mobile, normalizePhone(contact.mobile), provenance);
    push(signals, 'business_name', contact.salonName || answers.salonName,
      normalizeName(contact.salonName || answers.salonName), provenance);

    /* Context: used to narrow a search, never persisted as an identifier.
       The vertical lives on business_records.vertical_id, which is where it
       belongs — a row per business saying "nails" is not identity evidence. */
    push(signals, 'vertical', vertical.id,
      typeof vertical.id === 'string' ? vertical.id : null, provenance);

    return signals;
  };

  /* Signals that may be persisted to business_identifiers. Context types are
     excluded: they match nothing and only bloat the lookup index. */
  const persistableSignals = signals =>
    (signals || []).filter(s => s && !CONTEXT_TYPES.includes(s.type));

  /* candidates: [{ businessId, matchedTypes, verifiedStrongTypes, claimedStrongTypes, recordStatus }]
     Assembled by the caller from an exact-match lookup on normalized values.
     `verifiedStrongTypes` is the only field that can produce an automatic link. */
  const decideIdentity = ({ sessionBusinessId = null, candidates = [], signals = [] } = {}) => {
    const contributing = [];
    const conflicting = [];

    const usable = (candidates || [])
      .filter(c => c && c.businessId && c.recordStatus !== 'merged_away')
      .map(c => ({
        businessId: c.businessId,
        matchedTypes: c.matchedTypes || [],
        verifiedStrongTypes: (c.verifiedStrongTypes || []).filter(t => STRONG_TYPES.includes(t)),
        claimedStrongTypes: (c.claimedStrongTypes || []).filter(t => STRONG_TYPES.includes(t))
      }));

    /* Rule B2 — a saved journey is deterministic for itself. The visitor
       already told us who they are by resuming their own assessment. */
    if (sessionBusinessId) {
      return {
        action: 'link_to_existing',
        businessId: sessionBusinessId,
        identityStatus: 'linked',
        resolutionStatus: 'unique_match',
        confidence: 1,
        contributingSignals: ['assessment_session_link'],
        conflictingSignals: [],
        candidateBusinessIds: [sessionBusinessId],
        linkMethod: 'session',
        rationale: 'This assessment session is already linked to a Business Record.'
      };
    }

    /* Rule B4 — nothing to match against. */
    if (usable.length === 0) {
      return {
        action: 'create_new_record',
        businessId: null,
        identityStatus: 'linked',
        resolutionStatus: 'no_match',
        confidence: 0,
        contributingSignals: [],
        conflictingSignals: [],
        candidateBusinessIds: [],
        linkMethod: 'auto',
        rationale: 'No credible candidate. A new Business Record will be created.'
      };
    }

    const verifiedStrong = usable.filter(c => c.verifiedStrongTypes.length > 0);
    const claimedStrong = usable.filter(c => c.verifiedStrongTypes.length === 0 && c.claimedStrongTypes.length > 0);

    /* Rule B3 — exactly one candidate carries a VERIFIED strong identifier,
       and no other candidate carries one. Claimed identifiers, however
       confident the visitor was, never reach this branch. */
    if (verifiedStrong.length === 1) {
      const winner = verifiedStrong[0];
      contributing.push(...winner.matchedTypes);
      usable.filter(c => c.businessId !== winner.businessId).forEach(c => conflicting.push({
        businessId: c.businessId,
        kind: c.claimedStrongTypes.length ? 'competing_claimed_identifier' : 'competing_weak_candidate',
        matchedTypes: c.matchedTypes,
        claimedStrongTypes: c.claimedStrongTypes
      }));

      return {
        action: 'link_to_existing',
        businessId: winner.businessId,
        identityStatus: 'linked',
        resolutionStatus: 'unique_match',
        confidence: 0.95,
        contributingSignals: [...new Set(contributing)].filter(t => !CONTEXT_TYPES.includes(t)),
        conflictingSignals: conflicting,
        candidateBusinessIds: usable.map(c => c.businessId),
        linkMethod: 'auto',
        rationale: `Unique match on verified strong identifier(s): ${winner.verifiedStrongTypes.join(', ')}.`
      };
    }

    /* Rule B5 — everything else is ambiguous and belongs to a human.
       Weak-only matches never link no matter how many agree: name alone,
       email alone, and mobile alone are each insufficient by design, and so
       is their sum. Claimed strong identifiers are treated the same way,
       because an unverified claim is an assertion, not evidence of identity. */
    usable.forEach(c => contributing.push(...c.matchedTypes));

    if (verifiedStrong.length > 1) {
      verifiedStrong.forEach(c => conflicting.push({
        businessId: c.businessId,
        kind: 'multiple_verified_strong_candidates',
        matchedTypes: c.verifiedStrongTypes,
        claimedStrongTypes: c.claimedStrongTypes
      }));
    }
    claimedStrong.forEach(c => conflicting.push({
      businessId: c.businessId,
      kind: 'claimed_strong_identifier',
      matchedTypes: c.matchedTypes,
      claimedStrongTypes: c.claimedStrongTypes
    }));

    const hasVerifiedConflict = verifiedStrong.length > 1;
    const hasClaim = claimedStrong.length > 0;

    return {
      action: 'queue_for_review',
      businessId: null,
      identityStatus: 'resolution_pending',
      resolutionStatus: hasVerifiedConflict ? 'possible_duplicate'
        : hasClaim ? 'manual_review_required'
        : (usable.length === 1 ? 'probable_match' : 'possible_duplicate'),
      confidence: hasVerifiedConflict ? 0.75 : hasClaim ? 0.65 : 0.6,
      contributingSignals: [...new Set(contributing)].filter(t => !CONTEXT_TYPES.includes(t)),
      conflictingSignals: conflicting,
      candidateBusinessIds: usable.map(c => c.businessId),
      linkMethod: null,
      rationale: hasVerifiedConflict
        ? 'More than one candidate carries a verified strong identifier.'
        : hasClaim
          ? 'A strong identifier was claimed but is unverified; it cannot link a record on its own.'
          : 'Candidate matched only on weak signals; a verified strong identifier is required to link automatically.'
    };
  };

  const API = {
    IDENTIFIER_TYPES,
    STRONG_TYPES,
    CONTEXT_TYPES,
    SOURCES,
    TRUSTED_SOURCES,
    VERIFICATION_METHODS,
    RESOLUTION_ACTIONS,
    FREE_MAIL,
    MAX_IDENTIFIER_LENGTH,
    IDENTIFIER_FORMATS,
    isAcceptableValue,
    canAutoLink,
    makeSignal,
    normalizeEmail,
    emailDomain,
    normalizePhone,
    normalizeDomain,
    normalizeName,
    extractIdentitySignals,
    persistableSignals,
    decideIdentity
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDResolveIdentity = API;
})();
