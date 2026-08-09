# Staff identity resolution — operations runbook

How a person is given access to the identity-resolution queue, and how that
access is taken away again.

Everything here is a **service-role operation performed deliberately by a
named human**. There is no self-registration, no invite link that grants
staff access by itself, and no browser control anywhere that creates an
operator. That is not an omission to be fixed later; it is the design. The
queue attaches one business's review to another business's Business Record,
permanently, in tables that refuse `UPDATE` and refuse `DELETE`.

> **Nothing in this document claims compliance with any law or regulation.**
> Consent wording and retention policy remain pending professional review.

---

## 1. What guards the queue

Seven things, checked in this order on **every** request. None of them is
optional and none is inferable from any of the others. (The `/session`
endpoints stop after check 3, by definition: they are how a token comes to
exist. They carry their own tighter budget instead — see section 6.)

| # | Check | Where | What it refuses |
|---|---|---|---|
| 1 | HTTPS | `server/staff-identity-resolution.mjs` | An unencrypted request |
| 2 | Provenance (see below), then a JSON content type | `shared/security/origin.js` | Anything that is not the console |
| 3 | Pre-authentication rate limit, by address | `check_rate_limit` | A flood, before it can cost an Auth call |
| 4 | Signature-verified access token | Supabase Auth | A forged or expired token |
| 5 | Operator rate limit, by address and operator | `check_rate_limit` | One account hammering the queue |
| 6 | AAL2 | `staff_operator_guard` | A password without a second factor |
| 7 | Live `staff_operators` row | `staff_operator_guard` | Anyone not provisioned, or revoked |

Check 2 is **first among the ones that cost anything**, and that is the point.
A cross-origin `fetch` with `Content-Type: text/plain` is a CORS *simple*
request: there is no preflight to fail, so it arrives. The caller cannot read
the answer — but the request is still counted, and a few dozen of them from any
page an operator happens to open would lock that operator out of their own
console. Refusing it before the rate limiter, the body, Supabase and the
database means it costs nothing at all.

### What check 2 actually checks, and why it depends on the method

Browsers do not send `Origin` on every request, so a rule that demands one on
every request cannot be satisfied by a browser. Per the Fetch standard the
header is appended when a request's response tainting is `cors` **or** the
method is neither `GET` nor `HEAD`. A same-origin `fetch` keeps tainting
`basic`, so **a same-origin `GET` carries no `Origin`** — and adding an
`Authorization` header does not change it, because that forces a preflight
only when the request is cross-origin.

| Method | `Origin` present | `Origin` absent |
|---|---|---|
| `POST` (and any unsafe method) | exact-matched against the allowlist | **refused** — `origin_required` |
| `GET`, `HEAD` | exact-matched against the allowlist | accepted **only** on `Sec-Fetch-Site: same-origin` or `none` |

`Sec-Fetch-Site` is set by the browser and cannot be set by script, which is
what makes it usable as evidence. `same-site` is **not** accepted — it means
any host under the same registrable domain, and this console must not inherit
trust from whatever else is hosted beside it. A missing, malformed or
unrecognised value on an absent-`Origin` read is refused, not guessed at.

**An operator-visible failure came from getting this wrong.** The route
briefly required `Origin` on every method. Sign-in worked, because `POST`
carries one — and then the queue and every case read were refused
`403 origin_required`, so the console listed nothing and opened nothing. If
that symptom ever returns, this is the first thing to check, and
`tests/browser/staff-origin-headers.test.mjs` is the test that observes the
real headers rather than assuming them.

A client that is not a browser — an approved integration — is unaffected: it
states an exact `Origin` and is held to it exactly as before.

Check 3 is **before** check 4 deliberately. Verifying an access token means an
outbound HTTPS call to Supabase Auth, and an unauthenticated caller must not
be able to make the function issue one per request for as long as they like.
The pre-authentication pass has no operator to count against yet, so it counts
by address alone, in its own bucket — a legitimate request is never charged
twice to one counter.

Check 6 is a **row lookup on every call**, never a JWT claim. A token can
keep asserting whatever it asserted at sign-in for the rest of its lifetime;
the row is what makes revocation take effect on the next request rather than
the next token refresh.

The route calls `staff_operator_guard` **before it reads anything**, and each
privileged function calls it again inside its own transaction. The second
call is where the guarantee lives. The first is what stops a submission's
stored payload being read with the server credential on behalf of somebody
who turns out not to be an operator.

### Where the code lives

| | |
|---|---|
| Deployment entrypoint | `api/staff/identity-resolution/[...path].mjs` |
| Implementation | `server/staff-identity-resolution.mjs` |
| Browser auth adapter | `staff/identity-resolution/auth.js` |
| Console page | `staff/identity-resolution/index.html` + `page.js` |
| Onboarding page | `staff/identity-resolution/accept-invite.html` + `accept-invite.js` |
| Password-recovery page | `staff/identity-resolution/reset-password.html` + `reset-password.js` |
| Vendored client | `staff/vendor/supabase-js-2.112.0.umd.js` — see `staff/vendor/README.md` |

The implementation sits **outside `api/`** on purpose. Vercel deploys every
file under `api/` as its own function, so while it lived there the same
privileged route was deployed twice — once through the catch-all the console
calls, and once at its own bare path, absent from `vercel.json` and therefore
on platform defaults. One route, one function.

---

## 1a. How sign-in works

**The console page** (`index.html`) holds no Supabase client and no key. It
posts to three same-origin endpoints on the staff route, and the route makes
every Supabase Auth call with the publishable key, server-side:

| Endpoint | What the route does |
|---|---|
| `POST …/session` | `signInWithPassword`, then `mfa.listFactors`, then `mfa.challengeAndVerify` |
| `POST …/session/refresh` | `refreshSession`, and re-checks the new token is still `aal2` |
| `POST …/session/signout` | `setSession`, then `signOut({ scope: 'local' })` |

**Onboarding is the opposite arrangement, deliberately.** The onboarding page
talks to Supabase Auth **directly** with the publishable key, because the
password, the session tokens, the TOTP secret and the TOTP code must never
pass through a CED endpoint (CLAUDE.md §9). The route's only involvement is:

| Endpoint | What the route does |
|---|---|
| `GET …/auth-config` | returns `{ supabaseUrl, publishableKey }` — no body accepted, no credential returned, no database touched |

`publishableKey` is read through the same `lowPrivilegeKey` check the Auth
path uses, so a **secret key pasted into the publishable variable is refused**
and the endpoint answers `503 auth_unavailable` rather than serving an
elevated credential to a browser.

All three session endpoints are `POST`, so all three require an exact-matched
`Origin` — the
method-sensitive relaxation above applies to safe reads only and never to
these — and, because they carry a body, `Content-Type: application/json`. Both
are checked before any rate-limit bucket, body read, Supabase call or database
round trip. See section 6.

**Why the two pages differ.** The console's sign-in exchanges a password for a
bearer token that the route then uses on the operator's behalf, so the route
is already in that path and putting the Auth call there costs nothing extra.
Onboarding is not like that: it *creates* a password and a TOTP secret, and
those may never reach a CED endpoint at all. So the onboarding page carries
the supported client itself, vendored at `staff/vendor/` — vendored rather
than loaded from a CDN so `script-src` stays `'self'`, and byte-for-byte the
published build so it is a copy rather than a fork. Nothing is hand-rolled on
either page.

**The two-step form.** The first submit sends email and password only. If the
password is right and the account has a verified TOTP factor, the route
discards the `aal1` session — it is never parked anywhere between requests —
and answers `needsSecondFactor`, which reveals the code field. The second
submit sends all three, and the route returns an access token only after
confirming the `aal` claim on it is `aal2`.

### What "sign out" actually revokes

**Every sign-out this route performs is `{ scope: 'local' }`, and that is
deliberate.** `@supabase/supabase-js` signs out *globally* unless told
otherwise, which revokes every refresh token the account holds on every device.

| Situation | What is revoked | What is NOT |
|---|---|---|
| Password correct, code not yet supplied | the temporary `aal1` session just created | any session on any other device |
| Account has no verified authenticator | the temporary `aal1` session | anything else |
| Wrong six-digit code | the temporary `aal1` session | anything else |
| Verified, but the session did not reach `aal2` | that session | anything else |
| Any other incomplete post-password result | the session created for the attempt | anything else |
| A refresh that came back below `aal2` | the rotated session | anything else |
| The operator presses **Sign out** | this browser's session | the operator's session on any other machine |

Three of those sit on the ordinary sign-in path, which is why the default
mattered: somebody holding only the password could post it repeatedly and
evict the real operator from a live `aal2` session, over and over. The second
factor exists to make a stolen password insufficient, and the library's default
made it sufficient for that.

**Other valid device sessions are never revoked intentionally.** If you need to
end every session an account holds — a lost laptop, a departing operator — do
it deliberately in the Supabase Dashboard, as section 4 says.

**Revocation is not instantaneous, and it is not what protects the queue.** An
access token stays cryptographically valid until it expires; Supabase revokes
the *refresh* token. What stops a revoked operator working the queue is not
token expiry but the two checks that run on every single request: the `aal2`
claim, and a live `staff_operators` row lookup. Disable the row and the very
next request is refused, whatever token the caller is still holding.

**Token lifetime.** The access token, its refresh token and its expiry live in
memory in `auth.js` for the life of the page. Nothing is written to
`localStorage`, `sessionStorage` or a cookie, so a reload signs the operator
out. The adapter refreshes 60 seconds before expiry, *before* sending a
request rather than after a failure — the one POST this console makes attaches
a review permanently, and an automatic resend is a decision the operator did
not take. A refresh that comes back at `aal1` is refused rather than carried.

**On a 401** the console clears the session it holds and returns to sign-in.
On a **403** it does not: a revoked operator is still signed in, and sending
them to a form they can complete successfully would be a lie.

**No verified authenticator** is answered with `403 mfa_enrollment_required`
and a message naming the owner who can complete enrollment. There is no
enrollment control, no registration control, and no self-service path anywhere
on the page.

---

## 2. Provisioning the first operator

There is a chicken-and-egg problem and it is solved once, explicitly.

`staff_operators.created_by` records which operator created another. The
first operator has no creator, and the table's own
`staff_operators_no_self_creation` constraint refuses a row that claims to
have created itself. So the first row is the only one that legitimately has
`created_by = null`, and `bootstrap_staff_owner` is the only supported way to
write it.

### 2.0 One-time project setup

Four steps, all required before the first invitation is sent. Three are
dashboard settings; one is a one-line edit to `vercel.json`.

**Set `SUPABASE_URL` on every environment that serves the console.** There is
nothing to edit in `vercel.json` and no placeholder to replace: the
onboarding page's `connect-src` is **generated at build time** from this one
variable, by `tools/build-static.mjs`, using the same validator
`GET /auth-config` uses — so the origin the page is told to call and the
origin it is permitted to reach cannot disagree.

Vercel Project Settings → **Environment Variables** → `SUPABASE_URL`, set
**separately for Production and for Preview**, each to its own project:

| Environment | `SUPABASE_URL` |
|---|---|
| Preview | the development project — currently `https://qkpptajglstgucadhfwq.supabase.co` |
| Production | the production project's own origin, which is **not** the development one |

The Preview value above is this repository's development project and is given
as an **example of the shape**. Nothing defaults to it: a build with no
`SUPABASE_URL` fails, and a Preview deployment that inherited a Production
value would be a preview pointed at production data.

**What the build accepts**, and refuses with a failed build otherwise: an
absolute `https` URL, one exact `<ref>.supabase.co` host, no credentials, no
path beyond `/`, no query, no fragment, no port, no whitespace, and nothing
shaped like a Supabase key. A wildcard is not expressible — there is nowhere
to put one.

**It fails closed at every stage.** No variable, no build. A wrong origin
blocks sign-up rather than weakening anything. And the committed page carries
`connect-src 'self'` with no host at all, so an unbuilt copy reaches no
Supabase project rather than the wrong one.

**Enable TOTP.** Supabase Dashboard → **Authentication → Providers →
Multi-Factor Authentication** → enable **TOTP (App Authenticator)**. Without
it `mfa.enroll` fails, onboarding answers `502 enrollment_unavailable`, and
the invitation is already spent by then.

**Point the invitation email at the onboarding page.** Supabase Dashboard →
**Authentication → Email Templates → Invite user**. Replace the default link
with one that carries the *token hash* to this repository's own page:

```html
<h2>You have been invited</h2>
<p>You have been invited to the CED Service staff console. Follow the link
   below to set your password and add your authenticator app.</p>
<p><a href="{{ .SiteURL }}/staff/identity-resolution/accept-invite.html#token_hash={{ .TokenHash }}&type=invite">Accept the invitation</a></p>
<p>This link can be used once and expires. If it has expired, ask an owner to
   send a new one.</p>
```

**The invitation template uses `{{ .SiteURL }}`, and that is deliberate — but
it is a constraint, not a free choice.** An invitation is created from the
Dashboard by an owner. Nothing in this repository calls
`inviteUserByEmail`, so **no `redirectTo` is ever supplied for an
invitation**, and `{{ .RedirectTo }}` would render empty — producing a link to
`/staff/identity-resolution/accept-invite.html` with no host at all.
`{{ .SiteURL }}` is the only value available.

**What that constrains.** `{{ .SiteURL }}` is a per-project setting, so an
invitation always lands on **whichever host that project's Site URL names**.
Two things follow, and both must hold:

- **Preview and Production must be different Supabase projects** — which they
  already are, because they are different `SUPABASE_URL` values (see above).
  One project's Site URL then correctly serves one environment.
- **A per-deployment Vercel preview URL will not receive invitations.** Site
  URL is one value; a branch deployment's generated hostname is not it. Invite
  against the stable host that Site URL names, or change Site URL first. This
  is the one flow in the subsystem that cannot be environment-derived from the
  browser, precisely because no browser is involved in creating it.

If invitations are ever created from code with an explicit `redirectTo` — via
the admin `inviteUserByEmail` — this template **must** change to
`{{ .RedirectTo }}` at the same time, for exactly the reason the recovery
template already does.

**Note the `#`, not a `?`. This matters and is not cosmetic.** A fragment is
never transmitted: it is absent from the request line of the page load, from
every subresource request, and from any `Referer`. A query string is the
opposite — the invitation token would be in the very first `GET` for the page,
in the access log, before a single line of page JavaScript had run, and no
amount of care afterwards could take it back. The page **refuses** a
`token_hash` offered in the query for exactly that reason: by the time it
could use one, it has already leaked.

On top of that the page removes the fragment with `history.replaceState`
before its first network call, so it survives into no history entry or
bookmark either, and declares `Referrer-Policy: no-referrer`.

**Why `{{ .TokenHash }}` and not the default `{{ .ConfirmationURL }}`.** The
default routes the browser through Supabase's own `/auth/v1/verify`, which
redirects back with a live session in the URL. A single-use token is a smaller
thing to have leak than a session, and `{{ .TokenHash }}` is what lets the
page call `verifyOtp({ token_hash, type: 'invite' })` itself.

**Point the password-reset email at the recovery page**, and for the same
reason. Supabase Dashboard → **Authentication → Email Templates → Reset
password**:

```html
<h2>Set a new password</h2>
<p>Follow the link below to choose a new password for your CED Service staff
   account.</p>
<p><a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=recovery">Set a new password</a></p>
<p>This link can be used once and expires. If you did not ask for it, you can
   ignore this email.</p>
```

**`{{ .RedirectTo }}`, NOT `{{ .SiteURL }}`, and no path appended to it.**
This is the difference between the two templates and it is load-bearing.

Unlike an invitation, a password reset **is** requested from a browser:
`accept-invite.js` calls `resetPasswordForEmail(email, { redirectTo })` with
the **complete, exact, same-origin recovery URL** — `window.location.origin`
plus `/staff/identity-resolution/reset-password.html`. Supabase carries that
value into the template as `{{ .RedirectTo }}`.

So the template must *consume* it. Building the link from `{{ .SiteURL }}`
would throw the browser's own environment away and send every recovery email
to whichever host the project's Site URL names — a Preview reset landing on
Production, or on a host the person never used. And because the application
already supplies the whole URL, **appending
`/staff/identity-resolution/reset-password.html` to `{{ .RedirectTo }}` would
double the path** and produce a 404.

**Allow the recovery redirect URL.** Supabase Dashboard → **Authentication →
URL Configuration → Redirect URLs** → add the exact recovery page, for every
environment that serves the console:

```
https://<your-deployment-host>/staff/identity-resolution/reset-password.html
```

Supabase refuses a `redirectTo` that is not on this list — and when it refuses
one it falls back to the Site URL, which is exactly the wrong-host outcome
this template avoids. Add the exact path for each environment. A wildcard is
not needed and should not be used.

Also set **Authentication → URL Configuration → Site URL** to the deployment's
origin. The **invitation** link depends on it entirely, and a wrong value
sends invitations to `localhost`. The recovery link does not depend on it,
provided its redirect URL is allowed as above.

### 2.1 Invite the person through Supabase Auth

Supabase Dashboard → **Authentication → Users → Invite user**. Use their work
email address.

Do **not** create a password on their behalf and do not share one. You cannot:
the invited person sets it themselves in step 2.2, and there is no path by
which an owner learns it.

### 2.2 They accept the invitation, set a password, and enroll TOTP

They open the link from the email. It lands on
`/staff/identity-resolution/accept-invite.html`.

**The credentials never touch CED.** This page talks to Supabase Auth
**directly**, with the supported client and the *publishable* key. The
password, the session tokens, the TOTP secret, the `otpauth://` URI and the
six-digit code go from the browser to Supabase and nowhere else. CLAUDE.md §9
forbids this platform from transmitting or storing credentials, and the only
CED request the page makes is a `GET …/auth-config` for the project URL and
the publishable key — neither of which is a secret.

The page does three things:

1. **Accepts the invitation.** It reads `token_hash` from the URL **fragment**
   — never the query, which it refuses — removes it with
   `history.replaceState` before any network call, and calls
   `verifyOtp({ token_hash, type: 'invite' })`. The type is **hard-coded in
   the page**; a recovery, signup, magic-link or email-change token presented
   here never enters the flow.
2. **Sets their password.** `updateUser({ password })`, minimum **12
   characters**, checked in the page before the invitation is spent so a short
   password costs a retry rather than an invitation.
3. **Enrolls an authenticator.** `mfa.enroll({ factorType: 'totp' })`, then
   `mfa.challengeAndVerify({ factorId, code })`. The setup key is added to the
   authenticator app **by typing it** — there is deliberately no QR image,
   because the staff CSP is `default-src 'none'` with no `img-src`, and
   widening a verified security header to render a convenience is the wrong
   trade. Every common authenticator app supports manual key entry.

**What this page cannot do.** It cannot create an account: without a
`token_hash` Supabase minted for a specific invited address, the only thing on
offer is the recovery form, which is a password sign-in against an account
that must already exist. It cannot write `staff_operators` — the publishable
key cannot see the table, because RLS is enabled and **forced** with no
policies and every grant to `anon` and `authenticated` is revoked. And it
grants no console access: the session is signed out when enrollment finishes.

**If they are interrupted after the password step**, they do **not** need a
new invitation — see §2.2a. Supabase cannot re-invite an already-created user
anyway.

**The email must still be confirmed**, and accepting the invitation is what
confirms it. Three separate things refuse an unconfirmed account:

- `bootstrap_staff_owner` checks `auth.users.email_confirmed_at`
- the staff route refuses with `403 email_unconfirmed`
- Supabase itself will not issue a session

### 2.2a Recovery — an interrupted set-up

**Two situations, and they need different answers.**

*They already set a password* and were then interrupted before finishing the
authenticator step. Use the password path below.

*They may never have got a password at all.* Accepting an invitation is two
calls against Supabase: the invitation is consumed, then the password is
created. **Between them the account exists with no usable password.** If the
tab closed, the network dropped, or the password step failed or its answer was
lost, they hold a real account they cannot sign in to — and the invitation is
spent and cannot be reissued, because Supabase will not invite a user that
already exists. **They cannot tell which happened**, and neither can you: a
lost response looks exactly like a failure.

The answer to the second case is a **password reset**, which depends on the
account rather than on the invitation and therefore works in every one of
those states. It is on the same page: **"Send me a password reset"**. When in
doubt, use it — it is harmless if a password already existed.

**What they do.** Open `/staff/identity-resolution/accept-invite.html` with no
link parameters — the plain URL is enough — and choose **"Finish an
interrupted set-up"**. They sign in with the work email they were invited with
and the password they already chose. The page then resumes exactly where it
stopped:

- it lists their factors;
- it removes any **unverified** factor left behind by the abandoned attempt,
  because Supabase refuses a second factor with the same friendly name and
  without this the recovery would fail for the very person it is for;
- it enrolls a fresh factor and shows the new setup key;
- they enter the code and finish.

**What recovery does not do.** It grants nothing. Signing in with a password
and no verified factor produces an `aal1` session, which is enough to enroll a
factor and nothing else — `staff_operator_guard` requires exactly `aal2`, and
authorization additionally requires an active `staff_operators` row that this
page cannot create or see. The session is signed out when enrollment finishes.

**If the account already has a verified factor**, the page says so, signs out,
and points at the console. Recovery is not a second way in.

### The password-reset path, in full

1. On `accept-invite.html` with no link parameters, choose **"Send me a
   password reset"** and enter the work email.
2. The page calls `resetPasswordForEmail` **directly against Supabase**, with
   `redirectTo` set to the **complete same-origin recovery URL** —
   `window.location.origin` + `/staff/identity-resolution/reset-password.html`.
   The template renders that value as `{{ .RedirectTo }}`, so the email always
   points back at the environment the request came from. The answer is
   deliberately the same whether or not an account exists — whether an address is a staff
   account is not something an unauthenticated page may reveal, so "we sent
   it" is shown for an unknown address and for a failure to reach Supabase
   too.
3. The email lands on `reset-password.html` with the token in the **fragment**.
   That page verifies it with `verifyOtp({ type: 'recovery' })`, sets the new
   password with `updateUser`, signs out, and stops. **It enrolls no
   authenticator, writes no `staff_operators` row, and grants no queue
   access.**
4. They return to `accept-invite.html` → **"Finish an interrupted set-up"**
   with the new password, and enroll their authenticator as normal.

**When a new invitation IS the answer:** only when no account was ever
created — that is, the invitation link was never opened at all. Once
`verifyOtp` has run once, the account exists and a reset is the route.

### 2.3 Confirm the factor is verified

Enrollment without verification does not produce an `aal2` session, and
`staff_operator_guard` refuses anything that is not exactly `aal2` — including
an absent claim, which is treated as "not satisfied" rather than "not
mentioned". The onboarding page will not reach its final screen unless
`challengeAndVerify` returned a token that actually carries `"aal": "aal2"`,
which the route checks rather than assumes.

Confirm in the dashboard: **Authentication → Users** → the user → the factor is
listed and its status is **verified**.

### 2.4 Take the immutable Auth user UUID

Supabase Dashboard → **Authentication → Users** → the user → the **UID**
field. It is a UUID.

**Use the UUID, never the email address.** Email addresses change, get
reassigned, and are personal data with a retention rule of their own. An
actor identifier that can be reassigned is not one.

### 2.5 Create the row

Supabase Dashboard → **SQL Editor**, or any client connected with the service
role:

```sql
select public.bootstrap_staff_owner('00000000-0000-0000-0000-000000000000');
```

Returns:

```json
{ "ok": true, "bootstrapped": true, "userId": "…", "role": "owner", "createdAt": "…" }
```

What the function guarantees, all of them as refusals:

| Property | Behaviour |
|---|---|
| Only when the table is empty | `staff_bootstrap_already_done` once any operator exists |
| Auth user must exist and be confirmed | `staff_bootstrap_user_unconfirmed` |
| Exactly one row | `owner`, `active`, `created_by = null` |
| Idempotent for the identical sole operator | returns `"bootstrapped": false`, changes nothing |
| Competing bootstraps | serialised by an advisory transaction lock; one wins, the rest are refused |
| Reachability | `service_role` only. No `anon`, no `authenticated`, and no route calls it |

Running it a second time for the **same** user is safe. Running it for a
**different** user is refused — that is the point.

### 2.6 Confirm the guard actually holds

Do not assume. Check all four, in this order:

```sql
-- Provisioned, active, correct role.
select user_id, role, active, disabled_at, created_by
  from public.staff_operators;

-- AAL2 is required: this must RAISE staff_aal2_required.
select public.staff_operator_guard('<uuid>', 'aal1');

-- A stranger is refused: this must RAISE staff_not_an_operator.
select public.staff_operator_guard(gen_random_uuid(), 'aal2');

-- The real thing: this must return 'owner'.
select public.staff_operator_guard('<uuid>', 'aal2');
```

Then sign in at `/staff/identity-resolution/`: work email and password, then
the six-digit code when the field appears, and confirm the queue loads. If the
account has no verified authenticator the page says so explicitly and names
you as the person who can fix it — go back to step 2.2 and send a new
invitation.

**The order matters and it is not the intuitive one.** Onboarding (2.1–2.3)
comes *before* provisioning (2.5), because `bootstrap_staff_owner` requires a
confirmed `auth.users` row and the guard requires `aal2`. Between finishing
onboarding and running the bootstrap, the account exists, has a password, has
a verified authenticator — and is refused the queue with
`403 not_an_operator`. That is the system working, not a fault, and the
onboarding page says so on its final screen.

---

## 3. Provisioning later operators

Once an owner exists, further operators are ordinary rows created **by that
owner**, with `created_by` recorded. Steps 2.1 to 2.4 are unchanged — invite
them, they accept the invitation and enroll their authenticator through
`accept-invite.html`, then take the UUID. Step 2.0 is one-time project setup
and does not repeat.

The new operator will be refused the queue with `403 not_an_operator` between
finishing onboarding and the `insert` below. Tell them to expect it.

```sql
insert into public.staff_operators (user_id, role, active, created_by)
values (
  '<new operator UUID>',
  'identity_resolver',          -- or 'owner'
  true,
  '<the existing owner''s UUID>'   -- who authorised this
);
```

`created_by` is not decoration. It is the only record of who authorised the
access, and the table refuses a row that names itself.

Roles are deliberately the smallest vocabulary that answers today's question:

| Role | May work the queue | May provision others |
|---|---|---|
| `owner` | yes | yes |
| `identity_resolver` | yes | no — by procedure, not yet by constraint |

`identity_resolver` not being able to provision is currently a rule in this
document rather than one in the schema, because both roles reach
`staff_operators` only through the service role, which is trusted absolutely.
Recorded here as a known limit rather than implied to be enforced.

**Do not build a staff-management console for this.** Provisioning is rare,
deliberate, and better done by a person holding the server credential than by
a web form that has to be secured all over again.

---

## 4. Removing access

**Disable. Never delete.**

```sql
update public.staff_operators
   set active = false, disabled_at = now()
 where user_id = '<uuid>';
```

The next request that operator makes is refused with
`staff_operator_disabled`. Not the next hour, not the next token refresh —
the next request, because authorization is a live lookup.

`active` and `disabled_at` are one fact written two ways and
`staff_operators_active_pair` refuses them apart, so both must be set
together.

### Why deletion is refused

`identity_resolution_cases.resolved_by_operator_id` references
`staff_operators.user_id` with `ON DELETE RESTRICT` **and** `ON UPDATE
RESTRICT`. An operator who has resolved a case is part of the audit trail of
a permanent, unerasable attachment. Neither deleting them nor renumbering
them may quietly detach that, and the database will refuse both.

Deactivation is how an operator leaves. That is exactly why `active` exists.

Revoke the Supabase Auth session too — Dashboard → Authentication → Users →
the user → sign out / delete the user's sessions — so a live token is not
left circulating. The database refuses it either way; this just closes it
sooner.

---

## 5. What an operator can and cannot do

Can:

- read the open-case queue, and one case in detail
- see **masked** contact shapes (`o***@r***.test`), never full values
- see identifier **type names** — `email_exact`, `business_name` — never values
- attach a queued review to a Business Record **the case itself names**
- override an automatic identity protection, with an approved reason code and
  a written explanation, both recorded against their UUID

Cannot, by construction:

- resolve against a record the case does not name — the eligible set is
  derived in SQL from persisted evidence, not from anything the browser sends
- resolve a case twice, or two operators resolve one case
- create, merge, or dismiss a Business Record
- write an identifier — a decision about where a review belongs is not a
  decision that its values are trustworthy identity evidence
- repoint an assessment session
- change a case's evidence — a trigger refuses it
- read any table directly

### The resolution note

Free text, 8 to 2000 characters, stored against the record and read back.

It is **screened before it is stored** (`shared/security/staff-note.js`) and
refused if it appears to contain credentials, tokens, email addresses,
telephone numbers, payment card numbers, government identifiers, or raw
opaque identifier values. The refusal names the category and never echoes the
value.

Prose about any of those is fine — "the continuation token had expired" is a
useful thing to write down. It is the *value* that is refused, not the word.

Write what you checked and how you know. It is redacted when the business is
redacted (`redact_business_pii`), but until then it is stored as typed.

---

## 6. Environment

Everything the console needs, and nothing else. Full descriptions in
[.env.example](../.env.example).

| Variable | Required | For |
|---|---|---|
| `SUPABASE_URL` | yes | both clients |
| `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) | yes | server-side sign-in, **and served to the onboarding page** via `GET …/auth-config` |
| `SUPABASE_SECRET_KEY` (**preferred**; `SUPABASE_SERVICE_ROLE_KEY` is the legacy name) | yes | every protected staff operation — the RPC, the two table reads, and the rate-limit passes. Not needed by `GET …/auth-config` |
| `CED_RATE_LIMIT_SECRET` | **yes** | all four rate-limit passes — every staff route subject to database-backed pre-authentication limiting fails closed without it. `GET …/auth-config` does not use it |
| `CED_RATE_LIMIT_TIMEOUT_MS` | no | default 2000, clamped 250–4000 |
| `CED_STAFF_ALLOWED_ORIGINS` | no | defaults to the request's own origin |
| `CED_STAFF_RATE_LIMIT_WINDOW_SECONDS` / `_MAX_REQUESTS` | no | defaults 900 / 240 |
| `CED_STAFF_SIGNIN_RATE_LIMIT_WINDOW_SECONDS` / `_MAX_REQUESTS` | no | defaults 900 / 30 |
| `CED_STAFF_SESSION_RATE_LIMIT_WINDOW_SECONDS` / `_MAX_REQUESTS` | no | defaults 900 / 60 |
| `CED_ALLOW_INSECURE_STAFF` | no | local development only |

### The origin allowlist

Exact-matched, comma-separated, no wildcards, no suffix matching, and `null` is
refused — the same rule the public endpoint applies, from the same shared
validator. **Leave it unset** unless the console is served from a different
host than the API: unset, the allowlist is the request's own origin, which is
exactly right for a same-origin console and needs no configuration to be
correct. Setting it *replaces* that default rather than adding to it.

It is deliberately **not** `CED_ALLOWED_ORIGINS`. That list is the marketing
verticals' audience, and sharing it would widen this one every time a vertical
launched.

### The four rate-limit passes

Every request takes the pre-authentication pass and then exactly **one** of the
other three, so nothing is charged twice and a refusal in one bucket can never
consume another.

| # | Pass | Applies to | Default |
|---|---|---|---|
| 1 | pre-authentication, by address | every request | 900 / 240 |
| 2 | sign-in, by address | `/session` only | 900 / 30 |
| 3 | session maintenance, by address | `/session/refresh`, `/session/signout` | 900 / 60 |
| 4 | authenticated, by address **and** operator UUID | everything after the token is verified | 900 / 240 |

**Why sign-in is 30 and not 10.** One completed sign-in is *two* posts to
`/session`, because the form is two steps. Ten therefore bought five sign-ins
per address per window — and operators share an address whenever they share an
office. Ten complete two-step attempts is twenty posts, so thirty leaves room
for a mistyped code without locking the office out.

**Onboarding is not in any of them.** It never reaches this route: the browser
rate-limiting that applies to invitation acceptance, password changes and TOTP
verification is Supabase Auth's own. `GET …/auth-config` takes the
pre-authentication pass like every other request.

**Why maintenance is separate.** Refresh and sign-out present a token this
server issued; neither can be used to guess one. Sharing the sign-in bucket
meant a working console spent the budget its own operator needed to sign in
again — and because a refused refresh ends the session, the tight bucket was
ejecting exactly the people it was meant to protect.

**A blocked sign-out still signs you out.** The browser clears its own session
first and unconditionally; revoking the refresh token server-side is what
happens next, not what it waits on. A `429`, a network failure or a refusal
cannot leave the page believing it is still signed in.

The staff limits are **separate from the public form's** and moving one does
not move the other. They are separate because working a single case costs
three requests — the case detail, the resolution, and the queue refetch behind
the panel — so the public budget of 20 per 15 minutes locked an operator out
after roughly six cases.

None of the four stores a raw address, email, token, session id or operator
UUID: the namespace and the value are hashed together with
`CED_RATE_LIMIT_SECRET`, and only the HMAC reaches the database. The `scope`
column keeps the `('address','session')` vocabulary migration 0003 gave it.

The two key variables **fail closed if crossed**. A secret key pasted into
`SUPABASE_PUBLISHABLE_KEY` is recognised and refused, so the route answers
`503 auth_unavailable` rather than verifying tokens with an elevated
credential.

`CED_ALLOW_INSECURE_STAFF` needs all three of: the variable set to `true`, a
**loopback** request host (`localhost`, `127.0.0.1`, `::1` — not `0.0.0.0`),
and `NODE_ENV` that is not `production`.

---

## 7. Known limits

Recorded rather than implied away.

- **Migration 0007 IS present on the hosted development project** (PostgreSQL
  17.6.1.155), which corrects an earlier claim here that nothing had run
  against hosted Supabase or PostgreSQL 17. What has *not* happened: no
  deployed definition has been compared against the committed file, nothing
  has been successfully **called** through PostgREST, and no part of this
  console has run against **real Supabase Auth**. Migration 0008, which
  hardens three things 0007 depends on, has been applied nowhere. See
  [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md) run 14.
  The `auth.users` foreign key and the confirmed-email check are both
  conditional on a schema that does not exist in the local test harness, so
  neither has ever executed. No real access token has ever been verified, and
  no real TOTP factor has ever been challenged: the sign-in flow is covered by
  a stubbed client on the server side and a stubbed network in the browser.
- **No real invitation has ever been accepted.** Onboarding is covered against
  a stubbed Auth client in `tests/staff-invite-onboarding.test.mjs` and
  against the same stub *behind a real browser over a real socket* in
  `tests/browser/staff-invite-browser.test.mjs`. What has never happened:
  a real `verifyOtp` on a token Supabase minted, a real `updateUser` password
  change, a real `mfa.enroll`, and a real authenticator app scanning a real
  secret. The invite email template in step 2.0 is written from Supabase's
  documented template variables and **has not been sent**.
- **A page reload during onboarding loses the enrollment.** Nothing is
  persisted, by design, and the invitation is already spent by then — so the
  operator needs a new invitation rather than a resume. This is the same
  no-persistence rule the console follows, and the cost is one dashboard
  click.
- **There is no QR code**, deliberately: the staff CSP is `default-src 'none'`
  with no `img-src`, and Supabase returns the QR as a `data:` image. The setup
  key and the `otpauth://` URI are shown as text instead, which every common
  authenticator app accepts.
- **`identity_resolver` cannot provision operators by procedure only**, not by
  constraint. See section 3.
- **A session does not survive a page reload.** Nothing is persisted, by
  design; the operator signs in again. Within the life of a page the token is
  refreshed before expiry, once — the refresh is single-flight, so however many
  things want a token at the same moment, exactly one rotation happens. A
  refresh that comes back for a different user, without a rotated refresh
  token, or below `aal2` drops the session rather than half-updating it.
- **`server/` is no longer part of the published site — by configuration, not
  yet by observation.** It used to be: with no `buildCommand` and no
  `outputDirectory` the repository root was the static output, so
  `server/staff-identity-resolution.mjs` was downloadable, along with every
  migration, every document including this one, every test, and `.env.example`.
  None of them carried a credential — the server reads its secrets from the
  environment and `.env.example` values are blank — so it was source
  disclosure, not a credential leak. It was still nobody's decision.

  `vercel.json` now sets a `buildCommand` and an `outputDirectory`, and
  `tools/build-static.mjs` copies only the files named in
  `tools/static-manifest.mjs` into `dist/`. `server/` is not among them and
  cannot be: it is reached through `/api`, never downloaded. No `.vercelignore`
  is used, deliberately — excluding `server/` would break the function's file
  tracing and take the console down. **Whether Vercel honours this
  configuration has not been observed**; it needs a real `vercel build` or a
  preview deployment. See
  [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md), runs 6 and 8.
- **Rate limiting is REQUIRED, and fails closed.** `CED_RATE_LIMIT_SECRET`
  is not optional for the staff route. Without it — or without a usable
  caller identifier, or when `check_rate_limit` fails or exceeds its
  timeout — every rate-limited staff route answers
  `503 rate_limit_unavailable` with `Retry-After: 5`. The reason
  (`missing_secret`, `missing_identifier`, `rpc_error`, `timeout`) is a
  fixed token in the server log; the secret, the caller's address and any
  upstream error body are never logged. This reverses an earlier note saying
  a missing secret simply disabled limiting: it did, and that was an
  unmetered authentication path created by forgetting one variable.
- **`GET …/auth-config` is excluded from that limiter, deliberately.** It
  returns only public client configuration — the project origin and the
  publishable key Supabase publishes for browser clients — and performs no
  authentication and no privileged database operation: no token, no body, no
  table, no RPC. It therefore needs neither `CED_RATE_LIMIT_SECRET` nor an
  elevated Supabase credential.

  **This is not a development or Preview bypass.** It is one method on one
  path, decided identically in every environment, with no variable that
  widens or narrows it. HTTPS, the origin and Fetch Metadata gate, the
  no-body rule and the method table (`405` with `Allow: GET`) all still apply,
  and a misconfigured project URL or publishable key still gives the
  established sanitized `503 auth_unavailable`.

  The exclusion exists because of an observed failure, not a preference: while
  the endpoint was metered, a deployment holding a project URL and a
  publishable key and nothing else answered `503 database_unavailable` to the
  one request whose job is to tell the browser which Supabase project to talk
  to. Every other staff route is unchanged and still fails closed on all five
  conditions, the missing elevated credential included.
- **The queue is the only surface.** There is still no path to dismiss a case,
  create a record, request more information, or merge. Cases outside
  link-to-existing stay open, visibly, and say so.
