/* ============================================================
   The two Supabase email templates
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR. The documented reset-password
   template built its link from `{{ .SiteURL }}`.

   `accept-invite.js` calls
   `resetPasswordForEmail(email, { redirectTo })` with the
   COMPLETE, exact, same-origin recovery URL — the environment the
   request actually came from. Supabase carries that value into
   the template as `{{ .RedirectTo }}`. A template built from
   `{{ .SiteURL }}` throws it away and sends every recovery email
   to whichever single host that project's Site URL names: a
   Preview reset landing on Production, or on a host the person
   has never used.

   The templates live in a dashboard, not in this repository, so
   what is testable is the DOCUMENT that tells an operator what to
   paste — and the code the document has to agree with. Both are
   checked here, against each other.

   THE TWO TEMPLATES ARE DELIBERATELY DIFFERENT, and that is the
   subtle part:

     recovery   `{{ .RedirectTo }}` — a browser asked for it and
                supplied its own origin.
     invitation `{{ .SiteURL }}`    — an owner creates it from the
                Dashboard, no browser is involved, nothing in this
                repository calls inviteUserByEmail, so
                `{{ .RedirectTo }}` would render EMPTY.

   Getting either one backwards produces a broken link, so both
   directions are asserted.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RUNBOOK = readFileSync(join(ROOT, 'docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md'), 'utf8');
const INVITE_JS = readFileSync(join(ROOT, 'staff/identity-resolution/accept-invite.js'), 'utf8');
const RESET_JS = readFileSync(join(ROOT, 'staff/identity-resolution/reset-password.js'), 'utf8');

const RESET_PATH = '/staff/identity-resolution/reset-password.html';
const INVITE_PATH = '/staff/identity-resolution/accept-invite.html';

/* Every `<a href="…">` the runbook documents, so the assertions are made
   against the actual links an operator would paste rather than against prose
   that happens to mention a variable. */
const documentedLinks = () =>
  [...RUNBOOK.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]);

const recoveryLink = () => {
  const found = documentedLinks().filter(href => href.includes('type=recovery'));
  assert.equal(found.length, 1, `exactly one recovery link is documented, found ${found.length}`);
  return found[0];
};

const invitationLink = () => {
  const found = documentedLinks().filter(href => href.includes('type=invite'));
  assert.equal(found.length, 1, `exactly one invitation link is documented, found ${found.length}`);
  return found[0];
};

/* ============================================================
   1. The recovery template
   ============================================================ */

test('the documented recovery template uses {{ .RedirectTo }}', () => {
  const href = recoveryLink();
  assert.ok(href.startsWith('{{ .RedirectTo }}'),
    `the recovery link must start with the redirect the browser supplied: ${href}`);
});

test('the recovery template does NOT use {{ .SiteURL }}', () => {
  /* THE DEFECT, named. Site URL is one per-project value; the recovery
     request knows the actual environment and passes it. */
  const href = recoveryLink();
  assert.equal(href.includes('{{ .SiteURL }}'), false,
    `the recovery link must not be built from Site URL: ${href}`);
  assert.equal(href.includes('{{ .ConfirmationURL }}'), false,
    'and not from ConfirmationURL, which routes through Supabase and returns a session');
});

test('the recovery template appends no path to the redirect', () => {
  /* The application supplies the COMPLETE URL. Appending the page path again
     would double it and 404. */
  const href = recoveryLink();
  const afterRedirect = href.slice('{{ .RedirectTo }}'.length);
  assert.ok(afterRedirect.startsWith('#'),
    `nothing may sit between the redirect and the fragment: ${afterRedirect}`);
  assert.equal(href.includes(`{{ .RedirectTo }}${RESET_PATH}`), false,
    'the reset-password path must not be appended — the browser already supplied it');
  assert.equal((href.match(/reset-password\.html/g) || []).length, 0,
    'the documented link names no path at all; it is entirely the redirect');
});

test('the recovery token stays in the fragment, never the query', () => {
  const href = recoveryLink();
  assert.match(href, /#token_hash=\{\{ \.TokenHash \}\}&type=recovery$/,
    `the exact required tail: ${href}`);
  assert.equal(href.includes('?token_hash='), false, 'no query-string token');
  assert.equal(href.indexOf('#') < href.indexOf('token_hash'), true,
    'the token must appear after the fragment marker');
});

test('no query-string recovery token is documented anywhere', () => {
  /* Not just in the template — anywhere in the runbook. A worked example with
     a `?` in it is an instruction to leak a credential. */
  for (const href of documentedLinks()) {
    assert.equal(/\?[^#]*token_hash=/.test(href), false,
      `a documented link puts token_hash in the query: ${href}`);
  }
  assert.equal(/\?token_hash=/.test(RUNBOOK), false,
    'the runbook shows no query-string token anywhere');
});

/* ============================================================
   2. The browser supplies the complete URL
   ============================================================ */

test('the browser passes the complete same-origin reset URL to resetPasswordForEmail', () => {
  /* The template is only correct because the code supplies a whole URL. Both
     halves are asserted, so neither can drift alone. */
  assert.match(INVITE_JS, /const RESET_PAGE_PATH = '\/staff\/identity-resolution\/reset-password\.html'/,
    'the exact path is a named constant');
  assert.match(INVITE_JS, /const redirectTo = `\$\{window\.location\.origin\}\$\{RESET_PAGE_PATH\}`/,
    'the redirect is origin + path, so it is absolute and same-origin');
  assert.match(INVITE_JS, /resetPasswordForEmail\(email, \{ redirectTo \}\)/,
    'and it is what resetPasswordForEmail is given');

  /* Same-origin, not a configured or inherited host. */
  assert.equal(/redirectTo\s*[:=]\s*['"`]https?:\/\//.test(INVITE_JS), false,
    'the redirect must never be a hardcoded absolute host');
});

test('the path the code sends and the page the manifest publishes are the same', async () => {
  const { STATIC_MANIFEST } = await import('../tools/static-manifest.mjs');
  assert.ok(STATIC_MANIFEST.includes(RESET_PATH.replace(/^\//, '')),
    'the recovery page must be published, or the redirect 404s');
  assert.ok(STATIC_MANIFEST.includes(INVITE_PATH.replace(/^\//, '')));
});

test('the runbook documents the exact redirect URL that must be allowed', () => {
  /* Supabase refuses a redirectTo that is not on the project's list — and
     falls back to the Site URL when it does, which is the wrong-host outcome
     the template exists to avoid. */
  assert.ok(RUNBOOK.includes('Redirect URLs'), 'the dashboard setting is named');
  assert.ok(RUNBOOK.includes(RESET_PATH),
    'and the exact path an operator has to add is written out');
  /* Whitespace-normalised: the runbook is hard-wrapped, so a sentence may be
     split across lines and a naive match would depend on where. */
  const flowed = RUNBOOK.replace(/\s+/g, ' ');
  assert.match(flowed, /wildcard is not needed/i, 'a wildcard is explicitly discouraged');
  assert.match(flowed, /falls back to the Site URL/i,
    'and the consequence of an unlisted redirect is stated, because it is the '
    + 'exact failure this template avoids');
});

/* ============================================================
   3. The invitation template, checked separately
   ============================================================ */

test('the invitation template uses {{ .SiteURL }}, because no redirectTo exists for it', () => {
  /* Nothing in this repository calls inviteUserByEmail — invitations are
     created from the Dashboard — so `{{ .RedirectTo }}` would render empty
     and produce a hostless link. */
  const href = invitationLink();
  assert.ok(href.startsWith('{{ .SiteURL }}'), `the invitation link: ${href}`);
  assert.equal(href.includes('{{ .RedirectTo }}'), false,
    'RedirectTo would be empty for an invitation and must not be used');

  /* Unlike the recovery link, this one DOES carry the page path — Site URL is
     an origin, not a URL. */
  assert.ok(href.includes(INVITE_PATH), 'the invitation link names its own page path');
});

test('no code path supplies a redirectTo for an invitation', () => {
  /* The moment one does, the template above becomes wrong. This is the test
     that will fail then, and the runbook says so in words too. */
  for (const source of [INVITE_JS, RESET_JS]) {
    assert.equal(/inviteUserByEmail/.test(source), false,
      'an invitation created from code would need {{ .RedirectTo }} instead');
  }
  const server = readFileSync(join(ROOT, 'server/staff-identity-resolution.mjs'), 'utf8');
  assert.equal(/inviteUserByEmail/.test(server), false);
});

test('the Site URL constraint on invitations is documented, not assumed', () => {
  /* Requirement: if a flow intentionally depends on Site URL, say what that
     costs and what must be true for it to be right. */
  assert.match(RUNBOOK, /\{\{ \.RedirectTo \}\} would render empty|would render empty/i,
    'the reason Site URL is unavoidable for invitations is stated');
  assert.match(RUNBOOK, /different Supabase projects/i,
    'the constraint that makes per-project Site URL correct is stated');
  assert.match(RUNBOOK, /preview URL will not receive invitations/i,
    'and the case it cannot serve is admitted rather than glossed');
  assert.match(RUNBOOK, /inviteUserByEmail/,
    'and what would have to change if invitations ever gain a redirectTo');
});

/* ============================================================
   4. The two templates do not drift into each other
   ============================================================ */

test('each template uses exactly one host source, and they are different', () => {
  const recovery = recoveryLink();
  const invitation = invitationLink();

  assert.equal(recovery.includes('{{ .SiteURL }}'), false);
  assert.equal(invitation.includes('{{ .RedirectTo }}'), false);
  assert.notEqual(recovery.split('#')[0], invitation.split('#')[0],
    'the two links must not resolve their host the same way');

  /* Both keep the token in the fragment and hard-code their own type. */
  assert.match(recovery, /#token_hash=\{\{ \.TokenHash \}\}&type=recovery$/);
  assert.match(invitation, /#token_hash=\{\{ \.TokenHash \}\}&type=invite$/);

  /* And each page hard-codes the matching type, so a swapped link is refused
     rather than spent. */
  assert.match(INVITE_JS, /const OTP_TYPE = 'invite'/);
  assert.match(RESET_JS, /const OTP_TYPE = 'recovery'/);
});
