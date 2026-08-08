/* ============================================================
   Staff console — identity resolution
   ------------------------------------------------------------
   Classic script, no build step, same as every other page here.
   What is NOT the same: this page is served over HTTPS behind
   authentication and is exempt from the file:// rule, because a
   secure auth callback cannot come from a local file.

   The browser's whole job:

     · sign in through Supabase Auth, including the second factor;
     · send the access token to the staff route;
     · render what the route returns;
     · send a case id, a target id, a note and — when required —
       an explicit override.

   It never reads an identity table, never calls a privileged
   function, and never sees an identifier value: every value the
   queue shows was masked in SQL before it left the database.
   ============================================================ */

(() => {
  'use strict';

  const API = (window.CED_STAFF_API || '/api/staff/identity-resolution');
  const PAGE_SIZE = 25;

  const $ = id => document.getElementById(id);
  const show = (el, on) => { if (el) el.hidden = !on; };
  const text = (el, value) => { if (el) el.textContent = value == null ? '' : String(value); };

  /* The production adapter, set by auth.js, which index.html loads first.
     The guard is a last resort for a page whose auth.js failed to load — it
     is not a deployment mode: a deployed page always has one. */
  const auth = window.CED_STAFF_AUTH || null;

  let signedIn = false;
  let offset = 0;
  let total = 0;
  let currentCase = null;
  let lastFocused = null;
  let queueDirty = false;

  /* WHO DECIDES WHETHER THIS IS AN OVERRIDE.

     'auto'      — nobody has been told otherwise; the heuristic below guesses
                   from the case evidence, which is what the operator sees.
     'required'  — the SERVER said this link contradicts the record. Its
                   verdict is the authoritative one: it re-ran the conflict
                   rule against the record as it is NOW, which is something
                   this page cannot do.
     'forbidden' — the server said there is nothing here to override.

     Before this existed the flag was read straight off the visibility of a
     div, so a disagreement between the page's guess and the server's verdict
     was unrecoverable in both directions: an operator who got
     `material_conflict` had no control that could reveal the override, and
     one who got `override_not_applicable` had no control that could dismiss
     it. Either way the case became permanently unresolvable through the only
     surface that can resolve it. */
  let overrideMode = 'auto';

  /* ---------- the resolution attempt ----------
     ONE IDEMPOTENCY KEY PER PAYLOAD, held until that payload is finished with.

     The previous version minted a UUID inside the submit handler and called it
     "reused verbatim on retry" in a comment. It was not: every press of the
     button produced a new one, so the one case the ledger exists for — a
     request that timed out, may or may not have committed, and is sent again
     by the operator — arrived as a second, unrelated request. Nothing was ever
     resolved twice (the case lock and irr_one_per_case refuse that), but the
     retry came back `case_already_resolved` instead of replaying the outcome
     that was actually recorded, which is the difference between an idempotent
     API and one that merely cannot be made to corrupt anything.

     `key` is every input that changes what would be written. It includes the
     NOTE, which the server's request hash deliberately does not: reusing an id
     with an edited note would be a legitimate replay by the server's rule and
     the new note would be silently discarded, so the note has to force a new
     id here instead.

     The attempt is cleared when it is finished — on success, on opening any
     case, and on leaving the panel. Anything else changes `key` and mints a
     new id by itself. Nothing here retries: the operator presses the button. */
  let attempt = null;   /* { key, requestId } */

  const attemptKey = payload => JSON.stringify([
    payload.caseId, payload.targetBusinessId,
    payload.overrideConflict === true, payload.overrideReason || null,
    payload.note
  ]);

  /* Returns the id for this payload, minting one only when the payload is not
     the one the held id belongs to. */
  const requestIdFor = payload => {
    const key = attemptKey(payload);
    if (!attempt || attempt.key !== key) {
      attempt = { key, requestId: window.crypto.randomUUID() };
    }
    return attempt.requestId;
  };

  const clearAttempt = () => { attempt = null; };

  /* ---------- small helpers ---------- */

  const age = seconds => {
    const s = Number(seconds) || 0;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };

  const listTypes = types =>
    (Array.isArray(types) && types.length) ? types.join(', ') : '—';

  /* The token is asked for per request rather than held here, so the adapter
     can refresh it before expiry. A session that can no longer produce one is
     reported as a 401, which is the same thing the server would have said and
     routes into the same recovery. */
  const api = async (path, options = {}) => {
    if (!signedIn || !auth) throw new Error('not_signed_in');
    const token = await auth.getAccessToken();
    if (!token) return { status: 401, body: null };
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  const fail = (el, message) => { text(el, message); show(el, true); };
  const clear = el => { text(el, ''); show(el, false); };

  /* Returns the page to the signed-out state without asking the server
     anything. Used when the server says the token is no longer good: keeping
     a dead token in memory only produces a second failure that reads like a
     different problem. */
  function signOutLocally(message) {
    signedIn = false;
    if (auth) auth.clear();
    currentCase = null;
    overrideMode = 'auto';
    clearAttempt();
    show($('who'), false);
    show($('queue'), false);
    show($('detail'), false);
    show($('signin'), true);
    if (message) fail($('signin-error'), message);
    if ($('email')) $('email').focus();
  }

  /* True when the response says this session is no longer authenticated, as
     opposed to not permitted to do this one thing. 403 is deliberately NOT
     included: a revoked operator is still signed in, and throwing them back
     to a sign-in form they can complete successfully would be a lie. */
  const isSignedOut = status => status === 401;

  /* ---------- sign in ---------- */

  const signInForm = $('signin-form');
  if (signInForm) {
    signInForm.addEventListener('submit', async event => {
      event.preventDefault();
      clear($('signin-error'));
      clear($('signin-enrollment'));
      if (!auth) {
        return fail($('signin-error'),
          'The sign-in component did not load. Reload the page; if it happens again '
          + 'this deployment is incomplete.');
      }
      const submit = $('signin-submit');
      submit.disabled = true;
      try {
        const result = await auth.signIn({
          email: $('email').value.trim(),
          password: $('password').value,
          totp: $('totp') ? $('totp').value.trim() : ''
        });
        if (result && result.needsSecondFactor) {
          show($('totp-field'), true);
          $('totp').focus();
          return fail($('signin-error'), 'Enter the six-digit code from your authenticator app.');
        }
        if (!result || !result.accessToken) {
          return fail($('signin-error'), 'Sign-in failed. Check your details and try again.');
        }
        signedIn = true;
        /* The password is not left sitting in the DOM once it has been used. */
        $('password').value = '';
        if ($('totp')) $('totp').value = '';
        text($('who-id'), result.userId);
        show($('who'), true);
        show($('signin'), false);
        await loadQueue();
      } catch (err) {
        /* No verified authenticator is a PROVISIONING problem, and telling
           somebody to check their details would send them round a loop they
           cannot get out of. It is stated separately, and it names who can
           fix it. The queue stays closed either way. */
        if (err && err.code === 'mfa_enrollment_required') {
          return fail($('signin-enrollment'), err.message);
        }
        if (err && err.code === 'auth_unavailable') {
          return fail($('signin-error'), err.message);
        }
        fail($('signin-error'),
          (err && err.code === 'rate_limited' && err.message)
          || 'Sign-in failed. Check your details and try again.');
      } finally {
        submit.disabled = false;
      }
    });
  }

  const signOut = $('sign-out');
  if (signOut) {
    signOut.addEventListener('click', async () => {
      signedIn = false;
      currentCase = null;
      clearAttempt();
      show($('who'), false);
      show($('queue'), false);
      show($('detail'), false);
      show($('signin'), true);
      $('email').focus();
      /* The page is already signed out; revoking the refresh token server-side
         is what happens next, not what this waits on. */
      if (auth && auth.signOut) { try { await auth.signOut(); } catch { /* ignore */ } }
    });
  }

  /* ---------- the queue ---------- */

  async function loadQueue() {
    show($('detail'), false);
    show($('queue'), true);
    const { status, body } = await api(`/cases?limit=${PAGE_SIZE}&offset=${offset}`);
    const table = $('queue-table');
    const tbody = $('queue-body');
    tbody.replaceChildren();

    if (isSignedOut(status)) {
      return signOutLocally('Your session has expired. Sign in again to continue.');
    }

    if (status !== 200 || !body || !body.ok) {
      show(table, false);
      show($('queue-empty'), true);
      text($('queue-empty'), (body && body.message) || 'The queue could not be loaded.');
      return;
    }

    total = Number(body.total) || 0;
    const cases = body.cases || [];
    text($('queue-summary'), `${total} open case${total === 1 ? '' : 's'}.`);

    if (!cases.length) {
      show(table, false);
      show($('pager'), false);
      show($('queue-empty'), true);
      text($('queue-empty'), 'No open cases. Nothing is waiting on a person.');
      return;
    }

    show($('queue-empty'), false);
    show(table, true);

    cases.forEach(c => {
      const tr = document.createElement('tr');
      const cell = (value, cls) => {
        const td = document.createElement('td');
        td.textContent = value;
        if (cls) td.className = cls;
        tr.appendChild(td);
        return td;
      };
      cell(c.submittedLabel || '—');
      cell(age(c.ageSeconds));
      cell(c.reviewType === 'service_mix' ? 'Service Mix' : 'Growth');
      cell(c.escalationReason || '—');
      cell(`agrees: ${listTypes(c.agreedTypes)} · differs: ${listTypes(c.contradictedTypes)}`);
      cell(c.resolvable ? String(c.candidateCount) : `${c.candidateCount} (not resolvable yet)`);

      const actions = document.createElement('td');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn--quiet';
      open.textContent = 'Open';
      open.setAttribute('aria-label', `Open the case submitted as ${c.submittedLabel || 'an unnamed business'}`);
      open.addEventListener('click', () => { lastFocused = open; openCase(c.caseId); });
      actions.appendChild(open);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    text($('page-label'), `Page ${page} of ${pages}`);
    show($('pager'), pages > 1);
    $('prev').disabled = offset === 0;
    $('next').disabled = offset + PAGE_SIZE >= total;
  }

  if ($('prev')) $('prev').addEventListener('click', () => {
    offset = Math.max(0, offset - PAGE_SIZE); loadQueue();
  });
  if ($('next')) $('next').addEventListener('click', () => {
    offset = offset + PAGE_SIZE; loadQueue();
  });
  if ($('back')) $('back').addEventListener('click', async () => {
    show($('detail'), false);
    show($('queue'), true);
    /* Leaving the panel is abandoning the attempt. */
    clearAttempt();
    /* A case resolved a moment ago is still in the list behind this panel.
       Refetching is what stops an operator opening it again and being told,
       correctly but confusingly, that it is already resolved. */
    if (queueDirty) { queueDirty = false; await loadQueue(); }
    if (lastFocused) lastFocused.focus();
  });

  /* ---------- case detail ---------- */

  async function openCase(caseId) {
    clear($('detail-error'));
    clear($('detail-ok'));
    const { status, body } = await api(`/cases/${caseId}`);
    if (isSignedOut(status)) {
      return signOutLocally('Your session has expired. Sign in again to continue.');
    }
    if (status !== 200 || !body || !body.ok) {
      return fail($('detail-error'), (body && body.message) || 'The case could not be loaded.');
    }

    currentCase = body.case;
    /* A fresh case carries no server verdict yet, and no attempt in progress:
       an id belongs to one decision about one case and may never be carried
       onto another. */
    overrideMode = 'auto';
    clearAttempt();
    resetOverrideControls();
    show($('queue'), false);
    show($('detail'), true);

    const facts = $('submitted-facts');
    facts.replaceChildren();
    const fact = (term, value) => {
      const dt = document.createElement('dt'); dt.textContent = term;
      const dd = document.createElement('dd'); dd.textContent = value == null ? '—' : String(value);
      facts.append(dt, dd);
    };
    const sub = currentCase.submitted || {};
    fact('Business name', sub.label);
    fact('Email', sub.email);       /* already masked in SQL */
    fact('Mobile', sub.mobile);
    fact('Review type', currentCase.reviewType === 'service_mix' ? 'Service Mix' : 'Growth');
    fact('Submitted', sub.submittedAt);
    fact('Confidence', currentCase.confidence);

    text($('stop-reason'), (currentCase.conflicts && currentCase.conflicts[0]
      && currentCase.conflicts[0].reason)
      || 'No unique verified strong identifier among the candidates.');

    const conflicts = $('conflict-list');
    conflicts.replaceChildren();
    (currentCase.conflicts || []).forEach(c => {
      const li = document.createElement('li');
      li.textContent =
        `${c.kind}: agrees on ${listTypes(c.agreedTypes)}; differs on ${listTypes(c.contradictedTypes)}`;
      conflicts.appendChild(li);
    });

    const warn = $('detail-warn');
    const merged = (currentCase.candidates || []).filter(c => c.mergedAway);
    if (merged.length) {
      text(warn, `${merged.length} candidate record${merged.length === 1 ? ' has' : 's have'} been merged away and cannot be linked. Resolve against the surviving record instead.`);
      show(warn, true);
    } else { show(warn, false); }

    const box = $('candidates');
    box.replaceChildren();
    const candidates = currentCase.candidates || [];

    if (!currentCase.resolvable || !candidates.length) {
      show($('candidates-set'), false);
      show($('resolve'), false);
      /* The note is part of resolving. Leaving it on screen with nothing to
         submit it invites somebody to type an explanation into a field that
         will never be read. */
      show($('note-field'), false);
      $('note').value = '';
      $('note').disabled = true;
      show($('override'), false);
      show($('no-candidates'), true);
      text($('no-candidates'), currentCase.unsupportedReason
        || 'This case names no candidate Business Record, so it cannot be resolved here yet.');
      return;
    }
    show($('no-candidates'), false);
    show($('candidates-set'), true);
    show($('note-field'), true);
    $('note').disabled = false;
    show($('resolve'), true);

    candidates.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'candidate';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'target';
      input.value = c.businessId;
      input.id = `cand-${i}`;
      input.disabled = c.mergedAway === true;
      const label = document.createElement('label');
      label.setAttribute('for', input.id);
      const prior = (c.priorReviews || [])
        .map(p => `${p.reviewType === 'service_mix' ? 'Service Mix' : 'Growth'} ×${p.completedCount}`)
        .join(', ') || 'no prior reviews';
      /* Why this record is on the list at all. A record that shares an
         identifier and a record a saved pointer named are different kinds of
         claim, and the operator is choosing between them. */
      const why = c.provenance === 'proposal_vetoed'
        ? 'a saved pointer named it, and the submission contradicted it'
        : c.provenance === 'proposals_disagreed'
          ? 'one of two saved pointers that disagreed'
          : `matches on ${listTypes(c.matchedTypes)}`;
      label.textContent = c.mergedAway
        ? `${c.label} — merged away, cannot be linked`
        : `${c.label} — ${why}; ${prior}`;
      input.addEventListener('change', () => {
        /* A server verdict is about ONE record. Choosing a different one
           makes it stale, so the page goes back to guessing rather than
           carrying the previous answer onto a target it was never about. */
        overrideMode = 'auto';
        resetOverrideControls();
        clear($('detail-error'));
        updateOverrideVisibility();
      });
      row.append(input, label);
      box.appendChild(row);
    });

    updateOverrideVisibility();
    $('note').value = '';
    $('back').focus();
  }

  /* Puts the override controls back to unanswered. Called whenever the
     question changes — a new case, a new target, or a server verdict that
     replaces the page's guess. An override must be chosen deliberately for
     the request it is actually attached to, so a reason left selected from a
     previous attempt is cleared rather than carried forward. */
  function resetOverrideControls() {
    if ($('override-reason')) $('override-reason').value = '';
    if ($('override-confirm')) $('override-confirm').checked = false;
    show($('override-required'), false);
  }

  /* The override block appears only when the chosen record actually
     contradicts the submission.

     The SERVER is the authority: it re-runs the conflict rule against the
     record as it stands now, which is something this page cannot do from
     evidence captured when the case was queued. `overrideMode` is how a
     verdict it has already given overrules the guess below. */
  function updateOverrideVisibility() {
    const chosen = document.querySelector('input[name="target"]:checked');
    if (!chosen || !currentCase) return show($('override'), false);
    if (overrideMode === 'required') return show($('override'), true);
    if (overrideMode === 'forbidden') return show($('override'), false);
    const candidate = (currentCase.candidates || [])
      .find(c => c.businessId === chosen.value) || {};
    const contradicted = (currentCase.conflicts || [])
      .some(c => (c.contradictedTypes || []).length > 0);
    const agrees = (candidate.matchedTypes || []).length > 0;
    /* A record a contradicted proposal named is contradicted by definition —
       that is why the proposal was set aside — so the override is expected
       there. The server decides in the end; this is the interface saying in
       advance what it is about to ask for. */
    const vetoed = candidate.provenance === 'proposal_vetoed';
    show($('override'), (contradicted && !agrees) || vetoed);
  }

  /* ---------- resolve ---------- */

  const resolveForm = $('resolve-form');
  if (resolveForm) {
    resolveForm.addEventListener('submit', async event => {
      event.preventDefault();
      clear($('detail-error'));
      clear($('detail-ok'));

      const chosen = document.querySelector('input[name="target"]:checked');
      if (!chosen) return fail($('detail-error'), 'Choose the record this review belongs to.');
      const note = $('note').value.trim();
      if (note.length < 8) return fail($('detail-error'), 'Write a short resolution note first.');

      const overriding = !$('override').hidden;
      let overrideReason = null;
      if (overriding) {
        overrideReason = $('override-reason').value || null;
        if (!overrideReason) return fail($('detail-error'), 'Choose why this link is correct.');
        if (!$('override-confirm').checked) {
          return fail($('detail-error'), 'Confirm the override before linking.');
        }
        if (overrideReason === 'other_verified_evidence' && note.length < 40) {
          return fail($('detail-error'),
            'Other verified evidence needs a fuller explanation — at least 40 characters.');
        }
      }

      /* There is no fallback. The previous one produced `String(Date.now())`,
         which is not a UUID, so the server refused it with a message about a
         request id that the operator had no way to act on. A browser without
         crypto.randomUUID is told plainly that it cannot be used for this. */
      if (!(window.crypto && typeof window.crypto.randomUUID === 'function')) {
        return fail($('detail-error'),
          'This browser cannot generate the secure request id this action needs. '
          + 'Use a current version of Chrome, Edge, Firefox or Safari over HTTPS.');
      }

      const payload = {
        caseId: currentCase.caseId,
        targetBusinessId: chosen.value,
        note,
        overrideConflict: overriding,
        overrideReason
      };
      /* The same payload keeps the same id, so a retry the operator chooses to
         make after a timeout replays rather than colliding. A changed target,
         override or note is a different decision and gets a different id. */
      const requestId = requestIdFor(payload);

      const btn = $('resolve');
      /* Disabled for the whole flight, so a double-click cannot produce a
         second request at all — the shared id makes a duplicate harmless, and
         this makes it impossible. */
      btn.disabled = true;
      try {
        const { status, body } = await api(`/cases/${currentCase.caseId}/link`, {
          method: 'POST',
          body: JSON.stringify({
            targetBusinessId: payload.targetBusinessId,
            resolutionRequestId: requestId,
            note: payload.note,
            overrideConflict: payload.overrideConflict,
            overrideReason: payload.overrideReason
          })
        });

        if (status === 200 || status === 201) {
          text($('detail-ok'), body.resolution && body.resolution.replayed
            ? 'Already resolved — this is the outcome that was recorded.'
            : 'Linked. The review is attached to that record.');
          show($('detail-ok'), true);
          show($('resolve'), false);
          /* The attempt is over. Holding its id after it succeeded would let a
             later, different decision inherit it. */
          clearAttempt();
          queueDirty = true;
          return;
        }

        if (isSignedOut(status)) {
          return signOutLocally('Your session has expired. Sign in again to continue.');
        }

        /* ---------- the two ways the page and the server can disagree ----------

           NOTHING IS RESENT AUTOMATICALLY. This attaches a review to a
           Business Record permanently, in tables that refuse UPDATE and
           refuse DELETE. A retry the operator did not ask for is a decision
           the operator did not take. Each branch corrects the form, says what
           changed, and stops — the operator presses the button again, or
           does not. */
        const code = body && body.code;

        if (code === 'material_conflict') {
          /* The record contradicts the submission NOW, whatever the case
             evidence suggested when it was queued. Ask for the override the
             server is going to require, from scratch. */
          overrideMode = 'required';
          resetOverrideControls();
          show($('override-required'), true);
          updateOverrideVisibility();
          fail($('detail-error'),
            'This record contradicts the submission, so linking it needs a documented override. '
            + 'Choose a reason and confirm below, then link again.');
          if ($('override-reason')) $('override-reason').focus();
          return;
        }

        if (code === 'override_not_applicable') {
          /* Nothing to override. Take the controls away so the next attempt
             cannot carry an override the server will refuse again. */
          overrideMode = 'forbidden';
          resetOverrideControls();
          updateOverrideVisibility();
          fail($('detail-error'),
            'This record does not contradict the submission, so no override is needed. '
            + 'Link again to attach it without one.');
          if ($('resolve')) $('resolve').focus();
          return;
        }

        fail($('detail-error'), (body && body.message) || 'The resolution was refused.');
      } catch (err) {
        fail($('detail-error'), 'The resolution could not be sent. Try again.');
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ---------- the test harness seam ----------
     The browser suite signs in through the REAL form and the REAL adapter,
     against a stubbed fetch — there is no test-only sign-in path, and no way
     to put an arbitrary string where a session goes. What is left here is
     navigation: opening a case by id and reloading the queue, so a test can
     reach a panel without depending on which row happens to be first.

     Gated all the same. The flag has to be set before this script runs, which
     only the suite's `evaluateOnNewDocument` can do, so a deployed page has no
     `window.CEDStaffConsole` at all. */
  if (window.CED_STAFF_TEST_HARNESS === true) {
    window.CEDStaffConsole = { openCase, reload: loadQueue };
  }
})();
