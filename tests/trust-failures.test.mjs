/* ============================================================
   Trust failure: the platform claimed it had emailed the results
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR. A completed review POSTs to
   /api/assessments, which validates the submission and stores it.
   That is all it does. There is no email provider anywhere in
   this repository — no SMTP, no SendGrid/Postmark/Resend/SES, no
   pg_net or net.http call in any migration, and no delivery-state
   column in any table.

   The engine nonetheless reported the successful POST to the
   visitor as:

       sending: 'Sending your results…'
       sent:    'Results sent.'

   The visitor reads that immediately after ticking a consent that
   reads "Send my assessment results and directly related
   follow-up to the email address above. This is required to
   deliver your results." In that context "Results sent." is a
   claim that an email was sent, and no email was sent.

   The specification names this as one of two trust failures that
   must be repaired before anything ships (section 2, section 18
   step 1), and section 13.4 requires four distinct stored states
   before any delivery claim may be displayed at all — with
   provider acceptance explicitly NOT counted as delivery.

   THE PAGE COPY WAS REPAIRED TOO, on the owner's decision, by
   applying the pattern the Service Mix review already used: the
   required permission describes what actually happens, and the
   non-conditionality assurance is kept but stated in terms of
   the real delivery method. CLAUDE.md section 4 was amended in
   the same change — it previously REQUIRED the page to promise
   delivery by email, which nothing could perform.

   The delivery method is on-page. Email is deferred as a
   separate product decision. Nothing here anticipates it.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetGlobals } from './helpers/dom-harness.mjs';
import {
  mountNails, answer, grantResultsConsent, walkToResults, STAGE1_ANSWERS
} from './helpers/nails-markup.mjs';

const engineSource = readFileSync(
  new URL('../shared/assessment-engine/engine.js', import.meta.url), 'utf8');

/* Reads the STATUS_COPY literal out of the source rather than importing it:
   the object is private to the engine's IIFE and never exported. */
const statusCopyValues = () => {
  const block = engineSource.match(/const STATUS_COPY = \{([\s\S]*?)\};/);
  assert.ok(block, 'STATUS_COPY could not be located in the engine source.');
  const values = [...block[1].matchAll(/:\s*'([^']*)'/g)].map(m => m[1]);
  assert.ok(values.length >= 4, 'STATUS_COPY parsed to fewer entries than expected.');
  return values;
};

test('no submission status tells the visitor an email was sent', () => {
  /* "sent" is the exact word the defect turned on, and it is what a visitor
     who has just supplied an email address reads as delivery. */
  const forbidden = /\bemail\b|\binbox\b|\bdeliver(ed|y)?\b|\bsent\b/i;
  statusCopyValues().forEach(value => {
    assert.ok(!forbidden.test(value),
      `Status copy "${value}" claims or implies email delivery. The platform ` +
      `sends no email. See section 13.4 before restoring any delivery claim.`);
  });
});

test('the exact retired string cannot come back', () => {
  assert.ok(!/sent:\s*'Results sent\.'/.test(engineSource),
    'STATUS_COPY.sent is "Results sent." again — the original false claim.');
});

/* ---------- the page ---------- */

const PAGE = readFileSync(
  new URL('../verticals/beauty-wellness-fitness/nails/site/index.html', import.meta.url), 'utf8');

/* Visitor-facing text only: strip comments, scripts and styles so a rationale
   comment explaining why we do NOT email cannot itself trip the assertion. */
const visibleText = () => PAGE
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

test('the Growth page never tells a visitor their results will be emailed', () => {
  /* Each pattern is a claim the page actually made before this repair. The
     optional MARKETING permissions are deliberately not covered: they are
     permissions for future contact, not claims that anything was sent. */
  const claims = [
    /we will email your/i,
    /emailed? (?:to )?you/i,
    /results (?:are|will be) delivered by email/i,
    /required to deliver your results/i,
    /check your (?:inbox|email)/i,
    /sent to your email/i,
    /where to send your results/i
  ];
  const text = visibleText();
  claims.forEach(pattern => {
    assert.ok(!pattern.test(text),
      `The Growth page claims email delivery: ${pattern}. Delivery is on-page.`);
  });
});

test('the required permission describes processing, not email delivery', () => {
  const statement = PAGE.match(/data-consent-for="consentResults">([\s\S]*?)<\/span>/);
  assert.ok(statement, 'the results consent statement is missing from the page');
  const text = statement[1].trim();

  assert.match(text, /shown to me on this page/i,
    'the required permission must state that results appear on this page');
  assert.ok(!/\bemail\b/i.test(text),
    `the required permission still mentions email: "${text}"`);
});

test('the marketing assurance promises the page, and stays separate', () => {
  const text = visibleText();
  assert.match(text, /results appear on this page whether or not you opt in to marketing/i,
    'the non-conditionality assurance is missing or reworded');
  /* Three checkboxes, never one. */
  ['consentResults', 'consentEmailMarketing', 'consentSmsMarketing'].forEach(field => {
    assert.match(PAGE, new RegExp(`name="${field}"`),
      `${field} is missing — the permissions must stay separate`);
  });
  assert.match(PAGE, /data-legal-review="pending"/,
    'the legal-review marker must remain until counsel signs off');
});

test('CLAUDE.md no longer requires the promise the page cannot keep', () => {
  const claudeMd = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  assert.ok(!/Declining must still\s+deliver the results, by email/i.test(claudeMd),
    'CLAUDE.md still requires delivery by email, which contradicts the page.');
  assert.match(claudeMd, /Never claim a delivery that has not happened/i,
    'the replacement rule is missing from CLAUDE.md section 4.');
});

test('the Stage 2 CTA describes who is emailing whom', () => {
  /* It opens the VISITOR's mail client addressed to CED. The old label,
     "Send My Results & Next Steps", read as a request for CED to email the
     results — the one thing the platform cannot do. */
  assert.ok(!/Send My Results/i.test(PAGE),
    'the CTA implies the platform will email results to the visitor');
  const cta = PAGE.match(/href="mailto:[^"]*"[^>]*>([^<]*)<\/a>/g) || [];
  assert.ok(cta.some(a => /Email CED About My Results/i.test(a)),
    'the Stage 2 mailto CTA must say who is being emailed');
  /* Still a real mailto, not a promise of automated delivery. */
  assert.match(PAGE, /href="mailto:[^"]*"[^>]*>\s*Email CED About My Results/);
});

test('the required email field says why it is required', () => {
  const text = visibleText();
  assert.match(text, /We use your email to match this review to your Business Record/i,
    'the email-purpose disclosure is missing');
  assert.match(text, /Your results appear here/i,
    'the disclosure must restate that delivery is on-page');
  assert.match(text, /does not opt you into marketing/i,
    'the disclosure must separate identity from marketing consent');
  /* The claim has to stay true: email must remain an identity signal. */
  const resolver = readFileSync(
    new URL('../shared/business-record/resolve-identity.js', import.meta.url), 'utf8');
  assert.match(resolver, /email_exact/,
    'the page claims email is used for matching; resolve-identity.js no longer derives it');
  assert.match(resolver, /push\(signals, 'email_exact', contact\.email/,
    'email is no longer fed into identity resolution — the disclosure would be false');
});

/* ---------- the flow ---------- */

test('results are reached and stored without any marketing consent', async () => {
  resetGlobals();
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);          /* required permission only */
  const results = walkToResults(engine);
  await Promise.resolve();

  assert.ok(results, 'the visitor never reached the results screen');
  const [payload] = engine.submissions;
  assert.equal(payload.consent.emailMarketingConsent.granted, false);
  assert.equal(payload.consent.resultsDeliveryConsent.granted, true);
  /* The figures a declining visitor is shown are the real ones. */
  assert.ok(payload.results.score >= 0 && payload.results.score <= 100);
});

test('the displayed permission is what gets stored as consent evidence', async () => {
  resetGlobals();
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  const stored = engine.submissions[0].consent.resultsDeliveryConsent.statement;
  const shown = PAGE.match(/data-consent-for="consentResults">([\s\S]*?)<\/span>/)[1].trim();

  /* CLAUDE.md section 4: store the wording, not a version number. The record
     must be provably what was displayed — including the repaired wording. */
  assert.equal(stored, shown);
  assert.match(stored, /shown to me on this page/i);
  assert.ok(!/\bemail\b/i.test(stored));
});

test('a delivery claim may not be reintroduced without a provider', () => {
  /* If this fails, an email provider may genuinely have been added. That is
     not a defect — but the four states in section 13.4 must land with it, and
     the copy above must distinguish acceptance from delivery. Update this
     file deliberately at that point; do not delete it. */
  const providers = /nodemailer|sendgrid|postmark|mailgun|@aws-sdk\/client-ses|resend/i;
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.ok(!providers.test(pkg),
    'An email provider appeared in package.json. Revisit the delivery states ' +
    'in specification section 13.4 and the status copy in engine.js together.');
});
