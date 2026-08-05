/* ============================================================
   CED Intelligence Platform — endpoint input limits
   ------------------------------------------------------------
   One place where every field-size and structural bound lives,
   so the endpoint, the tests, and the documentation cannot
   drift apart.

   Two separate jobs, deliberately not merged:

     · request-size enforcement  — bytes on the wire, handled by
       read-body.js before anything is parsed.
     · field-size enforcement    — this file, applied to the
       parsed object before any database work.

   The hard reason these exist: identity values reach btree
   indexes in Postgres, which reject an index entry larger than
   about 2704 bytes with an error that is NOT unique_violation
   and therefore aborts the whole ingestion transaction. Every
   value that can reach business_identifiers is capped far below
   that ceiling.

   Identity values are never silently truncated. A value over the
   limit is rejected, because a truncated identifier is a wrong
   identifier, and a wrong identifier links the wrong business.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* Anything that can reach an indexed column stays well under the btree
     entry ceiling. The rest are sized for what a real answer looks like. */
  const LIMITS = {
    /* identity-bearing: never truncated, always rejected when over */
    businessName: 160,
    ownerName: 120,
    email: 254,            /* RFC 5321 maximum path length */
    mobile: 32,
    website: 253,          /* maximum DNS name length */
    gbpPlaceId: 128,
    externalCustomerId: 128,
    identifierValue: 256,  /* hard ceiling for any normalized identifier */

    /* attribution */
    url: 2048,
    referrer: 2048,
    utmName: 64,
    utmValue: 256,
    utmCount: 24,

    /* assessment content */
    answerKey: 64,
    answerValue: 2000,
    answerCount: 200,          /* the intelligence expansion roughly doubled the inventory */
    /* Free-text intelligence answers. Bounded well below answerValue because
       these are "in your own words" boxes, not essays, and every one of them
       reaches the report as evidence a human will read. */
    freeTextAnswer: 300,
    consentStatement: 2000,
    recommendationCopy: 600,
    priorityText: 600,
    priorityCount: 10,
    disclaimer: 2000,

    /* structural — deliberately looser than the field-specific bounds above.
       These are the outer sanity rails that keep traversal safe; the field
       checks are what produce the precise category a caller can act on. A
       structural bound set equal to a field bound would mask it. */
    maxDepth: 12,
    maxArrayLength: 100,
    maxNodes: 2000,
    maxKeyLength: 128,
    maxStringAnywhere: 4096
  };

  /* Categories are stable identifiers. Tests and the API documentation
     reference them; do not rename one without updating both. */
  const CATEGORY = {
    businessName: 'business_name',
    ownerName: 'owner_name',
    email: 'email',
    mobile: 'mobile',
    website: 'website',
    gbpPlaceId: 'gbp_place_id',
    externalCustomerId: 'external_customer_id',
    url: 'url',
    referrer: 'referrer',
    utmName: 'utm_name',
    utmValue: 'utm_value',
    utmCount: 'utm_count',
    answerKey: 'answer_key',
    answerValue: 'answer_value',
    answerCount: 'answer_count',
    freeTextAnswer: 'free_text_answer',
    consentStatement: 'consent_statement',
    recommendationCopy: 'recommendation_copy',
    priorityText: 'priority_text',
    priorityCount: 'priority_count',
    disclaimer: 'disclaimer',
    depth: 'nesting_depth',
    arrayLength: 'array_length',
    nodes: 'total_nodes',
    keyLength: 'key_length',
    stringLength: 'string_length'
  };

  /* Identifier formats. Deliberately conservative: anything that does not
     match is refused rather than normalized into a guess. */
  const FORMATS = {
    /* Google place ids are opaque, but they are URL-safe and bounded. */
    gbp_place_id: /^[A-Za-z0-9_\-]{6,128}$/,
    external_customer_id: /^[A-Za-z0-9_\-:.]{4,128}$/,
    payment_customer_id: /^[A-Za-z0-9_\-]{4,128}$/
  };

  /* "In your own words" answers from the intelligence expansion. Bounded
     tighter than a general answer because they are read by a person. */
  const FREE_TEXT_ANSWERS = ['changeReason', 'concernDetail', 'openQuestions'];

  const violation = (category, path, limit, actual) => ({ category, path, limit, actual });

  /* ---------- structural traversal ----------
     Bounded on three axes at once: how deep, how wide, and how many nodes
     in total. Depth is checked before recursing, so a hostile body cannot
     exhaust the stack on the way to being rejected. */
  const checkStructure = (root, out) => {
    let nodes = 0;

    const walk = (value, path, depth) => {
      if (out.length >= 20) return;                /* enough to diagnose */
      nodes++;
      if (nodes > LIMITS.maxNodes) {
        out.push(violation(CATEGORY.nodes, path, LIMITS.maxNodes, nodes));
        return;
      }
      if (depth > LIMITS.maxDepth) {
        out.push(violation(CATEGORY.depth, path, LIMITS.maxDepth, depth));
        return;                                    /* never recurse past the bound */
      }

      if (typeof value === 'string') {
        if (value.length > LIMITS.maxStringAnywhere) {
          out.push(violation(CATEGORY.stringLength, path, LIMITS.maxStringAnywhere, value.length));
        }
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > LIMITS.maxArrayLength) {
          out.push(violation(CATEGORY.arrayLength, path, LIMITS.maxArrayLength, value.length));
          return;
        }
        value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          if (key.length > LIMITS.maxKeyLength) {
            out.push(violation(CATEGORY.keyLength, path ? `${path}.${key.slice(0, 32)}…` : key.slice(0, 32),
              LIMITS.maxKeyLength, key.length));
            continue;
          }
          walk(value[key], path ? `${path}.${key}` : key, depth + 1);
        }
      }
    };

    walk(root, '', 0);
    return nodes;
  };

  /* ---------- field checks ---------- */
  const str = (obj, key) => (obj && typeof obj[key] === 'string') ? obj[key] : null;

  const checkLength = (out, value, category, path, limit) => {
    if (typeof value === 'string' && value.length > limit) {
      out.push(violation(category, path, limit, value.length));
    }
  };

  const checkFields = (payload, out) => {
    const contact = payload.contact || {};
    checkLength(out, str(contact, 'salonName'), CATEGORY.businessName, 'contact.salonName', LIMITS.businessName);
    checkLength(out, str(contact, 'businessName'), CATEGORY.businessName, 'contact.businessName', LIMITS.businessName);
    checkLength(out, str(contact, 'ownerName'), CATEGORY.ownerName, 'contact.ownerName', LIMITS.ownerName);
    checkLength(out, str(contact, 'email'), CATEGORY.email, 'contact.email', LIMITS.email);
    checkLength(out, str(contact, 'mobile'), CATEGORY.mobile, 'contact.mobile', LIMITS.mobile);
    checkLength(out, str(contact, 'website'), CATEGORY.website, 'contact.website', LIMITS.website);
    checkLength(out, str(contact, 'businessPhone'), CATEGORY.mobile, 'contact.businessPhone', LIMITS.mobile);
    checkLength(out, str(contact, 'googlePlaceId'), CATEGORY.gbpPlaceId, 'contact.googlePlaceId', LIMITS.gbpPlaceId);
    checkLength(out, str(contact, 'externalCustomerId'), CATEGORY.externalCustomerId,
      'contact.externalCustomerId', LIMITS.externalCustomerId);

    const attribution = payload.attribution || {};
    ['firstTouch', 'latestTouch'].forEach(which => {
      const touch = attribution[which];
      if (!touch || typeof touch !== 'object') return;
      checkLength(out, str(touch, 'url'), CATEGORY.url, `attribution.${which}.url`, LIMITS.url);
      checkLength(out, str(touch, 'referrer'), CATEGORY.referrer, `attribution.${which}.referrer`, LIMITS.referrer);
      const utm = touch.utm;
      if (utm && typeof utm === 'object' && !Array.isArray(utm)) {
        const keys = Object.keys(utm);
        if (keys.length > LIMITS.utmCount) {
          out.push(violation(CATEGORY.utmCount, `attribution.${which}.utm`, LIMITS.utmCount, keys.length));
        }
        keys.slice(0, LIMITS.utmCount).forEach(key => {
          if (key.length > LIMITS.utmName) {
            out.push(violation(CATEGORY.utmName, `attribution.${which}.utm.${key.slice(0, 24)}…`,
              LIMITS.utmName, key.length));
            return;
          }
          checkLength(out, typeof utm[key] === 'string' ? utm[key] : null,
            CATEGORY.utmValue, `attribution.${which}.utm.${key}`, LIMITS.utmValue);
        });
      }
    });

    const answers = payload.answers;
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      const keys = Object.keys(answers);
      if (keys.length > LIMITS.answerCount) {
        out.push(violation(CATEGORY.answerCount, 'answers', LIMITS.answerCount, keys.length));
      }
      keys.forEach(key => {
        if (key.length > LIMITS.answerKey) {
          out.push(violation(CATEGORY.answerKey, `answers.${key.slice(0, 24)}…`, LIMITS.answerKey, key.length));
          return;
        }
        const isFreeText = FREE_TEXT_ANSWERS.includes(key);
        checkLength(out, typeof answers[key] === 'string' ? answers[key] : null,
          isFreeText ? CATEGORY.freeTextAnswer : CATEGORY.answerValue,
          `answers.${key}`,
          isFreeText ? LIMITS.freeTextAnswer : LIMITS.answerValue);
      });
    }

    const consent = payload.consent;
    if (consent && typeof consent === 'object') {
      Object.keys(consent).forEach(key => {
        const record = consent[key];
        if (!record || typeof record !== 'object') return;
        checkLength(out, str(record, 'statement'), CATEGORY.consentStatement,
          `consent.${key}.statement`, LIMITS.consentStatement);
      });
    }

    const results = payload.results;
    if (results && typeof results === 'object') {
      checkLength(out, str(results, 'disclaimer'), CATEGORY.disclaimer, 'results.disclaimer', LIMITS.disclaimer);
      checkLength(out, str(results, 'opportunityFormatted'), CATEGORY.recommendationCopy,
        'results.opportunityFormatted', LIMITS.recommendationCopy);

      /* The range the visitor actually saw, and the assumptions printed beside
         it. Bounded like the disclaimer because it does the same job: it is
         the context without which the figure must never travel. */
      const range = results.opportunityRange;
      if (range && typeof range === 'object' && !Array.isArray(range)) {
        checkLength(out, str(range, 'formatted'), CATEGORY.recommendationCopy,
          'results.opportunityRange.formatted', LIMITS.recommendationCopy);
        checkLength(out, str(range, 'assumptions'), CATEGORY.disclaimer,
          'results.opportunityRange.assumptions', LIMITS.disclaimer);
      }

      const priorities = results.priorities;
      if (Array.isArray(priorities)) {
        if (priorities.length > LIMITS.priorityCount) {
          out.push(violation(CATEGORY.priorityCount, 'results.priorities', LIMITS.priorityCount, priorities.length));
        }
        priorities.slice(0, LIMITS.priorityCount).forEach((text, i) => {
          checkLength(out, typeof text === 'string' ? text : null,
            CATEGORY.priorityText, `results.priorities[${i}]`, LIMITS.priorityText);
        });
      }

      const pkg = results.recommendedPackage;
      if (pkg && typeof pkg === 'object') {
        ['id', 'label', 'reason', 'name', 'currency', 'interval'].forEach(key => {
          checkLength(out, str(pkg, key), CATEGORY.recommendationCopy,
            `results.recommendedPackage.${key}`, LIMITS.recommendationCopy);
        });
      }
    }
  };

  /* The single entry point. Returns [] when the payload is within every
     bound, otherwise a list of violations naming the category and path.
     Values are never echoed back — only lengths. */
  const checkPayloadLimits = payload => {
    const out = [];
    if (!payload || typeof payload !== 'object') return out;
    checkStructure(payload, out);
    /* A structurally hostile body is rejected on structure alone; walking its
       fields afterwards adds nothing and costs time. */
    if (out.length) return out;
    checkFields(payload, out);
    return out;
  };

  /* Identifier-specific gate, applied before a value is allowed to become
     identity evidence. Length AND format, because an identifier that is the
     right size but the wrong shape is still not an identifier. */
  const isAcceptableIdentifier = (type, value) => {
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > LIMITS.identifierValue) return false;
    const format = FORMATS[type];
    return format ? format.test(value) : true;
  };

  const API = { LIMITS, CATEGORY, FORMATS, FREE_TEXT_ANSWERS,
                checkPayloadLimits, isAcceptableIdentifier };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDLimits = API;
})();
