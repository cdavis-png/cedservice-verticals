/* ============================================================
   CED Intelligence Platform — staff route deployment entrypoint
   ------------------------------------------------------------
   WHY THIS FILE EXISTS.

   Vercel's filesystem routing maps a plain `api/<name>.mjs` to
   exactly `/api/<name>` and to nothing below it. The console does
   not call such a path; it calls

     /api/staff/identity-resolution/session
     /api/staff/identity-resolution/cases
     /api/staff/identity-resolution/cases/:id
     /api/staff/identity-resolution/cases/:id/link

   all of which carry a sub-path. Without a route that accepts
   sub-paths, every one of them is a platform 404 that never
   reaches any handler — the console would have failed on its
   first request, with no server log to explain it.

   A CATCH-ALL SEGMENT RATHER THAN A REWRITE, deliberately. A
   `rewrites` entry would have to rewrite to a single fixed
   function path, which discards the very sub-path the handler
   routes on; recovering it would mean smuggling it through a
   query parameter and teaching the handler a second way to find
   out what was asked for. Filesystem routing hands the function
   the ORIGINAL request URL, unchanged, so `/cases/:id/link` is
   still `/cases/:id/link` when handleRequest reads it. One
   mechanism, no reconstruction, nothing to keep in step.

   `[...path]` and not `[[...path]]`: every console path has at
   least one segment after the prefix, so the bare
   `/api/staff/identity-resolution` needs no route and is better
   off not having one.

   THIS IS THE ONLY ENTRYPOINT. The implementation lives at
   server/staff-identity-resolution.mjs, OUTSIDE the api/ tree,
   because Vercel deploys every file under api/ as its own
   function. While the implementation sat in api/ the platform
   deployed the same privileged route twice — once here and once
   at its own bare path, unconfigured by vercel.json. One route,
   one function, one thing to secure.

   ============================================================
   NAMED METHOD EXPORTS, AND WHY A DEFAULT EXPORT WAS A 504.

   Vercel's Node.js runtime offers two invocation contracts, and
   the export SHAPE is what selects between them:

     export default handler        -> Node signature (req, res)
     export function GET(request)  -> Web signature (Request)

   This file used to be a DEFAULT export written for the Web
   signature: it took a `Request` and returned a `Response`. The
   platform therefore called it with `(req, res)`, and:

     · `req.url` is a PATH, not an absolute URL, so `new URL()`
       inside handleRequest threw `Invalid URL`;
     · the generic catch turned that into a 500 `Response`;
     · that Response was RETURNED, and the return value of a Node
       -signature handler is discarded;
     · `res` was never written, never ended, so the invocation ran
       to the 15-second limit and the platform answered
       504 FUNCTION_INVOCATION_TIMEOUT with no exception to show
       for it.

   The old comment here claimed that taking one argument and
   forwarding one was a SAFETY BOUNDARY protecting handleRequest's
   dependency-injection seam. That was exactly backwards. The
   second argument was `res` — the only means of answering — and
   discarding it is what made every invocation hang. The seam is
   protected below by not forwarding a second argument, which is
   true of these named exports as well; it was never the reason
   the wrapper existed, and it was never worth a 504.

   EVERY STANDARD METHOD IS EXPORTED, deliberately, and this does
   NOT widen what the application accepts. handleRequest already
   answers a deterministic `405 method_not_allowed` with an
   `Allow` header for the methods a path does not serve — POST for
   /session, GET for /auth-config. A method with no named export
   is answered by VERCEL with a generic 405 instead, losing the
   JSON body, the error code and the `Allow` header the console
   and the contract tests depend on. Forwarding the method so the
   application can refuse it is what preserves that behaviour.
   ============================================================ */

import { handleRequest } from '../../../server/staff-identity-resolution.mjs';

/* ============================================================
   THE REWRITE SEAM, AND WHY IT HAD TO EXIST AFTER ALL

   The comment above argues that filesystem routing beats a
   rewrite because it hands the function the ORIGINAL path. That
   reasoning was sound and the premise was false, and only the
   platform could say so.

   Observed on a real Preview deployment of this branch:

     GET …/identity-resolution/cases           -> the application answered
     GET …/identity-resolution/session/refresh -> 404: NOT_FOUND (Vercel)

   One segment reaches the function; two do not. That is
   `[param]` behaviour, not `[...param]` behaviour: this project
   is not a framework preset, and its `api/` filesystem routing
   resolves a bracketed segment as ONE dynamic segment. The
   catch-all was never a catch-all here, so every console path
   below /cases/:id was a platform 404 — `session/refresh`,
   `session/signout`, `cases/:id` and `cases/:id/link`, which is
   the whole workflow past the queue listing.

   `vercel.json` now carries ONE rewrite that gathers every
   sub-path back onto this function. Two documented consequences
   follow, and this seam exists to absorb the second:

     · the function is invoked with the DESTINATION path, not the
       one the browser asked for;
     · a `source` parameter the destination does not consume is
       appended as a QUERY parameter — so `:path+` arrives as
       `?path=cases/test-id/link`.

   So the original path is not lost, it is relocated, and the one
   thing handleRequest needs is for `request.url` to say what was
   asked for. It is restored HERE, in the entrypoint, so that
   handleRequest, its routing, its provenance gate and its
   contracts are untouched — this file is already the platform
   adapter, and adapting is its job.

   IT IS A NARROW SEAM ON PURPOSE. Only the exact rewrite
   destination is rewritten back; anything else passes through
   unchanged, so a direct request is still routed by its own path
   and local tests still drive real URLs. The restored path is
   rebuilt from validated segments under a FIXED prefix, so a
   caller who supplies their own `?path=` cannot traverse out of
   the staff namespace or reach anything the same caller could
   not have requested directly. It selects which staff route
   runs; every one of them still enforces provenance, origin,
   authentication, AAL2 and the live operator lookup for itself.
   ============================================================ */

const STAFF_PREFIX = '/api/staff/identity-resolution';

/* The single literal segment vercel.json rewrites to. It is not a route the
   console calls; it exists only so the rewrite has somewhere to land that
   the platform demonstrably resolves to this function. */
const REWRITE_TARGET = `${STAFF_PREFIX}/_router`;

/* Deliberately narrow: the segments the supported routes are actually made
   of. A UUID, `auth-config`, `session`, `refresh`, `signout`, `cases`,
   `link`. No slash, no dot-segment, no encoded separator. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const restoreRewrittenPath = request => {
  const url = new URL(request.url);
  if (url.pathname !== REWRITE_TARGET) return request;

  const segments = (url.searchParams.get('path') || '').split('/').filter(Boolean);
  if (!segments.length || !segments.every(s => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..')) {
    return request;
  }

  const restored = new URL(url);
  restored.pathname = `${STAFF_PREFIX}/${segments.join('/')}`;
  restored.searchParams.delete('path');
  /* Method, headers and body are carried over intact; only the URL moves. */
  return new Request(restored, request);
};

/* One argument in, one argument forwarded: `handleRequest`'s second
   parameter is a test-only injection seam and nothing the platform passes may
   reach it. Written once and reused by every method below, so no export can
   drift into forwarding something extra. */
const respond = request => handleRequest(restoreRewrittenPath(request));

/* The two the console actually uses. */
export const GET = respond;
export const POST = respond;

/* Forwarded ONLY so the application's own 405 answers them. Adding an export
   here does not add a route: handleRequest matches path and method itself,
   and anything it does not serve gets its deterministic refusal. */
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const OPTIONS = respond;
export const HEAD = respond;

export const config = { runtime: 'nodejs' };
