/* ============================================================
   Resolution-note screening
   ------------------------------------------------------------
   The note is the one free-text field a member of staff can type
   against a Business Record. It is stored, read back, and
   survives until a redaction runs.

   Two failure modes matter and they pull in opposite directions:

     · letting a credential, an address or a card number through,
       into a store that keeps it;
     · refusing so much ordinary prose that the field stops being
       used honestly, which is worse than not having the control,
       because then nobody writes down what they checked.

   Both are tested here. The permissive half is not padding.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const identity = require('../shared/business-record/resolve-identity.js');
const { screenResolutionNote, CATEGORY_MESSAGE } = require('../shared/security/staff-note.js');

const screen = note => screenResolutionNote(note, identity);

/* ---------- what must be refused ---------- */

test('an email address in a note is refused', () => {
  for (const note of [
    'Owner is reachable at owner@riverside.test for confirmation.',
    'Wrote to owner@riverside.test.',
    'Their address (billing+invoices@salon.example.com) matched.',
    'owner@riverside.test'
  ]) {
    const r = screen(note);
    assert.equal(r.ok, false, note);
    assert.equal(r.category, 'email_address', note);
  }
});

test('a telephone number in a note is refused', () => {
  for (const note of [
    'Called the owner on +1 415 555 0142 and confirmed the rebrand.',
    'Reached them at (415) 555-0142 this morning.',
    'Number on file 4155550142 matches the submission.'
  ]) {
    const r = screen(note);
    assert.equal(r.ok, false, note);
    assert.equal(r.category, 'phone_number', note);
  }
});

test('a payment card number is refused ahead of the phone rule', () => {
  const r = screen('Card on file 4111 1111 1111 1111 matches their statement.');
  assert.equal(r.ok, false);
  assert.equal(r.category, 'payment_data');
});

test('a labelled credential is refused', () => {
  for (const note of [
    'Their portal password: hunter2blue confirms the account is theirs.',
    'api_key = sk_live_abcdefghijkl was quoted on the call.',
    'secret: correct-horse-battery from their message.',
    'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l was in the header they sent.'
  ]) {
    const r = screen(note);
    assert.equal(r.ok, false, note);
    assert.ok(['credential', 'token', 'opaque_identifier'].includes(r.category), note);
  }
});

test('a JSON Web Token is refused however it is introduced', () => {
  const r = screen('They pasted eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0 into the chat.');
  assert.equal(r.ok, false);
  assert.equal(r.category, 'token');
});

test('a raw opaque identifier value is refused', () => {
  const r = screen('Their place id is ChIJN1t7SomeVeryLongPlaceIdValue99 on the listing.');
  assert.equal(r.ok, false);
  assert.equal(r.category, 'opaque_identifier');
});

test('a government identifier shape is refused', () => {
  const r = screen('Reference 123-45-6789 was quoted on the call.');
  assert.equal(r.ok, false);
  assert.equal(r.category, 'government_id');
});

test('a refusal never contains any part of the note', () => {
  /* Each value is placed in a note that genuinely triggers a rule — a bare
     word is not a password to anyone, including this screener, and pretending
     otherwise would test nothing. */
  const secrets = [
    ['owner@riverside.test', 'Contact owner@riverside.test confirmed the rebrand.'],
    ['4155550142', 'Reached them on 4155550142 this morning.'],
    ['4111111111111111', 'Card 4111111111111111 was read out on the call.'],
    ['hunter2blue', 'Their password: hunter2blue was volunteered, unasked.'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
      'They pasted eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0 into the chat.'],
    ['ChIJN1t7SomeVeryLongPlaceIdValue99',
      'Listing shows ChIJN1t7SomeVeryLongPlaceIdValue99 as the place id.'],
    ['123-45-6789', 'Reference 123-45-6789 was quoted on the call.']
  ];
  for (const [secret, note] of secrets) {
    const r = screen(note);
    assert.equal(r.ok, false, secret);
    assert.equal(r.message.includes(secret), false,
      `the refusal echoed the value it refused: ${secret}`);
    /* Nor any distinctive fragment of it. */
    for (const piece of secret.split(/[\s.@-]+/).filter(p => p.length > 4)) {
      assert.equal(r.message.includes(piece), false, `echoed the fragment "${piece}"`);
    }
    assert.ok(r.message.includes(CATEGORY_MESSAGE[r.category]),
      'but it does say which category it refused');
  }
});

/* ---------- what must be allowed ---------- */

test('ordinary operator prose is allowed', () => {
  const allowed = [
    'Confirmed by phone with the owner.',
    'Spoke to the owner, who confirmed the salon moved and rebranded in June.',
    'Owner confirmed the rebrand and the new address by phone.',
    'Same business; the visitor used a different address.',
    'The visitor mistyped the salon name; confirmed by phone it is the same business.',
    'Checked the address and phone with the owner.',
    'New owner, same salon; confirmed the change of contact details.',
    'Verified with the owner that this is the same salon under a new name.',
    'Attempting to resolve against a record that has since been merged away.',
    'Confirmed this is the northern location, not the original site.'
  ];
  for (const note of allowed) {
    const r = screen(note);
    assert.equal(r.ok, true, `${note}\n  refused as ${r.category}`);
  }
});

test('prose ABOUT credentials and tokens is allowed; the value is what is refused', () => {
  /* Matching the WORD would make the field useless and the operators
     inventive. "The continuation token had expired" is exactly the kind of
     thing a resolution note is for. */
  for (const note of [
    'The continuation token had expired, so the visitor re-entered their details.',
    'They mentioned a password reset but it is unrelated to this case.',
    'No API key or credential was involved in this resolution.',
    'The session token question came up and was a red herring.'
  ]) {
    const r = screen(note);
    assert.equal(r.ok, true, `${note}\n  refused as ${r.category}`);
  }
});

test('an internal UUID is allowed, because it is not personal data', () => {
  /* An operator quoting a case id is being helpful, and a case id identifies
     nobody. The opaque-run rule would swallow it without the exception. */
  const r = screen('Case 22222222-2222-4222-8222-222222222222 covers the same salon.');
  assert.equal(r.ok, true, r.message);

  /* But a same-length run that is NOT a UUID is still refused. */
  const bad = screen('Reference 22222222222222222222222222222222 was quoted.');
  assert.equal(bad.ok, false);
});

test('short numbers, dates and prices are not mistaken for contact data', () => {
  for (const note of [
    'They have 3 technicians and 2 chairs, confirmed on the call.',
    'Rebranded on 12 June; the old name is still on the sign.',
    'Quoted at $597 per month, which matches the recommendation.',
    'Review 2 of 2 for this record.'
  ]) {
    const r = screen(note);
    assert.equal(r.ok, true, `${note}\n  refused as ${r.category}`);
  }
});

test('an empty note is not the screener\'s problem', () => {
  /* Length is checked before this runs, and a screener that also had an
     opinion about length would be a second place for that rule to live. */
  assert.deepEqual(screen(''), { ok: true });
  assert.deepEqual(screen(null), { ok: true });
});

/* ---------- the screener cannot be silently disabled ---------- */

test('a caller that forgets the recognizers fails closed', () => {
  /* Refusing to screen is not the same as screening and finding nothing. If
     the recognizers were optional, a wiring mistake would look exactly like a
     clean note. */
  assert.throws(() => screenResolutionNote('owner@riverside.test', {}),
    /requires normalizeEmail and normalizePhone/);
  assert.throws(() => screenResolutionNote('anything at all'),
    /requires normalizeEmail and normalizePhone/);
});

test('the recognizers are the ones ingestion uses, not a second copy', () => {
  /* The whole reason they are injected. A regex here that drifted from
     resolve-identity.js would be the defect this module exists to prevent. */
  assert.equal(typeof identity.normalizeEmail, 'function');
  assert.equal(typeof identity.normalizePhone, 'function');

  /* Anything resolve-identity.js calls an email, this refuses. */
  for (const candidate of ['a@b.co', 'Owner.Name+tag@Salon.Example.COM']) {
    assert.ok(identity.normalizeEmail(candidate), `precondition: ${candidate}`);
    assert.equal(screen(`Contact ${candidate} confirmed.`).ok, false, candidate);
  }
});
