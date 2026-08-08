/* ============================================================
   CED Intelligence Platform — staff resolution-note screening
   ------------------------------------------------------------
   A resolution note is the one free-text field a member of staff
   can type against a Business Record. It is stored, it is read
   back, and until a redaction runs it stays exactly as typed.

   A warning in the markup is not a control. It tells an honest
   operator what not to do and does nothing at all about the
   afternoon somebody pastes a whole email thread into the box
   because it was easier than summarising it.

   WHAT THIS REFUSES, and nothing else:

     · credentials and secrets — a labelled value, not the word
     · access, bearer and continuation tokens
     · raw email addresses
     · raw telephone numbers
     · raw opaque identifier values — place ids, customer ids,
       API keys, base64 blobs
     · payment card and government identifier shapes

   WHAT IT DELIBERATELY ALLOWS. Prose about any of the above.
   "The continuation token had expired" is a useful thing for an
   operator to write down and carries nothing; `token=ey…` is a
   credential. Matching the WORD would have made the control
   useless and the operators inventive, which is worse than not
   having it.

   ONE DEFINITION OF "IS THIS AN EMAIL". The recognizers are
   injected — `normalizeEmail` and `normalizePhone` come from
   shared/business-record/resolve-identity.js, the same functions
   ingestion and the conflict rule use. A second regex here that
   could drift from those is the defect this file would otherwise
   be introducing, not preventing.

   THE VALUE IS NEVER RETURNED. A refusal names the CATEGORY. An
   error travels into logs, into a response body, and sometimes
   into a screenshot in a ticket; echoing the thing we just
   refused to store would put it in all three.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* A labelled secret: a recognised name, a separator, then a value. The name
     alone is prose and is allowed through; the pair is a credential. */
  const SECRET_ASSIGNMENT =
    /(password|passwd|pwd|secret|api[\s_-]?key|apikey|credential|bearer|authorization|auth[\s_-]?token|access[\s_-]?token|refresh[\s_-]?token|continuation[\s_-]?token|session[\s_-]?token|private[\s_-]?key|token)\s*[:=]\s*\S{4,}/i;

  /* A JSON Web Token, which is what a Supabase access token and a
     continuation context both look like on the wire. */
  const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

  /* A canonical UUID is an INTERNAL identifier, not personal data, and an
     operator quoting a case id in their note is being helpful. Excluded
     before the opaque-run rule below, which would otherwise swallow it. */
  const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  /* Everything else that is long, unbroken and not a word: place ids,
     external customer ids, API keys, base64. No English word reaches 24
     characters, so this costs prose nothing. */
  const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/g;

  const GOVERNMENT_ID = /\b\d{3}-\d{2}-\d{4}\b/;

  /* Digit runs, separators ignored, so 4111 1111 1111 1111 is caught as
     readily as the unspaced form. 13-19 digits is a payment card; 10-15 is
     handed to the phone normalizer, which refuses anything it cannot
     confidently read rather than guessing. */
  const DIGIT_RUN = /[+(]?\d[\d\s().-]{8,}\d/g;

  /* Trims the punctuation a sentence wraps around a value, so
     "wrote to owner@salon.test." is still recognised as an address. */
  const bareToken = word => String(word).replace(/^[^A-Za-z0-9@+_-]+/, '')
                                        .replace(/[^A-Za-z0-9._%+-]+$/, '');

  const CATEGORY_MESSAGE = Object.freeze({
    credential: 'a password, secret, API key or other credential',
    token: 'an access, bearer or continuation token',
    email_address: 'an email address',
    phone_number: 'a telephone number',
    payment_data: 'a payment card number',
    government_id: 'a government identifier',
    opaque_identifier: 'a raw identifier value such as a place id or customer id'
  });

  /* Returns { ok: true } or { ok: false, category, message }.
     `message` is safe to return to a caller and safe to log: it names the
     category and never contains any part of the note. */
  const screenResolutionNote = (note, recognizers = {}) => {
    const text = typeof note === 'string' ? note : '';
    if (!text) return { ok: true };

    const normalizeEmail = typeof recognizers.normalizeEmail === 'function'
      ? recognizers.normalizeEmail : null;
    const normalizePhone = typeof recognizers.normalizePhone === 'function'
      ? recognizers.normalizePhone : null;

    if (!normalizeEmail || !normalizePhone) {
      /* Refusing to screen is not the same as screening and finding nothing.
         A caller that forgets to wire the recognizers must fail closed. */
      throw new Error(
        'screenResolutionNote requires normalizeEmail and normalizePhone from resolve-identity.js');
    }

    const refuse = category => ({
      ok: false,
      category,
      message: `The resolution note appears to contain ${CATEGORY_MESSAGE[category]}. `
             + 'Summarise what you checked instead — this field is stored against the record.'
    });

    if (JWT.test(text)) return refuse('token');
    if (SECRET_ASSIGNMENT.test(text)) return refuse('credential');
    if (GOVERNMENT_ID.test(text)) return refuse('government_id');

    for (const word of text.split(/\s+/)) {
      if (normalizeEmail(bareToken(word))) return refuse('email_address');
    }

    for (const run of text.match(DIGIT_RUN) || []) {
      const digits = run.replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19) return refuse('payment_data');
      if (normalizePhone(run)) return refuse('phone_number');
    }

    for (const run of text.match(OPAQUE_RUN) || []) {
      if (!UUID.test(run)) return refuse('opaque_identifier');
    }

    return { ok: true };
  };

  const API = {
    screenResolutionNote,
    CATEGORY_MESSAGE,
    /* Exported for the tests that pin the rules rather than restating them. */
    PATTERNS: { SECRET_ASSIGNMENT, JWT, UUID, OPAQUE_RUN, GOVERNMENT_ID, DIGIT_RUN }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDStaffNote = API;
})();
