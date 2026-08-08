/* ============================================================
   Staff console — the production authentication adapter
   ------------------------------------------------------------
   This file is the reason the console can sign in. It is loaded
   before page.js and it sets window.CED_STAFF_AUTH, which page.js
   then uses for every token it needs. There is no other path: the
   test harness drives THIS adapter through a stubbed fetch rather
   than replacing it, so what the suite exercises is what ships.

   WHY THE BROWSER DOES NOT HOLD A SUPABASE CLIENT.

   The obvious arrangement is @supabase/supabase-js in the page
   with the publishable key. This repository has no build step, no
   bundler and no module loader, so putting that library in the
   browser would mean either committing a generated third-party
   bundle or loading one from a CDN at runtime. The first is a
   build artifact in a repository that does not carry them; the
   second puts a third party in the sign-in path of a console that
   performs permanent, unerasable attachments.

   So the supported client runs on the other side of the wire, in
   the staff route, exactly as .env.example has always described:
   the browser talks to /api/staff/identity-resolution/…, and the
   route holds the keys. Nothing here is a hand-rolled Supabase
   protocol call — every one of them is made by the real client,
   server-side. No key of any privilege level reaches this file,
   and none can: the route never sends one.

   WHAT IT DOES

     · email and password, then the TOTP code, to /session
     · the resulting AAL2 access token, held in memory only
     · a refresh before expiry, whose new token is re-checked for
       aal2 server-side, so a refresh cannot quietly demote a
       session, and which fails closed unless it comes back
       complete, rotated and for the same user
     · sign-out, which revokes THIS browser's session — local
       scope, server-side — and clears here first, so a network
       failure cannot leave the page believing it is signed in

   NOTHING IS PERSISTED. No localStorage, no sessionStorage, no
   cookie written by this file. A reload signs the operator out,
   which for a surface like this one is the right default.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const API = (window.CED_STAFF_API || '/api/staff/identity-resolution');

  /* Refresh this many seconds before the token actually expires, so a long
     resolution is not interrupted by a 401 it could have avoided. */
  const REFRESH_SKEW_SECONDS = 60;

  /* In memory, for the life of the page. */
  let session = null;      /* { accessToken, refreshToken, expiresAt, userId } */
  let refreshing = null;   /* single-flight guard */

  class StaffAuthError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const post = async (path, body) => {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };

  const refusal = (body, fallback) => new StaffAuthError(
    (body && body.code) || 'sign_in_failed',
    (body && body.message) || fallback);

  /* ---------- sign in ----------
     Two shapes come back, and both are ordinary:

       { needsSecondFactor: true }  the password was accepted and the account
                                    has a verified authenticator; ask for the
                                    code. No session exists yet — the route
                                    discards the aal1 one rather than parking
                                    it anywhere.
       { session: { … } }           an aal2 session, confirmed server-side.

     Everything else throws, carrying the route's own code so the page can
     tell "wrong password" from "no second factor enrolled". */
  const signIn = async ({ email, password, totp } = {}) => {
    const { status, body } = await post('/session', {
      email: email || '', password: password || '', totp: totp || ''
    });

    if (status === 200 && body && body.needsSecondFactor === true) {
      return { needsSecondFactor: true };
    }
    if (status === 200 && body && body.session && body.session.accessToken) {
      session = {
        accessToken: body.session.accessToken,
        refreshToken: body.session.refreshToken || null,
        expiresAt: Number(body.session.expiresAt) || null,
        userId: body.session.userId || null
      };
      return { accessToken: session.accessToken, userId: session.userId };
    }
    throw refusal(body, 'Sign-in failed. Check your details and try again.');
  };

  /* ---------- the token ----------
     Refreshed BEFORE it is used, never after a failure. Retrying a request
     that already reached the server is not something this console does: the
     one POST it makes attaches a review permanently, and an automatic resend
     is a decision the operator did not take. */
  const expiringSoon = () => Boolean(session && session.expiresAt)
    && (session.expiresAt - REFRESH_SKEW_SECONDS) * 1000 <= Date.now();

  /* ---------- refresh ----------
     SINGLE-FLIGHT, and it has to be. Supabase rotates refresh tokens and the
     old one is consumed by the first use, so two concurrent refreshes would
     mean the second presenting a token the first had already spent. `refreshing`
     is assigned with no `await` between the check and the assignment, so two
     callers cannot both get past it; the second awaits the first one's promise
     and sees the same outcome.

     FAIL CLOSED, ON EVERY AMBIGUITY. A refresh either produces a complete,
     rotated, same-user, aal2 session or it produces nothing:

       · a rotated refresh token is REQUIRED. Keeping the held one as a
         fallback would keep a token the server has already consumed, and the
         next refresh would fail for a reason that looks like something else;
       · the user must be the same one. A different subject is not this
         operator's session however valid it is;
       · aal2 is re-confirmed server-side, so a silently demoted session is a
         refusal here rather than a 403 halfway through a resolution;
       · a throw is a failure, not a retry.

     ATOMIC. `session` is replaced by ONE assignment of a fully built object,
     so there is no window in which the new access token sits beside the old
     refresh token. On any failure that one assignment is `null`. */
  const refresh = async () => {
    if (!session || !session.refreshToken) { session = null; return false; }
    if (refreshing) return refreshing;

    const held = session;
    refreshing = (async () => {
      let next = null;
      try {
        const { status, body } = await post('/session/refresh',
          { refreshToken: held.refreshToken });
        const issued = (status === 200 && body && body.session) ? body.session : null;
        const sameUser = Boolean(issued && issued.userId)
          && (!held.userId || issued.userId === held.userId);
        if (issued && issued.accessToken && issued.refreshToken && sameUser) {
          next = {
            accessToken: issued.accessToken,
            refreshToken: issued.refreshToken,
            expiresAt: Number(issued.expiresAt) || null,
            userId: issued.userId
          };
        }
      } catch {
        /* An ambiguous failure is a failure. The request may or may not have
           reached the server, so the token in hand may or may not still be
           good — and a token that may not be good is not one to keep. */
        next = null;
      }
      session = next;
      return next !== null;
    })();

    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  };

  const getAccessToken = async () => {
    if (!session) return null;
    if (expiringSoon() && !(await refresh())) return null;
    return session ? session.accessToken : null;
  };

  const currentUserId = () => (session ? session.userId : null);

  /* ---------- sign out ----------
     Local state goes first and unconditionally, so a network failure cannot
     leave the page believing it is still signed in. Revoking the refresh
     token is best effort on top of that. */
  const signOut = async () => {
    const held = session;
    session = null;
    if (held && held.refreshToken) {
      try {
        await post('/session/signout', {
          refreshToken: held.refreshToken, accessToken: held.accessToken
        });
      } catch { /* the browser has already forgotten it */ }
    }
  };

  /* Synchronous local clear, for the 401 path: the token the server has just
     refused must not be sent again, and asking the server about it would only
     produce a second failure that reads like a different problem. */
  const clear = () => { session = null; };

  window.CED_STAFF_AUTH = {
    signIn, signOut, clear, refresh, getAccessToken, currentUserId,
    StaffAuthError
  };
})();
