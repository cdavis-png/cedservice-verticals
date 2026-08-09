/* ============================================================
   CED Intelligence Platform — invitation onboarding, browser half
   ------------------------------------------------------------
   Completes a Supabase invitation: accept it, set a password,
   enroll a TOTP authenticator, verify it. Plus a recovery path
   for the person who was interrupted after the invitation was
   already spent.

   NO ONBOARDING CREDENTIAL EVER REACHES A CED ENDPOINT.

   Scoped, and the scope matters: this is a statement about THIS
   page. The console's own sign-in (/session, /session/refresh,
   /session/signout) is deliberately server-mediated and still
   handles the operator's password and TOTP code — see
   docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md §1a for why the
   two differ. Nothing here changes that.

   THE PASSWORD, THE SESSION TOKENS, THE TOTP SECRET, THE otpauth
   URI AND THE TOTP CODE GO STRAIGHT TO SUPABASE AUTH, from this
   page, with the supported client and the PUBLISHABLE key.
   CLAUDE.md §9 forbids this platform from transmitting or storing
   passwords, tokens or other credentials, and an earlier version
   of this file broke that rule by proxying every one of them
   through /api/staff/identity-resolution. The reasoning behind
   that — "the browser must hold no Supabase key" — confused the
   secret key, which must never reach a browser, with the
   publishable key, which is designed for one.

   THE ONLY CED CALL THIS PAGE MAKES is a GET for the project URL
   and the publishable key. Neither is a secret; the publishable
   key grants nothing, because every table has RLS enabled and
   FORCED with no policies and no function is executable by anon.

   ONBOARDING GRANTS NOTHING. Verifying a factor raises this
   session to aal2, and that is still not authorization: the queue
   requires an active `staff_operators` row, checked live in the
   database on every request. This page never writes one and
   could not — the publishable key cannot see the table.

   NOTHING IS PERSISTED. persistSession, autoRefreshToken and
   detectSessionInUrl are all off, so the client keeps the session
   in memory only and writes no storage of any kind. The page
   signs out when it is finished.

   THE TOKEN NEVER STAYS IN THE ADDRESS BAR. It is read once and
   removed with replaceState before any network call, so it does
   not survive into history, a bookmark or a Referer header — and
   the page also declares Referrer-Policy: no-referrer.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const API = (window.CED_STAFF_API || '/api/staff/identity-resolution');

  /* The one type this page will ever verify. Hard-coded, never read from the
     URL: a recovery, signup, magiclink or email-change token presented here
     must not enter the invitation flow. The query's `type` is only used to
     refuse an obviously wrong link early. */
  const OTP_TYPE = 'invite';

  /* Where a password-reset email must land. Same origin, and the exact path
     that has to be on the project's allowed-redirect list. */
  const RESET_PAGE_PATH = '/staff/identity-resolution/reset-password.html';

  const MIN_PASSWORD = 12;
  const TOTP_FRIENDLY_NAME = 'CED Service staff console';

  const $ = id => document.getElementById(id);
  const show = (id, visible) => { const el = $(id); if (el) el.hidden = !visible; };
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

  const showError = (id, message) => {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  };
  const clearError = id => { const el = $(id); if (el) { el.textContent = ''; el.hidden = true; } };

  const busy = (id, isBusy, label) => {
    const el = $(id);
    if (!el) return;
    el.disabled = isBusy;
    el.textContent = label;
  };

  /* In memory, for the life of the page, and no longer than needed. */
  let client = null;         /* the Supabase client, built once config arrives */
  let invitationToken = null;
  let factorId = null;

  /* ---------- the invitation token ----------
     IT ARRIVES IN THE FRAGMENT, AND ONLY THE FRAGMENT.

     A fragment is never transmitted. It is not in the request line of the
     page load, it is not sent with any subresource request, and it cannot
     appear in a `Referer`, a proxy log, an access log or a CED log — because
     it never leaves the browser at all. A query string is the opposite: the
     invitation token would be in the very first GET for this page, before a
     single line of this script had run, and no amount of care afterwards
     could take it back.

     So the invite template is configured as
     `…/accept-invite.html#token_hash={{ .TokenHash }}&type=invite`, and a
     token offered in the QUERY is REFUSED rather than accepted-and-tidied:
     if one is there it has already been transmitted, and using it would be
     treating a leaked credential as a usable one.

     Read once, then removed with replaceState before any network call, so it
     survives into no history entry, bookmark or screenshot either. */
  const readInvitation = () => {
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const tokenHash = (hash.get('token_hash') || '').trim();

    /* Out of the address bar whatever happens next — a refused token is still
       a token, and a refused query token is one that has already leaked. */
    if (window.location.search || window.location.hash) {
      try { window.history.replaceState(null, '', window.location.pathname); } catch { /* noop */ }
    }

    /* A token in the query has been sent to the server. Refuse it, and say
       so, rather than silently proceeding as though it had not. */
    if (search.has('token_hash')) return { refused: 'query' };

    if (!tokenHash) return { refused: null, token: null };

    /* A `type` that is PRESENT must be exactly `invite`; an empty one is a
       present one, and "it was blank so we assumed the good case" is how a
       recovery link ends up in an invitation flow. Absent is allowed, because
       a link may legitimately carry only the token — and the value is never
       forwarded either way: `verifyOtp` is always called with OTP_TYPE. */
    if (hash.has('type') && hash.get('type').trim() !== OTP_TYPE) {
      return { refused: null, token: null };
    }

    return { refused: null, token: tokenHash };
  };

  /* ---------- Supabase ----------
     Exactly the options CLAUDE.md §12 requires of the server client, for the
     same reasons and with one more: a page that persisted a session would
     leave an aal1 token in storage on a shared machine. */
  const buildClient = ({ supabaseUrl, publishableKey }) =>
    window.supabase.createClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });

  /* Supabase's own message where it is safe and useful, a plain one where it
     is not. Never the token, never the password. */
  const authMessage = (error, fallback) => {
    const raw = String((error && error.message) || '');
    if (!raw) return fallback;
    if (invitationToken && raw.includes(invitationToken)) return fallback;
    return raw;
  };

  /* ---------- enrollment, shared by both entry paths ----------
     One place, because the invitation path and the recovery path need
     identically the same thing once a session exists.

     An UNVERIFIED factor left over from an interrupted attempt is removed
     first. Supabase refuses a second factor with the same friendly name, so
     without this the recovery path would fail for exactly the person it
     exists for. A VERIFIED factor is never touched: that account is already
     set up and is sent to sign in instead. */
  const beginEnrollment = async () => {
    const { data: factors, error: listError } = await client.auth.mfa.listFactors();
    if (listError) throw new Error(authMessage(listError, 'Your authenticator could not be checked.'));

    const all = (factors && (factors.all || factors.totp)) || [];
    const verified = all.find(f => f && f.status === 'verified');
    if (verified) return { alreadyVerified: true };

    for (const stale of all.filter(f => f && f.status === 'unverified')) {
      await client.auth.mfa.unenroll({ factorId: stale.id });
    }

    const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: TOTP_FRIENDLY_NAME
    });
    if (enrollError || !enrolled || !enrolled.id || !enrolled.totp || !enrolled.totp.secret) {
      throw new Error(authMessage(enrollError,
        'The authenticator could not be set up. Ask an owner for help.'));
    }

    factorId = enrolled.id;
    setText('factor-secret', enrolled.totp.secret);
    if (enrolled.totp.uri) {
      setText('factor-uri', enrolled.totp.uri);
    } else {
      show('factor-uri-wrap', false);
    }
    return { alreadyVerified: false };
  };

  const goToFactorStep = () => {
    show('step-password', false);
    show('step-resume', false);
    show('no-invite', false);
    show('step-factor', true);
    $('code').focus();
  };

  /* ---------- step 1: accept the invitation and set the password ---------- */
  const submitPassword = async event => {
    event.preventDefault();
    clearError('password-error');

    const password = $('password').value;
    const confirm = $('password-confirm').value;

    if (password !== confirm) {
      return showError('password-error', 'Those two passwords are not the same.');
    }
    if (password.length < MIN_PASSWORD) {
      return showError('password-error',
        `Choose a password of at least ${MIN_PASSWORD} characters.`);
    }
    if (!invitationToken) {
      return showError('password-error',
        'This invitation link is no longer usable. Choose "Finish an interrupted '
        + 'set-up" if you already set a password, or ask an owner for a new invitation.');
    }

    busy('password-submit', true, 'Setting up…');
    try {
      /* THE TYPE IS THE PAGE'S, NOT THE URL'S. */
      const { data: accepted, error: verifyError } = await client.auth.verifyOtp({
        token_hash: invitationToken,
        type: OTP_TYPE
      });
      if (verifyError || !accepted || !accepted.session) {
        return showError('password-error',
          'That invitation link is not valid. It may have expired or already been '
          + 'used. If you already set a password here, choose "Finish an interrupted '
          + 'set-up". Otherwise ask an owner for a new invitation.');
      }

      /* Spent. Cleared before anything else can fail, so a retry cannot
         replay it and the page stops offering it. */
      invitationToken = null;

      const { error: passwordError } = await client.auth.updateUser({ password });
      if (passwordError) {
        return showError('password-error', authMessage(passwordError,
          'That password was not accepted. Choose a longer, less common one and '
          + 'use "Finish an interrupted set-up" to continue.'));
      }

      $('password').value = '';
      $('password-confirm').value = '';

      const { alreadyVerified } = await beginEnrollment();
      if (alreadyVerified) return finish();
      goToFactorStep();
    } catch (err) {
      showError('password-error', err && err.message
        ? err.message
        : 'Supabase could not be reached. Check your connection and try again.');
    } finally {
      busy('password-submit', false, 'Set password and continue');
    }
  };

  /* ---------- recovery: resume an interrupted set-up ----------
     REQUIREMENT: a person interrupted after the invitation was consumed must
     be able to finish without a second invitation, which Supabase cannot
     issue for an already-created user anyway.

     They already have a password, so they sign in with it. That session is
     aal1 — no factor is verified yet — which is exactly enough to enroll one
     and not enough to do anything else. It grants no staff authorization:
     that lives in `staff_operators`, which this key cannot see. */
  const submitResume = async event => {
    event.preventDefault();
    clearError('resume-error');
    show('resume-already', false);

    const email = $('resume-email').value.trim();
    const password = $('resume-password').value;
    if (!email || !password) {
      return showError('resume-error', 'Enter the email you were invited with and your password.');
    }

    busy('resume-submit', true, 'Checking…');
    try {
      const { data: signedIn, error: signInError } =
        await client.auth.signInWithPassword({ email, password });
      if (signInError || !signedIn || !signedIn.session) {
        return showError('resume-error',
          'That email and password were not accepted. If you never finished setting '
          + 'a password, ask an owner for a new invitation.');
      }
      $('resume-password').value = '';

      const { alreadyVerified } = await beginEnrollment();
      if (alreadyVerified) {
        /* Nothing left to do here, and this page must not become a second
           way into the console. */
        await client.auth.signOut({ scope: 'local' });
        const el = $('resume-already');
        el.textContent = 'This account already has a verified authenticator app. '
          + 'Nothing more to do here — sign in at the staff console.';
        el.hidden = false;
        return;
      }
      goToFactorStep();
    } catch (err) {
      showError('resume-error', err && err.message
        ? err.message
        : 'Supabase could not be reached. Check your connection and try again.');
    } finally {
      busy('resume-submit', false, 'Continue');
    }
  };

  /* ---------- password recovery request ----------
     THE WINDOW THIS CLOSES. Accepting an invitation is two calls: verifyOtp
     consumes the one-time token, then updateUser creates the password.
     Between them the account exists with no usable password, so the resume
     path above — which signs in with that password — cannot help, and the
     invitation cannot be reissued because the user already exists.

     A recovery email does not depend on the invitation at all, so it works
     whether updateUser never ran, failed, or succeeded with its response
     lost. It is sent by Supabase, from this page, and lands on
     reset-password.html.

     THE ANSWER IS THE SAME EITHER WAY. Whether an email address is a staff
     account is not something an unauthenticated page may reveal, so a
     Supabase error is not shown: the visible result is identical for a real
     account, an unknown address and a rate-limited request. */
  const RESET_SENT =
    'If there is an account for that address, a password-reset link is on its way. '
    + 'It can be used once and expires. When you have set a new password, come back '
    + 'and choose "Finish an interrupted set-up".';

  const submitReset = async event => {
    event.preventDefault();
    clearError('reset-error');
    show('reset-sent', false);

    const email = $('reset-email').value.trim();
    if (!email) {
      return showError('reset-error', 'Enter the email you were invited with.');
    }

    busy('reset-submit', true, 'Sending…');
    try {
      /* The exact same-origin recovery page, absolute so Supabase can match
         it against the project's allowed redirect URLs. */
      const redirectTo = `${window.location.origin}${RESET_PAGE_PATH}`;
      await client.auth.resetPasswordForEmail(email, { redirectTo });
    } catch {
      /* Even a transport failure answers the same way. Saying "we could not
         reach Supabase" for one address and "sent" for another would be the
         same disclosure by a different route. */
    } finally {
      busy('reset-submit', false, 'Send the link');
    }

    $('reset-email').value = '';
    const el = $('reset-sent');
    el.textContent = RESET_SENT;
    el.hidden = false;
  };

  /* ---------- step 2: verify the code ---------- */
  const finish = async () => {
    /* The aal2 session this page just created is not console access and must
       not linger: sign out locally, so nothing is left in memory and the
       refresh token is revoked for this browser only. */
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* best effort */ }
    factorId = null;
    setText('factor-secret', '');
    setText('factor-uri', '');
    show('step-factor', false);
    show('step-resume', false);
    show('step-done', true);
    $('main').focus();
  };

  const submitCode = async event => {
    event.preventDefault();
    clearError('factor-error');

    const code = $('code').value.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      return showError('factor-error', 'Enter the six digits from your authenticator app.');
    }
    if (!factorId) {
      return showError('factor-error',
        'This set-up has expired. Reload and choose "Finish an interrupted set-up".');
    }

    busy('factor-submit', true, 'Verifying…');
    try {
      const { data: verified, error: verifyError } =
        await client.auth.mfa.challengeAndVerify({ factorId, code });
      if (verifyError || !verified || !verified.access_token) {
        return showError('factor-error', 'That authentication code was not accepted.');
      }
      $('code').value = '';
      await finish();
    } catch (err) {
      showError('factor-error', err && err.message
        ? err.message
        : 'Supabase could not be reached. Check your connection and try again.');
    } finally {
      busy('factor-submit', false, 'Verify and finish');
    }
  };

  /* ---------- start ---------- */
  const start = async () => {
    /* Before the network call, so a failed config fetch cannot leave the
       invitation sitting in the address bar. */
    const invitation = readInvitation();
    invitationToken = invitation.token || null;

    let config = null;
    try {
      const res = await fetch(`${API}/auth-config`, { headers: { Accept: 'application/json' } });
      const parsed = await res.json().catch(() => null);
      if (res.status === 200 && parsed && parsed.supabaseUrl && parsed.publishableKey) {
        config = parsed;
      }
    } catch { config = null; }

    if (!config || typeof window.supabase === 'undefined') {
      return showError('loading-error',
        'Staff sign-up is not available right now. Ask an owner to check the '
        + 'console configuration.');
    }

    client = buildClient(config);

    show('loading', false);
    $('password-form').addEventListener('submit', submitPassword);
    $('resume-form').addEventListener('submit', submitResume);
    $('factor-form').addEventListener('submit', submitCode);
    $('reset-form').addEventListener('submit', submitReset);
    $('show-resume').addEventListener('click', () => {
      show('no-invite', false);
      show('step-reset', false);
      show('step-resume', true);
      $('resume-email').focus();
    });
    $('show-reset').addEventListener('click', () => {
      show('step-resume', false);
      show('step-reset', true);
      $('reset-email').focus();
    });

    if (invitation.refused === 'query') {
      /* Stated plainly rather than folded into "no invitation": the token was
         transmitted, so it must be treated as spent and a new one requested. */
      show('query-token', true);
      show('no-invite', true);
      return;
    }
    if (invitationToken) show('step-password', true);
    else show('no-invite', true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* Exposed for the browser suite only. It reports PRESENCE, never values: a
     test that could read the secret would be a test proving the page leaks
     it. */
  window.CED_STAFF_ONBOARDING = {
    holdsInvitation: () => Boolean(invitationToken),
    holdsFactor: () => Boolean(factorId),
    hasClient: () => Boolean(client)
  };
})();
