/* ============================================================
   CED Intelligence Platform — staff password recovery
   ------------------------------------------------------------
   THE WINDOW THIS CLOSES.

   Accepting an invitation is two calls against Supabase Auth:

     verifyOtp({ type: 'invite' })   consumes the one-time token
     updateUser({ password })        creates the password

   Between them the account EXISTS and has NO USABLE PASSWORD. If
   the tab closes, the network drops, or updateUser fails or its
   response is lost, the person holds an Auth account they cannot
   sign in to, and an invitation that cannot be reissued because
   Supabase will not invite a user that already exists. The
   password-based resume path on accept-invite.html needs a
   password, so it could not help them either.

   A password recovery email is a second way in that does not
   depend on the invitation at all. It works identically whether
   updateUser never ran, failed, or succeeded with its answer lost
   — in every case the account exists, and in every case this sets
   a password the resume flow can then use.

   NO CREDENTIAL REACHES CED. The email, the recovery token, the
   new password and every Supabase session go straight to Supabase
   Auth from this page, with the publishable key. The only CED
   request is a GET for the project URL and that key.

   WHAT THIS PAGE DOES NOT DO. It does not enroll a second factor,
   does not write staff_operators, and grants no queue access. It
   sets a password and signs out. Authorization stays exactly
   where it was: a live staff_operators lookup, AAL2, in the
   database.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const API = (window.CED_STAFF_API || '/api/staff/identity-resolution');

  /* The one type this page will ever verify. Hard-coded, never read from the
     URL: an invitation, magic-link or email-change token presented here must
     not be spent by the recovery flow. */
  const OTP_TYPE = 'recovery';

  const MIN_PASSWORD = 12;

  const $ = id => document.getElementById(id);
  const show = (id, visible) => { const el = $(id); if (el) el.hidden = !visible; };

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

  let client = null;
  let recoveryToken = null;

  /* ---------- the recovery token ----------
     FRAGMENT ONLY, for the same reason the invitation is fragment-only: a
     fragment is never transmitted, so the token is absent from the page
     load's own request line, from every subresource request and from any
     Referer. A token in the QUERY has already been sent to a server and
     written to an access log by the time this script runs, so it is REFUSED
     rather than used — using it would be treating a leaked credential as a
     usable one. */
  const readToken = () => {
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const token = (hash.get('token_hash') || '').trim();

    /* Out of the address bar before anything else, whatever happens next. */
    if (window.location.search || window.location.hash) {
      try { window.history.replaceState(null, '', window.location.pathname); } catch { /* noop */ }
    }

    if (search.has('token_hash')) return { refused: 'query' };
    if (!token) return { refused: null, token: null };

    /* A `type` that is PRESENT must be exactly `recovery`. Absent is allowed,
       because a link may carry only the token — and the value is never
       forwarded either way: verifyOtp is always called with OTP_TYPE. */
    if (hash.has('type') && hash.get('type').trim() !== OTP_TYPE) {
      return { refused: null, token: null };
    }
    return { refused: null, token };
  };

  /* Same options as every other Supabase client in this repository, for the
     same reasons — and one more here: a persisted session would leave a live
     password-changing session in storage on a shared machine. */
  const buildClient = ({ supabaseUrl, publishableKey }) =>
    window.supabase.createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

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
    if (!recoveryToken) {
      return showError('password-error',
        'This recovery link is no longer usable. Request a new password reset.');
    }

    busy('password-submit', true, 'Setting…');
    try {
      /* THE TYPE IS THE PAGE'S, NOT THE URL'S. */
      const { data: recovered, error: verifyError } = await client.auth.verifyOtp({
        token_hash: recoveryToken,
        type: OTP_TYPE
      });
      if (verifyError || !recovered || !recovered.session) {
        return showError('password-error',
          'That recovery link is not valid. It may have expired or already been used. '
          + 'Request a new password reset.');
      }

      /* Spent. Cleared before anything else can fail, so a second submit
         cannot replay it. */
      recoveryToken = null;

      const { error: passwordError } = await client.auth.updateUser({ password });
      if (passwordError) {
        /* The recovery token is gone, so say what to do rather than inviting
           a retry that cannot work. */
        return showError('password-error',
          'That password was not accepted. Request a new password reset and choose '
          + 'a longer, less common one.');
      }

      $('password').value = '';
      $('password-confirm').value = '';

      /* A password is not access. Sign out rather than leaving a live session
         on a page that has no business holding one. */
      try { await client.auth.signOut({ scope: 'local' }); } catch { /* best effort */ }

      show('step-password', false);
      show('step-done', true);
      $('main').focus();
    } catch {
      showError('password-error',
        'Supabase could not be reached. Check your connection and try again.');
    } finally {
      busy('password-submit', false, 'Set password');
    }
  };

  const start = async () => {
    /* Before the network call, so a failed config fetch cannot leave the
       token sitting in the address bar. */
    const found = readToken();
    recoveryToken = found.token || null;

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
        'Password recovery is not available right now. Ask an owner to check the '
        + 'console configuration.');
    }

    client = buildClient(config);
    show('loading', false);

    if (found.refused === 'query') return show('query-token', true);
    if (!recoveryToken) return show('no-token', true);

    show('step-password', true);
    $('password-form').addEventListener('submit', submitPassword);
    $('password').focus();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* Exposed for the browser suite only. Presence, never values. */
  window.CED_STAFF_RECOVERY = {
    holdsToken: () => Boolean(recoveryToken),
    hasClient: () => Boolean(client)
  };
})();
