-- ============================================================
-- CED Intelligence Platform — Milestone 1.1 production hardening
--
-- Applied AFTER 0001 and 0002. This migration:
--
--   1. splits identifier STRENGTH from identifier TRUST, so a
--      value typed into a public form can never link a record
--   2. narrows the uniqueness backstop to VERIFIED identifiers,
--      so squatting a place id reserves nothing
--   3. adds pseudonymous, database-backed rate limiting
--      (no raw address is ever stored)
--   4. adds a controlled redaction function, because an
--      append-only store with no erasure path is not tenable
--      once it holds real contact details
--   5. adds an expiry sweep for idempotency records
--   6. REPLACES ingest_assessment() to fix the timestamp
--      constraint conflict, make candidate lookup index-usable,
--      stop persisting context as identity, surface cross-
--      business identifier conflicts instead of swallowing
--      them, and maintain the BIR supersession chain
--
-- Row Level Security stays ON and FORCED with NO policies on
-- every table, including the new one. Only the service role
-- reaches any of this, and it lives exclusively in the Vercel
-- function.
--
-- NOTHING HERE HAS BEEN EXECUTED against a real Postgres. See
-- docs/PRODUCTION_HARDENING.md, "Real-Postgres test plan".
-- ============================================================

-- ------------------------------------------------------------
-- 1. Identifier trust model
-- ------------------------------------------------------------

alter table public.business_identifiers
  add column if not exists verification_method   text not null default 'none',
  add column if not exists verification_evidence jsonb,
  add column if not exists claimed_at            timestamptz not null default now();

-- Existing rows predate the vocabulary; 'assessment' meant "someone typed it".
update public.business_identifiers
   set source = 'visitor_supplied'
 where source in ('assessment', 'form');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_identifiers_source_check') then
    alter table public.business_identifiers
      add constraint business_identifiers_source_check check (
        source in ('visitor_supplied','trusted_integration','verified_enrichment',
                   'authenticated_customer','manual_verification','seed')
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'business_identifiers_verification_method_check') then
    alter table public.business_identifiers
      add constraint business_identifiers_verification_method_check check (
        verification_method in ('none','integration_callback','enrichment_provider',
                               'authenticated_session','operator_review','domain_control','payment_instrument')
      );
  end if;

  -- The rule that makes the trust model real rather than advisory: a row may
  -- not claim to be verified unless it came from a source we trust AND names
  -- the method by which it was verified.
  if not exists (select 1 from pg_constraint where conname = 'business_identifiers_verified_requires_trust') then
    alter table public.business_identifiers
      add constraint business_identifiers_verified_requires_trust check (
        verified = false
        or (source in ('trusted_integration','verified_enrichment','authenticated_customer',
                       'manual_verification','seed')
            and verification_method <> 'none')
      );
  end if;

  -- Bounded so a value can never exceed the btree index entry limit, which
  -- would abort ingestion with an error that is not a unique violation.
  if not exists (select 1 from pg_constraint where conname = 'business_identifiers_value_length') then
    alter table public.business_identifiers
      add constraint business_identifiers_value_length check (
        length(normalized_value) between 1 and 256
        and (raw_value is null or length(raw_value) <= 512)
      );
  end if;

  -- Context is not identity. The vertical belongs on business_records.
  if not exists (select 1 from pg_constraint where conname = 'business_identifiers_no_context_types') then
    alter table public.business_identifiers
      add constraint business_identifiers_no_context_types check (
        identifier_type not in ('vertical','locality')
      );
  end if;
end $$;

-- Any context rows written before this migration are evidence of nothing.
delete from public.business_identifiers where identifier_type in ('vertical','locality');

-- THE key change. Uniqueness now applies to VERIFIED strong identifiers only.
-- An unverified claim is recorded as evidence and reserves nothing, so no one
-- can squat a place id to block the business that actually owns it.
drop index if exists public.business_identifiers_strong_unique;

create unique index if not exists business_identifiers_verified_strong_unique
  on public.business_identifiers (identifier_type, normalized_value)
  where valid_to is null
    and verified = true
    and identifier_type in ('gbp_place_id','external_customer_id','payment_customer_id');

-- Candidate lookup joins on exactly this pair; keep it lean and partial.
drop index if exists public.business_identifiers_lookup_idx;
create index if not exists business_identifiers_lookup_idx
  on public.business_identifiers (identifier_type, normalized_value)
  where valid_to is null;

-- ------------------------------------------------------------
-- 2. Payload version compatibility, recorded per submission
-- ------------------------------------------------------------

alter table public.assessment_submissions
  add column if not exists payload_schema_version integer,
  add column if not exists ingest_meta jsonb not null default '{}'::jsonb;

update public.assessment_submissions
   set payload_schema_version = coalesce((raw_payload ->> 'schemaVersion')::integer, 2)
 where payload_schema_version is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assessment_submissions_payload_version_check') then
    alter table public.assessment_submissions
      add constraint assessment_submissions_payload_version_check check (
        payload_schema_version is null or payload_schema_version between 2 and 3
      );
  end if;
end $$;

comment on column public.assessment_submissions.payload_schema_version is
  'Accepted payload schema range. Widen deliberately when the endpoint widens; see docs/PRODUCTION_HARDENING.md.';
comment on column public.assessment_submissions.ingest_meta is
  'Audit-safe ingestion facts: correlation id, clock skew, clamped timeline timestamp. Never contact data.';

-- ------------------------------------------------------------
-- 3. Rate limiting — pseudonymous, fixed window
-- ------------------------------------------------------------
-- bucket_key is an HMAC computed in the function using a server-only secret.
-- No address, session id, or other raw identifier is ever written here, and
-- rotating CED_RATE_LIMIT_SECRET invalidates every historical bucket.

create table if not exists public.rate_limit_buckets (
  scope         text        not null,
  bucket_key    text        not null,
  window_start  timestamptz not null,
  request_count integer     not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,

  primary key (scope, bucket_key, window_start),
  constraint rate_limit_scope_check check (scope in ('address','session')),
  constraint rate_limit_key_shape check (bucket_key ~ '^[0-9a-f]{64}$'),
  constraint rate_limit_count_positive check (request_count >= 0)
);

create index if not exists rate_limit_expiry_idx on public.rate_limit_buckets (expires_at);

comment on table public.rate_limit_buckets is
  'Fixed-window counters keyed by HMAC. Never store a raw IP address or session id here.';

create or replace function public.check_rate_limit(
  p_keys           jsonb,
  p_window_seconds integer default 900,
  p_max_requests   integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now          timestamptz := now();
  v_window_start timestamptz;
  v_expires      timestamptz;
  v_key          jsonb;
  v_scope        text;
  v_hash         text;
  v_count        integer;
  v_worst        integer := 0;
  v_worst_scope  text;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then p_window_seconds := 900; end if;
  if p_max_requests is null or p_max_requests <= 0 then p_max_requests := 20; end if;

  v_window_start := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
  -- Two windows of slack so a bucket outlives any request still referencing it.
  v_expires := v_window_start + make_interval(secs => p_window_seconds * 2);

  -- Opportunistic sweep. Probabilistic so a hot path is not also a delete path;
  -- purge_expired_rate_limit_buckets() is the deterministic version.
  if random() < 0.01 then
    delete from public.rate_limit_buckets where expires_at < v_now;
  end if;

  for v_key in select * from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb))
  loop
    v_scope := v_key ->> 'scope';
    v_hash  := v_key ->> 'key';
    continue when v_scope is null or v_hash is null;

    -- Aliased so the DO UPDATE expression refers to the target row
    -- unambiguously; a schema-qualified reference is not reliably resolvable
    -- against the insert's range-table entry.
    insert into public.rate_limit_buckets as b
           (scope, bucket_key, window_start, request_count, expires_at)
    values (v_scope, v_hash, v_window_start, 1, v_expires)
    on conflict (scope, bucket_key, window_start)
      do update set request_count = b.request_count + 1
    returning b.request_count into v_count;

    if v_count > v_worst then
      v_worst := v_count;
      v_worst_scope := v_scope;
    end if;
  end loop;

  if v_worst > p_max_requests then
    return jsonb_build_object(
      'allowed', false,
      'scope', v_worst_scope,
      'limit', p_max_requests,
      'count', v_worst,
      'windowSeconds', p_window_seconds,
      'retryAfterSeconds',
        greatest(1, ceil(extract(epoch from
          (v_window_start + make_interval(secs => p_window_seconds)) - v_now))::integer)
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'scope', v_worst_scope,
    'limit', p_max_requests,
    'count', v_worst,
    'remaining', greatest(0, p_max_requests - v_worst),
    'windowSeconds', p_window_seconds
  );
end;
$$;

revoke all on function public.check_rate_limit(jsonb, integer, integer) from public, anon, authenticated;

create or replace function public.purge_expired_rate_limit_buckets(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_removed integer;
begin
  delete from public.rate_limit_buckets where expires_at < p_now;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.purge_expired_rate_limit_buckets(timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Idempotency expiry sweep
-- ------------------------------------------------------------
-- expires_at was set from the first migration but nothing ever deleted, so
-- the table grew without bound. This is the deliberate, auditable sweep.
-- It is NOT wired to a scheduler here; see docs/PRODUCTION_HARDENING.md for
-- how it will be run (pg_cron or an authenticated maintenance route).

create or replace function public.purge_expired_idempotency_records(
  p_now   timestamptz default now(),
  p_limit integer default 10000
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_removed integer;
begin
  if p_limit is null or p_limit <= 0 then p_limit := 10000; end if;

  -- Batched so a large backlog cannot hold a long transaction open.
  with doomed as (
    select idempotency_key
      from public.idempotency_records
     where expires_at < p_now          -- ONLY past expiry; never a live key
     order by expires_at
     limit p_limit
  )
  delete from public.idempotency_records r
   using doomed d
   where r.idempotency_key = d.idempotency_key;

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.purge_expired_idempotency_records(timestamptz, integer) from public, anon, authenticated;

comment on function public.purge_expired_idempotency_records is
  'Deletes idempotency records past expires_at only. Maintenance role only. No scheduler is wired up yet.';

-- ------------------------------------------------------------
-- 5. Controlled redaction
-- ------------------------------------------------------------
-- History is append-only, so erasure cannot mean DELETE. It means replacing
-- direct identifiers in the CURRENT, mutable surfaces while leaving the
-- structural record intact.
--
-- This depends on one invariant that must not be broken: timeline_events and
-- audit_events payloads carry identifiers, statuses, and counts — NEVER
-- contact details. Both tables refuse UPDATE at the database, so if PII ever
-- reaches them it cannot be removed. Review new event payloads against this.
--
-- THIS IS A TECHNICAL FOUNDATION, NOT A COMPLIANCE CLAIM. No statement here
-- asserts that any statute is satisfied. See
-- docs/DATA_RETENTION_AND_REDACTION.md, which is pending professional review.

create or replace function public.redact_business_pii(
  p_business_id uuid,
  p_reason      text,
  p_actor       text,
  p_actor_type  text default 'human'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now            timestamptz := now();
  v_exists         boolean;
  v_submissions    integer := 0;
  v_identifiers    integer := 0;
  v_reports        integer := 0;
  v_audit_id       uuid;
  v_token constant text := '[redacted]';
begin
  if p_reason is null or length(btrim(p_reason)) < 8 then
    raise exception 'redaction_reason_required' using errcode = '22023';
  end if;
  if p_actor is null or length(btrim(p_actor)) = 0 then
    raise exception 'redaction_actor_required' using errcode = '22023';
  end if;
  if p_actor_type not in ('human','engine','integration','system') then
    raise exception 'redaction_actor_type_invalid' using errcode = '22023';
  end if;

  select true into v_exists from public.business_records where business_id = p_business_id;
  if not found then
    raise exception 'business_not_found' using errcode = 'P0002';
  end if;

  -- 5a. The current record. display_name is NOT NULL, so it is replaced
  --     rather than cleared.
  update public.business_records
     set display_name = v_token,
         legal_name   = null,
         metadata     = coalesce(metadata, '{}'::jsonb)
                        || jsonb_build_object('redactedAt', v_now, 'redactionReason', p_reason)
   where business_id = p_business_id;

  -- 5b. Raw payloads. Contact values are replaced in place; answers keep
  --     their operational content but lose the identity fields. The scoring
  --     inputs are untouched, so nothing about the analysis changes.
  update public.assessment_submissions s
     set raw_payload = (
           select jsonb_set(
                    jsonb_set(s.raw_payload, '{contact}',
                      (select coalesce(jsonb_object_agg(k,
                                case when k = 'preferredContact' then v else to_jsonb(v_token) end), '{}'::jsonb)
                         from jsonb_each(coalesce(s.raw_payload -> 'contact', '{}'::jsonb)) as t(k, v))),
                    '{answers}',
                    (select coalesce(jsonb_object_agg(k,
                              case when k in ('salonName','ownerName','email','mobile','businessName',
                                              'website','googlePlaceId','externalCustomerId','businessPhone')
                                   then to_jsonb(v_token) else v end), '{}'::jsonb)
                       from jsonb_each(coalesce(s.raw_payload -> 'answers', '{}'::jsonb)) as t(k, v)))
         ),
         ingest_meta = coalesce(ingest_meta, '{}'::jsonb)
                       || jsonb_build_object('redactedAt', v_now)
   where s.business_id = p_business_id;
  get diagnostics v_submissions = row_count;

  -- 5c. Identity evidence. PII-bearing identifiers are closed and their
  --     values destroyed. normalized_value is NOT NULL and indexed, so each
  --     row gets a unique, meaningless token rather than a shared one.
  update public.business_identifiers
     set raw_value        = null,
         normalized_value = 'redacted:' || identifier_id::text,
         verified         = false,
         valid_to         = coalesce(valid_to, v_now)
   where business_id = p_business_id
     and identifier_type in ('email_exact','email_domain','mobile_phone',
                             'business_phone','business_name','website_domain');
  get diagnostics v_identifiers = row_count;

  -- 5d. Business intelligence. ONE field is touched — the display name, which
  --     is direct PII. Every score, band, estimate, and rationale is left
  --     exactly as generated. This is recorded in the audit event below, so
  --     it is a declared change rather than a silent rewrite.
  update public.business_intelligence_reports
     set report = jsonb_set(report, '{businessProfile,displayName}', to_jsonb(v_token))
   where business_id = p_business_id
     and report -> 'businessProfile' ? 'displayName'
     and report -> 'businessProfile' ->> 'displayName' is distinct from v_token;
  get diagnostics v_reports = row_count;

  -- 5e. Audit. Append-only, and deliberately free of the values removed.
  insert into public.audit_events (business_id, action, actor_type, actor_id, reason, new_value, correlation_id)
  values (
    p_business_id, 'business.pii_redacted', p_actor_type, p_actor, p_reason,
    jsonb_build_object(
      'submissionsRedacted', v_submissions,
      'identifiersRedacted', v_identifiers,
      'reportsDisplayNameRedacted', v_reports,
      'redactedAt', v_now
    ),
    'redaction:' || p_business_id::text
  )
  returning audit_event_id into v_audit_id;

  return jsonb_build_object(
    'businessId', p_business_id,
    'redactedAt', v_now,
    'auditEventId', v_audit_id,
    'redacted', jsonb_build_object(
      'businessRecordDisplayName', true,
      'businessRecordLegalName', true,
      'assessmentSubmissionContact', v_submissions,
      'assessmentSubmissionIdentityAnswers', v_submissions,
      'identityEvidenceRows', v_identifiers,
      'birDisplayName', v_reports
    ),
    'preserved', jsonb_build_object(
      'businessId', 'permanent, opaque, not derived from contact data',
      'timelineEvents', 'append-only skeleton retained; payloads carry no contact data',
      'auditEvents', 'append-only, retained in full',
      'assessmentScoresAndAnswers', 'operational answers and all scoring retained',
      'birAnalysis', 'every score, band, estimate, and rationale retained unchanged',
      'consentRecords', 'retained as proof of what was shown and agreed',
      'attribution', 'campaign attribution retained; review separately if a URL can carry contact data'
    ),
    'notes', jsonb_build_array(
      'Timeline and audit history cannot be updated by design; they are retained in structural form.',
      'External systems (payment processor, CRM, email provider) are NOT touched by this function.',
      'This function makes no claim of compliance with any law or regulation.'
    )
  );
end;
$$;

revoke all on function public.redact_business_pii(uuid, text, text, text) from public, anon, authenticated;

comment on function public.redact_business_pii is
  'Controlled PII redaction for one Business Record. Maintenance role only. Not a compliance guarantee.';

-- ------------------------------------------------------------
-- 6. ingest_assessment v2
-- ------------------------------------------------------------
-- The signature changes (p_meta is added), so the old function is dropped
-- rather than replaced: two overloads would make the PostgREST call
-- ambiguous.

drop function if exists public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer);

create or replace function public.ingest_assessment(
  p_idempotency_key text,
  p_request_hash    text,
  p_payload         jsonb,
  p_signals         jsonb,
  p_bir             jsonb,
  p_bir_id          uuid,
  p_retention_days  integer default 30,
  p_meta            jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now             timestamptz := now();
  v_submission_id   uuid := (p_payload ->> 'submissionId')::uuid;
  v_session_id      uuid := (p_payload ->> 'assessmentSessionId')::uuid;
  v_vertical_id     text := coalesce(p_payload -> 'vertical' ->> 'id', 'unknown');
  v_display_name    text := left(coalesce(nullif(p_payload -> 'contact' ->> 'salonName', ''), 'Unnamed business'), 160);
  v_submitted_at    timestamptz := coalesce((p_payload ->> 'submittedAt')::timestamptz, v_now);
  v_schema_version  integer := coalesce((p_payload ->> 'schemaVersion')::integer, 2);
  -- sha256() is built into pg_catalog (PostgreSQL 11+), so this needs no
  -- extension. digest() would have worked only if pgcrypto happened to live
  -- in the search_path, which on Supabase is not guaranteed — extensions are
  -- frequently installed into an `extensions` schema. Replaces the md5() used
  -- in 0002, which was never a security choice but reads badly in review.
  v_payload_hash    text := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  -- The timeline requires recorded_at >= occurred_at. A device clock running
  -- fast must never abort ingestion, so the event timestamp is clamped here
  -- while assessment_submissions.submitted_at keeps the visitor's value.
  v_timeline_at     timestamptz := least(v_submitted_at, v_now);

  v_existing        public.idempotency_records%rowtype;
  v_claimed_rows    integer := 0;

  v_session_business uuid;
  v_business_id     uuid;
  v_identity_status text;
  v_resolution_status text;
  v_recommended_action text;
  v_link_method     text;
  v_confidence      numeric(3,2);
  v_case_id         uuid;
  v_created_business boolean := false;

  v_candidates      jsonb := '[]'::jsonb;
  v_verified_ids    uuid[];
  v_all_ids         uuid[];
  v_contributing    jsonb := '[]'::jsonb;
  v_conflicting     jsonb := '[]'::jsonb;
  v_claim_conflicts jsonb := '[]'::jsonb;

  v_prev_bir        uuid;
  v_report          jsonb;
  v_event_ids       uuid[] := array[]::uuid[];
  v_event_id        uuid;
  v_response        jsonb;
  v_next_action     text;
  v_signal          jsonb;
  v_holder          uuid;

  c_strong_types constant text[] := array['gbp_place_id','external_customer_id','payment_customer_id'];
  c_context_types constant text[] := array['vertical','locality'];
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'missing_idempotency_key' using errcode = '22023';
  end if;

  -- --------------------------------------------------------
  -- 1. Claim the idempotency key. The insert IS the lock.
  -- --------------------------------------------------------
  insert into public.idempotency_records (idempotency_key, submission_id, request_hash, expires_at)
  values (p_idempotency_key, v_submission_id, p_request_hash, v_now + make_interval(days => p_retention_days))
  on conflict (idempotency_key) do nothing;

  get diagnostics v_claimed_rows = row_count;

  if v_claimed_rows = 0 then
    select * into v_existing
      from public.idempotency_records
     where idempotency_key = p_idempotency_key
       for update;

    if v_existing.request_hash is distinct from p_request_hash then
      raise exception 'idempotency_key_conflict' using errcode = '23505';
    end if;

    if v_existing.response_body is not null then
      -- A replay creates nothing: no second record, no second BIR, no second
      -- link in the supersession chain, no second timeline entry.
      return jsonb_set(v_existing.response_body, '{replayed}', 'true'::jsonb);
    end if;

    -- Claimed but unfinished: a concurrent request holds it.
    raise exception 'request_in_flight' using errcode = '55P03';
  end if;

  -- --------------------------------------------------------
  -- 2. Session. Upsert without disturbing an existing link.
  -- --------------------------------------------------------
  insert into public.assessment_sessions (assessment_session_id, first_touch, created_at, last_seen_at)
  values (
    v_session_id,
    coalesce(p_payload -> 'attribution' -> 'firstTouch', '{}'::jsonb),
    v_now, v_now
  )
  on conflict (assessment_session_id) do update
    set last_seen_at = v_now;

  select business_id into v_session_business
    from public.assessment_sessions
   where assessment_session_id = v_session_id
     for update;

  -- --------------------------------------------------------
  -- 3. Identity resolution
  --
  -- Candidate lookup drives from the small set of claimed signals INTO
  -- business_identifiers, so business_identifiers_lookup_idx is usable.
  -- The previous shape correlated a subquery against every identifier row
  -- and degraded linearly with the size of the table.
  --
  -- Only VERIFIED strong identifiers can produce an automatic link. A
  -- claimed one is evidence for a human, never a decision.
  -- --------------------------------------------------------
  if v_session_business is not null then
    -- Rule B2: a saved journey is deterministic for itself.
    v_business_id        := v_session_business;
    v_identity_status    := 'linked';
    v_resolution_status  := 'unique_match';
    v_recommended_action := 'link_to_existing';
    v_link_method        := 'session';
    v_confidence         := 1.00;
    v_contributing       := '["assessment_session_link"]'::jsonb;
  else
    with claimed as (
      select s ->> 'type'            as identifier_type,
             s ->> 'normalizedValue' as normalized_value
        from jsonb_array_elements(coalesce(p_signals, '[]'::jsonb)) s
       where s ->> 'type' is not null
         and s ->> 'normalizedValue' is not null
         and not (s ->> 'type' = any (c_context_types))
    ),
    matches as (
      select bi.business_id,
             array_agg(distinct bi.identifier_type) as matched_types,
             array_remove(array_agg(distinct case
               when bi.verified and bi.identifier_type = any (c_strong_types)
               then bi.identifier_type end), null) as verified_strong_types,
             array_remove(array_agg(distinct case
               when not bi.verified and bi.identifier_type = any (c_strong_types)
               then bi.identifier_type end), null) as claimed_strong_types
        from claimed c
        join public.business_identifiers bi
          on bi.identifier_type  = c.identifier_type
         and bi.normalized_value = c.normalized_value
         and bi.valid_to is null
        join public.business_records br
          on br.business_id = bi.business_id
         and br.merged_into_business_id is null
       group by bi.business_id
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'businessId', business_id,
        'matchedTypes', to_jsonb(matched_types),
        'verifiedStrongTypes', to_jsonb(verified_strong_types),
        'claimedStrongTypes', to_jsonb(claimed_strong_types))), '[]'::jsonb),
      array_agg(business_id) filter (where cardinality(verified_strong_types) > 0),
      array_agg(business_id)
      into v_candidates, v_verified_ids, v_all_ids
      from matches;

    v_verified_ids := coalesce(v_verified_ids, array[]::uuid[]);
    v_all_ids      := coalesce(v_all_ids, array[]::uuid[]);

    if array_length(v_all_ids, 1) is null then
      -- Rule B4: no credible candidate -> create.
      v_business_id        := gen_random_uuid();
      v_identity_status    := 'linked';
      v_resolution_status  := 'no_match';
      v_recommended_action := 'create_new_record';
      v_link_method        := 'auto';
      v_confidence         := 0.00;
      v_created_business   := true;

    elsif array_length(v_verified_ids, 1) = 1 then
      -- Rule B3: exactly one candidate carries a VERIFIED strong identifier.
      v_business_id        := v_verified_ids[1];
      v_identity_status    := 'linked';
      v_resolution_status  := 'unique_match';
      v_recommended_action := 'link_to_existing';
      v_link_method        := 'auto';
      v_confidence         := 0.95;
      select coalesce(jsonb_agg(c -> 'matchedTypes'), '[]'::jsonb) into v_contributing
        from jsonb_array_elements(v_candidates) c
       where (c ->> 'businessId')::uuid = v_business_id;

    else
      -- Rule B5: ambiguous. Never a second permanent record, never a merge.
      -- Weak-only matches and unverified claims both land here.
      v_business_id        := null;
      v_identity_status    := 'resolution_pending';
      v_resolution_status  := case
                                when array_length(v_verified_ids, 1) > 1 then 'possible_duplicate'
                                when exists (select 1 from jsonb_array_elements(v_candidates) c
                                              where jsonb_array_length(coalesce(c -> 'claimedStrongTypes','[]'::jsonb)) > 0)
                                  then 'manual_review_required'
                                when array_length(v_all_ids, 1) = 1 then 'probable_match'
                                else 'possible_duplicate'
                              end;
      v_recommended_action := 'queue_for_review';
      v_link_method        := null;
      v_confidence         := case when array_length(v_verified_ids, 1) > 1 then 0.75 else 0.60 end;
      v_conflicting        := v_candidates;
    end if;
  end if;

  -- --------------------------------------------------------
  -- 4. Create the Business Record when required
  -- --------------------------------------------------------
  if v_created_business then
    insert into public.business_records (
      business_id, schema_version, identity_status, display_name,
      vertical_id, lifecycle_state, created_at, updated_at, metadata
    ) values (
      v_business_id, 1, 'linked', v_display_name,
      v_vertical_id, 'lead_assessed', v_now, v_now,
      jsonb_build_object('createdFrom', 'assessment', 'createdBySubmission', v_submission_id)
    );
  end if;

  -- --------------------------------------------------------
  -- 5. Submission (durable regardless of identity outcome)
  -- --------------------------------------------------------
  insert into public.assessment_submissions (
    submission_id, assessment_session_id, business_id, assessment_version, vertical_id,
    raw_payload, identity_status, submitted_at, received_at, payload_hash,
    consent_snapshot, attribution_snapshot, payload_schema_version, ingest_meta
  ) values (
    v_submission_id, v_session_id, v_business_id,
    coalesce(p_payload ->> 'assessmentVersion', 'unknown'), v_vertical_id,
    p_payload, v_identity_status, v_submitted_at, v_now, v_payload_hash,
    coalesce(p_payload -> 'consent', '{}'::jsonb),
    coalesce(p_payload -> 'attribution', '{}'::jsonb),
    v_schema_version,
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('timelineOccurredAt', v_timeline_at)
  );

  -- --------------------------------------------------------
  -- 6. Link the session and record identifier evidence
  --
  -- A claimed identifier that another business already holds as VERIFIED is
  -- a conflict, not a duplicate to swallow. It is recorded and raised as a
  -- case below, so an identifier collision can never disappear silently.
  -- --------------------------------------------------------
  if v_business_id is not null then
    update public.assessment_sessions
       set business_id = v_business_id, last_seen_at = v_now
     where assessment_session_id = v_session_id
       and business_id is null;

    for v_signal in select * from jsonb_array_elements(coalesce(p_signals, '[]'::jsonb))
    loop
      continue when v_signal ->> 'type' is null
                 or v_signal ->> 'normalizedValue' is null
                 or (v_signal ->> 'type') = any (c_context_types)
                 or length(v_signal ->> 'normalizedValue') > 256;

      v_holder := null;
      if (v_signal ->> 'type') = any (c_strong_types) then
        select bi.business_id into v_holder
          from public.business_identifiers bi
         where bi.valid_to is null
           and bi.verified = true
           and bi.identifier_type  = v_signal ->> 'type'
           and bi.normalized_value = v_signal ->> 'normalizedValue'
           and bi.business_id <> v_business_id
         limit 1;
      end if;

      if v_holder is not null then
        v_claim_conflicts := v_claim_conflicts || jsonb_build_object(
          'identifierType', v_signal ->> 'type',
          'heldByBusinessId', v_holder,
          'claimedBySubmissionId', v_submission_id,
          'claimSource', coalesce(v_signal ->> 'source', 'visitor_supplied'));
        continue;   -- the claim is reported, never written under this business
      end if;

      -- ON CONFLICT rather than an exception block: no subtransaction per
      -- signal, and a repeat of our own evidence is simply a no-op.
      insert into public.business_identifiers (
        business_id, identifier_type, normalized_value, raw_value, source,
        confidence, verified, verification_method, verification_evidence
      ) values (
        v_business_id,
        v_signal ->> 'type',
        v_signal ->> 'normalizedValue',
        left(v_signal ->> 'rawValue', 512),
        coalesce(v_signal ->> 'source', 'visitor_supplied'),
        case when coalesce((v_signal ->> 'verified')::boolean, false) then 0.95
             when (v_signal ->> 'strength') = 'moderate' then 0.50
             else 0.35 end,
        coalesce((v_signal ->> 'verified')::boolean, false),
        coalesce(nullif(v_signal ->> 'verificationMethod', ''), 'none'),
        v_signal -> 'verificationEvidence'
      )
      on conflict do nothing;
    end loop;
  end if;

  -- --------------------------------------------------------
  -- 7. BIR — businessId injected once identity is known, and
  --    chained to whatever the business's current BIR was.
  -- --------------------------------------------------------
  if v_business_id is not null then
    select current_bir_id into v_prev_bir
      from public.business_records
     where business_id = v_business_id
       for update;
  end if;

  v_report := jsonb_set(p_bir, '{identity,businessId}',
                        case when v_business_id is null then 'null'::jsonb
                             else to_jsonb(v_business_id::text) end);
  v_report := jsonb_set(v_report, '{identity,identityStatus}', to_jsonb(v_identity_status));
  v_report := jsonb_set(v_report, '{provenance,supersedes}',
                        case when v_prev_bir is null then 'null'::jsonb
                             else to_jsonb(v_prev_bir::text) end);

  insert into public.business_intelligence_reports (
    bir_id, business_id, assessment_submission_id, schema_version,
    generated_at, report, confidence_band, missing_critical_fields, supersedes_bir_id
  ) values (
    p_bir_id, v_business_id, v_submission_id,
    (v_report ->> 'schemaVersion')::integer,
    v_now, v_report,
    coalesce(v_report -> 'estimateConfidence' ->> 'band', 'low'),
    coalesce(v_report -> 'qualificationProfile' -> 'missingCriticalFields', '[]'::jsonb),
    v_prev_bir
  );

  -- Only after the new BIR is safely inserted. Prior BIRs are never deleted
  -- and never rewritten; the chain is what preserves them.
  if v_business_id is not null then
    update public.business_records
       set current_bir_id = p_bir_id, updated_at = v_now
     where business_id = v_business_id;
  end if;

  -- --------------------------------------------------------
  -- 8. Timeline — append-only, one row per fact
  -- --------------------------------------------------------
  if v_created_business then
    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (v_business_id, 'business.created', 1, v_timeline_at, 'business-record-engine', v_business_id::text,
            'Business Record created from a completed assessment.',
            jsonb_build_object('createdFrom','assessment','verticalId',v_vertical_id), v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'identity.resolved', 1, v_timeline_at, 'business-record-engine', v_submission_id::text,
          format('Identity resolution: %s.', v_resolution_status),
          jsonb_build_object('resolutionStatus', v_resolution_status, 'resolutionConfidence', v_confidence,
                             'recommendedAction', v_recommended_action, 'candidateCount', coalesce(array_length(v_all_ids,1),0)),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  if v_business_id is not null then
    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (v_business_id, 'identity.linked', 1, v_timeline_at, 'business-record-engine', 'submission:' || v_submission_id::text,
            'Assessment submission linked to this Business Record.',
            jsonb_build_object('linkedBusinessId', v_business_id, 'linkedArtifactKind','assessment_submission',
                               'linkedArtifactId', v_submission_id, 'linkMethod', v_link_method),
            v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  -- occurred_at is the CLAMPED timestamp. The visitor's own submittedAt is
  -- preserved verbatim on assessment_submissions and inside the payload.
  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, source_record_id, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'assessment.completed', 2, v_timeline_at, 'assessment-engine', v_submission_id::text, v_submission_id::text,
          'Assessment completed.',
          jsonb_build_object('assessmentSessionId', v_session_id, 'submissionId', v_submission_id,
                             'verticalId', v_vertical_id, 'assessmentVersion', p_payload ->> 'assessmentVersion',
                             'payloadSchemaVersion', v_schema_version,
                             'reportedSubmittedAt', p_payload ->> 'submittedAt',
                             'clockSkewDetected', coalesce((p_meta ->> 'clockSkewDetected')::boolean, false)),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, source_record_id, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'bir.generated', 1, v_timeline_at, 'business-intelligence-engine', p_bir_id::text, p_bir_id::text,
          'Business Intelligence Report generated.',
          jsonb_build_object('birId', p_bir_id, 'supersedesBirId', v_prev_bir,
                             'confidenceBand', v_report -> 'estimateConfidence' ->> 'band',
                             'closeReadinessBand', v_report -> 'closeReadinessProfile' ->> 'band'),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  -- --------------------------------------------------------
  -- 9. Ambiguity or conflict -> a case for a human.
  --    Never a second record, never a merge.
  -- --------------------------------------------------------
  if v_identity_status = 'resolution_pending' or v_claim_conflicts <> '[]'::jsonb then
    insert into public.identity_resolution_cases (
      assessment_submission_id, candidate_business_ids, contributing_signals,
      conflicting_signals, confidence, resolution_status, recommended_action
    ) values (
      v_submission_id, v_candidates, v_contributing,
      case when v_claim_conflicts = '[]'::jsonb then v_conflicting
           else v_conflicting || v_claim_conflicts end,
      coalesce(v_confidence, 0.00),
      case when v_identity_status = 'resolution_pending' then v_resolution_status
           else 'manual_review_required' end,
      'queue_for_review'
    ) returning identity_resolution_id into v_case_id;

    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (v_business_id, 'identity.review_required', 1, v_timeline_at, 'business-record-engine', v_case_id::text,
            case when v_claim_conflicts <> '[]'::jsonb
                 then 'A claimed identifier is already held, verified, by another business.'
                 else 'Identity could not be resolved automatically; queued for review.' end,
            jsonb_build_object('identityResolutionId', v_case_id, 'resolutionStatus', v_resolution_status,
                               'reason', case when v_claim_conflicts <> '[]'::jsonb
                                              then 'Cross-business claim on a verified identifier.'
                                              else 'No unique verified strong identifier among candidates.' end,
                               'candidateBusinessIds', v_candidates,
                               'claimConflicts', v_claim_conflicts),
            v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  -- --------------------------------------------------------
  -- 10. Audit
  -- --------------------------------------------------------
  insert into public.audit_events (business_id, action, actor_type, actor_id, reason, new_value, correlation_id)
  values (v_business_id, 'assessment.ingested', 'engine', 'business-record-engine',
          format('Ingested submission %s with identity status %s.', v_submission_id, v_identity_status),
          jsonb_build_object('submissionId', v_submission_id, 'birId', p_bir_id,
                             'supersedesBirId', v_prev_bir,
                             'identityStatus', v_identity_status, 'resolutionStatus', v_resolution_status,
                             'payloadSchemaVersion', v_schema_version,
                             'ingestMeta', coalesce(p_meta, '{}'::jsonb),
                             'claimConflicts', v_claim_conflicts),
          coalesce(p_meta ->> 'correlationId', v_submission_id::text));

  -- --------------------------------------------------------
  -- 11. Response, stored for replay
  -- --------------------------------------------------------
  v_next_action := case when v_identity_status = 'resolution_pending'
                        then 'identity_review_pending' else 'results_ready' end;

  v_response := jsonb_build_object(
    'ok', true,
    'replayed', false,
    'submissionId', v_submission_id,
    'assessmentSessionId', v_session_id,
    'businessId', v_business_id,
    'assessmentId', v_submission_id,
    'birId', p_bir_id,
    'supersedesBirId', v_prev_bir,
    'identityStatus', v_identity_status,
    'payloadSchemaVersion', v_schema_version,
    'clockSkewDetected', coalesce((p_meta ->> 'clockSkewDetected')::boolean, false),
    'timelineEventIds', to_jsonb(v_event_ids),
    'receivedAt', to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'nextAction', v_next_action
  );

  update public.idempotency_records
     set response_status = 201,
         response_body   = v_response,
         submission_id   = v_submission_id
   where idempotency_key = p_idempotency_key;

  return v_response;
end;
$$;

revoke all on function public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb)
  from public, anon, authenticated;

comment on function public.ingest_assessment is
  'Atomic assessment ingestion. One call = one transaction. Server-role only.';

-- ------------------------------------------------------------
-- 7. Row Level Security for the new table
-- ------------------------------------------------------------

alter table public.rate_limit_buckets enable row level security;
alter table public.rate_limit_buckets force  row level security;

revoke all on all tables in schema public from anon, authenticated;

-- ------------------------------------------------------------
-- 8. Trigger functions — search_path and execute
-- ------------------------------------------------------------
-- Found by the real-Postgres validation run: 0001 created these two without a
-- pinned search_path and left the default PUBLIC execute grant, so anon and
-- authenticated could call them and Supabase's linter flagged
-- function_search_path_mutable on both.
--
-- Neither is SECURITY DEFINER, so the exposure is small: called directly,
-- touch_updated_at() errors because it is not running as a trigger, and
-- reject_mutation() only raises. But "small" is not "none", every other
-- function in this schema pins its path, and the documentation claims execute
-- is revoked from anon and authenticated. Making that true is a two-line fix.

create or replace function public.reject_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'append_only_violation: % is append-only; write a new row instead', tg_table_name
    using errcode = 'raise_exception';
end;
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.reject_mutation() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
