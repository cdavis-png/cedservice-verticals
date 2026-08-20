-- ============================================================
-- 0009 — AEO evidence store and scan harness (minimum)
-- ============================================================
-- Applied AFTER 0001 through 0008. Never applied anywhere yet.
--
-- Build order step 2 of BIR-replacement-spec.md v1.7: "Build the
-- minimum scan harness and evidence store. Admin-triggered,
-- cost-estimated, provenance-complete." Nothing here captures
-- anything. It is the place captures will be RECORDED, built
-- before the first capture so no observation can exist without
-- its provenance.
--
-- WHY MARKET-SCOPED, NOT BUSINESS-SCOPED
--
-- Every table added since 0001 hangs off business_id. These do not.
-- "What are the best nail salons in Easley?" is a question about a
-- MARKET (section 3). One panel run describes every salon in it —
-- claimed, unclaimed, and not yet discovered — so an observation
-- cannot be filed under a Business Record without inventing a link
-- the evidence does not contain. The join is `mentions`, which
-- parses a named business out of a raw response, and it is step 3
-- work: nothing here references business_records at all.
--
-- THREE RULES THIS FILE EXISTS TO ENFORCE, all in the database
-- rather than in the harness, because a harness can be bypassed.
--
--   1. SYNTHETIC EVIDENCE IS NEVER ADMISSIBLE. Every batch declares
--      an execution_mode and every observation carries the matching
--      evidence_origin. Only `live_capture` can be admissible or
--      count toward consumer reach. A fixture may prove that
--      recording works; it may never prove that a customer saw
--      anything. The default is `fixture`, so a forgotten
--      declaration fails toward inadmissible rather than toward a
--      fabricated finding.
--
--   2. AN OWNER APPROVES AN EXACT WORKLOAD, NOT AN INTENTION. The
--      attempts are materialized from versioned configuration
--      FIRST, hashed, counted and priced; the owner approves that
--      hash, that count and a cost ceiling. Afterwards the attempt
--      set is frozen, and an observation can only be recorded
--      against a materialized attempt of an approved batch. A
--      configuration changed later cannot reach a batch already
--      materialized.
--
--   3. RAW PAYLOADS EXPIRE; EVIDENCE DOES NOT. The observation is
--      append-only and immutable and keeps provenance, status,
--      timestamps, byte count, content type and a SHA-256 content
--      hash forever. The raw text lives in a separate, disposable
--      table with its own expiry. Disposal is service-role only and
--      is recorded in audit_events. The evidence record itself
--      never becomes mutable.
--
-- WHAT IS DELIBERATELY NOT HERE: mentions, ground truth,
-- comparables, business profiles, review sessions, interviews,
-- reports, owner authorization — all downstream of the mandatory
-- stop-and-report gate at step 4. No vendor, endpoint, credential
-- or collection code: section 19 leaves the Google AI Overview
-- capture path open and gives Grok none at all, and committing to
-- one here would decide by accident what step 4 decides on
-- evidence. No screenshots, binaries, headers, cookies or
-- authentication material are collected or storable.
--
-- Every statement is re-runnable.

-- ------------------------------------------------------------
-- 1. Markets
-- ------------------------------------------------------------
-- New because nothing in 0001-0008 has any concept of place:
-- business_records carries no city, region or postal column.
-- `status` is the section 15.4 authorization gate — a scan may only
-- run against a market somebody authorized, so "which city gets
-- scanned" falls out of data rather than out of a feature.
create table if not exists public.aeo_markets (
  market_id     uuid        primary key default gen_random_uuid(),
  city          text        not null,
  state         text        not null,
  country_code  text        not null default 'US',
  status        text        not null default 'candidate',
  authorized_at timestamptz,
  created_at    timestamptz not null default now(),

  constraint aeo_markets_city_present    check (length(btrim(city)) > 0),
  constraint aeo_markets_state_present   check (length(btrim(state)) > 0),
  constraint aeo_markets_status_check    check (status in ('candidate', 'authorized', 'retired')),
  -- status and authorized_at are one fact written twice and may not
  -- disagree. Same shape as staff_operators.active/disabled_at.
  constraint aeo_markets_authorized_pair check ((status = 'authorized') = (authorized_at is not null))
);

create unique index if not exists aeo_markets_place_key
  on public.aeo_markets (lower(btrim(city)), lower(btrim(state)), upper(btrim(country_code)));

comment on table public.aeo_markets is
  'A local market a panel is run against. New in 0009: no table before it carried a place. status = authorized is the section 15.4 spend gate.';

-- ------------------------------------------------------------
-- 2. Panel versions and questions
-- ------------------------------------------------------------
create table if not exists public.aeo_panel_versions (
  panel_version_id uuid        primary key default gen_random_uuid(),
  category         text        not null,
  version          text        not null,
  frozen_at        timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),

  constraint aeo_panel_versions_category_present check (length(btrim(category)) > 0),
  constraint aeo_panel_versions_version_present  check (length(btrim(version)) > 0)
);

create unique index if not exists aeo_panel_versions_key
  on public.aeo_panel_versions (lower(btrim(category)), lower(btrim(version)));

comment on table public.aeo_panel_versions is
  'A frozen question panel for one category. Section 4.1: wording is frozen because month-over-month comparison is invalid if it drifts. Re-word by creating a new version, never by editing one.';

create table if not exists public.aeo_panel_questions (
  panel_question_id uuid        primary key default gen_random_uuid(),
  panel_version_id  uuid        not null references public.aeo_panel_versions (panel_version_id) on delete restrict,
  question_key      text        not null,
  intent            text        not null,
  template          text        not null,
  position          integer     not null,
  created_at        timestamptz not null default now(),

  constraint aeo_panel_questions_key_present      check (length(btrim(question_key)) > 0),
  constraint aeo_panel_questions_template_present check (length(btrim(template)) > 0),
  constraint aeo_panel_questions_position_check   check (position > 0)
);

create unique index if not exists aeo_panel_questions_version_key
  on public.aeo_panel_questions (panel_version_id, lower(btrim(question_key)));
create unique index if not exists aeo_panel_questions_version_position
  on public.aeo_panel_questions (panel_version_id, position);

comment on table public.aeo_panel_questions is
  'One frozen question template. {city} and {state} are the only variables (section 4.1); a visitor never generates a prompt.';

-- ------------------------------------------------------------
-- 3. Engines and their configurations
-- ------------------------------------------------------------
create table if not exists public.aeo_engines (
  engine_id    uuid        primary key default gen_random_uuid(),
  engine_key   text        not null,
  display_name text        not null,
  created_at   timestamptz not null default now(),

  constraint aeo_engines_key_present check (length(btrim(engine_key)) > 0)
);

create unique index if not exists aeo_engines_key
  on public.aeo_engines (lower(btrim(engine_key)));

comment on table public.aeo_engines is
  'An answer engine as a product family. What actually produced an observation is the CONFIGURATION, not this row.';

-- IMMUTABLE (section 4.4, section 17 comment). If a product, model,
-- vendor or capture method changes, insert a NEW row: editing one
-- would silently rewrite what produced every observation already
-- filed against it, and the recurring fee rests on that comparison
-- being sound.
--
-- estimated_unit_cost_usd is what makes a deterministic cost
-- ceiling possible. Neither CLAUDE.md nor v1.7 supplies unit costs,
-- so it defaults to 0 and is reported as such; a batch priced at 0
-- is honestly priced at 0 rather than falsely priced at a guess.
create table if not exists public.aeo_engine_configurations (
  engine_configuration_id uuid          primary key default gen_random_uuid(),
  engine_id               uuid          not null references public.aeo_engines (engine_id) on delete restrict,
  surface_type            text          not null,
  product_name            text          not null,
  model_identifier        text,
  capture_method          text          not null,
  collector_version       text          not null,
  -- NO DEFAULT, and nullable on purpose. A default of 0 made an
  -- unpriced configuration look free, which let an owner approve a
  -- $0.00 ceiling for a batch nobody had costed. Unknown must stay
  -- unknown: NULL means "nobody has established a price", and an
  -- explicit 0 means "this genuinely costs nothing". Materialization
  -- refuses a plan containing the first and accepts the second.
  estimated_unit_cost_usd numeric(10,4),
  configuration           jsonb         not null default '{}'::jsonb,
  created_at              timestamptz   not null default now(),

  constraint aeo_engine_configurations_surface_check
    check (surface_type in ('consumer_surface', 'proxy')),
  constraint aeo_engine_configurations_product_present
    check (length(btrim(product_name)) > 0),
  constraint aeo_engine_configurations_capture_present
    check (length(btrim(capture_method)) > 0),
  constraint aeo_engine_configurations_collector_present
    check (length(btrim(collector_version)) > 0),
  constraint aeo_engine_configurations_cost_not_negative
    check (estimated_unit_cost_usd is null or estimated_unit_cost_usd >= 0)
);

create index if not exists aeo_engine_configurations_engine_idx
  on public.aeo_engine_configurations (engine_id);

comment on table public.aeo_engine_configurations is
  'IMMUTABLE. Exactly what produced an observation: product, model, capture method, collector version, unit cost. Section 4.4 — a vendor exposing a ChatGPT scraper and a ChatGPT API model endpoint is two configurations, never one. UPDATE and DELETE are refused by trigger.';

-- ------------------------------------------------------------
-- 3b. Capture verification — the thing `live_capture` is NOT
-- ------------------------------------------------------------
-- `evidence_origin = 'live_capture'` states an INTENTION. It is
-- chosen by whoever started the batch and proves nothing: a caller
-- who simply picks that word would otherwise manufacture admissible
-- evidence out of a simulation, which is exactly what the first
-- draft of this migration allowed.
--
-- Admissibility therefore additionally requires an independent,
-- evidence-backed record that the capture PATH itself was verified
-- to reach a real surface. That record is a row here.
--
-- A separate table rather than a column because
-- aeo_engine_configurations is immutable: verification is a fact
-- learned later about an unchanged configuration, not an edit to
-- it. Rows are insert-only; the single permitted later change is
-- setting revoked_at once, the same narrow exception the disposal
-- marker gets.
--
-- STEP 2 WRITES NO ROWS HERE, and that is deliberate. Section 19
-- leaves the Google AI Overview capture path open and gives Grok
-- none at all, so nothing in this repository has reached a real
-- consumer surface. Until step 3 establishes and registers a
-- validated collection path, every observation this store can hold
-- is inadmissible — which is the honest position rather than a
-- limitation.
create table if not exists public.aeo_capture_verifications (
  verification_id         uuid        primary key default gen_random_uuid(),
  engine_configuration_id uuid        not null references public.aeo_engine_configurations (engine_configuration_id) on delete restrict,
  verified_at             timestamptz not null default now(),
  verified_by             uuid,
  method                  text        not null,
  evidence_ref            text        not null,
  notes                   text,
  revoked_at              timestamptz,
  revoked_reason          text,
  created_at              timestamptz not null default now(),

  constraint aeo_capture_verifications_method_present   check (length(btrim(method)) > 0),
  -- A verification with no evidence behind it is the self-declaration
  -- this table exists to replace.
  constraint aeo_capture_verifications_evidence_present check (length(btrim(evidence_ref)) > 0),
  constraint aeo_capture_verifications_revocation_pair  check (
    (revoked_at is null) = (revoked_reason is null)
  )
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'aeo_capture_verifications_verifier_fk') then
    alter table public.aeo_capture_verifications
      add constraint aeo_capture_verifications_verifier_fk
      foreign key (verified_by) references public.staff_operators (user_id)
      on delete restrict on update restrict;
  end if;
end $$;

-- At most one LIVE verification per configuration. A second one
-- would make "is this verified" a question with two answers.
create unique index if not exists aeo_capture_verifications_active_key
  on public.aeo_capture_verifications (engine_configuration_id) where revoked_at is null;

comment on table public.aeo_capture_verifications is
  'Independent, evidence-backed proof that a capture configuration actually reaches the surface it claims. Admissibility requires one; declaring evidence_origin = live_capture does not. Step 2 writes no rows here — no collection path has been validated, so no observation is admissible yet. Step 3 establishes the mechanism.';

create table if not exists public.aeo_panel_engine_configurations (
  panel_version_id            uuid    not null references public.aeo_panel_versions (panel_version_id) on delete restrict,
  engine_configuration_id     uuid    not null references public.aeo_engine_configurations (engine_configuration_id) on delete restrict,
  tier                        text    not null,
  scheduled_runs_per_question integer not null,

  primary key (panel_version_id, engine_configuration_id),

  constraint aeo_panel_engine_configurations_tier_check
    check (tier in ('consumer', 'secondary', 'diagnostic')),
  constraint aeo_panel_engine_configurations_runs_check
    check (scheduled_runs_per_question between 1 and 100)
);

comment on table public.aeo_panel_engine_configurations is
  'Pins configurations to a frozen panel with their scheduled run counts (section 4.2). Scheduled counts are ceilings, never denominators — only observed admissible responses divide.';

-- ------------------------------------------------------------
-- 4. Scan batches
-- ------------------------------------------------------------
-- Section 15.4 controls 1 and 2: admin-only execution, and an
-- explicit cost estimate approved before the batch runs.
--
-- The lifecycle is draft -> materialized -> approved -> running ->
-- completed. Materialization comes BEFORE approval on purpose: an
-- owner must approve a fixed workload, not an intention that can
-- expand afterwards. plan_hash, attempt_count and
-- max_estimated_cost_usd are written by materialization and are
-- what the approver signs off.
--
-- execution_mode is the defect-1 fix. It defaults to `fixture`,
-- which is the safe direction: a forgotten declaration yields
-- inadmissible evidence, which is visible immediately, rather than
-- synthetic evidence labelled live, which is not.
--
-- AUTHORIZATION NOTE, flagged rather than assumed: neither
-- CLAUDE.md nor v1.7 names a role for scan approval and 15.4 says
-- only "admin-only". The narrowest reading is used — owner only.
create table if not exists public.aeo_scan_batches (
  scan_batch_id          uuid          primary key default gen_random_uuid(),
  market_id              uuid          not null references public.aeo_markets (market_id) on delete restrict,
  panel_version_id       uuid          not null references public.aeo_panel_versions (panel_version_id) on delete restrict,
  status                 text          not null default 'draft',
  execution_mode         text          not null default 'fixture',

  materialized_at        timestamptz,
  attempt_count          integer,
  plan_hash              text,
  max_estimated_cost_usd numeric(12,4),

  approved_plan_hash     text,
  approved_attempt_count integer,
  approved_cost_ceiling  numeric(12,4),
  approved_by            uuid,
  approved_at            timestamptz,

  requested_by           uuid,
  requested_at           timestamptz   not null default now(),
  started_at             timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz   not null default now(),

  constraint aeo_scan_batches_status_check check (
    status in ('draft', 'materialized', 'approved', 'running', 'completed', 'failed', 'cancelled')
  ),
  -- The same three words the observation uses, so the two can be
  -- compared directly rather than mapped.
  constraint aeo_scan_batches_execution_mode_check check (
    execution_mode in ('live_capture', 'fixture', 'replay')
  ),
  -- Materialization is one fact in four columns.
  constraint aeo_scan_batches_materialized_together check (
    (materialized_at is null)
    = (attempt_count is null and plan_hash is null and max_estimated_cost_usd is null)
  ),
  -- Approval is one fact in five columns. An approved batch names
  -- who approved it, when, and exactly what they approved.
  constraint aeo_scan_batches_approval_together check (
    (approved_at is null)
    = (approved_by is null and approved_plan_hash is null
       and approved_attempt_count is null and approved_cost_ceiling is null)
  ),
  constraint aeo_scan_batches_approved_was_materialized check (
    approved_at is null or materialized_at is not null
  ),
  -- No approved batch may carry an unknown maximum cost. The value is
  -- NULL whenever any attempt is unpriced, so this is the invariant
  -- expressed where nothing can route around it.
  constraint aeo_scan_batches_approved_cost_is_known check (
    approved_at is null or max_estimated_cost_usd is not null
  ),
  constraint aeo_scan_batches_cost_not_negative check (
    max_estimated_cost_usd is null or max_estimated_cost_usd >= 0
  ),
  constraint aeo_scan_batches_ceiling_not_negative check (
    approved_cost_ceiling is null or approved_cost_ceiling >= 0
  ),
  -- Nothing runs that was not approved. The spend gate as a
  -- constraint rather than a convention.
  constraint aeo_scan_batches_running_was_approved check (
    status in ('draft', 'materialized', 'cancelled') or approved_at is not null
  ),
  constraint aeo_scan_batches_started_before_completed check (
    completed_at is null or (started_at is not null and completed_at >= started_at)
  )
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'aeo_scan_batches_approver_fk') then
    alter table public.aeo_scan_batches
      add constraint aeo_scan_batches_approver_fk
      foreign key (approved_by) references public.staff_operators (user_id)
      on delete restrict on update restrict;
  end if;
end $$;

create index if not exists aeo_scan_batches_market_idx
  on public.aeo_scan_batches (market_id, requested_at desc);

comment on table public.aeo_scan_batches is
  'One authorized market scan. Materialized before approval so an owner approves an exact workload — a plan hash, an attempt count and a cost ceiling — rather than an intention that could expand afterwards. execution_mode defaults to fixture so a forgotten declaration produces inadmissible evidence rather than synthetic evidence labelled live.';

-- ------------------------------------------------------------
-- 5. Materialized attempts — the approved workload
-- ------------------------------------------------------------
-- The exact list of captures the owner approved, frozen at
-- materialization. Configuration changed afterwards cannot reach a
-- batch already materialized, because every value the attempt needs
-- is copied here.
create table if not exists public.aeo_scan_attempts (
  scan_attempt_id         uuid        primary key default gen_random_uuid(),
  scan_batch_id           uuid        not null references public.aeo_scan_batches (scan_batch_id) on delete restrict,
  engine_configuration_id uuid        not null references public.aeo_engine_configurations (engine_configuration_id) on delete restrict,
  panel_question_id       uuid        not null references public.aeo_panel_questions (panel_question_id) on delete restrict,
  market_id               uuid        not null references public.aeo_markets (market_id) on delete restrict,
  run_index               integer     not null,
  tier                    text        not null,
  surface_type            text        not null,
  question_text           text        not null,
  location_context        jsonb       not null default '{}'::jsonb,
  -- Copied from the configuration, NULL and all. A plan carrying one
  -- of these cannot be materialized, so an unpriced attempt can never
  -- reach an approved batch.
  unit_cost_usd           numeric(10,4),
  created_at              timestamptz not null default now(),

  constraint aeo_scan_attempts_cost_not_negative
    check (unit_cost_usd is null or unit_cost_usd >= 0),
  constraint aeo_scan_attempts_run_index_check check (run_index > 0),
  constraint aeo_scan_attempts_question_present check (length(btrim(question_text)) > 0),
  -- Section 4.1: {city} and {state} are the only variables. A question
  -- still carrying a placeholder is not the frozen wording, and asking
  -- it would silently break month-over-month comparison. Materialization
  -- is the only renderer — the harness does not render, so there is no
  -- second implementation to drift.
  constraint aeo_scan_attempts_fully_rendered check (question_text !~ '\{[a-zA-Z_]+\}'),
  constraint aeo_scan_attempts_tier_check check (tier in ('consumer', 'secondary', 'diagnostic')),
  constraint aeo_scan_attempts_surface_check check (surface_type in ('consumer_surface', 'proxy'))
);

create unique index if not exists aeo_scan_attempts_key
  on public.aeo_scan_attempts (scan_batch_id, engine_configuration_id, panel_question_id, run_index);
create index if not exists aeo_scan_attempts_batch_idx
  on public.aeo_scan_attempts (scan_batch_id);

comment on table public.aeo_scan_attempts is
  'The exact workload an owner approved, materialized from versioned configuration before approval and frozen at it. Every value an attempt needs is copied, so a configuration edited later cannot alter a batch already materialized.';

-- ------------------------------------------------------------
-- 6. Observations — immutable evidence metadata
-- ------------------------------------------------------------
-- APPEND-ONLY, like timeline_events and audit_events in 0001. The
-- raw text is NOT here: it lives in aeo_observation_payloads and
-- expires. What remains forever is the provenance — including a
-- SHA-256 of the payload, so a disposed response can still be
-- proved to have been what it was.
--
-- A failed, blocked or unsupported attempt is recorded here too.
-- Section 6 makes surface_not_triggered "a finding, not a null",
-- and a silently dropped failure turns a collection problem into an
-- apparent visibility change.
create table if not exists public.aeo_observations (
  observation_id          uuid        primary key default gen_random_uuid(),
  scan_attempt_id         uuid        not null references public.aeo_scan_attempts (scan_attempt_id) on delete restrict,
  scan_batch_id           uuid        not null references public.aeo_scan_batches (scan_batch_id) on delete restrict,
  engine_configuration_id uuid        not null references public.aeo_engine_configurations (engine_configuration_id) on delete restrict,
  panel_question_id       uuid        not null references public.aeo_panel_questions (panel_question_id) on delete restrict,
  market_id               uuid        not null references public.aeo_markets (market_id) on delete restrict,
  run_index               integer     not null,

  question_text           text        not null,
  location_context        jsonb       not null default '{}'::jsonb,

  evidence_origin         text        not null,
  personalization_state   text        not null,
  surface_type            text        not null,
  observation_status      text        not null,
  failure_reason          text,

  requested_at            timestamptz not null,
  received_at             timestamptz,

  -- Payload metadata. Survives disposal; the payload itself does not.
  content_hash            text,
  content_type            text,
  byte_count              integer,
  payload_expires_at      timestamptz,
  payload_disposed_at     timestamptz,

  citations               jsonb       not null default '[]'::jsonb,
  created_at              timestamptz not null default now(),

  constraint aeo_observations_run_index_check check (run_index > 0),
  constraint aeo_observations_question_present check (length(btrim(question_text)) > 0),
  -- Synthetic evidence is a first-class, permanent property of the row.
  constraint aeo_observations_origin_check
    check (evidence_origin in ('live_capture', 'fixture', 'replay')),
  constraint aeo_observations_personalization_check
    check (personalization_state in ('clean', 'personalized', 'unknown')),
  constraint aeo_observations_surface_check
    check (surface_type in ('consumer_surface', 'proxy')),
  constraint aeo_observations_status_check
    check (observation_status in
      ('response_observed', 'surface_not_triggered', 'collection_failed', 'inadmissible')),

  -- A response was observed, so there is a hash, a size and a time.
  -- The raw text may since have expired; the proof it existed may not.
  constraint aeo_observations_observed_has_evidence check (
    observation_status <> 'response_observed'
    or (received_at is not null and content_hash is not null
        and byte_count is not null and byte_count >= 0)
  ),
  constraint aeo_observations_failure_has_reason check (
    observation_status <> 'collection_failed'
    or (failure_reason is not null and length(btrim(failure_reason)) > 0)
  ),
  constraint aeo_observations_citations_is_array check (jsonb_typeof(citations) = 'array'),
  constraint aeo_observations_received_after_requested check (
    received_at is null or received_at >= requested_at
  ),
  constraint aeo_observations_hash_shape check (
    content_hash is null or content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint aeo_observations_byte_count_check check (
    byte_count is null or byte_count >= 0
  )
);

create unique index if not exists aeo_observations_attempt_key
  on public.aeo_observations (scan_attempt_id);
create index if not exists aeo_observations_batch_idx
  on public.aeo_observations (scan_batch_id);
-- Only live, clean, observed responses can ever be counted.
create index if not exists aeo_observations_admissible_idx
  on public.aeo_observations (market_id, surface_type)
  where observation_status = 'response_observed'
    and personalization_state = 'clean'
    and evidence_origin = 'live_capture';
create index if not exists aeo_observations_expiry_idx
  on public.aeo_observations (payload_expires_at)
  where payload_expires_at is not null and payload_disposed_at is null;

comment on table public.aeo_observations is
  'APPEND-ONLY evidence metadata. One row per approved attempt, including failures, blocks and unsupported methods. Carries evidence_origin, so synthetic evidence can never be counted as a real consumer surface, and a SHA-256 content hash that outlives the payload it describes.';

-- ------------------------------------------------------------
-- 7. Payloads — disposable, and the only mutable surface
-- ------------------------------------------------------------
-- PRODUCT RETENTION DECISION, recorded here because it is the
-- reason this table is separate: raw response payloads are retained
-- for 180 days from capture. This is a product decision and is NOT
-- a claim of compliance with any law or regulation.
--
-- Separating the payload is what lets retention exist without
-- making the evidence record mutable. UPDATE is refused; DELETE is
-- permitted, because disposal is the entire point, and it is
-- reachable only by service_role and only through
-- aeo_dispose_expired_payloads.
--
-- Text only. No screenshots, binaries, headers, cookies or
-- authentication material — none of them are storable here.
create table if not exists public.aeo_observation_payloads (
  observation_id uuid        primary key references public.aeo_observations (observation_id) on delete restrict,
  raw_response   text        not null,
  content_type   text        not null default 'text/plain',
  byte_count     integer     not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),

  constraint aeo_observation_payloads_present check (length(raw_response) > 0),
  -- 256 KiB. Deterministic, and small enough that an unexpected
  -- binary or page dump is refused rather than quietly stored.
  constraint aeo_observation_payloads_size_check check (byte_count between 1 and 262144),
  constraint aeo_observation_payloads_text_only check (
    content_type in ('text/plain', 'application/json')
  )
);

create index if not exists aeo_observation_payloads_expiry_idx
  on public.aeo_observation_payloads (expires_at);

comment on table public.aeo_observation_payloads is
  'Disposable raw response text, retained 180 days from capture (product decision, not a compliance claim). Separate from the observation so retention never makes the evidence record mutable. UPDATE refused; DELETE only via aeo_dispose_expired_payloads, service_role only.';

-- ------------------------------------------------------------
-- 8. Guards
-- ------------------------------------------------------------

-- Every cross-table claim an observation makes, checked against the
-- attempt it names. The caller supplies these values because
-- section 6 requires the record to carry them; it does not get to
-- choose them.
create or replace function public.aeo_enforce_observation_provenance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.aeo_scan_attempts;
  b public.aeo_scan_batches;
  v_config_surface text;
begin
  select * into a from public.aeo_scan_attempts where scan_attempt_id = new.scan_attempt_id;
  if not found then
    raise exception 'aeo_observations: unknown attempt %', new.scan_attempt_id
      using errcode = 'foreign_key_violation';
  end if;

  select * into b from public.aeo_scan_batches where scan_batch_id = a.scan_batch_id;

  -- Execute only what was approved.
  if b.approved_at is null then
    raise exception 'aeo_observations: batch % is not approved', b.scan_batch_id
      using errcode = 'insufficient_privilege';
  end if;

  if new.scan_batch_id is distinct from a.scan_batch_id then
    raise exception 'aeo_observations: batch % does not match its attempt (%)',
      new.scan_batch_id, a.scan_batch_id using errcode = 'check_violation';
  end if;
  if new.engine_configuration_id is distinct from a.engine_configuration_id
     or new.panel_question_id is distinct from a.panel_question_id
     or new.market_id is distinct from a.market_id
     or new.run_index is distinct from a.run_index then
    raise exception 'aeo_observations: the observation contradicts the attempt it names'
      using errcode = 'check_violation';
  end if;

  -- Section 4.4: an API result may never be recorded as a consumer
  -- surface. Checked against the CONFIGURATION, not the attempt, so
  -- neither copy can drift.
  select surface_type into v_config_surface
    from public.aeo_engine_configurations
   where engine_configuration_id = new.engine_configuration_id;

  if new.surface_type is distinct from v_config_surface then
    raise exception
      'aeo_observations: surface_type % contradicts its configuration (%). An API result may never be recorded as a consumer surface.',
      new.surface_type, v_config_surface using errcode = 'check_violation';
  end if;

  -- Defect 1: synthetic evidence can never be dressed as live. The
  -- batch declares the mode once; every observation must match it.
  if new.evidence_origin is distinct from b.execution_mode then
    raise exception
      'aeo_observations: evidence_origin % contradicts the batch execution_mode (%). Fixture and replay evidence may never be recorded as a live capture.',
      new.evidence_origin, b.execution_mode using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.aeo_enforce_observation_provenance() from public, anon, authenticated;

drop trigger if exists aeo_observations_provenance_guard on public.aeo_observations;
create trigger aeo_observations_provenance_guard
  before insert on public.aeo_observations
  for each row execute function public.aeo_enforce_observation_provenance();

-- Defect 2: the attempt set is frozen once approved. Materialize
-- again and you get a refusal, not a bigger batch.
create or replace function public.aeo_freeze_approved_attempts()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_batch uuid := coalesce(new.scan_batch_id, old.scan_batch_id);
  v_approved timestamptz;
begin
  -- FOR UPDATE, and that is the whole concurrency design.
  --
  -- aeo_approve_scan_batch locks this same batch row before it
  -- recomputes the plan, and holds that lock until its transaction
  -- ends. A `for update` on the EXISTING attempt rows cannot stop a
  -- concurrent INSERT — a phantom — because there is no row yet to
  -- lock. Routing every attempt insert, update and delete through the
  -- parent batch row gives both sides one common lock target, so a
  -- mutation that starts after the recompute blocks until approval
  -- commits, and then meets an approved batch and is refused.
  select approved_at into v_approved
    from public.aeo_scan_batches
   where scan_batch_id = v_batch
     for update;

  if v_approved is not null then
    raise exception
      'aeo_scan_attempts: batch % is approved; its workload is frozen. Re-materialize a new batch instead.',
      v_batch using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'aeo_scan_attempts: a materialized attempt is immutable'
      using errcode = 'insufficient_privilege';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.aeo_freeze_approved_attempts() from public, anon, authenticated;

drop trigger if exists aeo_scan_attempts_frozen on public.aeo_scan_attempts;
create trigger aeo_scan_attempts_frozen
  before insert or update or delete on public.aeo_scan_attempts
  for each row execute function public.aeo_freeze_approved_attempts();

-- Append-only, with exactly one permitted exception: the disposal
-- marker. Retention has to record that a payload is gone, and the
-- alternative — suspending the trigger during disposal — would mean
-- a code path that can edit evidence arbitrarily, which is the
-- thing being prevented. So the rule is narrow and total: DELETE
-- never; UPDATE only to set payload_disposed_at once, with every
-- other column byte-identical, compared wholesale rather than
-- column by column so a column added later is covered by default.
create or replace function public.aeo_observations_guard_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'aeo_observations: evidence is append-only and may not be deleted'
      using errcode = 'insufficient_privilege';
  end if;

  if old.payload_disposed_at is not null then
    raise exception 'aeo_observations: observation % is already marked disposed', old.observation_id
      using errcode = 'insufficient_privilege';
  end if;
  if new.payload_disposed_at is null then
    raise exception 'aeo_observations: evidence is append-only; only the payload disposal marker may be set'
      using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'payload_disposed_at') is distinct from (to_jsonb(old) - 'payload_disposed_at') then
    raise exception 'aeo_observations: only the payload disposal marker may change'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

revoke all on function public.aeo_observations_guard_mutation() from public, anon, authenticated;

drop trigger if exists aeo_observations_append_only on public.aeo_observations;
create trigger aeo_observations_append_only
  before update or delete on public.aeo_observations
  for each row execute function public.aeo_observations_guard_mutation();

drop trigger if exists aeo_engine_configurations_immutable on public.aeo_engine_configurations;
create trigger aeo_engine_configurations_immutable
  before update or delete on public.aeo_engine_configurations
  for each row execute function public.reject_mutation();

-- A verification is insert-only apart from revocation, which may be
-- set once. Same narrow shape as the disposal marker: everything
-- else must be byte-identical, compared wholesale so a column added
-- later is covered by default.
create or replace function public.aeo_verifications_guard_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'aeo_capture_verifications: a verification record may not be deleted'
      using errcode = 'insufficient_privilege';
  end if;
  if old.revoked_at is not null then
    raise exception 'aeo_capture_verifications: verification % is already revoked', old.verification_id
      using errcode = 'insufficient_privilege';
  end if;
  if new.revoked_at is null then
    raise exception 'aeo_capture_verifications: only revocation may be recorded'
      using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'revoked_at' - 'revoked_reason')
     is distinct from (to_jsonb(old) - 'revoked_at' - 'revoked_reason') then
    raise exception 'aeo_capture_verifications: only the revocation fields may change'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.aeo_verifications_guard_mutation() from public, anon, authenticated;

drop trigger if exists aeo_capture_verifications_guard on public.aeo_capture_verifications;
create trigger aeo_capture_verifications_guard
  before update or delete on public.aeo_capture_verifications
  for each row execute function public.aeo_verifications_guard_mutation();

-- The payload may be DELETED (that is disposal) but never edited.
create or replace function public.aeo_reject_payload_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'aeo_observation_payloads: a stored payload is immutable; it may only expire'
    using errcode = 'insufficient_privilege';
end;
$$;

revoke all on function public.aeo_reject_payload_update() from public, anon, authenticated;

drop trigger if exists aeo_observation_payloads_no_update on public.aeo_observation_payloads;
create trigger aeo_observation_payloads_no_update
  before update on public.aeo_observation_payloads
  for each row execute function public.aeo_reject_payload_update();

-- ------------------------------------------------------------
-- 9. Admissibility is DERIVED, never stored
-- ------------------------------------------------------------
-- The section 17 rule. A stored flag is a second copy of a
-- judgement that can drift from the evidence, invisibly.
--
-- Capture status and admissibility are deliberately separate
-- concepts: a fixture run can be a complete success as a CAPTURE
-- and still be worth nothing as EVIDENCE.
-- Four separate concepts, because collapsing them is how a fixture
-- became admissible and how a disposed payload stayed admissible:
--
--   capture_verified          the PATH was independently proved to
--                             reach a real surface (a verification
--                             row exists). Nothing in step 2 is.
--   was_verified_live_capture this row was a real capture at the
--                             time it was taken. Historical, and it
--                             survives disposal.
--   payload_available         the raw answer can still be read.
--   currently_admissible      it may be used NOW for normalization,
--                             findings, scoring or reporting.
--
-- currently_admissible requires all of them. A historical origin
-- label is not a substitute for evidence somebody can still open:
-- once the payload is disposed, a new parser or a reviewer has
-- nothing to inspect, so the row is not admissible for new work
-- however real it was.
create or replace view public.aeo_admissible_observations as
  select o.*,
         v.verification_id is not null                              as capture_verified,
         (o.evidence_origin = 'live_capture'
          and o.observation_status = 'response_observed'
          and o.personalization_state = 'clean'
          and o.content_hash is not null
          and v.verification_id is not null)                        as was_verified_live_capture,
         (o.payload_disposed_at is null
          and p.observation_id is not null)                         as payload_available,
         (o.evidence_origin = 'live_capture'
          and o.observation_status = 'response_observed'
          and o.personalization_state = 'clean'
          and o.content_hash is not null
          and v.verification_id is not null
          and o.payload_disposed_at is null
          and p.observation_id is not null)                         as currently_admissible,
         (o.evidence_origin = 'live_capture'
          and o.observation_status = 'response_observed'
          and o.personalization_state = 'clean'
          and o.content_hash is not null
          and v.verification_id is not null
          and o.payload_disposed_at is null
          and p.observation_id is not null
          and o.surface_type = 'consumer_surface')                  as counts_as_consumer
    from public.aeo_observations o
    left join public.aeo_observation_payloads p
      on p.observation_id = o.observation_id
    left join public.aeo_capture_verifications v
      on v.engine_configuration_id = o.engine_configuration_id
     and v.revoked_at is null;

comment on view public.aeo_admissible_observations is
  'Admissibility derived, never stored. currently_admissible requires ALL of: a live_capture origin, an observed clean response, an independently VERIFIED capture configuration, and a payload that still exists. Declaring live_capture proves nothing on its own, and a disposed payload is not inspectable evidence. counts_as_consumer additionally requires a consumer surface (section 4.4). Step 2 verifies no configuration, so nothing it can store is currently admissible.';

-- ------------------------------------------------------------
-- 10. Materialize a batch
-- ------------------------------------------------------------
-- Expands versioned configuration into the exact attempt list,
-- hashes it, counts it and prices it. Runs before approval.
-- The plan fingerprint, in ONE place. Materialization and approval
-- both call it, so approval cannot compare against a differently
-- computed number, and a plan that changed between the two produces
-- a different hash by construction rather than by a stored field
-- somebody remembered to update.
--
-- Ordered explicitly: string_agg over an unordered set hashes
-- differently for the same plan.
create or replace function public.aeo_compute_plan(p_scan_batch_id uuid)
returns table (attempt_count integer, total_cost numeric,
               unpriced_attempts integer, plan_hash text)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select count(a.scan_attempt_id)::integer,
         -- NULL total when anything is unpriced. Summing around a NULL
         -- would report a smaller, confident number for a plan nobody
         -- has finished costing.
         case when count(*) filter (where a.unit_cost_usd is null) > 0
              then null
              else coalesce(sum(a.unit_cost_usd), 0)::numeric end,
         count(*) filter (where a.scan_attempt_id is not null
                            and a.unit_cost_usd is null)::integer,
         encode(sha256(convert_to(
           b.market_id::text || '|' || b.panel_version_id::text || '|' ||
           coalesce(string_agg(
             a.engine_configuration_id::text || '|' || a.panel_question_id::text || '|' ||
             a.run_index::text || '|' || a.surface_type || '|' || a.question_text || '|' ||
             -- UNPRICED is a distinct token, never an empty string and
             -- never confusable with '0.0000'. Interpolating a NULL
             -- would make the whole row's text NULL and string_agg
             -- would DROP it, so an unpriced attempt would vanish from
             -- the fingerprint of the plan it belongs to.
             coalesce(a.unit_cost_usd::text, 'UNPRICED'),
             E'\n' order by a.engine_configuration_id, a.panel_question_id, a.run_index), ''),
           'UTF8')), 'hex')
    from public.aeo_scan_batches b
    left join public.aeo_scan_attempts a on a.scan_batch_id = b.scan_batch_id
   where b.scan_batch_id = p_scan_batch_id
   group by b.market_id, b.panel_version_id;
$$;

revoke all on function public.aeo_compute_plan(uuid) from public, anon, authenticated;
grant execute on function public.aeo_compute_plan(uuid) to service_role;

create or replace function public.aeo_materialize_scan_batch(p_scan_batch_id uuid)
returns public.aeo_scan_batches
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  b        public.aeo_scan_batches;
  m        public.aeo_markets;
  v_count  integer;
  v_cost   numeric(12,4);
  v_hash   text;
  v_unpriced integer;
begin
  select * into b from public.aeo_scan_batches where scan_batch_id = p_scan_batch_id for update;
  if not found then
    raise exception 'aeo_materialize_scan_batch: no such batch %', p_scan_batch_id
      using errcode = 'no_data_found';
  end if;
  if b.approved_at is not null then
    raise exception 'aeo_materialize_scan_batch: batch % is already approved', p_scan_batch_id
      using errcode = 'insufficient_privilege';
  end if;

  select * into m from public.aeo_markets where market_id = b.market_id;

  -- Re-materialization replaces the plan wholesale, so a plan that
  -- was reviewed and then changed produces a different hash and the
  -- earlier review is refused at approval.
  delete from public.aeo_scan_attempts where scan_batch_id = p_scan_batch_id;

  insert into public.aeo_scan_attempts (
    scan_batch_id, engine_configuration_id, panel_question_id, market_id,
    run_index, tier, surface_type, question_text, location_context, unit_cost_usd)
  select b.scan_batch_id, ec.engine_configuration_id, q.panel_question_id, b.market_id,
         g.run_index, pec.tier, ec.surface_type,
         replace(replace(q.template, '{city}', m.city), '{state}', m.state),
         jsonb_build_object('city', m.city, 'state', m.state, 'countryCode', m.country_code),
         ec.estimated_unit_cost_usd
    from public.aeo_panel_engine_configurations pec
    join public.aeo_engine_configurations ec using (engine_configuration_id)
    join public.aeo_panel_questions q on q.panel_version_id = pec.panel_version_id
    cross join lateral generate_series(1, pec.scheduled_runs_per_question) as g(run_index)
   where pec.panel_version_id = b.panel_version_id;

  select c.attempt_count, c.total_cost, c.unpriced_attempts, c.plan_hash
    into v_count, v_cost, v_unpriced, v_hash
    from public.aeo_compute_plan(p_scan_batch_id) c;

  if coalesce(v_count, 0) = 0 then
    raise exception 'aeo_materialize_scan_batch: batch % materialized to no attempts', p_scan_batch_id
      using errcode = 'check_violation';
  end if;

  -- FAIL CLOSED ON UNKNOWN COST. Naming the offending configurations
  -- rather than assigning them a value: a plan nobody has costed must
  -- not become an approvable $0.00, and the operator needs to know
  -- which configuration to price.
  if v_unpriced > 0 then
    raise exception
      'aeo_materialize_scan_batch: % of % attempts have no established unit cost. Unpriced configuration(s): %. Set an explicit cost — including an explicit 0 for a genuinely free capture — and materialize again.',
      v_unpriced, v_count,
      (select string_agg(distinct ec.product_name, ', ')
         from public.aeo_scan_attempts a
         join public.aeo_engine_configurations ec using (engine_configuration_id)
        where a.scan_batch_id = p_scan_batch_id and a.unit_cost_usd is null)
      using errcode = 'check_violation';
  end if;

  update public.aeo_scan_batches
     set status                 = 'materialized',
         materialized_at        = now(),
         attempt_count          = v_count,
         plan_hash              = v_hash,
         max_estimated_cost_usd = v_cost
   where scan_batch_id = p_scan_batch_id
   returning * into b;

  return b;
end;
$$;

revoke all on function public.aeo_materialize_scan_batch(uuid) from public, anon, authenticated;
grant execute on function public.aeo_materialize_scan_batch(uuid) to service_role;

-- ------------------------------------------------------------
-- 11. Approve an exact plan
-- ------------------------------------------------------------
-- The approver states what they believe they are approving. If the
-- plan moved between review and approval, every one of those three
-- values stops matching and the approval is refused rather than
-- silently applied to a different workload.
create or replace function public.aeo_approve_scan_batch(
  p_scan_batch_id          uuid,
  p_approver_user_id       uuid,
  p_expected_plan_hash     text,
  p_expected_attempt_count integer,
  p_cost_ceiling_usd       numeric
)
returns public.aeo_scan_batches
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  b              public.aeo_scan_batches;
  v_role         text;
  v_active       boolean;
  v_market_state text;
  v_count        integer;
  v_cost         numeric;
  v_hash         text;
  v_unpriced     integer;
begin
  if p_cost_ceiling_usd is null or p_cost_ceiling_usd < 0 then
    raise exception 'aeo_approve_scan_batch: an explicit non-negative cost ceiling is required'
      using errcode = 'check_violation';
  end if;

  select role, active into v_role, v_active
    from public.staff_operators where user_id = p_approver_user_id;

  if v_role is null then
    raise exception 'aeo_approve_scan_batch: % is not a staff operator', p_approver_user_id
      using errcode = 'insufficient_privilege';
  end if;
  if not v_active then
    raise exception 'aeo_approve_scan_batch: operator % is not active', p_approver_user_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_role <> 'owner' then
    raise exception 'aeo_approve_scan_batch: role % may not approve scan spend', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into b from public.aeo_scan_batches where scan_batch_id = p_scan_batch_id for update;
  if not found then
    raise exception 'aeo_approve_scan_batch: no such batch %', p_scan_batch_id
      using errcode = 'no_data_found';
  end if;
  if b.approved_at is not null then
    raise exception 'aeo_approve_scan_batch: batch % is already approved', p_scan_batch_id
      using errcode = 'unique_violation';
  end if;
  if b.materialized_at is null then
    raise exception 'aeo_approve_scan_batch: batch % has no materialized plan to approve', p_scan_batch_id
      using errcode = 'check_violation';
  end if;

  select status into v_market_state from public.aeo_markets where market_id = b.market_id;
  if v_market_state <> 'authorized' then
    raise exception 'aeo_approve_scan_batch: market % is %, not authorized', b.market_id, v_market_state
      using errcode = 'insufficient_privilege';
  end if;

  -- RECOMPUTED, not read back. Comparing the caller's values against
  -- the batch's own stored fields would prove only that the caller
  -- had read the same row: both would still match after somebody
  -- inserted, deleted or edited an attempt, because nothing updates
  -- those fields on a mutation.
  --
  -- The batch row above is already locked FOR UPDATE and stays locked
  -- until this transaction ends. Every attempt insert, update and
  -- delete goes through aeo_freeze_approved_attempts, which takes the
  -- same lock on the same row — so a concurrent mutation cannot slip
  -- in between the recompute below and the commit. Locking the
  -- existing attempt rows instead would leave phantom INSERTs
  -- unblocked, because a row that does not exist cannot be locked.
  perform 1 from public.aeo_scan_attempts
    where scan_batch_id = p_scan_batch_id for update;

  select c.attempt_count, c.total_cost, c.unpriced_attempts, c.plan_hash
    into v_count, v_cost, v_unpriced, v_hash
    from public.aeo_compute_plan(p_scan_batch_id) c;

  -- Defence in depth: materialization refuses an unpriced plan, so
  -- reaching here means an attempt was inserted after pricing. An
  -- approval with an unknown maximum cost is not an approval.
  if v_unpriced > 0 then
    raise exception
      'aeo_approve_scan_batch: % of % attempts have no established unit cost; the maximum cost is unknown and cannot be approved',
      v_unpriced, v_count using errcode = 'check_violation';
  end if;

  -- Drift between what materialization recorded and what the attempt
  -- rows now say. Named separately because it means something else
  -- wrote to the workload after it was priced.
  if v_hash is distinct from b.plan_hash
     or v_count is distinct from b.attempt_count
     or v_cost is distinct from b.max_estimated_cost_usd then
    raise exception
      'aeo_approve_scan_batch: the materialized workload changed after it was priced (stored %/%/%, current %/%/%). Re-materialize before approving.',
      b.attempt_count, b.max_estimated_cost_usd, b.plan_hash, v_count, v_cost, v_hash
      using errcode = 'check_violation';
  end if;

  -- Stale-review refusals, each named separately so the operator is
  -- told what moved.
  if v_hash is distinct from p_expected_plan_hash then
    raise exception
      'aeo_approve_scan_batch: the plan changed since it was reviewed (approving %, current %). Re-review and approve the current plan.',
      p_expected_plan_hash, v_hash using errcode = 'check_violation';
  end if;
  if v_count is distinct from p_expected_attempt_count then
    raise exception
      'aeo_approve_scan_batch: attempt count changed since review (approving %, current %)',
      p_expected_attempt_count, v_count using errcode = 'check_violation';
  end if;
  if v_cost > p_cost_ceiling_usd then
    raise exception
      'aeo_approve_scan_batch: estimated cost % exceeds the approved ceiling %',
      v_cost, p_cost_ceiling_usd using errcode = 'check_violation';
  end if;

  update public.aeo_scan_batches
     set status                 = 'approved',
         approved_plan_hash     = v_hash,
         approved_attempt_count = v_count,
         approved_cost_ceiling  = p_cost_ceiling_usd,
         approved_by            = p_approver_user_id,
         approved_at            = now()
   where scan_batch_id = p_scan_batch_id
   returning * into b;

  return b;
end;
$$;

revoke all on function public.aeo_approve_scan_batch(uuid, uuid, text, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.aeo_approve_scan_batch(uuid, uuid, text, integer, numeric) to service_role;

-- ------------------------------------------------------------
-- 12. Record one observation
-- ------------------------------------------------------------
-- The single writer. It hashes and sizes the payload BEFORE storing
-- it, refuses one over the limit while still recording a truthful
-- failure, and sets the retention clock from capture time.
create or replace function public.aeo_record_observation(
  p_scan_attempt_id       uuid,
  p_evidence_origin       text,
  p_observation_status    text,
  p_personalization_state text,
  p_requested_at          timestamptz,
  p_received_at           timestamptz,
  p_raw_response          text,
  p_content_type          text,
  p_citations             jsonb,
  p_failure_reason        text
)
returns public.aeo_observations
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a          public.aeo_scan_attempts;
  o          public.aeo_observations;
  v_bytes    integer;
  v_hash     text;
  v_status   text := p_observation_status;
  v_reason   text := p_failure_reason;
  v_store    boolean := false;
  v_expires  timestamptz;
  /* Product decision: 180 days from capture. Not a compliance claim. */
  c_retention constant interval := interval '180 days';
  c_max_bytes constant integer  := 262144;   /* 256 KiB */
begin
  select * into a from public.aeo_scan_attempts where scan_attempt_id = p_scan_attempt_id;
  if not found then
    raise exception 'aeo_record_observation: unknown attempt %', p_scan_attempt_id
      using errcode = 'no_data_found';
  end if;

  if p_raw_response is not null and length(p_raw_response) > 0 then
    v_bytes := octet_length(convert_to(p_raw_response, 'UTF8'));
    -- Hashed before any decision about storing it, so an oversized
    -- payload is still provably identified even though it is not kept.
    v_hash  := encode(sha256(convert_to(p_raw_response, 'UTF8')), 'hex');

    if v_bytes > c_max_bytes then
      v_status := 'collection_failed';
      v_reason := format('payload_too_large: %s bytes exceeds the %s byte limit', v_bytes, c_max_bytes);
      v_store  := false;
    else
      v_store  := (v_status = 'response_observed');
    end if;
  end if;

  -- A claimed response with nothing behind it is a failure, not a
  -- constraint violation: the caller gets a recorded, explained row
  -- rather than an exception that loses the attempt. The check
  -- constraint remains as the backstop for a direct INSERT.
  if v_status = 'response_observed' and (p_received_at is null or v_hash is null) then
    v_status := 'collection_failed';
    v_reason := 'claimed_response_observed_without_a_response';
    v_store  := false;
  end if;

  if v_status = 'collection_failed' and (v_reason is null or length(btrim(v_reason)) = 0) then
    v_reason := 'unspecified_collection_failure';
  end if;

  if v_store then
    v_expires := coalesce(p_received_at, now()) + c_retention;
  end if;

  insert into public.aeo_observations (
    scan_attempt_id, scan_batch_id, engine_configuration_id, panel_question_id, market_id,
    run_index, question_text, location_context,
    evidence_origin, personalization_state, surface_type, observation_status, failure_reason,
    requested_at, received_at, content_hash, content_type, byte_count, payload_expires_at, citations)
  values (
    a.scan_attempt_id, a.scan_batch_id, a.engine_configuration_id, a.panel_question_id, a.market_id,
    a.run_index, a.question_text, a.location_context,
    p_evidence_origin, p_personalization_state, a.surface_type, v_status, v_reason,
    p_requested_at,
    case when v_status = 'response_observed' then p_received_at else null end,
    -- The hash is kept whatever the outcome. An oversized payload is
    -- not stored and is still provably identified.
    v_hash,
    p_content_type, v_bytes, v_expires, coalesce(p_citations, '[]'::jsonb))
  returning * into o;

  if v_store then
    insert into public.aeo_observation_payloads (
      observation_id, raw_response, content_type, byte_count, expires_at)
    values (o.observation_id, p_raw_response, coalesce(p_content_type, 'text/plain'), v_bytes, v_expires);
  end if;

  return o;
end;
$$;

revoke all on function public.aeo_record_observation(
  uuid, text, text, text, timestamptz, timestamptz, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.aeo_record_observation(
  uuid, text, text, text, timestamptz, timestamptz, text, text, jsonb, text) to service_role;

-- ------------------------------------------------------------
-- 13. Dispose expired payloads
-- ------------------------------------------------------------
-- Deletes the raw text and NOTHING else. The observation, its
-- provenance, its status, its timestamps, its byte count, its
-- content type and its hash all survive. Every disposal is written
-- to audit_events, which 0001 made append-only.
--
-- No scheduler. This is called deliberately.
create or replace function public.aeo_dispose_expired_payloads(
  p_reason text default 'retention: 180 days from capture'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_disposed integer := 0;
  v_now      timestamptz := clock_timestamp();
  r          record;
begin
  -- NO CALLER-SUPPLIED CUTOFF. The earlier signature took one, which
  -- meant service_role could pass a future date and destroy evidence
  -- months before its retention period ended — the 180 days would
  -- have been a convention the scheduler was trusted to honour rather
  -- than a rule the database enforced. The cutoff is database time,
  -- and there is no parameter through which to move it.
  for r in
    select p.observation_id, p.byte_count, p.expires_at, o.content_hash
      from public.aeo_observation_payloads p
      join public.aeo_observations o using (observation_id)
     where p.expires_at <= v_now
     for update
  loop
    delete from public.aeo_observation_payloads where observation_id = r.observation_id;

    -- The one write the append-only guard permits: setting the
    -- disposal marker, once. It records an absence rather than
    -- changing a fact, and every other column must be unchanged.
    update public.aeo_observations
       set payload_disposed_at = v_now
     where observation_id = r.observation_id;

    insert into public.audit_events (
      business_id, action, actor_type, actor_id, reason, previous_value, new_value)
    values (
      null, 'aeo_payload_disposed', 'system', 'aeo_dispose_expired_payloads', p_reason,
      jsonb_build_object('observationId', r.observation_id, 'byteCount', r.byte_count,
                         'contentHash', r.content_hash, 'expiredAt', r.expires_at),
      jsonb_build_object('payloadPresent', false, 'disposedAt', v_now));

    v_disposed := v_disposed + 1;
  end loop;

  return v_disposed;
end;
$$;

revoke all on function public.aeo_dispose_expired_payloads(text)
  from public, anon, authenticated;
grant execute on function public.aeo_dispose_expired_payloads(text) to service_role;

-- The two-argument form from the first draft took a caller-supplied
-- cutoff and must not survive alongside the safe one, or the unsafe
-- path stays reachable by passing an extra argument.
drop function if exists public.aeo_dispose_expired_payloads(timestamptz, text);

-- ------------------------------------------------------------
-- 14. Inspecting a batch
-- ------------------------------------------------------------
-- Both denominators, which section 4.2 requires every visibility
-- figure to carry, plus the admissible count — which is not the
-- same number, because a fixture run observes plenty and admits
-- nothing. Counts only; no rate, no score, no conclusion. Tiers are
-- reported separately and never blended (section 4.3).
create or replace function public.aeo_scan_batch_summary(p_scan_batch_id uuid)
returns table (
  tier                  text,
  surface_type          text,
  evidence_origin       text,
  scheduled_attempts    bigint,
  recorded_attempts     bigint,
  response_observed     bigint,
  surface_not_triggered bigint,
  collection_failed     bigint,
  inadmissible          bigint,
  capture_verified      bigint,
  currently_admissible  bigint,
  counts_as_consumer    bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select a.tier,
         a.surface_type,
         b.execution_mode                                                             as evidence_origin,
         count(*)::bigint                                                             as scheduled_attempts,
         count(o.observation_id)::bigint                                              as recorded_attempts,
         count(*) filter (where o.observation_status = 'response_observed')::bigint    as response_observed,
         count(*) filter (where o.observation_status = 'surface_not_triggered')::bigint as surface_not_triggered,
         count(*) filter (where o.observation_status = 'collection_failed')::bigint     as collection_failed,
         count(*) filter (where o.observation_status = 'inadmissible')::bigint          as inadmissible,
         count(*) filter (where v.capture_verified)::bigint                             as capture_verified,
         count(*) filter (where v.currently_admissible)::bigint                         as currently_admissible,
         count(*) filter (where v.counts_as_consumer)::bigint                           as counts_as_consumer
    from public.aeo_scan_batches b
    join public.aeo_scan_attempts a on a.scan_batch_id = b.scan_batch_id
    left join public.aeo_observations o on o.scan_attempt_id = a.scan_attempt_id
    left join public.aeo_admissible_observations v on v.observation_id = o.observation_id
   where b.scan_batch_id = p_scan_batch_id
   group by a.tier, a.surface_type, b.execution_mode
   order by 1, 2;
$$;

revoke all on function public.aeo_scan_batch_summary(uuid) from public, anon, authenticated;
grant execute on function public.aeo_scan_batch_summary(uuid) to service_role;

-- ------------------------------------------------------------
-- 15. RLS and grants
-- ------------------------------------------------------------
-- Same posture as every table since 0001: enabled AND forced, no
-- policies. Nothing here is reachable by anon or authenticated and
-- there is no browser path to any of it.
alter table public.aeo_markets                      enable row level security;
alter table public.aeo_panel_versions               enable row level security;
alter table public.aeo_panel_questions              enable row level security;
alter table public.aeo_engines                      enable row level security;
alter table public.aeo_engine_configurations        enable row level security;
alter table public.aeo_capture_verifications        enable row level security;
alter table public.aeo_panel_engine_configurations  enable row level security;
alter table public.aeo_scan_batches                 enable row level security;
alter table public.aeo_scan_attempts                enable row level security;
alter table public.aeo_observations                 enable row level security;
alter table public.aeo_observation_payloads         enable row level security;

alter table public.aeo_markets                      force row level security;
alter table public.aeo_panel_versions               force row level security;
alter table public.aeo_panel_questions              force row level security;
alter table public.aeo_engines                      force row level security;
alter table public.aeo_engine_configurations        force row level security;
alter table public.aeo_capture_verifications        force row level security;
alter table public.aeo_panel_engine_configurations  force row level security;
alter table public.aeo_scan_batches                 force row level security;
alter table public.aeo_scan_attempts                force row level security;
alter table public.aeo_observations                 force row level security;
alter table public.aeo_observation_payloads         force row level security;

revoke all on public.aeo_markets                     from public, anon, authenticated;
revoke all on public.aeo_panel_versions              from public, anon, authenticated;
revoke all on public.aeo_panel_questions             from public, anon, authenticated;
revoke all on public.aeo_engines                     from public, anon, authenticated;
revoke all on public.aeo_engine_configurations       from public, anon, authenticated;
-- THE VERIFICATION TABLE IS READ-ONLY TO EVERY APPLICATION ROLE.
--
-- Supabase grants ALL on new tables in `public` to service_role
-- through ALTER DEFAULT PRIVILEGES, and every other table here relies
-- on that default. This one must not: with it, an ordinary
-- service_role caller could insert a row whose only requirements are
-- two non-empty strings and immediately turn live-declared
-- observations into admissible evidence. That is the self-declaration
-- the table was added to prevent, moved one level down.
--
-- Step 2 has no validated capture path, so it deliberately ships NO
-- callable mechanism that can activate a configuration — no INSERT,
-- no UPDATE, no RPC. SELECT is granted because tests and operators
-- must be able to see that the table is empty. Step 3 defines how
-- capture evidence is validated, who may approve it, and how a
-- verification row is created or revoked.
revoke all on public.aeo_capture_verifications
  from public, anon, authenticated, service_role;
grant select on public.aeo_capture_verifications to service_role;
revoke all on public.aeo_panel_engine_configurations from public, anon, authenticated;
revoke all on public.aeo_scan_batches                from public, anon, authenticated;
revoke all on public.aeo_scan_attempts               from public, anon, authenticated;
revoke all on public.aeo_observations                from public, anon, authenticated;
revoke all on public.aeo_observation_payloads        from public, anon, authenticated;
revoke all on public.aeo_admissible_observations     from public, anon, authenticated;
