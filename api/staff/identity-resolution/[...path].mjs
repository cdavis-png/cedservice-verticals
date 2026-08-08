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

   ONE ARGUMENT. handleRequest's second parameter is a dependency
   -injection seam for the tests. Exporting it directly as the
   entrypoint would let whatever the platform passes second — now
   or after a runtime upgrade — arrive where injected dependencies
   are expected.
   ============================================================ */

import { handleRequest } from '../../../server/staff-identity-resolution.mjs';

export default async function handler(request) {
  return handleRequest(request);
}

export const config = { runtime: 'nodejs' };
