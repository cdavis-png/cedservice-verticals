/* ============================================================
   In-memory stand-in for the Supabase client, sales tables only
   ------------------------------------------------------------
   IT ENFORCES THE UNIQUE INDEXES, and that is the entire reason it
   exists rather than a bag of stubs. Every interesting path
   through the promotion boundary and the webhook receiver is
   reached by a CONSTRAINT FIRING — a replayed idempotency key, a
   second promotion for one business, a second active contact
   link, a redelivered webhook. A double that always says "ok"
   would exercise none of them and would report a green suite for
   a route that duplicates CRM contacts.

   The migration suite proves the real indexes behave this way
   against real PostgreSQL (tests/migration/0009-sales-handoff).
   This file mirrors those rules so the SERVER logic that reacts
   to them can be tested without a database. Where the two could
   drift, the migration suite is the authority.

   Errors are shaped like PostgREST's: `{ data, error }` with a
   `code` and a `message` that names the offending index, because
   the route classifies on exactly that.
   ============================================================ */

import { randomUUID } from 'node:crypto';

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const conflict = index => ({
  code: '23505',
  message: `duplicate key value violates unique constraint "${index}"`
});

/* The partial unique indexes, expressed as (row -> key | null). A null key
   means the row is outside the index's WHERE clause and cannot collide. */
const UNIQUE_INDEXES = {
  sales_promotion_requests: [
    ['sales_promotion_requests_idempotency_uidx', r => r.idempotency_key],
    ['sales_promotion_requests_one_processing_uidx',
      r => (r.status === 'processing' ? `h:${r.handoff_id}` : null)],
    ['sales_promotion_requests_one_business_processing_uidx',
      r => (r.status === 'processing' ? `b:${r.business_id}` : null)]
  ],
  external_record_links: [
    ['external_record_links_external_uidx',
      r => `${r.external_system}|${r.external_account_key}|${r.record_type}|${r.external_record_id}`],
    ['external_record_links_active_contact_uidx',
      r => (r.record_type === 'contact' && r.is_active
        ? `c:${r.business_id}|${r.external_system}|${r.external_account_key}` : null)],
    ['external_record_links_active_opportunity_uidx',
      r => (r.record_type === 'opportunity' && r.is_active ? `o:${r.handoff_id}` : null)]
  ],
  crm_webhook_receipts: [
    ['crm_webhook_receipts_delivery_uidx', r => `${r.external_system}|${r.delivery_key}`]
  ],
  timeline_events: [
    ['timeline_events_idempotency', r => `${r.event_name}|${r.idempotency_key}`]
  ]
};

const PRIMARY_KEY = {
  sales_promotion_requests: 'promotion_request_id',
  external_record_links: 'link_id',
  crm_webhook_receipts: 'receipt_id',
  timeline_events: 'event_id',
  sales_handoffs: 'handoff_id',
  business_records: 'business_id'
};

export function createFakeSalesDb(seed = {}) {
  const tables = {
    business_records: clone(seed.business_records) || [],
    sales_handoffs: clone(seed.sales_handoffs) || [],
    external_record_links: clone(seed.external_record_links) || [],
    sales_promotion_requests: clone(seed.sales_promotion_requests) || [],
    crm_webhook_receipts: clone(seed.crm_webhook_receipts) || [],
    timeline_events: clone(seed.timeline_events) || []
  };

  /* Every call is recorded so a test can assert what the route DID NOT do —
     "no contact was created", "no second opportunity was linked" — which is
     usually the more important half. */
  const calls = [];

  const violated = (table, candidate, ignoreRow = null) => {
    for (const [index, keyOf] of UNIQUE_INDEXES[table] || []) {
      const key = keyOf(candidate);
      if (key === null || key === undefined) continue;
      const clash = tables[table].some(row => row !== ignoreRow && keyOf(row) === key);
      if (clash) return index;
    }
    return null;
  };

  const matches = (row, filters) => filters.every(([op, column, value]) => {
    if (op === 'eq') return row[column] === value;
    if (op === 'gte') return String(row[column] ?? '') >= String(value);
    if (op === 'lte') return String(row[column] ?? '') <= String(value);
    return true;
  });

  const builder = table => {
    const filters = [];
    let mode = 'select';
    let pending = null;
    let upsertOptions = null;
    let limit = null;

    const api = {
      select() { return api; },
      eq(column, value) { filters.push(['eq', column, value]); return api; },
      gte(column, value) { filters.push(['gte', column, value]); return api; },
      lte(column, value) { filters.push(['lte', column, value]); return api; },
      limit(n) { limit = n; return api; },

      insert(row) { mode = 'insert'; pending = row; return api; },
      update(patch) { mode = 'update'; pending = patch; return api; },
      upsert(row, options) { mode = 'upsert'; pending = row; upsertOptions = options || {}; return api; },

      /* `run()` directly, NOT `api.then(...)`. `api` is itself thenable, so
         awaiting it inside its own terminal method resolves to undefined and
         every caller destructures `{ data, error }` off nothing. */
      async maybeSingle() { return run(); },
      async single() { return run(); },

      /* Thenable, so `await db.from(...).update(...).eq(...)` works with no
         terminal call — which is how the route writes its updates. */
      then(resolve, reject) {
        try {
          resolve(run());
        } catch (error) {
          if (reject) reject(error); else throw error;
        }
      }
    };

    const run = () => {
      if (mode === 'insert') {
        const row = { ...clone(pending) };
        const pk = PRIMARY_KEY[table];
        if (pk && !row[pk]) row[pk] = randomUUID();
        const index = violated(table, row);
        calls.push({ table, mode, row: clone(row), rejected: index || null });
        if (index) return { data: null, error: conflict(index) };
        tables[table].push(row);
        return { data: clone(row), error: null };
      }

      if (mode === 'upsert') {
        const row = { ...clone(pending) };
        const pk = PRIMARY_KEY[table];
        if (pk && !row[pk]) row[pk] = randomUUID();
        const index = violated(table, row);
        calls.push({ table, mode, row: clone(row), absorbed: Boolean(index) });
        if (index) {
          /* `ignoreDuplicates: true` is what the route asks for on a timeline
             append: a repeated append is absorbed, not an error. */
          if (upsertOptions?.ignoreDuplicates) return { data: null, error: null };
          return { data: null, error: conflict(index) };
        }
        tables[table].push(row);
        return { data: clone(row), error: null };
      }

      if (mode === 'update') {
        const targets = tables[table].filter(row => matches(row, filters));
        for (const row of targets) {
          const candidate = { ...row, ...clone(pending) };
          const index = violated(table, candidate, row);
          if (index) return { data: null, error: conflict(index) };
          Object.assign(row, clone(pending));
        }
        calls.push({ table, mode, patch: clone(pending), matched: targets.length });
        return { data: clone(targets), error: null };
      }

      let found = tables[table].filter(row => matches(row, filters));
      if (limit !== null) found = found.slice(0, limit);
      calls.push({ table, mode: 'select', filters: clone(filters), matched: found.length });
      return { data: found.length ? clone(found[0]) : null, error: null };
    };

    return api;
  };

  return {
    tables,
    calls,
    from: table => {
      if (!(table in tables)) throw new Error(`fake-sales-db: unknown table ${table}`);
      return builder(table);
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args: clone(args) });
      if (seed.rpc && name in seed.rpc) return seed.rpc[name](args);
      if (name === 'staff_operator_guard') return { data: 'ok', error: null };
      if (name === 'check_rate_limit') {
        return { data: [{ allowed: true, retry_after_seconds: 0 }], error: null };
      }
      return { data: null, error: null };
    }
  };
}
