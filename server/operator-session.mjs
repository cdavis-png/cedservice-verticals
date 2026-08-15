/* ============================================================
   CED Intelligence Platform — operator session primitives
   ------------------------------------------------------------
   The authentication pieces every AUTHENTICATED server route
   needs: the elevated database client, access-token verification,
   and the live `staff_operators` authorization lookup.

   ------------------------------------------------------------
   KNOWN DUPLICATION, STATED RATHER THAN HIDDEN.

   `server/staff-identity-resolution.mjs` predates this file and
   carries its own private equivalents of `getServiceClient`,
   `verifyAccessToken` and the operator guard call. This module
   was written for the sales routes rather than by extracting
   them, and that is a deliberate, narrow choice: the staff route
   is the only authenticated surface that has ever been deployed,
   its behaviour is pinned by a large suite, and rewiring its
   authentication is not a change that belongs inside a feature
   that does not touch the console.

   It is still duplication, and CLAUDE.md §3 is right about what
   duplication costs — the next fix to token handling has two
   homes and will find one of them. Unifying them is a separate,
   test-covered change: move the staff route onto this module,
   re-run `npm run test:unit` and `npm run test:browser`, and
   delete the private copies. Do that before a THIRD authenticated
   route is added, not after.
   ------------------------------------------------------------

   WHAT IS NOT NEGOTIABLE HERE, because §12 says so and the
   reasoning is load-bearing:

     · Two keys, kept strictly apart. The publishable key verifies
       tokens; the secret key does privileged reads. Both are
       resolved through shared/security/supabase-keys.js and
       neither variable is read directly.
     · A CLAIM MAY DECORATE THE INTERFACE AND MAY NEVER BE THE
       DECISION. Authorization is a live `staff_operators` lookup
       on every request. Revocation takes effect on the next
       request, not the next token refresh.
     · AAL2 is confirmed from the verified token, never assumed.
   ============================================================ */

import supabaseKeys from '../shared/security/supabase-keys.js';

const { elevatedKey, lowPrivilegeKey } = supabaseKeys;

export class OperatorError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OperatorError';
    this.status = status;
    this.code = code;
  }
}

export const operatorFail = (status, code, message) => {
  throw new OperatorError(status, code, message);
};

/* ------------------------------------------------------------
   The elevated client
   ------------------------------------------------------------
   Cached per resolved credential rather than globally: a process that
   sees a different URL or key must build a different client, not reuse
   the first one it happened to make. */
let cachedServiceClient = null;

export const getServiceClient = async env => {
  const url = env.SUPABASE_URL || '';
  const key = elevatedKey(env);
  if (!url || !key) {
    operatorFail(503, 'database_unavailable', 'This service is not configured.');
  }
  if (cachedServiceClient && cachedServiceClient.url === url && cachedServiceClient.key === key) {
    return cachedServiceClient.client;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  cachedServiceClient = { url, key, client };
  return client;
};

/* Test-only. The cache is process-global, so a suite that swaps
   credentials between cases would otherwise get the first case's client. */
export const __resetServiceClientCache = () => { cachedServiceClient = null; };

/* ------------------------------------------------------------
   Token verification
   ------------------------------------------------------------
   Built per request and never cached: the Auth client carries a session
   in memory, and two concurrent invocations sharing one instance would
   be two operators sharing one session. */
const defaultAuthClient = async env => {
  const key = lowPrivilegeKey(env);
  if (!env.SUPABASE_URL || !key) {
    operatorFail(503, 'auth_unavailable', 'Authentication is not configured.');
  }
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
};

/* The AAL is read from the verified token's own claims, which is
   legitimate: AAL is a property of the SESSION, established at sign-in,
   and the token is signature-verified by Supabase before these claims
   are read. What is NEVER read from a claim is whether this person may
   act — that is the live lookup below. */
const decodeClaims = token => {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return {};
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) || {};
  } catch {
    return {};
  }
};

export const bearerToken = request => {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
};

export const verifyAccessToken = async (token, env, { makeAuthClient = defaultAuthClient } = {}) => {
  const client = await makeAuthClient(env);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  const claims = decodeClaims(token);
  return {
    userId: data.user.id,
    aal: claims.aal || null,
    emailConfirmed: Boolean(data.user.email_confirmed_at || data.user.confirmed_at)
  };
};

/* ------------------------------------------------------------
   Authorization — the live lookup
   ------------------------------------------------------------
   Called BEFORE any privileged read runs on the caller's behalf.
   `staff_operator_guard(p_user_id, p_aal)` raises when the caller is not
   a provisioned, active operator at the required assurance level; the
   RPC error is mapped by the caller's own error classifier. */
export const assertActiveOperator = async (db, userId, aal) => {
  const { error } = await db.rpc('staff_operator_guard', { p_user_id: userId, p_aal: aal });
  return error || null;
};

/* ------------------------------------------------------------
   Local-development HTTP
   ------------------------------------------------------------
   THREE CONDITIONS, ALL REQUIRED, matching the rule the staff route has
   carried since §12. The flag alone is not sufficient and cannot weaken a
   deployment: the host must ALSO be loopback and NODE_ENV must not be
   production. Set on a real project it changes nothing, because neither of
   those will hold.

   The NODE_ENV condition is not decoration. Without it, one environment
   variable set on a production project would take the whole surface off
   HTTPS. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const insecureAllowed = (env, url, flagName) => {
  if (String(env[flagName] || '') !== 'true') return false;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return LOCAL_HOSTS.has(url.hostname);
};

/* ------------------------------------------------------------
   Shared response shape
   ------------------------------------------------------------ */
export const jsonResponse = (status, body, correlationId, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Correlation-Id': correlationId,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders
    }
  });

export const makeLogger = (env, correlationId) => (level, event, fields = {}) => {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const configured = levels[(env.CED_LOG_LEVEL || 'info').toLowerCase()] ?? 2;
  if ((levels[level] ?? 2) > configured) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, correlationId, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/* Database error classification shared by the sales routes. The staff
   route has its own richer table keyed to its own RPCs; these are the
   codes the sales surfaces actually raise. */
export const classifySalesDbError = error => {
  const message = String(error?.message || '');
  const code = String(error?.code || '');

  if (code === '23505') {
    if (message.includes('one_business_processing')) {
      return [409, 'promotion_in_progress', 'A promotion for this business is already in progress.'];
    }
    if (message.includes('one_processing')) {
      return [409, 'promotion_in_progress', 'A promotion for this handoff is already in progress.'];
    }
    if (message.includes('active_contact')) {
      return [409, 'contact_link_exists', 'This business already has an active CRM contact link.'];
    }
    if (message.includes('active_opportunity')) {
      return [409, 'opportunity_link_exists', 'This handoff already has an active CRM opportunity link.'];
    }
    if (message.includes('idempotency')) {
      return [409, 'idempotency_conflict', 'This idempotency key is already in use.'];
    }
    return [409, 'conflict', 'That record already exists.'];
  }
  /* The operator guard is checked BEFORE the generic 42501 mapping: it raises
     42501 itself, and answering "not permitted" would lose the one detail the
     caller can act on — that they are not a provisioned operator at all,
     rather than that this particular action is denied. */
  if (message.includes('staff_not_an_operator')) return [403, 'not_an_operator', 'You are not a provisioned operator.'];
  if (message.includes('staff_aal2_required')) return [403, 'aal2_required', 'A second factor is required.'];

  if (code === '23503') return [404, 'unknown_record', 'A referenced record does not exist.'];
  if (code === '23514') return [422, 'constraint_violation', message.slice(0, 200) || 'The request violates a data rule.'];
  if (code === '42501') return [403, 'not_permitted', 'That action is not permitted.'];

  return [500, 'database_error', 'The request could not be completed.'];
};
