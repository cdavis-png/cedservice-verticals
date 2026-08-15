/* ============================================================
   CED Intelligence Platform — GHL webhook deployment entrypoint
   ------------------------------------------------------------
   Maps to exactly `/api/webhooks/ghl`.

   A plain path, for the same reason as api/sales/promote.mjs: one
   endpoint, no sub-paths, so no catch-all and no rewrite.

   THIS ROUTE IS DELIBERATELY UNAUTHENTICATED IN THE SESSION
   SENSE. HighLevel holds no operator session and is not a
   browser, so there is no Origin to check and no bearer token to
   verify. The Ed25519 signature over the raw body is the
   credential, and `server/crm-webhook.mjs` verifies it before it
   parses, before it reads the database, and before it spends a
   rate-limit bucket.

   Nothing here may be changed to accept an unsigned delivery —
   not for a test, not for a replay tool, not behind a flag.
   ============================================================ */

import { handleRequest } from '../../server/crm-webhook.mjs';

const respond = request => handleRequest(request);

export const POST = respond;

/* Forwarded ONLY so the application answers its own deterministic 405
   with an `Allow` header, rather than Vercel answering a generic one. */
export const GET = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const OPTIONS = respond;
export const HEAD = respond;

export const config = { runtime: 'nodejs' };
