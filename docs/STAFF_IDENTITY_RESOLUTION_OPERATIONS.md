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
| Page | `staff/identity-resolution/index.html` + `page.js` |

The implementation sits **outside `api/`** on purpose. Vercel deploys every
file under `api/` as its own function, so while it lived there the same
privileged route was deployed twice — once through the catch-all the console
calls, and once at its own bare path, absent from `vercel.json` and therefore
on platform defaults. One route, one function.

---

## 1a. How sign-in works

The browser holds **no Supabase client and no key of any kind**. It posts to
three same-origin endpoints on the staff route, and the route makes every
Supabase Auth call with the publishable key, server-side:

| Endpoint | What the route does |
|---|---|
| `POST …/session` | `signInWithPassword`, then `mfa.listFactors`, then `mfa.challengeAndVerify` |
| `POST …/session/refresh` | `refreshSession`, and re-checks the new token is still `aal2` |
| `POST …/session/signout` | `setSession`, then `signOut({ scope: 'local' })` |

All three are `POST`, so all three require an exact-matched `Origin` — the
method-sensitive relaxation above applies to safe reads only and never to
these — and, because they carry a body, `Content-Type: application/json`. Both
are checked before any rate-limit bucket, body read, Supabase call or database
round trip. See section 6.

This repository has no build step and no bundler, so putting
`@supabase/supabase-js` in the page would have meant either committing a
generated third-party bundle or loading one from a CDN at runtime. Neither
belongs in the sign-in path of a console that performs permanent, unerasable
attachments. Nothing is hand-rolled: every call above is made by the supported
client, on the server side of the wire.

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

### 2.1 Invite the person through Supabase Auth

Supabase Dashboard → **Authentication → Users → Invite user**. Use their work
email address.

Do **not** create a password on their behalf and do not share one.

### 2.2 They confirm the email

The invite must be accepted and the email confirmed. An unconfirmed invite is
not an account yet, and three separate things refuse one:

- `bootstrap_staff_owner` checks `auth.users.email_confirmed_at`
- the staff route refuses with `403 email_unconfirmed`
- Supabase itself will not issue a session

### 2.3 They enroll a second factor

Supabase Dashboard → **Authentication → Providers → Multi-Factor
Authentication** must have TOTP enabled for the project first.

The operator then enrolls an authenticator app and **verifies** it. Enrollment
without verification does not produce an `aal2` session, and
`staff_operator_guard` refuses anything that is not exactly `aal2` — including
an absent claim, which is treated as "not satisfied" rather than "not
mentioned".

Confirm before continuing: sign in as that user and check that the session's
access token carries `"aal": "aal2"`.

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
you as the person who can fix it — go back to step 2.3.

---

## 3. Provisioning later operators

Once an owner exists, further operators are ordinary rows created **by that
owner**, with `created_by` recorded. Steps 2.1 to 2.4 are unchanged — invite,
confirm, enroll and verify TOTP, take the UUID.

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
| `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) | yes | all Supabase Auth calls |
| `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | yes | the RPC and the two table reads |
| `CED_RATE_LIMIT_SECRET` | strongly | all four rate-limit passes |
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

- **Nothing here has run against hosted Supabase, PostgreSQL 17, PostgREST, or
  real Supabase Auth.** See [REAL_POSTGRES_VALIDATION.md](REAL_POSTGRES_VALIDATION.md).
  The `auth.users` foreign key and the confirmed-email check are both
  conditional on a schema that does not exist in the local test harness, so
  neither has ever executed. No real access token has ever been verified, and
  no real TOTP factor has ever been challenged: the sign-in flow is covered by
  a stubbed client on the server side and a stubbed network in the browser.
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
- **Rate limiting depends on `CED_RATE_LIMIT_SECRET`.** With no secret there
  is none, and the route logs that at error level in production.
- **The queue is the only surface.** There is still no path to dismiss a case,
  create a record, request more information, or merge. Cases outside
  link-to-existing stay open, visibly, and say so.
