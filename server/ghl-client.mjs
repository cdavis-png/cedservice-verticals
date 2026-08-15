/* ============================================================
   CED Intelligence Platform — HighLevel (GHL) client
   ------------------------------------------------------------
   THE ONE PLACE THIS REPOSITORY TALKS TO GHL. Both the promotion
   boundary and the webhook receiver import from here, so there is
   one definition of which location, which pipeline, which stage
   and which custom field — and one place to change them.

   IT LIVES IN server/ RATHER THAN shared/ ON PURPOSE. CLAUDE.md
   §13 publishes a positive allowlist and forbids the `server/`
   prefix wholesale, so nothing here can reach a browser by
   accident. Putting it in `shared/` would have made publication a
   question somebody has to keep answering correctly; putting it
   here answers it once. It also holds an API token at runtime,
   which settles the matter.

   AUTHORITY BOUNDARY, restated because this file is where it would
   erode first: GHL owns communications, sales execution, current
   opportunity state, and Won/Lost. Supabase owns identity,
   evidence, qualification, links and history. This client reads
   and writes GHL. It must never become the place where a sales
   decision is made.
   ============================================================ */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/* ------------------------------------------------------------
   Signature verification
   ------------------------------------------------------------
   HighLevel signs the webhook body with Ed25519 and sends the
   signature base64-encoded in `X-GHL-Signature`. The public key
   below is HighLevel's own, published in their Webhook
   Integration Guide. It is a PUBLIC key: pinning it in source is
   correct, and it is not a credential.

   `X-WH-Signature` (RSA-SHA256) is the LEGACY header and is
   deprecated as of 2026-09-01. It is deliberately not accepted.
   Accepting both would mean the weaker scheme decides whenever an
   attacker gets to choose which header to send.
   ------------------------------------------------------------ */

export const GHL_ED25519_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n' +
  '-----END PUBLIC KEY-----\n';

/* Base64 that is actually base64. A malformed signature must be a
   refusal, never an exception that a generic catch turns into a 500 —
   a 500 invites a retry, and a forged signature should not be retried. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Verify a HighLevel webhook signature over the UNMODIFIED raw body.
 *
 * `rawBody` MUST be the exact bytes received. Parsing and re-serialising
 * JSON changes key order, whitespace and number formatting, and the
 * signature is over the original bytes — a re-serialised body fails
 * verification for a valid request and, worse, could pass for a body
 * that is not the one that was signed. The caller reads the body once,
 * as a Buffer, and hands the same Buffer to both this and the hash.
 *
 * Returns a boolean and throws nothing for ordinary bad input.
 */
export const verifyGhlSignature = (rawBody, signatureB64, publicKeyPem = GHL_ED25519_PUBLIC_KEY_PEM) => {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;

  const sig = String(signatureB64 ?? '').trim();
  if (!sig || sig.length > 512 || !BASE64_RE.test(sig)) return false;

  let signature;
  try {
    signature = Buffer.from(sig, 'base64');
  } catch {
    return false;
  }
  /* Ed25519 signatures are exactly 64 bytes. Checking the length before
     calling verify turns a whole class of garbage into a cheap refusal. */
  if (signature.length !== 64) return false;

  try {
    const key = createPublicKey(publicKeyPem);
    /* Algorithm is `null` for Ed25519: the curve determines the hash, and
       passing an algorithm name here throws. */
    return cryptoVerify(null, rawBody, key, signature);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------
   Configuration
   ------------------------------------------------------------
   FAILS CLOSED. Every value is required and every accessor throws
   a GhlConfigError when one is missing, because the alternative —
   a client that silently posts to the wrong location or omits the
   Business ID field — writes bad data into a CRM that a human then
   has to unpick by hand.
   ------------------------------------------------------------ */

export class GhlConfigError extends Error {
  constructor(message) { super(message); this.name = 'GhlConfigError'; }
}

export class GhlApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'GhlApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const required = (env, name) => {
  const value = String(env?.[name] ?? '').trim();
  if (!value) throw new GhlConfigError(`${name} is not set`);
  return value;
};

/**
 * Resolve the GHL configuration from the environment.
 *
 * The token is read but never returned in anything loggable, and no
 * caller of this module logs the object it gets back.
 */
export const resolveGhlConfig = env => ({
  /* `GHL_API_TOKEN` is preferred; `GHL_PI_TOKEN` is the name the
     infrastructure scripts already use for the same Private Integration
     token, accepted so one credential does not need two homes. Following
     the §14 precedent: the preferred name wins, the legacy name is a
     fallback only when the preferred one is unset. */
  token: String(env?.GHL_API_TOKEN ?? '').trim() || required(env, 'GHL_PI_TOKEN'),
  locationId: required(env, 'GHL_LOCATION_ID'),
  pipelineId: required(env, 'GHL_PIPELINE_ID'),
  /* The stage a researched OUTBOUND opportunity starts in. Inbound entry
     into `New Inquiry` is owned by GHL's own workflows and is not touched
     from here. */
  qualifiedNotContactedStageId: required(env, 'GHL_STAGE_QUALIFIED_NOT_CONTACTED'),
  businessIdFieldId: required(env, 'GHL_FIELD_CED_BUSINESS_ID'),
  leadFocusFieldId: required(env, 'GHL_FIELD_LEAD_FOCUS'),
  apiBase: String(env?.GHL_API_BASE ?? '').trim() || 'https://services.leadconnectorhq.com',
  apiVersion: String(env?.GHL_API_VERSION ?? '').trim() || '2021-07-28'
});

/* The two tags every BI-sourced contact carries. `ced_lead` already
   exists in the location; `ced_source_bi_research` records HOW the lead
   arrived, which is the distinction that stops researched outbound being
   confused with an inbound enquiry. */
export const CED_LEAD_TAG = 'ced_lead';
export const CED_SOURCE_BI_RESEARCH_TAG = 'ced_source_bi_research';

/* ------------------------------------------------------------
   The client
   ------------------------------------------------------------ */

/**
 * Build a GHL client.
 *
 * `fetchImpl` is injectable so tests drive this without a network and
 * without a token. That seam is the only reason this is a factory
 * rather than a set of bare functions.
 */
export const createGhlClient = (config, { fetchImpl = fetch, timeoutMs = 10000 } = {}) => {
  const call = async (method, path, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${config.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Version: config.apiVersion,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      /* A network failure and a timeout are the same thing to the caller:
         GHL did not answer, so nothing may be assumed about whether the
         write landed. The promotion path treats this as retryable and
         does NOT mark its idempotency record completed. */
      throw new GhlApiError(502, 'crm_unreachable', 'The CRM did not respond.', String(error?.name || error));
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }

    if (!response.ok) {
      /* The CRM's own message is carried in `detail` for the log, never
         into the caller's response body — it can echo submitted values. */
      throw new GhlApiError(
        response.status === 429 ? 429 : 502,
        response.status === 429 ? 'crm_rate_limited' : 'crm_error',
        'The CRM refused the request.',
        `${response.status}: ${String(parsed?.message ?? text).slice(0, 300)}`
      );
    }
    return parsed;
  };

  return {
    /**
     * Find a contact by its CED Business ID custom field.
     *
     * THIS IS THE FIRST THING THE PROMOTION PATH DOES when it holds no
     * link, and it is what stops a second contact being created for a
     * business whose link was lost — after a partial failure, after a
     * restore, or after somebody deleted the row by hand.
     */
    async findContactByBusinessId(businessId) {
      const result = await call('POST', '/contacts/search', {
        locationId: config.locationId,
        pageLimit: 2,
        filters: [{
          field: `customFields.${config.businessIdFieldId}`,
          operator: 'eq',
          value: businessId
        }]
      });
      const contacts = result?.contacts ?? [];
      /* More than one contact carrying the same canonical Business ID is a
         data fault in the CRM that this code must not paper over by
         picking one. The caller refuses and asks for a human. */
      if (contacts.length > 1) {
        throw new GhlApiError(409, 'crm_ambiguous_contact',
          'More than one CRM contact carries this Business ID.',
          `businessId=${businessId} matches=${contacts.length}`);
      }
      return contacts[0] ?? null;
    },

    async getContact(contactId) {
      const result = await call('GET', `/contacts/${encodeURIComponent(contactId)}`);
      return result?.contact ?? null;
    },

    async createContact(fields) {
      const result = await call('POST', '/contacts/', {
        locationId: config.locationId,
        ...fields
      });
      return result?.contact ?? null;
    },

    async updateContact(contactId, fields) {
      const result = await call('PUT', `/contacts/${encodeURIComponent(contactId)}`, fields);
      return result?.contact ?? null;
    },

    /**
     * Every opportunity on a contact, open or not.
     *
     * The promotion path filters for OPEN opportunities itself rather than
     * asking GHL to, because "open" is the condition it must enforce and
     * reading it here keeps that rule in one place.
     */
    async findOpportunitiesByContact(contactId) {
      const params = new URLSearchParams({
        location_id: config.locationId,
        contact_id: contactId
      });
      const result = await call('GET', `/opportunities/search?${params}`);
      return result?.opportunities ?? [];
    },

    async createOpportunity({ contactId, name, stageId, monetaryValue = 0 }) {
      const result = await call('POST', '/opportunities/', {
        locationId: config.locationId,
        pipelineId: config.pipelineId,
        pipelineStageId: stageId,
        contactId,
        name,
        status: 'open',
        monetaryValue
      });
      return result?.opportunity ?? null;
    }
  };
};

/**
 * The opportunity name format, in one place because it is a contract with
 * whoever reads the pipeline: `[Business Name] — [Need/Offer]`.
 *
 * An em dash, matching the agreed format. The business name is trimmed
 * rather than truncated silently at an arbitrary width — a shortened name
 * in a CRM is a name somebody will later fail to match.
 */
export const opportunityName = (businessName, needOrOffer) => {
  const left = String(businessName ?? '').trim();
  const right = String(needOrOffer ?? '').trim();
  if (!left) throw new GhlConfigError('opportunity name requires a business name');
  return right ? `${left} — ${right}` : left;
};
