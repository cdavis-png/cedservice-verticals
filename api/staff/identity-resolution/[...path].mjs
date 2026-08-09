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

/* One argument in, one argument forwarded: `handleRequest`'s second
   parameter is a test-only injection seam and nothing the platform passes may
   reach it. Written once and reused by every method below, so no export can
   drift into forwarding something extra. */
const respond = request => handleRequest(request);

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
