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

  /* THE AUTHORITATIVE LENGTH DEFINITION: Unicode code points — characters as
     Unicode counts them, not as a particular encoding stores them.

     `value.length` counts UTF-16 CODE UNITS, so an astral character (emoji,
     historic scripts, most CJK extensions) counts twice. PostgreSQL `length()`
     counts CODE POINTS. The two agree on ASCII and on the whole BMP and
     disagree above U+FFFF: 129 emoji are 258 code units and 129 code points,
     which JavaScript refused and `identity_value_acceptable` accepted. The
     same input reaching two different verdicts is the defect; which of the two
     numbers is larger is not.

     Code points is the definition that makes them agree, and it is the one
     that means something: a limit on how much identifier a person may supply.
     Code units are an artefact of how JavaScript happens to hold a string, and
     nothing else in this system counts in them. PostgreSQL needed no change.

     Not a loosening of any real bound. The three strong formats are ASCII-only
     and cap at 128; every weak type is canonicalized to ASCII by its own
     normalizer. A non-ASCII value can only reach this length check through a
     context type, and 256 code points is at most 1024 UTF-8 bytes — an order
     of magnitude under the btree entry ceiling the bound exists to respect.

     One remaining representational gap, recorded rather than papered over: an
     unpaired surrogate is one code point to JavaScript and is not storable in a
     UTF-8 database at all. It fails closed at the boundary — PostgreSQL rejects
     it while parsing the request body — rather than being silently accepted.
     Adding a JavaScript rule for it would be a second definition of validity
     with nothing on the other side to mirror it. */
  const identifierLength = value => [...value].length;

  const IDENTIFIER_FORMATS = {
    gbp_place_id: /^[A-Za-z0-9_\-]{6,128}$/,
    external_customer_id: /^[A-Za-z0-9_\-:.]{4,128}$/,
    payment_customer_id: /^[A-Za-z0-9_\-]{4,128}$/
  };

  const isAcceptableValue = (type, value) => {
    if (typeof value !== 'string') return false;
    const length = identifierLength(value);
    if (length === 0 || length > MAX_IDENTIFIER_LENGTH) return false;
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

  /* ============================================================
     Rule B0 — a PROPOSAL is not a decision
     ------------------------------------------------------------
     Two things can propose a Business Record before any identifier is
     looked at, and NEITHER is evidence about the business:

       · a continuation context — a bearer credential this server signed,
         which proves that *this browser recently finished a review that
         resolved to this record*
       · an assessment session id — a client-supplied journey identifier,
         which proves that *a previous submission carrying this same string
         resolved to this record*

     Both are statements about a BROWSER. Neither is a statement about the
     business now being described.

     It is not a hypothetical, and v4 fixed only half of it. A visitor
     finishes a review for Salon A and hands the laptop to a friend, who
     fills in a review for Salon B. v4 stopped the token from attaching
     Salon B to Salon A. The session id did it anyway: same journey
     identifier, no token needed, `linkMethod: "session"`, and Salon B's
     name, email and report filed permanently under Salon A — in tables that
     refuse UPDATE and refuse DELETE.

     So every proposal is compared against what the record already holds:

       agree(T)      the submission and the record share a value of type T
       contradict(T) both have values of type T and none of them match

     A contradiction is MATERIAL when the business name contradicts, AND at
     least one piece of contact evidence contradicts, AND nothing agrees.
     All three, because each on its own is something ordinary:

       · a name change alone is a rebrand
       · an email change alone is a new address
       · one agreement anywhere is continuity — a rebranded salon whose owner
         also switched provider still shares a phone, a domain, or a place id

     Only the combination — a different name, different contact details, and
     nothing whatsoever in common — says "this is somebody else".

     The rule is deliberately hard to trigger, because the cost of a false
     positive is a queued review and the cost of a false negative is a
     permanent, unerasable cross-business contamination.

     `heldIdentifiers` is [{ type, normalizedValue }] — the ACTIVE
     identifiers of the proposed Business Record, valid_to is null.

     ONE definition, used by the browser and by tests/helpers/fake-db.mjs,
     and deliberately mirrored in migration 0006 (`ingest_review`, rule B0).
     tests/identity-proposals.test.mjs runs one case table through all
     three. */

  /* Contact evidence: how to reach the business, as opposed to what it is
     called. Strong types are included because a contradicting place id is
     the strongest possible statement that this is a different business. */
  const CONTACT_EVIDENCE_TYPES = [
    'email_exact', 'email_domain', 'website_domain', 'business_phone', 'mobile_phone',
    'gbp_place_id', 'external_customer_id', 'payment_customer_id'
  ];

  /* ============================================================
     ONE position-safe walk, for every decision-bearing list
     ------------------------------------------------------------
     `forEach`, `map`, `filter`, `some`, `every` and `reduce` SKIP holes —
     they never invoke the callback for a position that was declared but not
     filled. `for…of` does not skip: it goes through the iterator, which
     yields `undefined` for a hole. Both behaviours are wrong for validation,
     the first because nothing is checked and the second because `undefined`
     is checked in place of the entry the caller meant to supply.

     So validation indexes, and asks each position whether it is actually
     present. A hole is not an absent element; it is a position the caller
     declared and did not fill, which makes the array malformed.

     Used by every list this module reads — the outer `candidates` and
     `proposals`, and the nested `signals`, `heldIdentifiers`, `matchedTypes`,
     `verifiedStrongTypes` and `claimedStrongTypes`. One walker, so no list
     can be protected while the one inside it is not. */
  const walkPositions = (list, inspect, label = 'array') => {
    /* Refused here, not only by each caller. A plain object has no `length`,
       so the loop below simply never ran and the walk reported success on
       whatever it was handed — `assertEvidenceList({})` returned the object.
       A validator with a shape that skips it is not a validator. */
    if (!Array.isArray(list)) {
      throw new TypeError(`${label} must be an array.`);
    }
    for (let index = 0; index < list.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(list, index)) {
        throw new TypeError(
          `${label}: position ${index} of ${list.length} is a hole — a declared ` +
          'position with nothing in it. Array iteration either skips holes or ' +
          'reads them as undefined, so a sparse array would be validated ' +
          'without being read. Supply a dense array.');
      }
      const fault = inspect(list[index], index);
      if (fault) throw new TypeError(fault);
    }
    return list;
  };

  /* An evidence entry — one side of one comparison. Used for the submitted
     `signals` and for a record's `heldIdentifiers`, which are the same shape
     and carry the same weight: each is half of a statement about whether two
     records are the same business.

     A malformed entry used to be silently dropped by `valuesByType`, which
     turned `heldIdentifiers: [null]` into `heldIdentifiers: []` — "this
     record holds nothing comparable" — and linked. */

  /* Which normalizer produced — and therefore recognises — a canonical value
     of each type. Every one of these already exists above; this maps types to
     them rather than introducing a rule, a length, or a format of its own.

     `email_domain` is the one that needs saying out loud. Its producer is
     `emailDomain`, which takes a whole address; the VALUE it produces is a
     bare registrable domain that is not free mail. Recognising such a value
     therefore means `normalizeDomain` plus the existing FREE_MAIL set — the
     same two rules `emailDomain` is built from, applied to its output.

     Types with no normalizer — the three strong ones, and the two context
     ones — are governed by `isAcceptableValue` alone, which is where their
     formats already live. */
  const VALUE_CANONICALIZERS = {
    email_exact:    normalizeEmail,
    email_domain:   value => (FREE_MAIL.has(value) ? null : normalizeDomain(value)),
    website_domain: normalizeDomain,
    business_phone: normalizePhone,
    mobile_phone:   normalizePhone,
    business_name:  normalizeName
  };

  /* An evidence entry — one side of one comparison. Used for the submitted
     `signals` and for a record's `heldIdentifiers`, which are the same shape
     and carry the same weight: each is half of a statement about whether two
     records are the same business.

     A malformed entry used to be silently dropped by `valuesByType`, which
     turned `heldIdentifiers: [null]` into `heldIdentifiers: []` — "this
     record holds nothing comparable" — and linked.

     THE VALUE MATTERS AS MUCH AS THE TYPE, and that is what this last round
     was about. A recognized type with a nonblank string was accepted, so
     `gbp_place_id: "x"` — which `isAcceptableValue` has always refused —
     appeared on both sides, counted as AGREEMENT, and neutralised a genuine
     name-and-email contradiction. Two records that share nothing but an
     impossible identifier linked at confidence 1.

     Agreement is the dangerous direction. A contradiction only ever sends a
     submission to review; an agreement is what lets one link. So evidence
     that could not have been produced by this platform is refused rather than
     compared: it cannot be a real match, and treating it as one is how
     nonsense becomes continuity. */
  const IDENTIFIER_TYPE_NAMES = Object.keys(IDENTIFIER_TYPES);

  const evidenceFault = label => (entry, index) => {
    const at = `${label}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `${at} must be an object with a type and a normalizedValue.`;
    }
    if (!IDENTIFIER_TYPE_NAMES.includes(entry.type)) {
      return `${at}.type must be a recognized identifier type. ` +
             `Permitted: ${IDENTIFIER_TYPE_NAMES.join(', ')}.`;
    }
    if (typeof entry.normalizedValue !== 'string' || entry.normalizedValue.trim() === '') {
      /* The VALUE is never echoed in any message below: an error travels into
         logs and review queues, and this one is about contact data. */
      return `${at}.normalizedValue must be a non-empty normalized string.`;
    }
    /* The module's own value contract — length and, for the strong types,
       format. Not a new rule: the same predicate the signal builder applies
       before it will emit a signal at all. */
    if (!isAcceptableValue(entry.type, entry.normalizedValue)) {
      return `${at}.normalizedValue is not an acceptable ${entry.type} value ` +
             `(see isAcceptableValue: length 1..${MAX_IDENTIFIER_LENGTH}` +
             `${IDENTIFIER_FORMATS[entry.type] ? ', and the format for this type' : ''}).`;
    }
    /* And genuinely canonical, where a normalizer exists to say so. A value
       that does not survive its own normalizer is not the value this platform
       stores, so it can never legitimately match one that is. */
    const canonicalize = VALUE_CANONICALIZERS[entry.type];
    if (canonicalize && canonicalize(entry.normalizedValue) !== entry.normalizedValue) {
      return `${at}.normalizedValue is not canonical for ${entry.type}. ` +
             'Normalize it with the shared normalizer before comparing.';
    }
    return null;
  };

  /* MODULE-PRIVATE. Exported only for tests would be the wrong reason to
     export anything, and an exported list validator that could be handed a
     non-array is a validator with its own bypass — `assertEvidenceList({})`
     returned the object, because a plain object has no `length` and the walk
     never ran. `walkPositions` now refuses a non-array itself, and these two
     stay internal to the module that uses them. */
  const assertEvidenceList = (list, label) =>
    walkPositions(list, evidenceFault(label), label);

  /* A list of identifier TYPE names — `matchedTypes` and the two strong-type
     arrays on a candidate. `vocabulary` is the established one in both cases;
     no second list is introduced. */
  const typeListFault = (label, vocabulary) => (entry, index) => {
    if (typeof entry !== 'string' || !vocabulary.includes(entry)) {
      return `${label}[${index}] must be one of ${vocabulary.join(', ')}.`;
    }
    return null;
  };

  const assertTypeList = (list, label, vocabulary) =>
    walkPositions(list, typeListFault(label, vocabulary), label);

  /* Both sides of the comparison, already validated by assertEvidenceList.

     The guard that used to sit here — `if (!entry || !entry.type ||
     !entry.normalizedValue) return;` — silently dropped anything it could not
     read, which is the same fail-open as every other default this module has
     had to remove: a malformed entry became an absent one, an absent one
     became "nothing to compare", and nothing to compare links.

     The only skip left is CONTEXT_TYPES, and that is a RULE rather than a
     tolerance: `vertical` and `locality` narrow a search and are never
     evidence that two records are the same business.

     COMPARISON IS EXACT. There was a `.toLowerCase()` here, and for the three
     opaque strong identifiers it was unsafe: `gbp_place_id` `Abcdef` and
     `abcdef` are two different places, and case-folding them reported
     agreement, which outranks any number of contradictions and produced a
     confidence-1 link — with contradictory names and emails on both records.

     Nothing else in the system treats them as case-insensitive. Their formats
     permit both cases, no canonicalizer touches their case, candidate lookup
     uses `=`, and the unique indexes on (identifier_type, normalized_value)
     store them as distinct values. Lowercasing here was the only place that
     disagreed, and this is a comparison — the one place where disagreeing
     merges two businesses.

     Case-insensitivity is NOT reintroduced for weak types either, because it
     is not needed and a second rule would be a second thing to keep in step.
     Every comparable non-strong type has a canonicalizer that already
     lowercases (normalizeEmail, normalizeDomain, normalizeName) or produces
     digits (normalizePhone), and since v12 `evidenceFault` refuses any value
     its own canonicalizer would have changed. So a weak value that reaches
     here is already lower case, and exact comparison gives the identical
     answer it gave before. `identity-and-bir.test.mjs` pins that coverage
     against IDENTIFIER_TYPES so a new weak type cannot be added without one. */
  const valuesByType = list => {
    const map = new Map();
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (CONTEXT_TYPES.includes(entry.type)) continue;
      if (!map.has(entry.type)) map.set(entry.type, new Set());
      map.get(entry.type).add(entry.normalizedValue);
    }
    return map;
  };

  /* NEITHER SIDE HAS A DEFAULT, and that is the whole point.

     This function is a comparison, and a comparison with nothing on either
     side always answers "no contradiction" — which is the answer that links.
     Every revision so far moved the same default one layer outwards instead
     of removing it: `decideIdentity` linked on a bare session id, then it
     validated its input and wrote `heldIdentifiers || []` when calling this,
     then this function's parameter default did the same job, and when
     `heldIdentifiers` was finally fixed, `signals = []` was still sitting
     beside it doing the identical thing from the other direction.

     `proposalConflict({ heldIdentifiers })` returned `material: false` and
     linked with confidence 1. Same defect, other operand.

     So both operands are required here, at the primitive. An absent property,
     `null`, or a non-array throws. An explicit `[]` is valid on either side
     and means "there is genuinely nothing here" — a statement the caller
     makes, never one this file infers from an omission. */
  const assertOperand = (value, name) => {
    if (value === undefined || value === null) {
      throw new TypeError(
        `proposalConflict requires ${name}. Pass [] only when there is genuinely ` +
        'nothing on that side; omitting it would make "I did not supply the ' +
        'evidence" indistinguishable from "there is nothing to compare", and the ' +
        'second one links.');
    }
    if (!Array.isArray(value)) {
      throw new TypeError(`proposalConflict requires ${name} to be an array.`);
    }
    return value;
  };

  const proposalConflict = ({ signals, heldIdentifiers } = {}) => {
    const submitted = valuesByType(
      assertEvidenceList(assertOperand(signals, 'signals'), 'signals'));
    const held = valuesByType(
      assertEvidenceList(assertOperand(heldIdentifiers, 'heldIdentifiers'), 'heldIdentifiers'));

    const agreed = [];
    const contradicted = [];

    submitted.forEach((values, type) => {
      const heldValues = held.get(type);
      if (!heldValues || heldValues.size === 0) return;      /* nothing to compare */
      const shares = [...values].some(v => heldValues.has(v));
      if (shares) agreed.push(type);
      else contradicted.push(type);
    });

    const nameContradicts = contradicted.includes('business_name');
    const contactContradicts = contradicted.filter(t => CONTACT_EVIDENCE_TYPES.includes(t));
    const nothingAgrees = agreed.length === 0;

    const material = nameContradicts && contactContradicts.length > 0 && nothingAgrees;

    return {
      material,
      agreedTypes: agreed.sort(),
      contradictedTypes: contradicted.sort(),
      /* Why, in a form a reviewer can read years later without the values. */
      reason: material
        ? 'The submitted business name and contact evidence match nothing this record holds.'
        : nothingAgrees && (nameContradicts || contactContradicts.length)
          ? 'Some evidence differs, but not enough to say this is another business.'
          : agreed.length
            ? 'The submission shares identifying evidence with this record.'
            : 'There is nothing comparable between the submission and this record.'
    };
  };

  /* ============================================================
     Rule B0b — two proposals, one submission
     ------------------------------------------------------------
     A continuation context and a session id can each name a record, and they
     can name different ones. Choosing silently is how the previous version
     produced a submission attached to one record while the assessment
     session row still pointed at another — permanently, because
     `assessment_sessions.business_id` is written once and never rewritten.

     So the outcome is decided from the whole picture rather than by trying
     one proposal and falling back to the next:

       both propose the same record, no contradiction   -> link
       exactly one proposal, no contradiction           -> link
       any proposal materially contradicted             -> review
       two surviving proposals naming different records -> review

     "Any proposal contradicted -> review" is stricter than it strictly needs
     to be in one case: a consistent session alongside a contradicted token
     could arguably link by session. It does not, because the alternative is
     a rule with an exception in it, and a rule with an exception is a rule
     somebody will get wrong later. A queued review costs a person five
     minutes; the other kind of mistake cannot be undone.

     Review here means the CALLER stops proposing and resolves on the
     submission's own evidence, forbidden to create. It does not mean the
     submission is refused: the visitor still gets their results.

     `proposals` is [{ kind, businessId, conflict }] where `conflict` is a
     proposalConflict verdict and `kind` is 'continuation_context' or
     'session'. Only live, unmerged records should be passed in — a proposal
     naming a record that no longer exists is not a proposal.

     Mirrored in migration 0006. The same case table covers both. */

  const PROPOSAL_KINDS = ['continuation_context', 'session'];

  /* The platform's Business Record id, in the one form it ever takes. Same
     expression as api/assessments.mjs and shared/service-mix-engine/
     offering.schema.js :: isUuid; a test asserts the three agree. */
  const BUSINESS_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isBusinessId = value =>
    typeof value === 'string' && BUSINESS_ID_RE.test(value);

  /* A POSTCONDITION, not an input check.

     Every input path already validates its business ids, so this can only
     fire if a future change lets one through — which is exactly what happened
     with the sparse-array hole, where `undefined` reached the link branch
     through `map` and `new Set` rather than through any input. A link is the
     one outcome that cannot be undone later, so it is worth asserting the
     thing that must be true at the moment it is decided rather than trusting
     that everything upstream stayed correct.

     Uses `isBusinessId`. No second definition. */
  const assertLinkTarget = (businessId, where) => {
    if (!isBusinessId(businessId)) {
      throw new TypeError(
        `${where} produced a link to ${JSON.stringify(businessId)}, which is not a ` +
        'Business Record id. A link must always carry a UUID; refusing rather ' +
        'than returning one nothing downstream could resolve.');
    }
    return businessId;
  };

  /* ---------- the proposal contract, enforced ----------

     Every rule above is a comparison, and a comparison with nothing to
     compare against always says "no contradiction". So the dangerous input is
     not a malformed proposal — it is an INCOMPLETE one, which looks exactly
     like a record that genuinely holds no comparable identifiers and links
     with confidence 1.

     The previous revision refused the legacy `sessionBusinessId` argument for
     precisely this reason, and then wrote `heldIdentifiers: p.heldIdentifiers
     || []` two lines further down — reintroducing by default what the
     exception existed to prevent. A caller who never looked the identifiers
     up got a confidence-1 link.

     So: a proposal must CARRY its evidence, and the difference between "this
     record holds nothing comparable" and "I did not look" must be something
     the caller states rather than something this file guesses. An explicit
     empty array is valid and means the first. An absent property, null, or a
     non-array throws.

     Filtering malformed proposals out and continuing would be the same
     mistake in a different shape: the caller would get "no proposal was
     supplied", which is a link-permitting answer, for input that was actually
     broken.

     A proposal is checked twice, in two different shapes. Before it is
     judged it must carry the EVIDENCE (`heldIdentifiers`); after it is judged
     it must carry the VERDICT (`conflict`). Neither shape is allowed to be
     partially specified, and neither check is a second definition of the
     conflict rule — both are structural. */

  const proposalFault = (proposal, index, { requireEvidence, requireVerdict }) => {
    const at = `proposals[${index}]`;
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
      return `${at} must be an object.`;
    }
    if (!PROPOSAL_KINDS.includes(proposal.kind)) {
      return `${at}.kind must be one of ${PROPOSAL_KINDS.join(', ')}.`;
    }
    if (!isBusinessId(proposal.businessId)) {
      /* A Business Record id is a UUID everywhere else in this platform —
         `business_records.business_id` is `uuid`, the endpoint validates the
         same shape, and PostgreSQL would refuse anything else. Accepting "any
         non-empty string" here let a caller link to `"not-a-uuid"` with
         confidence 1 and be told it had succeeded, when the write would have
         failed at the database or, worse, matched nothing and created a
         second record. */
      return `${at}.businessId must be a UUID.`;
    }
    if (requireEvidence) {
      if (!Object.prototype.hasOwnProperty.call(proposal, 'heldIdentifiers')) {
        return `${at} must carry heldIdentifiers — the ACTIVE identifiers of the ` +
               'record it names. Pass [] only when that record genuinely holds none; ' +
               'omitting it would make "I did not look" indistinguishable from ' +
               '"there is nothing to compare", and the second one links.';
      }
      if (!Array.isArray(proposal.heldIdentifiers)) {
        return `${at}.heldIdentifiers must be an array.`;
      }
      /* Every ENTRY, not merely the container. Confirming the array existed
         and stopping there let `assertProposals([{ …, heldIdentifiers: [null] }])`
         return the malformed proposal as though it had been checked — and a
         caller who validated first and acted on the result would then act on
         evidence nobody had read. Throws rather than returning a fault
         string, which is why it sits at the end. */
      assertEvidenceList(proposal.heldIdentifiers, `${at}.heldIdentifiers`);
    }
    if (requireVerdict &&
        (!proposal.conflict || typeof proposal.conflict !== 'object' ||
         typeof proposal.conflict.material !== 'boolean')) {
      /* A proposal that was never judged is not an uncontradicted one. The
         filter that used to read `p.conflict && p.conflict.material === true`
         treated an absent verdict as "survives", which is the link-permitting
         answer for a comparison nobody performed. */
      return `${at}.conflict must be a proposalConflict verdict with a boolean ` +
             '`material`. An unjudged proposal is not an uncontradicted one.';
    }
    return null;
  };

  /* ---------- the candidate contract ----------

     Candidates arrive from a database lookup rather than from a browser, and
     that is exactly why they were left unchecked: a row from our own query is
     easy to assume is well formed. It is an assumption, and it failed in the
     same two directions the proposal contract already failed in.

       · A candidate with `businessId: "not-a-uuid"` and a verified strong
         type LINKED, returning that string as the Business Record id with
         confidence 0.95. Nothing downstream would have found that record.
       · Malformed candidates — `null`, `{}`, no `businessId` — were silently
         filtered out, and a list that filtered down to empty reads as
         "nothing matched", which CREATES a second permanent record for a
         business that may already exist.

     Both are worse than an exception. A broken lookup should stop the
     decision, not quietly become one of its two most consequential outcomes.

     The evidence arrays are required rather than defaulted, for reasons that
     differ per field and are worth stating:

       · `verifiedStrongTypes` absent → treated as "not verified" → a genuine
         unique match is downgraded to a review, or a two-verified-candidate
         duplicate is recorded as a weak `probable_match` instead of
         `possible_duplicate`.
       · `claimedStrongTypes` absent → `manual_review_required` becomes
         `probable_match`, understating what a reviewer is looking at.
       · `matchedTypes` absent → a candidate that matched nothing is not a
         candidate at all.

     Uses the same `isBusinessId` as the proposal contract. One UUID
     definition, one identity rule. */
  const candidateFault = (candidate, index) => {
    const at = `candidates[${index}]`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return `${at} must be an object.`;
    }
    if (!isBusinessId(candidate.businessId)) {
      return `${at}.businessId must be a UUID.`;
    }
    const arrays = ['matchedTypes', 'verifiedStrongTypes', 'claimedStrongTypes'];
    for (const field of arrays) {
      if (!Object.prototype.hasOwnProperty.call(candidate, field)) {
        return `${at} must carry ${field}. A lookup that produced a candidate ` +
               'produced all three; defaulting an absent one silently changes ' +
               'which branch the decision takes.';
      }
      if (!Array.isArray(candidate[field])) {
        return `${at}.${field} must be an array.`;
      }
    }

    /* Each array dense, and every entry a recognized type. A hole in
       `matchedTypes` used to put `undefined` into `contributingSignals`; a
       hole in either strong array silently changed the review
       classification. `matchedTypes` may name any identifier type; the strong
       arrays are restricted to the established strong vocabulary, because a
       lookup calling `email_exact` a strong type has misread the schema. */
    assertTypeList(candidate.matchedTypes, `${at}.matchedTypes`, IDENTIFIER_TYPE_NAMES);
    assertTypeList(candidate.verifiedStrongTypes, `${at}.verifiedStrongTypes`, STRONG_TYPES);
    assertTypeList(candidate.claimedStrongTypes, `${at}.claimedStrongTypes`, STRONG_TYPES);

    /* A strong type the candidate did not match is a lookup contradicting
       itself, and the combination is the dangerous one: `matchedTypes: []`
       with `verifiedStrongTypes: ['gbp_place_id']` auto-linked at 0.95 while
       reporting that it had matched nothing. */
    const unmatched = field => candidate[field]
      .filter(type => !candidate.matchedTypes.includes(type));
    for (const field of ['verifiedStrongTypes', 'claimedStrongTypes']) {
      const missing = unmatched(field);
      if (missing.length) {
        return `${at}.${field} names ${missing.join(', ')}, which ${at}.matchedTypes ` +
               'does not contain. A candidate cannot be strong on evidence it did ' +
               'not match.';
      }
    }
    return null;
  };

  /* Throws on the first fault. Returns the list unchanged when every
     candidate is well formed. Validates SHAPE; it does not decide identity,
     and it does not exclude anything — `merged_away` is the caller's
     decision, made after this. */
  const assertCandidates = candidates => {
    if (candidates === undefined || candidates === null) return [];
    if (!Array.isArray(candidates)) {
      throw new TypeError('candidates must be an array.');
    }
    return walkPositions(candidates, candidateFault, 'candidates');
  };

  /* Throws on the first fault. Returns the list unchanged when every proposal
     is well formed. Validates SHAPE; it does not decide identity. */
  const assertProposals = (proposals, { requireEvidence = true, requireVerdict = false } = {}) => {
    if (proposals === undefined || proposals === null) return [];
    if (!Array.isArray(proposals)) {
      throw new TypeError('proposals must be an array.');
    }
    return walkPositions(proposals, (proposal, index) =>
      proposalFault(proposal, index, { requireEvidence, requireVerdict }), 'proposals');
  };

  /* MODULE-PRIVATE, and not exported.

     It takes verdicts rather than evidence, so on its own it cannot tell a
     verdict that was computed from real identifiers from one a caller made
     up. While it WAS exported — under the name `resolveProposals` — it
     composed with a then-permissive `proposalConflict` into exactly the
     evidence-free link the whole rule exists to prevent (historical):

         proposalConflict({ signals })                      -> material: false
         resolveProposals([{ kind, businessId, conflict }]) -> link

     Two functions, each defensible alone, wrong together. The public surface
     is `resolveIdentityProposals`, which takes the EVIDENCE and does both
     steps itself, so there is no seam to compose through. */
  const resolveJudgedProposals = (proposals = []) => {
    /* Judged proposals: the evidence has already been consumed into a
       verdict, so this shape carries the verdict and not the identifiers. */
    const usable = assertProposals(proposals,
      { requireEvidence: false, requireVerdict: true });

    const vetoed = usable.filter(p => p.conflict.material === true);
    const surviving = usable.filter(p => p.conflict.material !== true);
    const distinct = [...new Set(surviving.map(p => p.businessId))];

    if (!usable.length) {
      return { outcome: 'no_proposal', businessId: null, linkMethod: null,
               vetoedKinds: [], disagreed: false, mayCreate: true };
    }

    if (vetoed.length) {
      return {
        outcome: 'review',
        businessId: null,
        linkMethod: null,
        vetoedKinds: vetoed.map(p => p.kind).sort(),
        disagreed: distinct.length > 1,
        /* The only evidence that this is a new business is the evidence that
           just contradicted a saved proposal. Creating on it would turn a
           suspicious submission into a permanent record nobody reviewed. */
        mayCreate: false
      };
    }

    if (distinct.length > 1) {
      return { outcome: 'review', businessId: null, linkMethod: null,
               vetoedKinds: [], disagreed: true, mayCreate: false };
    }

    /* One record, proposed by one or both. A continuation context is named as
       the link method when it is among them: it is the stronger statement,
       being signed by this server rather than echoed by the client. */
    const byContext = surviving.some(p => p.kind === 'continuation_context');
    return {
      outcome: 'link',
      businessId: assertLinkTarget(distinct[0], 'resolveJudgedProposals'),
      linkMethod: byContext ? 'continuation_context' : 'session',
      vetoedKinds: [],
      disagreed: false,
      mayCreate: true
    };
  };

  /* ============================================================
     THE public entry point for rules B0 and B0b
     ------------------------------------------------------------
     One operation: validate the proposals, compare each against the evidence
     it carries, and resolve the pair. There is no exported way to perform
     half of it, because half of it is where every regression has lived — a
     validated caller in front of a permissive primitive, or a comparison and
     a resolver that were each safe alone.

       signals    — the submission's identity signals
       proposals  — [{ kind, businessId, heldIdentifiers }], each carrying the
                    ACTIVE identifiers of the record it names

     Returns the B0b verdict plus `judged`, the per-proposal conflict results,
     so a caller can record WHICH proposal was set aside and on which
     identifier types without re-running the comparison.

     Callers: decideIdentity below, tests/helpers/fake-db.mjs, and
     tests/identity-proposals.test.mjs. migration 0006 mirrors it in SQL. */
  const resolveIdentityProposals = ({ signals, proposals = [] } = {}) => {
    const validated = assertProposals(proposals);

    /* `signals` is NOT defaulted here either. With no proposals there is
       nothing to compare against and the question does not arise; with one or
       more, the submitted side of every comparison is required, and
       proposalConflict refuses an absent one. Passing `signals` straight
       through is what makes that refusal reach the caller. */
    const judged = validated.map(p => ({
      kind: p.kind,
      businessId: p.businessId,
      /* Both operands passed through, never defaulted. assertProposals has
         already refused a proposal that did not carry its evidence. */
      conflict: proposalConflict({ signals, heldIdentifiers: p.heldIdentifiers })
    }));

    return { ...resolveJudgedProposals(judged), judged };
  };

  /* candidates: [{ businessId, matchedTypes, verifiedStrongTypes, claimedStrongTypes, recordStatus }]
     Assembled by the caller from an exact-match lookup on normalized values.
     `verifiedStrongTypes` is the only field that can produce an automatic link.

     proposals: [{ kind, businessId, heldIdentifiers }] — the saved pointers a
     submission arrived with, each carrying the ACTIVE identifiers of the
     record it names. Evaluated through resolveIdentityProposals, which is
     called rather than restated: there is one definition of rule B0, and this
     function is not allowed to be a second one.

     `sessionBusinessId` used to be accepted here and linked unconditionally.
     It is now refused outright, and the refusal is deliberate — see below. */

  /* Refusing loudly, rather than ignoring the old argument, because the two
     failure modes are not equally bad.

     A session proposal with no `heldIdentifiers` is indistinguishable from a
     record that genuinely holds none, and a record holding nothing comparable
     cannot contradict anything — so it links. That is correct for a redacted
     record and catastrophic for a caller who simply forgot to look the
     identifiers up: it is the exact defect this rule exists to prevent,
     reintroduced by an omission nobody would notice.

     So the only safe way to say "you must supply what the record holds" is to
     make skipping it impossible rather than merely discouraged. */
  const LEGACY_SESSION_ARGUMENT =
    'decideIdentity no longer accepts sessionBusinessId. A saved session is a ' +
    'PROPOSAL, not a decision: pass it as ' +
    'proposals: [{ kind: "session", businessId, heldIdentifiers }] so it can be ' +
    'compared with what that record actually holds. See rule B0.';

  const decideIdentity = (input = {}) => {
    /* `signals` is deliberately NOT defaulted. Candidate-only resolution never
       compares signals against a proposed record, so it keeps working without
       them; the moment a proposal exists, proposalConflict requires the
       submitted side and refuses an absent one. Defaulting here would have
       swallowed that refusal — which is precisely how `signals = []` survived
       three rounds of hardening on the other operand. */
    const { candidates = [], signals, proposals = [] } = input;

    if (Object.prototype.hasOwnProperty.call(input, 'sessionBusinessId')) {
      throw new TypeError(LEGACY_SESSION_ARGUMENT);
    }

    const contributing = [];
    const conflicting = [];

    /* Validated, then filtered — in that order, and never the other way.

       `merged_away` is the one exclusion this function makes, and it is a
       decision about a well-formed candidate. Everything else that used to be
       dropped here was malformed INPUT, and dropping it turned a broken
       database lookup into an answer: with every candidate silently removed,
       `usable.length === 0` reads as "nothing matched" and creates a second
       permanent record for a business that may already exist. */
    const usable = assertCandidates(candidates)
      .filter(c => c.recordStatus !== 'merged_away')
      .map(c => ({
        businessId: c.businessId,
        matchedTypes: c.matchedTypes,
        /* Narrowed to the strong vocabulary. A caller naming a weak type here
           is describing something that cannot auto-link, and saying so
           changes no outcome — unlike an absent array, which does. */
        verifiedStrongTypes: c.verifiedStrongTypes.filter(t => STRONG_TYPES.includes(t)),
        claimedStrongTypes: c.claimedStrongTypes.filter(t => STRONG_TYPES.includes(t))
      }));

    /* Rules B0 and B0b — every saved pointer is compared with the record it
       names before any of them is honoured. One call, so this function cannot
       perform half the rule any more than an external caller can. */
    const verdict = resolveIdentityProposals({ signals, proposals });
    const judged = verdict.judged;
    const vetoed = judged.filter(p => p.conflict.material);

    if (verdict.outcome === 'link') {
      return {
        action: 'link_to_existing',
        businessId: assertLinkTarget(verdict.businessId, 'decideIdentity (proposal link)'),
        identityStatus: 'linked',
        resolutionStatus: 'unique_match',
        confidence: 1,
        contributingSignals: [verdict.linkMethod === 'continuation_context'
          ? 'server_issued_continuation_context' : 'assessment_session_link'],
        conflictingSignals: [],
        candidateBusinessIds: [verdict.businessId],
        linkMethod: verdict.linkMethod,
        rationale: verdict.linkMethod === 'continuation_context'
          ? 'A server-issued continuation context named this record, and nothing in the submission contradicts it.'
          : 'This assessment session already resolved to this record, and nothing in the submission contradicts it.'
      };
    }

    if (verdict.outcome === 'review') {
      return {
        action: 'queue_for_review',
        businessId: null,
        identityStatus: 'resolution_pending',
        resolutionStatus: 'manual_review_required',
        confidence: 0,
        contributingSignals: [],
        conflictingSignals: vetoed.map(p => ({
          businessId: p.businessId,
          kind: p.kind === 'session' ? 'session_contradicted' : 'continuation_context_contradicted',
          agreedTypes: p.conflict.agreedTypes,
          contradictedTypes: p.conflict.contradictedTypes
        })).concat(verdict.disagreed && !vetoed.length
          ? [{ kind: 'proposals_disagree',
               businessIds: judged.map(p => p.businessId) }]
          : []),
        candidateBusinessIds: judged.map(p => p.businessId),
        linkMethod: null,
        rationale: vetoed.length
          ? 'A saved proposal named a record the submitted identity contradicts.'
          : 'Two saved proposals name different Business Records.'
      };
    }

    /* Rule B4 — nothing to match against.

       Reached only with a VALIDATED, empty candidate list: assertCandidates
       has already refused a malformed one, so "nothing matched" now means
       what it says rather than "the lookup returned something this function
       could not read".

       No `mayCreate` guard is needed here: `mayCreate` is false only when
       resolveIdentityProposals returned `review`, and that returned above.
       Adding the condition anyway would create an unreachable fall-through
       into B5 with no candidates, which is a worse answer than the one it
       guards against. */
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
        businessId: assertLinkTarget(winner.businessId, 'decideIdentity (rule B3)'),
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
    CONTACT_EVIDENCE_TYPES,
    proposalConflict,
    PROPOSAL_KINDS,
    BUSINESS_ID_RE,
    isBusinessId,
    assertProposals,
    assertCandidates,
    IDENTIFIER_TYPE_NAMES,
    /* The ONE public way to resolve proposals. The verdict-only resolver is
       deliberately not exported: see resolveJudgedProposals. */
    resolveIdentityProposals,
    decideIdentity
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDResolveIdentity = API;
})();
