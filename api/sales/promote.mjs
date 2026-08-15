/* ============================================================
   CED Intelligence Platform — Promote to Sales deployment entrypoint
   ------------------------------------------------------------
   Maps to exactly `/api/sales/promote`.

   A PLAIN PATH, NOT A CATCH-ALL, and that is a deliberate
   difference from the staff route. §12 needed `[...path]` plus a
   `vercel.json` rewrite because the console calls four paths that
   all carry sub-paths, and this project's `api/` routing resolves
   a bracketed segment as ONE segment rather than many. This
   surface serves a SINGLE path with no sub-paths at all, so a
   plain `api/sales/promote.mjs` maps to it directly. No catch-all,
   no rewrite, no path restoration seam, nothing to keep in step.

   Do not "upgrade" this to a catch-all in anticipation of a second
   sales endpoint. Add the second endpoint as its own file, or —
   if it genuinely needs sub-paths — take the rewrite complexity on
   at that point, with the reason recorded.

   NAMED METHOD EXPORTS, WEB SIGNATURE. The export shape selects
   the invocation contract: a default export is called `(req, res)`
   and its return value is discarded, which is what once turned a
   thrown `Invalid URL` into a 504 that ran to the timeout with no
   exception to show for it. Named method exports take a `Request`
   and return a `Response`, which is what handleRequest speaks.

   Every standard method is exported so the APPLICATION answers a
   method it does not serve — a deterministic JSON `405` with an
   `Allow` header — rather than Vercel answering a generic one that
   loses the body, the error code and the header.

   THE IMPLEMENTATION IS OUTSIDE api/ because Vercel deploys every
   file under api/ as its own function. One route, one function,
   one thing to secure.
   ============================================================ */

import { handleRequest } from '../../server/sales-promotion.mjs';

/* One argument in, one argument forwarded. `handleRequest`'s second
   parameter is a test-only dependency-injection seam and nothing the
   platform passes may reach it. Written once and reused by every export
   below, so none can drift into forwarding something extra. */
const respond = request => handleRequest(request);

export const POST = respond;

/* Forwarded ONLY so the application's own 405 answers them. */
export const GET = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const OPTIONS = respond;
export const HEAD = respond;

export const config = { runtime: 'nodejs' };
