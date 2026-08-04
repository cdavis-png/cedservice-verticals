-- ============================================================
-- CED Intelligence Platform — Milestone 1 foundation
-- One completed assessment -> one resolved Business Record
-- -> one stored BIR -> one append-only timeline.
--
-- Row Level Security is enabled on every table and NO policies
-- are created. That is deliberate: with RLS on and no policy,
-- anon and authenticated roles can read nothing. Only the
-- service role (which bypasses RLS) may touch these tables, and
-- it lives exclusively in the Vercel function.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 1. business_records — the permanent record
-- ------------------------------------------------------------
create table if not exists public.business_records (
  business_id             uuid primary key default gen_random_uuid(),
  schema_version          integer     not null default 1,
  identity_status         text        not null default 'linked',
  display_name            text        not null,
  legal_name              text,
  vertical_id             text        not null,
  lifecycle_state         text        not null default 'lead_assessed',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  merged_into_business_id uuid        references public.business_records (business_id),
  current_bir_id          uuid,
  metadata                jsonb       not null default '{}'::jsonb,

  constraint business_records_identity_status_check check (
    identity_status in ('legacy_unresolved','resolution_pending','linked','manually_verified','merge_required','rejected_match')
  ),
  constraint business_records_no_self_merge check (merged_into_business_id is null or merged_into_business_id <> business_id),
  -- A permanent record always has an id. resolution_pending belongs on the
  -- artifact, never on a created record.
  constraint business_records_status_not_pending check (identity_status <> 'resolution_pending')
);

create index if not exists business_records_vertical_idx on public.business_records (vertical_id);
create index if not exists business_records_merged_idx  on public.business_records (merged_into_business_id) where merged_into_business_id is not null;

-- ------------------------------------------------------------
-- 2. business_identifiers — evidence, never identity
-- ------------------------------------------------------------
create table if not exists public.business_identifiers (
  identifier_id    uuid primary key default gen_random_uuid(),
  business_id      uuid        not null references public.business_records (business_id) on delete cascade,
  identifier_type  text        not null,
  normalized_value text        not null,
  raw_value        text,
  source           text        not null default 'assessment',
  confidence       numeric(3,2) not null default 1.00,
  verified         boolean     not null default false,
  valid_from       timestamptz not null default now(),
  valid_to         timestamptz,
  created_at       timestamptz not null default now(),

  constraint business_identifiers_type_check check (
    identifier_type in (
      'gbp_place_id','external_customer_id','payment_customer_id',
      'website_domain','business_phone',
      'mobile_phone','email_exact','email_domain','business_name',
      'vertical','locality'
    )
  ),
  constraint business_identifiers_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint business_identifiers_validity check (valid_to is null or valid_to >= valid_from)
);

-- One business may not record the same identifier twice while it is current.
create unique index if not exists business_identifiers_unique_per_business
  on public.business_identifiers (business_id, identifier_type, normalized_value)
  where valid_to is null;

-- Strong identifiers are globally unique. This is the database-level backstop
-- that makes a duplicate business impossible even if two requests race.
create unique index if not exists business_identifiers_strong_unique
  on public.business_identifiers (identifier_type, normalized_value)
  where valid_to is null
    and identifier_type in ('gbp_place_id','external_customer_id','payment_customer_id');

create index if not exists business_identifiers_lookup_idx
  on public.business_identifiers (identifier_type, normalized_value)
  where valid_to is null;

create index if not exists business_identifiers_business_idx on public.business_identifiers (business_id);

-- ------------------------------------------------------------
-- 3. assessment_sessions — the saved journey
-- ------------------------------------------------------------
create table if not exists public.assessment_sessions (
  assessment_session_id uuid primary key,
  business_id           uuid references public.business_records (business_id) on delete set null,
  first_touch           jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

create index if not exists assessment_sessions_business_idx on public.assessment_sessions (business_id);

-- ------------------------------------------------------------
-- 4. assessment_submissions — durable, append-only
-- ------------------------------------------------------------
create table if not exists public.assessment_submissions (
  submission_id         uuid primary key,
  assessment_session_id uuid        not null references public.assessment_sessions (assessment_session_id),
  business_id           uuid        references public.business_records (business_id) on delete set null,
  assessment_version    text        not null,
  vertical_id           text        not null,
  raw_payload           jsonb       not null,
  identity_status       text        not null,
  submitted_at          timestamptz not null,
  received_at           timestamptz not null default now(),
  payload_hash          text        not null,
  consent_snapshot      jsonb       not null default '{}'::jsonb,
  attribution_snapshot  jsonb       not null default '{}'::jsonb,

  constraint assessment_submissions_identity_status_check check (
    identity_status in ('legacy_unresolved','resolution_pending','linked','manually_verified','merge_required','rejected_match')
  ),
  -- businessId may be null ONLY while identity is unresolved (ADR-001).
  constraint assessment_submissions_identity_consistency check (
    (business_id is not null and identity_status in ('linked','manually_verified'))
    or (business_id is null and identity_status in ('resolution_pending','merge_required','legacy_unresolved','rejected_match'))
  )
);

create index if not exists assessment_submissions_session_idx  on public.assessment_submissions (assessment_session_id);
create index if not exists assessment_submissions_business_idx on public.assessment_submissions (business_id);
create index if not exists assessment_submissions_received_idx on public.assessment_submissions (received_at desc);

-- ------------------------------------------------------------
-- 5. business_intelligence_reports — point-in-time, append-only
-- ------------------------------------------------------------
create table if not exists public.business_intelligence_reports (
  bir_id                   uuid primary key,
  business_id              uuid references public.business_records (business_id) on delete set null,
  assessment_submission_id uuid not null references public.assessment_submissions (submission_id),
  schema_version           integer not null,
  generated_at             timestamptz not null default now(),
  report                   jsonb not null,
  confidence_band          text not null,
  missing_critical_fields  jsonb not null default '[]'::jsonb,
  supersedes_bir_id        uuid references public.business_intelligence_reports (bir_id),

  constraint bir_confidence_band_check check (confidence_band in ('low','medium','high')),
  constraint bir_schema_version_check check (schema_version = 2),
  constraint bir_no_self_supersede check (supersedes_bir_id is null or supersedes_bir_id <> bir_id)
);

-- One BIR per submission in this milestone; reassessment creates a new submission.
create unique index if not exists bir_one_per_submission on public.business_intelligence_reports (assessment_submission_id);
create index if not exists bir_business_idx on public.business_intelligence_reports (business_id, generated_at desc);

alter table public.business_records
  add constraint business_records_current_bir_fk
  foreign key (current_bir_id) references public.business_intelligence_reports (bir_id)
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 6. timeline_events — append-only history
-- ------------------------------------------------------------
create table if not exists public.timeline_events (
  event_id                uuid primary key default gen_random_uuid(),
  business_id             uuid references public.business_records (business_id) on delete set null,
  event_name              text not null,
  event_version           integer not null default 1,
  occurred_at             timestamptz not null,
  recorded_at             timestamptz not null default now(),
  producer                text not null,
  source_system           text not null default 'cip',
  source_record_id        text,
  correlation_id          text,
  causation_id            text,
  idempotency_key         text not null,
  summary                 text not null,
  payload                 jsonb not null default '{}'::jsonb,
  supersedes_event_id     uuid references public.timeline_events (event_id),
  correction_of_event_id  uuid references public.timeline_events (event_id),

  constraint timeline_recorded_after_occurred check (recorded_at >= occurred_at),
  -- An event may supersede or correct, never both.
  constraint timeline_single_correction_mode check (
    supersedes_event_id is null or correction_of_event_id is null
  ),
  constraint timeline_no_self_reference check (
    (supersedes_event_id is null or supersedes_event_id <> event_id)
    and (correction_of_event_id is null or correction_of_event_id <> event_id)
  )
);

-- Replay protection at the row level: one event of a given name per key.
create unique index if not exists timeline_events_idempotency
  on public.timeline_events (event_name, idempotency_key);

create index if not exists timeline_events_business_idx on public.timeline_events (business_id, occurred_at);
create index if not exists timeline_events_name_idx     on public.timeline_events (event_name);

-- History is append-only. Updates and deletes are refused at the database.
create or replace function public.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append_only_violation: % is append-only; write a new row instead', tg_table_name
    using errcode = 'raise_exception';
end;
$$;

drop trigger if exists timeline_events_no_update on public.timeline_events;
create trigger timeline_events_no_update
  before update or delete on public.timeline_events
  for each row execute function public.reject_mutation();

drop trigger if exists assessment_submissions_no_update on public.assessment_submissions;
create trigger assessment_submissions_no_update
  before delete on public.assessment_submissions
  for each row execute function public.reject_mutation();

-- ------------------------------------------------------------
-- 7. identity_resolution_cases — the human queue
-- ------------------------------------------------------------
create table if not exists public.identity_resolution_cases (
  identity_resolution_id   uuid primary key default gen_random_uuid(),
  assessment_submission_id uuid not null references public.assessment_submissions (submission_id),
  candidate_business_ids   jsonb not null default '[]'::jsonb,
  contributing_signals     jsonb not null default '[]'::jsonb,
  conflicting_signals      jsonb not null default '[]'::jsonb,
  confidence               numeric(3,2) not null default 0,
  resolution_status        text not null,
  recommended_action       text not null,
  created_at               timestamptz not null default now(),
  resolved_at              timestamptz,
  resolved_by              text,
  resolution_notes         text,

  constraint irc_status_check check (
    resolution_status in ('unique_match','probable_match','possible_duplicate','no_match','manual_review_required')
  ),
  constraint irc_action_check check (
    recommended_action in ('link_to_existing','create_new_record','queue_for_review','request_more_signal','propose_merge')
  ),
  constraint irc_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint irc_resolved_pair check ((resolved_at is null) = (resolved_by is null))
);

create unique index if not exists irc_one_open_per_submission
  on public.identity_resolution_cases (assessment_submission_id)
  where resolved_at is null;

create index if not exists irc_open_idx on public.identity_resolution_cases (created_at) where resolved_at is null;

-- ------------------------------------------------------------
-- 8. idempotency_records — replay protection
-- ------------------------------------------------------------
create table if not exists public.idempotency_records (
  idempotency_key text primary key,
  submission_id   uuid,
  request_hash    text not null,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,

  constraint idempotency_expiry_future check (expires_at > created_at)
);

create index if not exists idempotency_expiry_idx on public.idempotency_records (expires_at);

-- ------------------------------------------------------------
-- 9. audit_events — append-only
-- ------------------------------------------------------------
create table if not exists public.audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  business_id    uuid references public.business_records (business_id) on delete set null,
  action         text not null,
  actor_type     text not null,
  actor_id       text not null,
  reason         text not null,
  previous_value jsonb,
  new_value      jsonb,
  correlation_id text,
  created_at     timestamptz not null default now(),

  constraint audit_actor_type_check check (actor_type in ('human','engine','integration','system'))
);

create index if not exists audit_events_business_idx on public.audit_events (business_id, created_at desc);

drop trigger if exists audit_events_no_update on public.audit_events;
create trigger audit_events_no_update
  before update or delete on public.audit_events
  for each row execute function public.reject_mutation();

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists business_records_touch on public.business_records;
create trigger business_records_touch
  before update on public.business_records
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Row Level Security: ON everywhere, NO policies.
-- Server-only access via the service role.
-- ------------------------------------------------------------
alter table public.business_records            enable row level security;
alter table public.business_identifiers        enable row level security;
alter table public.assessment_sessions         enable row level security;
alter table public.assessment_submissions      enable row level security;
alter table public.business_intelligence_reports enable row level security;
alter table public.timeline_events             enable row level security;
alter table public.identity_resolution_cases   enable row level security;
alter table public.idempotency_records         enable row level security;
alter table public.audit_events                enable row level security;

alter table public.business_records            force row level security;
alter table public.business_identifiers        force row level security;
alter table public.assessment_sessions         force row level security;
alter table public.assessment_submissions      force row level security;
alter table public.business_intelligence_reports force row level security;
alter table public.timeline_events             force row level security;
alter table public.identity_resolution_cases   force row level security;
alter table public.idempotency_records         force row level security;
alter table public.audit_events                force row level security;

revoke all on all tables in schema public from anon, authenticated;
