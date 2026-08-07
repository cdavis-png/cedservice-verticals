-- ============================================================
-- CED Intelligence Platform — SM-1, the Quick Service Mix Review
--
-- Applied AFTER 0001, 0002, 0003, 0004, 0005.
--
-- This is the migration in which "assessment" stops meaning one
-- thing. It introduces review_type as a first-class dimension and
-- makes Growth and Service Mix independently current for one
-- business, without moving, rewriting, or reinterpreting a single
-- row that already exists.
--
--   1. review_type on submissions, sessions, reports, and all
--      three analytics tables. Default and backfill are both
--      'growth_review', because that is what every existing row
--      is.
--   2. business_review_states, keyed (business_id, review_type).
--   3. BIR schema versions widen to 2..5. A Service Mix report is
--      v5; a Growth report stays v4 and stays immutable.
--   4. Review-type indexes on what reporting will filter.
--   5. Supersession enforced within one business AND one review
--      type, at the database.
--   6. business_records.current_bir_id keeps meaning "the current
--      GROWTH report" and refuses anything else, at the database.
--   7. Review-type-aware timeline events, by trigger.
--   8. ingest_review(), the generic path. ingest_assessment()
--      becomes a thin wrapper over it with its signature
--      unchanged, so a queued browser submission, the existing
--      endpoint, and the existing tests are untouched.
--   9. Analytics separated by review type: the column, the
--      aggregate key, and the roll-up.
--
-- ============================================================
-- WHY ingest_assessment BECOMES A WRAPPER
--
-- Migration 0004 declined to redefine this function and used
-- triggers instead, on the grounds that a transcription error in
-- the parts that did NOT change is likelier than a bug in the
-- change itself. That reasoning still holds, which is why the
-- stage events in 0004 are still triggers and why the Service Mix
-- timeline events below are triggers too.
--
-- It is overridden for the ingestion body itself for one reason:
-- the alternative is two copies of the identity-resolution rules.
-- CLAUDE.md section 3 treats a second copy of shared logic as the
-- defect, and a bug fixed in one copy and not the other is a
-- permanently wrong identity decision — worse than a
-- transcription risk that a real-Postgres run will catch.
--
-- The compensating control is docs/REAL_POSTGRES_VALIDATION.md,
-- which MUST run before this migration is applied anywhere.
--
-- EXECUTION STATUS. Stated here because this comment is what
-- anyone opening the file will believe:
--
--   · EXECUTED against a disposable local PostgreSQL 18.3
--     through PGlite — a clean install of the whole chain, and
--     an upgrade over populated pre-0006 data. Reproduce with
--     `npm run test:migration` and
--     `CED_ALLOW_INTEGRATION_TESTS=true CED_LOCAL_PG=true
--      npm run test:integration:local`.
--   · NOT executed against PostgreSQL 17. The hosted
--     development project is 17.6.1.155, and a behaviour that
--     differs between the two majors would not be caught.
--   · NOT executed against hosted Supabase.
--   · NOT executed through PostgREST, so signature resolution
--     by argument name over HTTP remains unproven.
--
-- 0001-0005 were validated against Supabase 17.6. This one has
-- not been, and the local run is not a substitute for that.
--
-- An earlier revision of this header said the file had never
-- run against any Postgres, hosted or local. That stopped being
-- true when the local harness was added, and a stale claim in a
-- migration is worse than none: it is read as current.
-- ============================================================

-- ------------------------------------------------------------
-- 1. review_type
-- ------------------------------------------------------------
-- The vocabulary mirrors shared/business-intelligence/review-registry.js
-- :: REVIEW_TYPES. A test asserts the two lists stay identical.

alter table public.assessment_submissions
  add column if not exists review_type text not null default 'growth_review';

alter table public.assessment_sessions
  add column if not exists review_type text not null default 'growth_review';

alter table public.business_intelligence_reports
  add column if not exists review_type text not null default 'growth_review';

alter table public.assessment_analytics_events
  add column if not exists review_type text not null default 'growth_review';

alter table public.assessment_analytics_sessions
  add column if not exists review_type text not null default 'growth_review';

alter table public.assessment_funnel_daily
  add column if not exists review_type text not null default 'growth_review';

-- Backfill. The column default covers rows written from here on; this covers
-- anything that somehow arrived null, and makes the intent explicit for a
-- reader who finds this file years later.
update public.assessment_submissions        set review_type = 'growth_review' where review_type is null;
update public.assessment_sessions           set review_type = 'growth_review' where review_type is null;
update public.business_intelligence_reports set review_type = 'growth_review' where review_type is null;
update public.assessment_analytics_events   set review_type = 'growth_review' where review_type is null;
update public.assessment_analytics_sessions set review_type = 'growth_review' where review_type is null;
update public.assessment_funnel_daily       set review_type = 'growth_review' where review_type is null;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'assessment_submissions', 'assessment_sessions', 'business_intelligence_reports',
    'assessment_analytics_events', 'assessment_analytics_sessions', 'assessment_funnel_daily'
  ]
  loop
    execute format('alter table public.%I drop constraint if exists %I',
                   v_table, v_table || '_review_type_check');
    execute format(
      'alter table public.%I add constraint %I check (review_type in (%L, %L))',
      v_table, v_table || '_review_type_check', 'growth_review', 'service_mix');
  end loop;
end $$;

-- Payload schema 6 is the Quick Service Mix Review's shape. It is NOT a newer
-- Growth payload: the Growth page still builds 5, and 5 is still its current.
-- Widening the range keeps every queued submission of every prior version
-- deliverable, which is the rule docs/PRODUCTION_HARDENING.md section 10 sets.

alter table public.assessment_submissions
  drop constraint if exists assessment_submissions_payload_version_check;

alter table public.assessment_submissions
  add constraint assessment_submissions_payload_version_check
  check (payload_schema_version is null or payload_schema_version between 2 and 6);

comment on column public.assessment_submissions.payload_schema_version is
  'Accepted payload schema range, currently 2-6. 2-5 are Growth Review shapes; 6 is the Quick Service Mix Review. A version may only be retired once no queued submission of that version can still be inside CED_SUBMISSION_MAX_AGE_DAYS.';

comment on column public.assessment_submissions.review_type is
  'Which review produced this submission. growth_review is the default and the backfill value because every row written before SM-1 is a Growth Review.';
comment on column public.business_intelligence_reports.review_type is
  'Which review produced this report. Supersession is closed within one review type; see business_intelligence_reports_supersede_guard.';

-- ------------------------------------------------------------
-- 2. business_review_states
-- ------------------------------------------------------------
-- One row per business per review type. This is what makes "Growth and
-- Service Mix remain independently current" true: without it there is one
-- current_bir_id per business and the second review type to finish silently
-- displaces the first.
--
-- Mutable by design, unlike the append-only history it points into. It holds
-- POINTERS, never analysis — every prior submission and every prior report
-- stays exactly where it was.

create table if not exists public.business_review_states (
  business_id              uuid        not null references public.business_records (business_id) on delete cascade,
  review_type              text        not null,
  current_bir_id           uuid        references public.business_intelligence_reports (bir_id),
  -- The FIRST submission of this review type for this business, and the most
  -- recent. Two columns rather than one because they answer different
  -- questions: "when did this relationship start" and "what is current".
  -- The original is written once and never moves, which is what makes it the
  -- root of the supersession chain rather than a moving target.
  original_submission_id   uuid        references public.assessment_submissions (submission_id),
  latest_submission_id     uuid        references public.assessment_submissions (submission_id),
  last_completed_at        timestamptz,
  -- When this review type should be looked at again, and what kind of look.
  -- Computed from report.schema.js :: LIFECYCLE_POLICY, which is the
  -- authority; the numbers below quote it rather than redefine it.
  next_reassessment_due_at timestamptz,
  next_reassessment_kind   text,
  completed_count          integer     not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Structural facts about this review type for this business. Never contact
  -- data, never offering names, never a figure — the same rule the timeline
  -- and audit payloads follow, for the same reason.
  state                    jsonb       not null default '{}'::jsonb,

  primary key (business_id, review_type),

  constraint business_review_states_review_type_check
    check (review_type in ('growth_review', 'service_mix')),
  constraint business_review_states_count_non_negative
    check (completed_count >= 0),
  constraint business_review_states_reassessment_kind_check
    check (next_reassessment_kind is null or next_reassessment_kind in
      ('quick_recheck', 'quarterly_review', 'annual_full', 'change_triggered'))
);

-- Rerun-safe upgrade for a database that already took an earlier draft of
-- this table. `current_submission_id` was the original name; it becomes
-- `latest_submission_id`, and the original submission gains a column of its
-- own. Nothing is dropped: a rename preserves the values.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'business_review_states'
                and column_name = 'current_submission_id')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'business_review_states'
                and column_name = 'latest_submission_id') then
    alter table public.business_review_states
      rename column current_submission_id to latest_submission_id;
  end if;
end $$;

alter table public.business_review_states
  add column if not exists original_submission_id   uuid references public.assessment_submissions (submission_id),
  add column if not exists latest_submission_id     uuid references public.assessment_submissions (submission_id),
  add column if not exists next_reassessment_due_at timestamptz,
  add column if not exists next_reassessment_kind   text;

create index if not exists business_review_states_review_type_idx
  on public.business_review_states (review_type, last_completed_at desc);

comment on table public.business_review_states is
  'Current pointer per business per review type. The forward-looking surface; business_records.current_bir_id is the legacy Growth-only pointer and is not repurposed.';

drop trigger if exists business_review_states_touch on public.business_review_states;
create trigger business_review_states_touch
  before update on public.business_review_states
  for each row execute function public.touch_updated_at();

-- Backfill from the Growth pointers that already exist. A business with a
-- current BIR has completed at least one Growth Review, and that fact should
-- not have to wait for its next one to become visible here.
insert into public.business_review_states (
  business_id, review_type, current_bir_id,
  original_submission_id, latest_submission_id,
  last_completed_at, next_reassessment_due_at, next_reassessment_kind,
  completed_count, state
)
select
  br.business_id,
  'growth_review',
  br.current_bir_id,
  -- The earliest submission of this review type is the root of the chain.
  (select s.submission_id from public.assessment_submissions s
    where s.business_id = br.business_id and s.review_type = 'growth_review'
    order by s.received_at asc, s.submission_id asc limit 1),
  bir.assessment_submission_id,
  bir.generated_at,
  -- LIFECYCLE_POLICY.unconvertedLeadReassessDays = 90.
  bir.generated_at + interval '90 days',
  'quick_recheck',
  (select count(*) from public.assessment_submissions s
    where s.business_id = br.business_id and s.review_type = 'growth_review'),
  jsonb_build_object('backfilledFrom', 'business_records.current_bir_id')
  from public.business_records br
  join public.business_intelligence_reports bir on bir.bir_id = br.current_bir_id
 where br.current_bir_id is not null
on conflict (business_id, review_type) do nothing;

-- ------------------------------------------------------------
-- 3. BIR schema version
-- ------------------------------------------------------------
-- 0004 widened this to 2..4. A Service Mix report is v5 with
-- reportType 'service_mix'. Growth reports stay at 4 and are not rewritten:
-- a v4 report is still a correct report.

alter table public.business_intelligence_reports
  drop constraint if exists bir_schema_version_check;

alter table public.business_intelligence_reports
  add constraint bir_schema_version_check
  check (schema_version between 2 and 5);

comment on column public.business_intelligence_reports.schema_version is
  'BIR structural version. 2 = Milestone 1. 3 = Assessment Intelligence Expansion. 4 = two-stage progressive assessment. 5 = Service Mix (reportType service_mix). Widen deliberately; never narrow while reports of that version exist.';

-- A v5 report is a Service Mix report and nothing else, and a Service Mix
-- report is never any other version. Stated as a constraint because the pair
-- is the thing that keeps the two review types from ever being confused for
-- one another at rest.
alter table public.business_intelligence_reports
  drop constraint if exists bir_service_mix_version_check;

alter table public.business_intelligence_reports
  add constraint bir_service_mix_version_check
  check (
    (review_type = 'service_mix'  and schema_version = 5)
    or
    (review_type = 'growth_review' and schema_version between 2 and 4)
  );

-- ------------------------------------------------------------
-- 4. Review-type indexes
-- ------------------------------------------------------------

create index if not exists submissions_review_type_idx
  on public.assessment_submissions (review_type, received_at desc);

create index if not exists bir_review_type_idx
  on public.business_intelligence_reports (business_id, review_type, generated_at desc)
  where business_id is not null;

create index if not exists analytics_events_review_type_idx
  on public.assessment_analytics_events (review_type, occurred_at);

create index if not exists analytics_sessions_review_type_idx
  on public.assessment_analytics_sessions (review_type, started_at);

-- The Service Mix health classification is the field any future report will
-- filter on, and it lives inside the jsonb.
create index if not exists bir_service_mix_health_idx
  on public.business_intelligence_reports
  ((report -> 'serviceMixHealth' ->> 'classification'))
  where review_type = 'service_mix';

comment on index public.bir_service_mix_health_idx is
  'Supports filtering Service Mix reports by health classification without scanning the jsonb.';

-- ------------------------------------------------------------
-- 5. Supersession stays inside one business and one review type
-- ------------------------------------------------------------
-- The engine applies this rule too, in review-registry.js :: maySupersede.
-- A rule enforced in one layer is a convention; enforced in two it is a rule.
--
-- BEFORE INSERT rather than a CHECK, because the condition spans two rows of
-- the same table and a CHECK cannot see the referenced one.

create or replace function public.enforce_bir_supersession_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_prev public.business_intelligence_reports%rowtype;
begin
  if new.supersedes_bir_id is null then
    return new;
  end if;

  select * into v_prev
    from public.business_intelligence_reports
   where bir_id = new.supersedes_bir_id;

  if not found then
    raise exception 'supersedes_unknown_bir: % does not exist', new.supersedes_bir_id
      using errcode = '23503';
  end if;

  if v_prev.review_type is distinct from new.review_type then
    raise exception 'supersedes_review_type_mismatch: a % report may not supersede a % report',
      new.review_type, v_prev.review_type
      using errcode = 'raise_exception';
  end if;

  -- A report with no business has no chain to join. Two reports for two
  -- different businesses never chain, whatever their review type.
  if new.business_id is null or v_prev.business_id is distinct from new.business_id then
    raise exception 'supersedes_business_mismatch: supersession is closed within one Business Record'
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;

drop trigger if exists bir_supersession_scope on public.business_intelligence_reports;

create trigger bir_supersession_scope
  before insert on public.business_intelligence_reports
  for each row execute function public.enforce_bir_supersession_scope();

revoke all on function public.enforce_bir_supersession_scope() from public, anon, authenticated;

comment on function public.enforce_bir_supersession_scope is
  'Refuses a supersedes_bir_id pointing at another business or another review type. A Service Mix report may reference a Growth report; it may never supersede one.';

-- ------------------------------------------------------------
-- 6. The legacy Growth pointer stays a Growth pointer
-- ------------------------------------------------------------
-- business_records.current_bir_id predates review types and is referenced by
-- an existing foreign key and by existing consumers. Quietly repurposing it
-- would change what all of them read without telling them, so it keeps
-- meaning "the current GROWTH report" and refuses anything else.
--
-- business_review_states is the forward-looking surface.

create or replace function public.enforce_growth_only_current_bir()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_review_type text;
begin
  if new.current_bir_id is null
     or new.current_bir_id is not distinct from old.current_bir_id then
    return new;
  end if;

  select review_type into v_review_type
    from public.business_intelligence_reports
   where bir_id = new.current_bir_id;

  if v_review_type is distinct from 'growth_review' then
    raise exception 'current_bir_must_be_growth: business_records.current_bir_id is the Growth pointer; use business_review_states for %',
      coalesce(v_review_type, 'an unknown review type')
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;

drop trigger if exists business_records_growth_current_bir on public.business_records;

create trigger business_records_growth_current_bir
  before update on public.business_records
  for each row execute function public.enforce_growth_only_current_bir();

revoke all on function public.enforce_growth_only_current_bir() from public, anon, authenticated;

comment on function public.enforce_growth_only_current_bir is
  'Refuses any attempt to point business_records.current_bir_id at a report that is not a Growth Review.';

-- ------------------------------------------------------------
-- 7. Review-type-aware timeline events
-- ------------------------------------------------------------
-- Appended by trigger, inside the ingestion transaction, from data already on
-- the row — the same shape 0004 uses, for the same reason.
--
-- These are ADDITIONAL facts, never replacements. assessment.completed and
-- bir.generated are a published contract with consumers and with the stored
-- response body, and an append-only store cannot retroactively rename an
-- event. A Service Mix submission emits both the generic event and its own.
--
-- occurred_at is clamped in every case, because timeline_events requires
-- recorded_at >= occurred_at and a device clock running fast must never abort
-- ingestion.
--
-- NO OFFERING NAMES AND NO FIGURES appear in these payloads. timeline_events
-- refuses UPDATE, so anything personal or commercial that reaches it can
-- never be removed.

create or replace function public.append_service_mix_timeline_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_occurred_at timestamptz := least(new.submitted_at, now());
  v_offerings   integer;
begin
  if new.review_type is distinct from 'service_mix' then
    return null;
  end if;

  v_offerings := coalesce(
    jsonb_array_length(new.raw_payload -> 'serviceMix' -> 'offerings'), 0);

  insert into public.timeline_events (
    business_id, event_name, event_version, occurred_at, producer,
    source_record_id, idempotency_key, summary, payload, correlation_id
  ) values (
    new.business_id, 'service_mix.completed', 1, v_occurred_at, 'service-mix-engine',
    new.submission_id::text, new.submission_id::text,
    'Quick Service Mix Review completed.',
    jsonb_build_object(
      'submissionId', new.submission_id,
      'assessmentSessionId', new.assessment_session_id,
      'verticalId', new.vertical_id,
      'assessmentVersion', new.assessment_version,
      'reviewType', new.review_type,
      -- A count and a declaration. Not what the offerings are called, not
      -- what they cost, not what they earn.
      'offeringCount', v_offerings,
      'coverage', new.raw_payload -> 'serviceMix' ->> 'coverage',
      'continuationApplied',
        coalesce((new.ingest_meta ->> 'continuationApplied')::boolean, false)),
    new.submission_id::text
  );

  return null;
end;
$$;

drop trigger if exists assessment_submissions_service_mix_event on public.assessment_submissions;

create trigger assessment_submissions_service_mix_event
  after insert on public.assessment_submissions
  for each row execute function public.append_service_mix_timeline_event();

revoke all on function public.append_service_mix_timeline_event() from public, anon, authenticated;

comment on function public.append_service_mix_timeline_event is
  'Appends service_mix.completed for a Service Mix submission. Emits nothing for any other review type.';

create or replace function public.append_service_mix_bir_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_occurred_at timestamptz;
begin
  if new.review_type is distinct from 'service_mix' then
    return null;
  end if;

  -- Anchored on the SUBMISSION, clamped — exactly as 0004 does, and for the
  -- reason 0004's real-Postgres run found: two events describing one insert
  -- must carry one timestamp, and anchoring on generated_at made them drift.
  select least(s.submitted_at, now()) into v_occurred_at
    from public.assessment_submissions s
   where s.submission_id = new.assessment_submission_id;
  v_occurred_at := coalesce(v_occurred_at, least(new.generated_at, now()));

  insert into public.timeline_events (
    business_id, event_name, event_version, occurred_at, producer,
    source_record_id, idempotency_key, summary, payload, correlation_id
  ) values (
    new.business_id, 'service_mix_bir.generated', 1, v_occurred_at,
    'service-mix-engine',
    new.bir_id::text, new.bir_id::text,
    'Service Mix report generated from the Quick Service Mix Review.',
    jsonb_build_object(
      'birId', new.bir_id,
      'supersedesBirId', new.supersedes_bir_id,
      'reviewType', new.review_type,
      'schemaVersion', new.schema_version,
      'health', new.report -> 'serviceMixHealth' ->> 'classification',
      'confidence', new.report -> 'dataConfidence' ->> 'confidence',
      'offeringsAnalysed', new.report -> 'portfolioCoverage' ->> 'offeringsAnalysed',
      'relatedGrowthBirId', new.report -> 'relatedGrowthReview' ->> 'birId'),
    new.assessment_submission_id::text
  );

  return null;
end;
$$;

drop trigger if exists bir_service_mix_event on public.business_intelligence_reports;

create trigger bir_service_mix_event
  after insert on public.business_intelligence_reports
  for each row execute function public.append_service_mix_bir_event();

revoke all on function public.append_service_mix_bir_event() from public, anon, authenticated;

comment on function public.append_service_mix_bir_event is
  'Appends service_mix_bir.generated for a Service Mix report. Emits nothing for any other review type.';

-- ------------------------------------------------------------
-- 8. Generic review ingestion
-- ------------------------------------------------------------
-- ingest_review() is the body. ingest_assessment() keeps its signature and
-- becomes a wrapper, so the existing endpoint, the browser retry queue, and
-- the existing test suite reach exactly the same code by the name they
-- already use.
--
-- What differs from the 0003 body, and nothing else does:
--
--   · review_type is carried onto the session, the submission, and the report
--   · a SERVER-ISSUED continuation businessId can resolve identity directly.
--     It is never a client-supplied id: api/assessments.mjs verifies an HMAC
--     it signed itself before this parameter is ever populated.
--   · the supersession chain is read from business_review_states for THIS
--     review type, not from business_records.current_bir_id
--   · business_records.current_bir_id is written for growth_review only
--   · business_review_states is upserted for every review type
--   · the completion event's summary names the review

-- ------------------------------------------------------------
-- 6a. identity_proposal_conflict — one rule, called for every proposal
-- ------------------------------------------------------------
-- Compares the identity signals in a submission with the ACTIVE identifiers
-- a proposed Business Record already holds:
--
--     agree(T)       both have a value of type T and they share one
--     contradict(T)  both have values of type T and none match
--
-- A contradiction is MATERIAL when the business name contradicts, AND at
-- least one piece of contact evidence contradicts, AND nothing agrees. All
-- three, because each alone is ordinary: a name change is a rebrand, an
-- email change is a new address, and a single agreement anywhere is
-- continuity. Only the combination says "this is somebody else".
--
-- Deliberately hard to trigger. A false positive costs a queued review; a
-- false negative costs a permanent, unerasable cross-business contamination.
--
-- Written as ONE function rather than inline at each call site, because the
-- rule is applied to two different proposals and two copies would drift.
-- Mirrors shared/business-record/resolve-identity.js :: proposalConflict, and
-- tests/identity-proposals.test.mjs runs one case table through both.
--
-- Returns type NAMES only. The caller puts these in an identity-resolution
-- case, and an identifier VALUE in a review queue is a second copy of contact
-- data with a different lifetime and no owner.
-- ------------------------------------------------------------
-- 6a-i. identity_value_acceptable — the value contract, in SQL
-- ------------------------------------------------------------
-- Mirrors shared/business-record/resolve-identity.js :: isAcceptableValue.
-- Same length bound, same three formats, same vocabulary.
--
-- It exists because the JavaScript and this function must not DISAGREE about
-- whether an invalid shared value counts as agreement. `gbp_place_id: 'x'` is
-- refused by isAcceptableValue and was nonetheless being compared here — so a
-- value neither side could ever have produced appeared on both sides, counted
-- as agreement, and neutralised a real name-and-email contradiction. The
-- JavaScript now throws; without this, PostgreSQL would still have linked.
--
-- Canonicality (normalizeEmail, normalizePhone, normalizeDomain,
-- normalizeName) is deliberately NOT reimplemented here. Porting those would
-- be a second normalization rule, which is exactly what the JavaScript
-- contract forbids, and two normalizers that drift are worse than one. What
-- keeps non-canonical values out of this function instead is that the only
-- writer of both sides is api/assessments.mjs, which sends
-- persistableSignals(extractIdentitySignals(payload)) — canonical by
-- construction — and business_identifiers rows written from those same
-- signals. A test asserts that property at the endpoint.
-- LENGTH IS COUNTED IN UNICODE CODE POINTS, which is what `length()` does and
-- what resolve-identity.js :: isAcceptableValue now does too. It used to count
-- UTF-16 code units there, so a 129-emoji value was 258 to JavaScript and 129
-- here: refused by one implementation and accepted by the other. The two agree
-- on ASCII and across the whole BMP and disagreed only above U+FFFF. Code
-- points is the authoritative definition, this function was already correct
-- under it, and it did not change.
create or replace function public.identity_value_acceptable(
  p_type  text,
  p_value text
)
returns boolean
language sql
immutable
as $$
  select case
    when p_type is null or p_value is null then false
    when length(p_value) = 0 or length(p_value) > 256 then false
    when p_type = 'gbp_place_id'         then p_value ~ '^[A-Za-z0-9_-]{6,128}$'
    when p_type = 'external_customer_id' then p_value ~ '^[A-Za-z0-9_:.-]{4,128}$'
    when p_type = 'payment_customer_id'  then p_value ~ '^[A-Za-z0-9_-]{4,128}$'
    else true
  end;
$$;

revoke all on function public.identity_value_acceptable(text, text)
  from public, anon, authenticated;

comment on function public.identity_value_acceptable is
  'Mirrors shared/business-record/resolve-identity.js :: isAcceptableValue — length bound in Unicode code points, and the three strong-identifier formats. Used by identity_proposal_conflict so an impossible value can never count as agreement.';

-- ------------------------------------------------------------
-- 6a-ii. identity_evidence_fault — the SHAPE contract, in SQL
-- ------------------------------------------------------------
-- Mirrors shared/business-record/resolve-identity.js :: evidenceFault, for the
-- one operand that arrives as JSON. Returns a reason, or null when the entry is
-- well formed.
--
-- It exists because the comparison used to FILTER what it could not read:
-- `where s ->> 'type' is not null and s ->> 'normalizedValue' is not null`. A
-- `[null]` entry was silently dropped and the function answered
-- `material: false`, while the JavaScript threw on the same input. Dropping an
-- unreadable entry is the safe direction for a contradiction and the dangerous
-- one for an agreement — it turns a comparison into "nothing to compare", and
-- nothing to compare links.
--
-- The reason never contains the VALUE. It is contact data, and an error travels
-- into logs. The position and the type name are enough to fix a caller.
create or replace function public.identity_evidence_fault(p_entry jsonb)
returns text
language sql
immutable
as $$
  select case
    when p_entry is null or jsonb_typeof(p_entry) is distinct from 'object'
      then 'it is not an object'
    when jsonb_typeof(p_entry -> 'type') is distinct from 'string'
      then 'its type is missing or not a string'
    when not (p_entry ->> 'type' = any (array[
           'gbp_place_id','external_customer_id','payment_customer_id',
           'website_domain','business_phone','mobile_phone',
           'email_exact','email_domain','business_name',
           'vertical','locality']))
      then 'its type is not a recognized identifier type'
    when jsonb_typeof(p_entry -> 'normalizedValue') is distinct from 'string'
      then 'its normalizedValue is missing or not a string'
    else null
  end;
$$;

revoke all on function public.identity_evidence_fault(jsonb)
  from public, anon, authenticated;

comment on function public.identity_evidence_fault is
  'Mirrors shared/business-record/resolve-identity.js :: evidenceFault for the JSON operand — object, recognized type, string value. Returns a reason or null. Used by identity_proposal_conflict so malformed evidence is refused rather than filtered.';

create or replace function public.identity_proposal_conflict(
  p_signals     jsonb,
  p_business_id uuid
)
returns table (
  agreed_types       text[],
  contradicted_types text[],
  material           boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_bad   text;
  v_fault text;
  v_index bigint;
begin
  -- NULL IS NOT AN EMPTY LIST, and the difference is the whole function.
  --
  -- `coalesce(p_signals, '[]')` used to sit in every scan below, so a null
  -- operand became a comparison with nothing on one side — which always answers
  -- "no contradiction", which is the answer that links. A submission naming a
  -- different business, with a different email and no signals at all, linked to
  -- the proposed record at confidence 1 and was stored there permanently.
  --
  -- The JavaScript has drawn this distinction since v11: an absent or null
  -- operand is "the caller did not supply the evidence" and throws; an explicit
  -- `[]` is "there is genuinely nothing here" and is legal. This is the same
  -- distinction, in the same words, so the two cannot disagree about the same
  -- input. Every default this module has had to remove was the same defect one
  -- layer further out; this is that defect in SQL.
  --
  -- `ingest_review` calls this only when a session or continuation proposal
  -- exists, so candidate-only and no-proposal resolution never reach it and are
  -- unaffected.
  if p_signals is null then
    raise exception 'identity_evidence_invalid: submitted evidence is required to compare against a proposed record. Pass an empty array only when there is genuinely nothing to compare'
      using errcode = '22023';
  end if;

  -- The operand must be an array. `jsonb_array_elements` errors on anything
  -- else with a message about jsonb rather than about identity, and the
  -- JavaScript refuses a non-array at the same point. A jsonb `null` scalar is
  -- caught here rather than above: `to_jsonb(null)` and a SQL NULL are
  -- different things arriving by different routes, and neither is an array.
  if jsonb_typeof(p_signals) is distinct from 'array' then
    raise exception 'identity_evidence_invalid: submitted evidence must be an array'
      using errcode = '22023';
  end if;

  -- A malformed entry is REFUSED, not filtered. See identity_evidence_fault.
  -- Position is reported 0-based to match the JavaScript message, so one
  -- reproduction names the same entry in both implementations.
  select f.fault, e.idx into v_fault, v_index
    from jsonb_array_elements(p_signals) with ordinality as e(entry, idx)
    cross join lateral (select public.identity_evidence_fault(e.entry) as fault) f
   where f.fault is not null
   order by e.idx
   limit 1;
  if v_fault is not null then
    raise exception 'identity_evidence_invalid: submitted evidence at position % is invalid — %',
      v_index - 1, v_fault
      using errcode = '22023';
  end if;

  -- A value that fails identity_value_acceptable is REFUSED, not filtered.
  --
  -- Filtering is the safe direction for a contradiction and the dangerous one
  -- for an agreement: dropping an unreadable entry from one side turns a
  -- comparison into "nothing to compare", which links. And it would make this
  -- function disagree with the JavaScript, which throws — two implementations
  -- reaching different conclusions about the same input is the one thing the
  -- mirror exists to prevent.
  --
  -- Checked BEFORE the comparison, in plpgsql, because a guard expressed as a
  -- CTE would depend on evaluation order the planner does not promise. The
  -- offending VALUE is never named in the message: it is contact data, and an
  -- error travels into logs.
  select s ->> 'type' into v_bad
    from jsonb_array_elements(p_signals) s
   where not public.identity_value_acceptable(s ->> 'type', s ->> 'normalizedValue')
   limit 1;
  if v_bad is not null then
    raise exception 'identity_value_unacceptable: a submitted % value is not an acceptable identifier value', v_bad
      using errcode = '22023';
  end if;

  select bi.identifier_type into v_bad
    from public.business_identifiers bi
   where bi.business_id = p_business_id
     and bi.valid_to is null
     and not public.identity_value_acceptable(bi.identifier_type, bi.normalized_value)
   limit 1;
  if v_bad is not null then
    raise exception 'identity_value_unacceptable: a held % value is not an acceptable identifier value', v_bad
      using errcode = '22023';
  end if;

  -- The two vocabularies are written out rather than held in a CTE: a
  -- constant array reached through a scalar subquery makes `= any (...)`
  -- ambiguous with the subquery form of ANY, and Postgres resolves it as
  -- `text = text[]`. Inline literals cannot be misread.
  -- VALUES ARE COMPARED EXACTLY. There was a `lower()` on both sides here, and
  -- for the three opaque strong identifiers it was unsafe: `gbp_place_id`
  -- `Abcdef` and `abcdef` are two different places, and case-folding them
  -- reported agreement — which outranks any number of contradictions — so a
  -- submission with a contradictory name AND email linked to the wrong
  -- business at confidence 1, and that business ended up holding both names,
  -- both emails and both spellings of the place id.
  --
  -- Nothing else in this schema treats them as case-insensitive: candidate
  -- lookup uses `=`, and business_identifiers_strong_unique and
  -- business_identifiers_lookup_idx are plain btree indexes over
  -- (identifier_type, normalized_value), so `Abcdef` and `abcdef` are already
  -- two rows. The comparison was the only place that disagreed, and it is the
  -- one place where disagreeing merges two businesses.
  --
  -- Case-insensitivity is not reintroduced for weak types: every one of them is
  -- written from a canonicalizer that already lower-cases (email, domain, name)
  -- or produces digits (phone), both here and in resolve-identity.js, which now
  -- compares exactly for the same reason.
  --
  -- The `is not null` filters that used to sit in these two CTEs are gone. They
  -- were the filtering that identity_evidence_fault replaced; every entry
  -- reaching this point has a recognized type and an acceptable string value,
  -- and held rows are constrained to the same vocabulary by
  -- business_identifiers_type_check.
  return query
  with submitted as (
    select s ->> 'type' as t, s ->> 'normalizedValue' as v
      from jsonb_array_elements(p_signals) s
     where not (s ->> 'type' = any (array['vertical','locality']))
  ),
  held as (
    select bi.identifier_type as t, bi.normalized_value as v
      from public.business_identifiers bi
     where bi.business_id = p_business_id
       and bi.valid_to is null
       and not (bi.identifier_type = any (array['vertical','locality']))
  ),
  -- Only types PRESENT ON BOTH SIDES can agree or contradict. A type the
  -- record has never held says nothing, and neither does one the visitor did
  -- not supply.
  comparable as (
    select distinct s.t
      from submitted s
     where exists (select 1 from held h where h.t = s.t)
  ),
  verdict as (
    select c.t,
           exists (select 1 from submitted s join held h on h.t = s.t and h.v = s.v
                    where s.t = c.t) as agrees
      from comparable c
  ),
  totals as (
    select coalesce(array_agg(t order by t) filter (where agrees), array[]::text[]) as agreed,
           coalesce(array_agg(t order by t) filter (where not agrees), array[]::text[]) as contradicted
      from verdict
  )
  select
    totals.agreed,
    totals.contradicted,
    ('business_name' = any (totals.contradicted))
      and exists (select 1 from unnest(totals.contradicted) t
                   where t = any (array['email_exact','email_domain','website_domain',
                                        'business_phone','mobile_phone','gbp_place_id',
                                        'external_customer_id','payment_customer_id']))
      and cardinality(totals.agreed) = 0
    from totals;
end;
$$;

revoke all on function public.identity_proposal_conflict(jsonb, uuid)
  from public, anon, authenticated;

comment on function public.identity_proposal_conflict is
  'Compares a submission''s identity signals with a proposed Business Record''s active identifiers. Returns identifier TYPE names and whether the contradiction is material. Called by ingest_review for the continuation context and for the assessment session alike.';

drop function if exists public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb);

create or replace function public.ingest_review(
  p_idempotency_key          text,
  p_request_hash             text,
  p_payload                  jsonb,
  p_signals                  jsonb,
  p_bir                      jsonb,
  p_bir_id                   uuid,
  p_retention_days           integer default 30,
  p_meta                     jsonb   default '{}'::jsonb,
  p_review_type              text    default 'growth_review',
  p_continuation_business_id uuid    default null
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
  v_payload_hash    text := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  v_review_type     text := coalesce(nullif(p_review_type, ''), 'growth_review');

  v_timeline_at     timestamptz := least(v_submitted_at, v_now);

  v_existing        public.idempotency_records%rowtype;
  v_claimed_rows    integer := 0;

  v_session_business uuid;
  v_session_review_type text;
  v_business_id     uuid;
  v_growth_bir      public.business_intelligence_reports%rowtype;
  v_growth_age_days numeric;
  v_related_growth  jsonb;
  v_prefilled_fields jsonb;
  v_state_exists    boolean;
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

  v_continuation_ok boolean := false;
  v_continuation_conflict boolean := false;
  v_continuation_agreed       text[] := array[]::text[];
  v_continuation_contradicted text[] := array[]::text[];
  v_session_ok      boolean := false;
  v_session_conflict boolean := false;
  v_session_agreed            text[] := array[]::text[];
  v_session_contradicted_types text[] := array[]::text[];
  v_proposal_vetoed   boolean := false;
  v_proposals_disagree boolean := false;
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
  -- How to REACH a business, as opposed to what it is called. Strong types
  -- are included: a contradicting place id is the strongest possible
  -- statement that this is a different business.
  c_contact_evidence_types constant text[] := array[
    'email_exact','email_domain','website_domain','business_phone','mobile_phone',
    'gbp_place_id','external_customer_id','payment_customer_id'];
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'missing_idempotency_key' using errcode = '22023';
  end if;

  if v_review_type not in ('growth_review', 'service_mix') then
    raise exception 'unsupported_review_type: %', v_review_type using errcode = '22023';
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

    raise exception 'request_in_flight' using errcode = '55P03';
  end if;

  -- --------------------------------------------------------
  -- 2. Session. Upsert without disturbing an existing link.
  -- --------------------------------------------------------
  -- review_type is set on insert and never changed on conflict: a session id
  -- belongs to one review on one device, and rewriting it would relabel
  -- everything already attributed to it.
  --
  -- A session presented under a DIFFERENT review type is refused outright
  -- rather than silently relabelled or silently accepted. Accepting it would
  -- attribute a Service Mix submission to a Growth session's funnel and to
  -- its first-touch attribution; relabelling would move every count already
  -- made. Two reviews are two sessions, by design.
  insert into public.assessment_sessions (
    assessment_session_id, first_touch, review_type, created_at, last_seen_at
  ) values (
    v_session_id,
    coalesce(p_payload -> 'attribution' -> 'firstTouch', '{}'::jsonb),
    v_review_type, v_now, v_now
  )
  on conflict (assessment_session_id) do update
    set last_seen_at = v_now;

  select business_id, review_type into v_session_business, v_session_review_type
    from public.assessment_sessions
   where assessment_session_id = v_session_id
     for update;

  if v_session_review_type is distinct from v_review_type then
    raise exception 'session_review_type_conflict: session % belongs to % and cannot be reused for %',
      v_session_id, v_session_review_type, v_review_type
      using errcode = '22023';
  end if;

  -- --------------------------------------------------------
  -- 3. Identity resolution
  --
  -- Rule B0: a PROPOSAL is not a decision.
  -- --------------------------------------------------------
  -- Two things can name a Business Record before any identifier is looked
  -- at, and NEITHER is evidence about the business:
  --
  --   · a continuation context — a bearer credential this server signed,
  --     proving that this browser recently finished a review that resolved
  --     to this record
  --   · an assessment session id — a client-supplied journey identifier,
  --     proving that a previous submission carrying the same string resolved
  --     to this record
  --
  -- Both are statements about a BROWSER, not about the business now being
  -- described. A visitor finishes a review for Salon A and hands the laptop
  -- to a friend, who fills in a review for Salon B. An earlier revision
  -- stopped the token from attaching Salon B to Salon A and let the SESSION
  -- do it anyway: same journey id, no token needed, link method 'session',
  -- and Salon B's name, email and report filed permanently under Salon A in
  -- tables that refuse UPDATE and refuse DELETE.
  --
  -- So each proposal is compared with what the record it names actually
  -- holds, by public.identity_proposal_conflict — ONE rule, called twice,
  -- mirroring shared/business-record/resolve-identity.js :: proposalConflict.
  -- tests/identity-proposals.test.mjs runs one case table through the shared
  -- rule, the fake database and this function.
  if p_continuation_business_id is not null then
    select true into v_continuation_ok
      from public.business_records br
     where br.business_id = p_continuation_business_id
       and br.merged_into_business_id is null;
  end if;

  if coalesce(v_continuation_ok, false) then
    select agreed_types, contradicted_types, material
      into v_continuation_agreed, v_continuation_contradicted, v_continuation_conflict
      from public.identity_proposal_conflict(p_signals, p_continuation_business_id);
  end if;

  -- The session's record is re-checked the same way: one merged away or
  -- deleted since the session was linked must not be proposed either.
  if v_session_business is not null then
    select true into v_session_ok
      from public.business_records br
     where br.business_id = v_session_business
       and br.merged_into_business_id is null;
  end if;

  if coalesce(v_session_ok, false) then
    select agreed_types, contradicted_types, material
      into v_session_agreed, v_session_contradicted_types, v_session_conflict
      from public.identity_proposal_conflict(p_signals, v_session_business);
  end if;

  -- --------------------------------------------------------
  -- Rule B0b: two proposals, one submission.
  -- --------------------------------------------------------
  --   both propose the same record, no contradiction   -> link
  --   exactly one proposal, no contradiction           -> link
  --   any proposal materially contradicted             -> review
  --   two surviving proposals naming different records -> review
  --
  -- "Any contradiction -> review" is stricter than it strictly needs to be
  -- in one case: a consistent session alongside a contradicted token could
  -- arguably link by session. It does not, because the alternative is a rule
  -- with an exception in it, and choosing silently is how a submission ends
  -- up attached to one record while the session row still points at another
  -- — permanently, since assessment_sessions.business_id is written once and
  -- never rewritten.
  v_proposal_vetoed  := coalesce(v_continuation_conflict, false)
                        or coalesce(v_session_conflict, false);
  v_proposals_disagree :=
    coalesce(v_continuation_ok, false) and coalesce(v_session_ok, false)
    and not coalesce(v_continuation_conflict, false)
    and not coalesce(v_session_conflict, false)
    and p_continuation_business_id is distinct from v_session_business;

  -- A vetoed proposal is set aside entirely: not weakened, not scored, not
  -- used as a tie-break. A saved pointer that may be describing a different
  -- business is worth nothing at all here.
  if v_proposal_vetoed or v_proposals_disagree then
    v_continuation_ok := false;
    v_session_ok      := false;
  end if;

  if coalesce(v_continuation_ok, false) then
    v_business_id        := p_continuation_business_id;
    v_identity_status    := 'linked';
    v_resolution_status  := 'unique_match';
    v_recommended_action := 'link_to_existing';
    v_link_method        := 'continuation_context';
    v_confidence         := 1.00;
    v_contributing       := '["server_issued_continuation_context"]'::jsonb;

  elsif coalesce(v_session_ok, false) then
    -- Rule B2: a saved journey is deterministic for itself — once its own
    -- evidence has been checked against the record it points at.
    v_business_id        := v_session_business;
    v_identity_status    := 'linked';
    v_resolution_status  := 'unique_match';
    v_recommended_action := 'link_to_existing';
    v_link_method        := 'session';
    v_confidence         := 1.00;
    v_contributing       := '["assessment_session_link"]'::jsonb;

  elsif v_proposal_vetoed or v_proposals_disagree then
    -- A contradicted proposal, or two surviving proposals naming different
    -- records. Neither record is touched and neither is chosen.
    v_business_id        := null;
    v_identity_status    := 'resolution_pending';
    v_resolution_status  := 'manual_review_required';
    v_recommended_action := 'queue_for_review';
    v_link_method        := null;
    v_confidence         := 0.00;
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

    if array_length(v_all_ids, 1) is null
       and not (v_proposal_vetoed or v_proposals_disagree) then
      -- Rule B4: no credible candidate -> create.
      v_business_id        := gen_random_uuid();
      v_identity_status    := 'linked';
      v_resolution_status  := 'no_match';
      v_recommended_action := 'create_new_record';
      v_link_method        := 'auto';
      v_confidence         := 0.00;
      v_created_business   := true;

    elsif array_length(v_all_ids, 1) is null
          and (v_proposal_vetoed or v_proposals_disagree) then
      -- Rule B4v: B4 would CREATE, and a vetoed proposal may not create.
      --
      -- The only evidence that this is a new business is the same
      -- visitor-supplied evidence that just contradicted a saved proposal.
      -- Creating on it would turn a suspicious submission into a permanent
      -- record with no human ever seeing it, and a wrongly created record
      -- cannot be deleted — these tables refuse it. Queued instead: the
      -- visitor still gets their results, and nothing permanent is decided
      -- by a form.
      v_business_id        := null;
      v_identity_status    := 'resolution_pending';
      v_resolution_status  := 'manual_review_required';
      v_recommended_action := 'queue_for_review';
      v_link_method        := null;
      v_confidence         := 0.00;

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

  -- Every vetoed proposal is recorded as evidence wherever resolution landed.
  -- Someone has to be able to see, later, that a saved pointer was set aside
  -- and why — without the identifier VALUES, which belong in the Business
  -- Record under its own retention rules and not in a review queue.
  if coalesce(v_continuation_conflict, false) then
    v_conflicting := v_conflicting || jsonb_build_object(
      'kind', 'continuation_context_contradicted',
      'proposedBusinessId', p_continuation_business_id,
      'agreedTypes', to_jsonb(v_continuation_agreed),
      'contradictedTypes', to_jsonb(v_continuation_contradicted),
      'reason', 'The submitted business name and contact evidence match nothing this record holds.');
  end if;

  if coalesce(v_session_conflict, false) then
    v_conflicting := v_conflicting || jsonb_build_object(
      'kind', 'session_contradicted',
      'proposedBusinessId', v_session_business,
      'agreedTypes', to_jsonb(v_session_agreed),
      'contradictedTypes', to_jsonb(v_session_contradicted_types),
      'reason', 'The submitted business name and contact evidence match nothing this record holds.');
  end if;

  -- Two surviving proposals naming different records. Neither contradicts the
  -- payload, so neither can be dismissed — and choosing one would leave the
  -- other pointing somewhere else forever.
  if v_proposals_disagree then
    v_conflicting := v_conflicting || jsonb_build_object(
      'kind', 'proposals_disagree',
      'proposedBusinessIds', jsonb_build_array(p_continuation_business_id, v_session_business),
      'reason', 'The session and the continuation context name different records.');
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
      jsonb_build_object('createdFrom', 'assessment', 'createdBySubmission', v_submission_id,
                         'createdByReviewType', v_review_type)
    );
  end if;

  -- --------------------------------------------------------
  -- 5. Submission (durable regardless of identity outcome)
  -- --------------------------------------------------------
  insert into public.assessment_submissions (
    submission_id, assessment_session_id, business_id, assessment_version, vertical_id,
    raw_payload, identity_status, submitted_at, received_at, payload_hash,
    consent_snapshot, attribution_snapshot, payload_schema_version, ingest_meta,
    review_type
  ) values (
    v_submission_id, v_session_id, v_business_id,
    coalesce(p_payload ->> 'assessmentVersion', 'unknown'), v_vertical_id,
    p_payload, v_identity_status, v_submitted_at, v_now, v_payload_hash,
    coalesce(p_payload -> 'consent', '{}'::jsonb),
    coalesce(p_payload -> 'attribution', '{}'::jsonb),
    v_schema_version,
    -- `continuationApplied` is decided HERE and overwrites whatever the caller
    -- put in the meta. The endpoint knows only that it offered a context; this
    -- function is the only place that knows whether rule B0 let it through,
    -- and the service_mix.completed timeline event reads this key.
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object(
      'timelineOccurredAt', v_timeline_at,
      -- coalesced: v_link_method is NULL when identity went to review, and
      -- `NULL = 'continuation_context'` is NULL, not false. A JSON null here
      -- would read as "we do not know whether the context applied", which is
      -- the one thing this key must never say.
      'continuationApplied', coalesce(v_link_method = 'continuation_context', false),
      'continuationContradicted', coalesce(v_continuation_conflict, false),
      'sessionContradicted', coalesce(v_session_conflict, false)),
    v_review_type
  );

  -- --------------------------------------------------------
  -- 6. Link the session and record identifier evidence
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
        continue;
      end if;

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
  -- 7. BIR — chained to this REVIEW TYPE's current report
  -- --------------------------------------------------------
  -- Read from business_review_states, not from business_records.current_bir_id.
  -- Reading the legacy pointer here is exactly the bug this milestone exists
  -- to prevent: a Service Mix report would chain onto a Growth report and the
  -- supersession guard in section 5 would refuse the insert.
  --
  -- SERIALIZED per (business, review type) by a transaction-scoped advisory
  -- lock taken BEFORE the read. `select … for update` cannot serialise two
  -- FIRST submissions: there is no row yet to lock, both read null, both
  -- insert a report that supersedes nothing, and the business ends up with
  -- two supersession roots and no way to say which is current. The lock is
  -- what makes "the first one wins and the second chains onto it" true.
  -- It is released at commit, and a replay never reaches here at all.
  if v_business_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(v_business_id::text || ':' || v_review_type, 0));

    select current_bir_id into v_prev_bir
      from public.business_review_states
     where business_id = v_business_id
       and review_type = v_review_type
       for update;
  end if;

  v_report := jsonb_set(p_bir, '{identity,businessId}',
                        case when v_business_id is null then 'null'::jsonb
                             else to_jsonb(v_business_id::text) end);
  v_report := jsonb_set(v_report, '{identity,identityStatus}', to_jsonb(v_identity_status));
  v_report := jsonb_set(v_report, '{provenance,supersedes}',
                        case when v_prev_bir is null then 'null'::jsonb
                             else to_jsonb(v_prev_bir::text) end);

  -- --------------------------------------------------------
  -- 7a. The related Growth Review reference
  -- --------------------------------------------------------
  -- Written HERE, after identity is resolved, because only the database knows
  -- which business this is. The endpoint generates the report before
  -- ingestion, when businessId is still null, so it cannot look this up.
  --
  -- A REFERENCE, never a copy. No Growth score, no Growth finding, no Growth
  -- opportunity figure crosses into this report, and `usedInCalculations` is
  -- false because nothing from the Growth Review enters any Service Mix
  -- calculation. The Growth BIR is not read for its analysis, not updated,
  -- and not superseded — it is only named.
  if v_review_type = 'service_mix' and v_business_id is not null then
    select bir.* into v_growth_bir
      from public.business_review_states st
      join public.business_intelligence_reports bir on bir.bir_id = st.current_bir_id
     where st.business_id = v_business_id
       and st.review_type = 'growth_review';

    if found then
      -- Freshness quotes report.schema.js :: LIFECYCLE_POLICY.freshnessDays
      -- { fresh: 90, aging: 180, stale: 365 }; beyond stale is expired.
      v_growth_age_days := extract(epoch from (v_now - v_growth_bir.generated_at)) / 86400.0;

      -- Which contact fields the visitor did not have to retype. A list of
      -- FIELD NAMES, never values.
      --
      -- REVALIDATED HERE, not carried verbatim. The endpoint refuses an
      -- unapproved entry, and this filters again against the same closed enum
      -- — because this function is also reachable by a future server-to-server
      -- caller that never passed through the endpoint, and a list of field
      -- names that can hold an arbitrary string is not a list of field names.
      -- Ordered by the enum and de-duplicated, so the same set always
      -- serialises the same way and the report stays deterministic.
      select coalesce(jsonb_agg(name order by ord), '[]'::jsonb)
        into v_prefilled_fields
        from unnest(array['salonName', 'businessName', 'ownerName', 'email'])
               with ordinality as approved(name, ord)
       where exists (
               select 1
                 from jsonb_array_elements_text(
                        case when jsonb_typeof(p_payload -> 'serviceMix' -> 'prefilledFields') = 'array'
                             then p_payload -> 'serviceMix' -> 'prefilledFields'
                             else '[]'::jsonb end) claimed
                where claimed = approved.name);

      -- EXACTLY the five approved fields. No sixth: the field is named
      -- relatedGrowthReview, so what it relates to is already said, and
      -- validateServiceMixBir refuses anything beyond the contract.
      v_related_growth := jsonb_build_object(
        'birId', v_growth_bir.bir_id,
        'generatedAt', to_char(v_growth_bir.generated_at at time zone 'utc',
                               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'freshness', case
                       when v_growth_age_days <= 90  then 'fresh'
                       when v_growth_age_days <= 180 then 'aging'
                       when v_growth_age_days <= 365 then 'stale'
                       else 'expired'
                     end,
        'prefilledFields', v_prefilled_fields,
        -- SM-1 uses no Growth figure in any calculation. The validator in
        -- generate-service-mix-bir.js refuses a report that claims otherwise.
        'usedInCalculations', false);

      v_report := jsonb_set(v_report, '{relatedGrowthReview}', v_related_growth);
    end if;
  end if;

  insert into public.business_intelligence_reports (
    bir_id, business_id, assessment_submission_id, schema_version,
    generated_at, report, confidence_band, missing_critical_fields, supersedes_bir_id,
    review_type
  ) values (
    p_bir_id, v_business_id, v_submission_id,
    (v_report ->> 'schemaVersion')::integer,
    v_now, v_report,
    -- A Service Mix report has no estimateConfidence band; its confidence is
    -- a 0..1 number under dataConfidence. Banded here so the column keeps one
    -- meaning across review types rather than defaulting silently to 'low'.
    case
      when v_review_type = 'service_mix' then
        case
          when coalesce((v_report -> 'dataConfidence' ->> 'confidence')::numeric, 0) >= 0.80 then 'high'
          when coalesce((v_report -> 'dataConfidence' ->> 'confidence')::numeric, 0) >= 0.50 then 'medium'
          else 'low'
        end
      else coalesce(v_report -> 'estimateConfidence' ->> 'band', 'low')
    end,
    case
      when v_review_type = 'service_mix'
        then coalesce(to_jsonb(array(
               select jsonb_build_object('offeringId', g ->> 'offeringId', 'measure', g ->> 'measure')
                 from jsonb_array_elements(coalesce(v_report -> 'measurementGaps', '[]'::jsonb)) g)),
             '[]'::jsonb)
      else coalesce(v_report -> 'qualificationProfile' -> 'missingCriticalFields', '[]'::jsonb)
    end,
    v_prev_bir,
    v_review_type
  );

  -- --------------------------------------------------------
  -- 7b. Current pointers
  -- --------------------------------------------------------
  if v_business_id is not null then
    -- Per review type. This is the surface that makes Growth and Service Mix
    -- independently current.
    insert into public.business_review_states as st (
      business_id, review_type, current_bir_id,
      original_submission_id, latest_submission_id,
      last_completed_at, next_reassessment_due_at, next_reassessment_kind,
      completed_count, state
    ) values (
      v_business_id, v_review_type, p_bir_id,
      v_submission_id, v_submission_id,
      v_timeline_at,
      -- LIFECYCLE_POLICY.unconvertedLeadReassessDays = 90 for a first review;
      -- quarterlyReviewDays is the same 90 for a repeat. One number today,
      -- two names, and the kind says which rule produced it.
      v_timeline_at + interval '90 days',
      'quick_recheck',
      1,
      jsonb_build_object('verticalId', v_vertical_id,
                         'lastLinkMethod', v_link_method)
    )
    on conflict (business_id, review_type) do update set
      current_bir_id           = excluded.current_bir_id,
      -- Written once, on the first submission of this review type, and never
      -- moved. It is the root of the supersession chain.
      original_submission_id   = coalesce(st.original_submission_id, excluded.original_submission_id),
      latest_submission_id     = excluded.latest_submission_id,
      last_completed_at        = greatest(st.last_completed_at, excluded.last_completed_at),
      next_reassessment_due_at = greatest(st.last_completed_at, excluded.last_completed_at)
                                   + interval '90 days',
      next_reassessment_kind   = 'quarterly_review',
      completed_count          = st.completed_count + 1,
      state                    = st.state || excluded.state;

    -- The legacy pointer, for Growth only. Section 6 refuses anything else at
    -- the database, so this condition is a statement of intent rather than
    -- the enforcement.
    if v_review_type = 'growth_review' then
      update public.business_records
         set current_bir_id = p_bir_id, updated_at = v_now
       where business_id = v_business_id;
    else
      update public.business_records
         set updated_at = v_now
       where business_id = v_business_id;
    end if;
  end if;

  -- --------------------------------------------------------
  -- 8. Timeline — append-only, one row per fact
  -- --------------------------------------------------------
  if v_created_business then
    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (v_business_id, 'business.created', 1, v_timeline_at, 'business-record-engine', v_business_id::text,
            'Business Record created from a completed review.',
            jsonb_build_object('createdFrom','assessment','verticalId',v_vertical_id,
                               'reviewType', v_review_type), v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'identity.resolved', 1, v_timeline_at, 'business-record-engine', v_submission_id::text,
          format('Identity resolution: %s.', v_resolution_status),
          jsonb_build_object('resolutionStatus', v_resolution_status, 'resolutionConfidence', v_confidence,
                             'recommendedAction', v_recommended_action, 'reviewType', v_review_type,
                             'linkMethod', v_link_method,
                             'candidateCount', coalesce(array_length(v_all_ids,1),0)),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  if v_business_id is not null then
    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (v_business_id, 'identity.linked', 1, v_timeline_at, 'business-record-engine', 'submission:' || v_submission_id::text,
            'Review submission linked to this Business Record.',
            jsonb_build_object('linkedBusinessId', v_business_id, 'linkedArtifactKind','assessment_submission',
                               'linkedArtifactId', v_submission_id, 'linkMethod', v_link_method,
                               'reviewType', v_review_type),
            v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, source_record_id, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'assessment.completed', 2, v_timeline_at, 'assessment-engine', v_submission_id::text, v_submission_id::text,
          case when v_review_type = 'service_mix'
               then 'Quick Service Mix Review completed.'
               else 'Assessment completed.' end,
          jsonb_build_object('assessmentSessionId', v_session_id, 'submissionId', v_submission_id,
                             'verticalId', v_vertical_id, 'assessmentVersion', p_payload ->> 'assessmentVersion',
                             'payloadSchemaVersion', v_schema_version,
                             'reviewType', v_review_type,
                             'reportedSubmittedAt', p_payload ->> 'submittedAt',
                             'clockSkewDetected', coalesce((p_meta ->> 'clockSkewDetected')::boolean, false)),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, source_record_id, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'bir.generated', 1, v_timeline_at, 'business-intelligence-engine', p_bir_id::text, p_bir_id::text,
          'Report generated.',
          jsonb_build_object('birId', p_bir_id, 'supersedesBirId', v_prev_bir,
                             'reviewType', v_review_type,
                             'schemaVersion', (v_report ->> 'schemaVersion')::integer,
                             'confidenceBand', v_report -> 'estimateConfidence' ->> 'band',
                             'closeReadinessBand', v_report -> 'closeReadinessProfile' ->> 'band'),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  -- --------------------------------------------------------
  -- 9. Ambiguity or conflict -> a case for a human.
  -- --------------------------------------------------------
  -- A vetoed continuation context always makes a case, even when resolution
  -- succeeded by other means: "a signed token was set aside" is a fact
  -- somebody needs to be able to find.
  if v_identity_status = 'resolution_pending' or v_claim_conflicts <> '[]'::jsonb
     or v_proposal_vetoed or v_proposals_disagree then
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
            case when v_proposal_vetoed
                 then 'A saved identity proposal was set aside: the submitted identity contradicts the record it named.'
                 when v_proposals_disagree
                 then 'The session and the continuation context name different records.'
                 when v_claim_conflicts <> '[]'::jsonb
                 then 'A claimed identifier is already held, verified, by another business.'
                 else 'Identity could not be resolved automatically; queued for review.' end,
            jsonb_build_object('identityResolutionId', v_case_id, 'resolutionStatus', v_resolution_status,
                               'reviewType', v_review_type,
                               'reason', case when v_proposal_vetoed
                                              then 'A saved identity proposal was contradicted by submitted identity evidence.'
                                              when v_proposals_disagree
                                              then 'Two saved proposals name different Business Records.'
                                              when v_claim_conflicts <> '[]'::jsonb
                                              then 'Cross-business claim on a verified identifier.'
                                              else 'No unique verified strong identifier among candidates.' end,
                               'continuationContradicted', coalesce(v_continuation_conflict, false),
                               'sessionContradicted', coalesce(v_session_conflict, false),
                               'proposalsDisagreed', v_proposals_disagree,
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
          format('Ingested %s submission %s with identity status %s.',
                 v_review_type, v_submission_id, v_identity_status),
          jsonb_build_object('submissionId', v_submission_id, 'birId', p_bir_id,
                             'supersedesBirId', v_prev_bir,
                             'reviewType', v_review_type,
                             'identityStatus', v_identity_status, 'resolutionStatus', v_resolution_status,
                             'linkMethod', v_link_method,
                             'payloadSchemaVersion', v_schema_version,
                             'ingestMeta', coalesce(p_meta, '{}'::jsonb),
                             'continuationContradicted', coalesce(v_continuation_conflict, false),
                             'sessionContradicted', coalesce(v_session_conflict, false),
                             'proposalsDisagreed', v_proposals_disagree,
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
    'reviewType', v_review_type,
    'linkMethod', v_link_method,
    -- Reported so the endpoint can log it. Carries no identifier value and no
    -- business id: the caller learns that a saved proposal was not applied,
    -- never whose record it named or what differed.
    'continuationContradicted', coalesce(v_continuation_conflict, false),
    'sessionContradicted', coalesce(v_session_conflict, false),
    'proposalsDisagreed', v_proposals_disagree,
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

revoke all on function public.ingest_review(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb, text, uuid)
  from public, anon, authenticated;

comment on function public.ingest_review is
  'Atomic review ingestion for any review type. One call = one transaction. Server-role only. p_continuation_business_id is server-issued and verified before it reaches here; it is never a client-supplied id.';

-- The compatibility wrapper. Same name, same signature, same behaviour — so
-- the endpoint, a queued browser submission built before this deploy, and the
-- existing test suite all reach one body by the name they already use.
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
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.ingest_review(
    p_idempotency_key, p_request_hash, p_payload, p_signals, p_bir, p_bir_id,
    p_retention_days, p_meta, 'growth_review', null);
$$;

revoke all on function public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb)
  from public, anon, authenticated;

comment on function public.ingest_assessment is
  'Growth Review ingestion. A thin wrapper over ingest_review, retained with its original signature so existing callers are untouched.';

-- ------------------------------------------------------------
-- 9. Analytics, separated by review type
-- ------------------------------------------------------------
-- The column alone is not enough: the aggregate key must carry review_type or
-- Service Mix events land on the Growth funnel's row and the two are averaged
-- into a number that describes neither.

alter table public.assessment_funnel_daily
  drop constraint if exists assessment_funnel_daily_pkey;

alter table public.assessment_funnel_daily
  add constraint assessment_funnel_daily_pkey
  primary key (aggregate_date, vertical_id, review_type, assessment_version,
               question_set_version, source, device_class);

-- Counters for what only the Service Mix review has. Added rather than
-- overloaded: reusing checkout_intents for "clicked the AI analysis" would
-- make one column mean two things and no report could separate them again.
alter table public.assessment_funnel_daily
  add column if not exists offerings_added              integer not null default 0,
  add column if not exists offerings_removed            integer not null default 0,
  add column if not exists pricing_detail_requests      integer not null default 0,
  add column if not exists bundle_recommendation_views  integer not null default 0,
  add column if not exists growth_review_clicks         integer not null default 0,
  add column if not exists ai_analysis_clicks           integer not null default 0;

-- The analytics ENVELOPE version, widened from 1 to 2.
--
-- FOUND BY THE FIRST REAL-POSTGRES RUN OF THIS MIGRATION. SM-1 added
-- `reviewType` to the event envelope and bumped
-- shared/analytics/events.js :: ANALYTICS_SCHEMA_VERSION to 2, and the
-- endpoint accepts [1, 2] — but 0005 pinned the column to `between 1 and 1`
-- and nothing here widened it. Every event a post-SM-1 page emitted would
-- have been refused by the database with a check-constraint violation, and
-- the whole batch with it.
--
-- Version 1 stays valid: a page cached before the deploy still emits it, and
-- every row already written is one.

alter table public.assessment_analytics_events
  drop constraint if exists analytics_events_schema_version_check;

alter table public.assessment_analytics_events
  add constraint analytics_events_schema_version_check
  check (schema_version between 1 and 2);

comment on column public.assessment_analytics_events.schema_version is
  'Analytics envelope version. 1 = the original. 2 = adds reviewType. Widen here and in shared/analytics/events.js :: SUPPORTED_SCHEMA_VERSIONS together; the two disagreeing means either lost events or stored events nothing can read.';

-- Resolves an event's review type. The event NAME wins when it settles the
-- matter, so a service_mix.* event can never be filed under the wrong funnel
-- by a misconfigured page. Anything undeclared is a Growth Review event,
-- which is what every row written before SM-1 is.
create or replace function public.analytics_review_type(p_event_name text, p_declared text)
returns text
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case
    when p_event_name like 'service\_mix.%' then 'service_mix'
    when p_declared in ('growth_review', 'service_mix') then p_declared
    else 'growth_review'
  end;
$$;

revoke all on function public.analytics_review_type(text, text) from public, anon, authenticated;

comment on function public.analytics_review_type is
  'Resolves an analytics event''s review type from its name and its declaration. The name wins when it settles the matter.';

-- ------------------------------------------------------------
-- 9b. Analytics ingestion carries review_type
-- ------------------------------------------------------------
-- Replaced rather than triggered: the value comes from the event JSON, which
-- only this function sees. A trigger could recover it from event_name alone,
-- and would then misfile every assessment.step_viewed the Service Mix page
-- emits — the drop-off events, which are exactly the ones the separation is
-- for.
--
-- Everything else in this body is 0005 unchanged, including the greatest()
-- null semantics that a real-Postgres run had to find once already.

create or replace function public.ingest_analytics_events(
  p_events         jsonb,
  p_meta           jsonb   default '{}'::jsonb,
  p_retention_days integer default 400
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now        timestamptz := now();
  v_expires    timestamptz := now() + make_interval(days => greatest(p_retention_days, 1));
  v_session    uuid;
  v_accepted   uuid[] := array[]::uuid[];
  v_duplicates uuid[] := array[]::uuid[];
  v_event      jsonb;
  v_id         uuid;
  v_inserted   integer;
  v_batch_review_type   text;
  v_session_review_type text;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    raise exception 'analytics_empty_batch' using errcode = '22023';
  end if;

  select distinct (e ->> 'assessmentSessionId')::uuid into v_session
    from jsonb_array_elements(p_events) e
   limit 2;

  if (select count(distinct e ->> 'assessmentSessionId') from jsonb_array_elements(p_events) e) <> 1 then
    raise exception 'analytics_mixed_sessions' using errcode = '22023';
  end if;

  -- One batch, one review type — and it must be the one this session already
  -- has. A Growth session reused for Service Mix events would blend two
  -- funnels into one row and silently corrupt every rate computed from it.
  -- Refused rather than relabelled: the roll-up deliberately never updates
  -- review_type, so relabelling would move counts already made.
  if (select count(distinct public.analytics_review_type(
        e ->> 'eventName', e ->> 'reviewType'))
        from jsonb_array_elements(p_events) e) <> 1 then
    raise exception 'analytics_mixed_review_types' using errcode = '22023';
  end if;

  select public.analytics_review_type(e ->> 'eventName', e ->> 'reviewType')
    into v_batch_review_type
    from jsonb_array_elements(p_events) e
   limit 1;

  select review_type into v_session_review_type
    from public.assessment_analytics_sessions
   where assessment_session_id = v_session;

  if v_session_review_type is not null
     and v_session_review_type is distinct from v_batch_review_type then
    raise exception 'analytics_session_review_type_conflict: session % belongs to % and cannot be reused for %',
      v_session, v_session_review_type, v_batch_review_type
      using errcode = '22023';
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_id := (v_event ->> 'eventId')::uuid;

    insert into public.assessment_analytics_events (
      event_id, event_name, event_version, schema_version,
      assessment_session_id, submission_id, business_id,
      vertical_id, assessment_version, question_set_version,
      review_type,
      assessment_stage, step_id, question_id,
      occurred_at, received_at,
      active_elapsed_ms, total_elapsed_ms, step_elapsed_ms,
      visible_question_count, completed_question_count,
      attribution, device, metadata, expires_at
    ) values (
      v_id,
      v_event ->> 'eventName',
      coalesce((v_event ->> 'eventVersion')::integer, 1),
      coalesce((v_event ->> 'schemaVersion')::integer, 1),
      (v_event ->> 'assessmentSessionId')::uuid,
      nullif(v_event ->> 'submissionId', '')::uuid,
      nullif(v_event ->> 'businessId', '')::uuid,
      v_event ->> 'verticalId',
      nullif(v_event ->> 'assessmentVersion', ''),
      nullif(v_event ->> 'questionSetVersion', ''),
      public.analytics_review_type(v_event ->> 'eventName', v_event ->> 'reviewType'),
      nullif(v_event ->> 'assessmentStage', '')::smallint,
      nullif(v_event ->> 'stepId', ''),
      nullif(v_event ->> 'questionId', ''),
      least((v_event ->> 'occurredAt')::timestamptz, v_now),
      v_now,
      coalesce((v_event ->> 'activeElapsedMs')::bigint, 0),
      coalesce((v_event ->> 'totalElapsedMs')::bigint, 0),
      nullif(v_event ->> 'stepElapsedMs', '')::bigint,
      nullif(v_event ->> 'visibleQuestionCount', '')::integer,
      nullif(v_event ->> 'completedQuestionCount', '')::integer,
      coalesce(v_event -> 'attribution', '{}'::jsonb),
      coalesce(v_event -> 'device', '{}'::jsonb),
      coalesce(v_event -> 'metadata', '{}'::jsonb),
      v_expires
    )
    on conflict (event_id) do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_accepted := v_accepted || v_id;
    else
      v_duplicates := v_duplicates || v_id;
    end if;
  end loop;

  insert into public.assessment_analytics_sessions as s (
    assessment_session_id, business_id, vertical_id, assessment_version,
    question_set_version, review_type, started_at, last_event_at,
    stage1_completed_at, stage2_started_at, stage2_completed_at,
    latest_step_id, max_step_reached, max_stage_reached, result_state,
    resumed_count, validation_failures, question_interactions, event_count,
    total_active_ms, total_elapsed_ms, first_touch, latest_touch, device,
    expires_at
  )
  select
    e.assessment_session_id,
    max(e.business_id::text)::uuid,
    max(e.vertical_id),
    max(e.assessment_version),
    max(e.question_set_version),
    -- A session belongs to one review. max() over a single distinct value is
    -- that value; it is an aggregate here only because the select is grouped.
    max(e.review_type),
    min(e.occurred_at),
    max(e.occurred_at),
    min(e.occurred_at) filter (where e.event_name in
      ('assessment.stage1_completed', 'service_mix.stage1_completed')),
    min(e.occurred_at) filter (where e.event_name = 'assessment.stage2_started'),
    min(e.occurred_at) filter (where e.event_name = 'assessment.stage2_completed'),
    (array_agg(e.step_id order by e.occurred_at desc, e.received_at desc)
       filter (where e.step_id is not null))[1],
    max(nullif(regexp_replace(coalesce(e.step_id, ''), '\D', '', 'g'), '')::integer),
    max(e.assessment_stage),
    case
      when count(*) filter (where e.event_name = 'assessment.stage2_completed') > 0
        then 'fit_review_complete'
      when count(*) filter (where e.event_name = 'assessment.stage2_started') > 0
        then 'fit_review_available'
      when count(*) filter (where e.event_name in
        ('assessment.stage1_completed', 'service_mix.stage1_completed')) > 0
        then 'preliminary_results'
      when count(*) filter (where e.event_name = 'assessment.abandoned') > 0
        then 'abandoned'
      else 'in_progress'
    end,
    count(*) filter (where e.event_name = 'assessment.resumed'),
    count(*) filter (where e.event_name = 'assessment.validation_failed'),
    count(*) filter (where e.event_name = 'assessment.question_answered'),
    count(*),
    max(e.active_elapsed_ms),
    max(e.total_elapsed_ms),
    coalesce((array_agg(e.attribution -> 'firstTouch' order by e.occurred_at asc)
                filter (where e.attribution -> 'firstTouch' <> 'null'::jsonb))[1], '{}'::jsonb),
    coalesce((array_agg(e.attribution -> 'latestTouch' order by e.occurred_at desc)
                filter (where e.attribution -> 'latestTouch' <> 'null'::jsonb))[1], '{}'::jsonb),
    coalesce((array_agg(e.device order by e.occurred_at desc))[1], '{}'::jsonb),
    max(e.expires_at)
  from public.assessment_analytics_events e
  where e.assessment_session_id = v_session
  group by e.assessment_session_id
  on conflict (assessment_session_id) do update set
    business_id           = coalesce(excluded.business_id, s.business_id),
    assessment_version    = coalesce(excluded.assessment_version, s.assessment_version),
    question_set_version  = coalesce(excluded.question_set_version, s.question_set_version),
    -- review_type is deliberately NOT updated. A session belongs to one
    -- review, and relabelling it would move every count already attributed.
    started_at            = least(s.started_at, excluded.started_at),
    last_event_at         = greatest(s.last_event_at, excluded.last_event_at),
    stage1_completed_at   = coalesce(s.stage1_completed_at, excluded.stage1_completed_at),
    stage2_started_at     = coalesce(s.stage2_started_at, excluded.stage2_started_at),
    stage2_completed_at   = coalesce(s.stage2_completed_at, excluded.stage2_completed_at),
    latest_step_id        = coalesce(excluded.latest_step_id, s.latest_step_id),
    -- greatest() SKIPS nulls in Postgres, which is exactly the semantics
    -- wanted here. The obvious-looking greatest(coalesce(x,0), coalesce(y,0))
    -- is a defect found against real Postgres on 2026-08-05: two nulls became
    -- 0, violating analytics_sessions_stage_check and aborting the batch.
    max_step_reached      = greatest(s.max_step_reached, excluded.max_step_reached),
    max_stage_reached     = greatest(s.max_stage_reached, excluded.max_stage_reached),
    result_state          = excluded.result_state,
    resumed_count         = excluded.resumed_count,
    validation_failures   = excluded.validation_failures,
    question_interactions = excluded.question_interactions,
    event_count           = excluded.event_count,
    total_active_ms       = greatest(s.total_active_ms, excluded.total_active_ms),
    total_elapsed_ms      = greatest(s.total_elapsed_ms, excluded.total_elapsed_ms),
    first_touch           = case when s.first_touch = '{}'::jsonb then excluded.first_touch else s.first_touch end,
    latest_touch          = excluded.latest_touch,
    device                = excluded.device,
    expires_at            = greatest(s.expires_at, excluded.expires_at);

  update public.assessment_analytics_sessions
     set abandoned_at = case
           when result_state = 'abandoned' then last_event_at
           else null
         end
   where assessment_session_id = v_session;

  return jsonb_build_object(
    'ok', true,
    'sessionId', v_session,
    'accepted', to_jsonb(v_accepted),
    'duplicates', to_jsonb(v_duplicates),
    'receivedAt', to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'correlationId', p_meta ->> 'correlationId'
  );
end;
$$;

revoke all on function public.ingest_analytics_events(jsonb, jsonb, integer)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 9c. Daily aggregation, grouped by review type
-- ------------------------------------------------------------
-- The Service Mix events map onto the EXISTING counters wherever they mean
-- the same thing — a review viewed is a page view, a review started is a
-- start — because the counter is the shared mechanism and review_type is what
-- separates the two funnels. Only what is genuinely Service-Mix-specific gets
-- its own column.

-- THE DEFAULT BOUNDS ARE UTC, because the buckets are.
--
-- Every event is grouped and filtered by `(occurred_at at time zone 'utc')::date`,
-- and the defaults inherited from 0005 were `current_date`, which is the
-- DATABASE SESSION's calendar. The two agree for most of the day and disagree
-- exactly at the edge, which is the worst possible failure shape: a nightly
-- refresh run from a session behind UTC asks for events "up to yesterday",
-- the events it wants are stamped today in UTC, and the aggregate table
-- silently stays empty. Reproduced at 00:05 UTC from America/New_York —
-- now() said August 6, current_date said August 5, both events bucketed to
-- August 6, and zero rows were written.
--
-- Nothing here reads the session time zone any more. `now() at time zone
-- 'utc'` is a timestamp in UTC whatever the session is set to.
create or replace function public.refresh_assessment_funnel_daily(
  p_from date default ((now() at time zone 'utc')::date - 7),
  p_to   date default (now() at time zone 'utc')::date
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_rows integer;
begin
  insert into public.assessment_funnel_daily as f (
    aggregate_date, vertical_id, review_type, assessment_version, question_set_version,
    source, device_class,
    page_views, starts, resumes, stage1_completions, preliminary_result_views,
    stage2_starts, stage2_completions, full_result_views,
    personal_review_clicks, recommended_system_clicks, improve_recommendation_clicks,
    checkout_intents, report_requests, validation_failures, question_interactions,
    abandonment_count,
    offerings_added, offerings_removed, pricing_detail_requests,
    bundle_recommendation_views, growth_review_clicks, ai_analysis_clicks,
    median_stage1_active_ms, median_stage2_active_ms, computed_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.vertical_id,
    e.review_type,
    coalesce(e.assessment_version, 'unknown'),
    coalesce(e.question_set_version, 'unknown'),
    coalesce(nullif(e.attribution -> 'firstTouch' -> 'utm' ->> 'utm_source', ''), '(none)'),
    coalesce(nullif(e.device ->> 'deviceClass', ''), 'unknown'),

    count(distinct e.assessment_session_id) filter (where e.event_name in
      ('assessment.page_viewed', 'service_mix.review_viewed')),
    count(distinct e.assessment_session_id) filter (where e.event_name in
      ('assessment.started', 'service_mix.review_started')),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.resumed'),
    count(distinct e.assessment_session_id) filter (where e.event_name in
      ('assessment.stage1_completed', 'service_mix.stage1_completed')),
    count(distinct e.assessment_session_id) filter (where e.event_name in
      ('assessment.preliminary_results_viewed', 'service_mix.results_viewed')),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.stage2_started'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.stage2_completed'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.full_results_viewed'),
    count(*) filter (where e.event_name = 'assessment.personal_review_clicked'),
    count(*) filter (where e.event_name = 'assessment.recommended_system_clicked'),
    count(*) filter (where e.event_name = 'assessment.improve_recommendation_clicked'),
    count(*) filter (where e.event_name = 'assessment.checkout_intent'),
    count(*) filter (where e.event_name = 'assessment.report_requested'),
    count(*) filter (where e.event_name = 'assessment.validation_failed'),
    count(*) filter (where e.event_name = 'assessment.question_answered'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.abandoned'),

    count(*) filter (where e.event_name = 'service_mix.offering_added'),
    count(*) filter (where e.event_name = 'service_mix.offering_removed'),
    count(*) filter (where e.event_name = 'service_mix.pricing_detail_requested'),
    count(*) filter (where e.event_name = 'service_mix.bundle_recommendation_viewed'),
    count(*) filter (where e.event_name = 'service_mix.growth_review_clicked'),
    count(*) filter (where e.event_name = 'service_mix.ai_analysis_clicked'),

    percentile_cont(0.5) within group (
      order by e.active_elapsed_ms) filter (where e.event_name in
        ('assessment.stage1_completed', 'service_mix.stage1_completed'))::bigint,
    percentile_cont(0.5) within group (
      order by e.active_elapsed_ms) filter (where e.event_name = 'assessment.stage2_completed')::bigint,
    now()
  from public.assessment_analytics_events e
  where (e.occurred_at at time zone 'utc')::date between p_from and p_to
  group by 1, 2, 3, 4, 5, 6, 7
  on conflict (aggregate_date, vertical_id, review_type, assessment_version,
               question_set_version, source, device_class) do update set
    page_views                    = excluded.page_views,
    starts                        = excluded.starts,
    resumes                       = excluded.resumes,
    stage1_completions            = excluded.stage1_completions,
    preliminary_result_views      = excluded.preliminary_result_views,
    stage2_starts                 = excluded.stage2_starts,
    stage2_completions            = excluded.stage2_completions,
    full_result_views             = excluded.full_result_views,
    personal_review_clicks        = excluded.personal_review_clicks,
    recommended_system_clicks     = excluded.recommended_system_clicks,
    improve_recommendation_clicks = excluded.improve_recommendation_clicks,
    checkout_intents              = excluded.checkout_intents,
    report_requests               = excluded.report_requests,
    validation_failures           = excluded.validation_failures,
    question_interactions         = excluded.question_interactions,
    abandonment_count             = excluded.abandonment_count,
    offerings_added               = excluded.offerings_added,
    offerings_removed             = excluded.offerings_removed,
    pricing_detail_requests       = excluded.pricing_detail_requests,
    bundle_recommendation_views   = excluded.bundle_recommendation_views,
    growth_review_clicks          = excluded.growth_review_clicks,
    ai_analysis_clicks            = excluded.ai_analysis_clicks,
    median_stage1_active_ms       = excluded.median_stage1_active_ms,
    median_stage2_active_ms       = excluded.median_stage2_active_ms,
    computed_at                   = now();

  get diagnostics v_rows = row_count;

  -- Written separately because the denominator is a sum over SESSIONS of a
  -- per-session maximum, and that cannot be expressed alongside the
  -- event-level aggregates above without double counting.
  update public.assessment_funnel_daily f
     set visible_question_total = coalesce(v.total, 0)
    from (
      select aggregate_date, vertical_id, review_type, assessment_version,
             question_set_version, source, device_class, sum(per_session_max) as total
        from (
          select (e.occurred_at at time zone 'utc')::date        as aggregate_date,
                 e.vertical_id,
                 e.review_type,
                 coalesce(e.assessment_version, 'unknown')       as assessment_version,
                 coalesce(e.question_set_version, 'unknown')     as question_set_version,
                 coalesce(nullif(e.attribution -> 'firstTouch' -> 'utm' ->> 'utm_source', ''), '(none)') as source,
                 coalesce(nullif(e.device ->> 'deviceClass', ''), 'unknown') as device_class,
                 e.assessment_session_id,
                 max(e.visible_question_count)                   as per_session_max
            from public.assessment_analytics_events e
           where (e.occurred_at at time zone 'utc')::date between p_from and p_to
             and e.visible_question_count is not null
           group by 1, 2, 3, 4, 5, 6, 7, 8
        ) s
       group by 1, 2, 3, 4, 5, 6, 7
    ) v
   where f.aggregate_date       = v.aggregate_date
     and f.vertical_id          = v.vertical_id
     and f.review_type          = v.review_type
     and f.assessment_version   = v.assessment_version
     and f.question_set_version = v.question_set_version
     and f.source               = v.source
     and f.device_class         = v.device_class;

  return v_rows;
end;
$$;

revoke all on function public.refresh_assessment_funnel_daily(date, date)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 10. Row Level Security for the new table
-- ------------------------------------------------------------
-- RLS ON and FORCED with NO policies, exactly as every other table here.
-- Only the service role reaches any of it, and it lives exclusively in the
-- Vercel Function.

alter table public.business_review_states enable row level security;
alter table public.business_review_states force  row level security;

revoke all on all tables in schema public from anon, authenticated;

-- ------------------------------------------------------------
-- 9d. Drop-off, on the same UTC calendar
-- ------------------------------------------------------------
-- Redefined here for ONE reason: 0005 buckets by
-- `(occurred_at at time zone 'utc')::date` and defaults its bounds to
-- `current_date`, which is the database session's calendar. The same
-- mismatch, and the same silent empty result at the edge of a UTC day, as
-- refresh_assessment_funnel_daily above.
--
-- 0005 is not edited. It has been applied to a hosted development database
-- and describes what that function was; changing an applied migration so an
-- old definition reads like a new one would make the migration history lie
-- about itself. The body below is 0005's, unchanged, with UTC defaults.
--
-- Every date-ranged analytics function in the schema is now on one calendar:
-- this one and refresh_assessment_funnel_daily are the only two.

create or replace function public.assessment_step_dropoff(
  p_vertical_id text,
  p_from        date default ((now() at time zone 'utc')::date - 30),
  p_to          date default (now() at time zone 'utc')::date
)
returns table (
  stage                smallint,
  step_id              text,
  visible_sessions     bigint,
  entered_sessions     bigint,
  completed_sessions   bigint,
  exits                bigint,
  resumes              bigint,
  validation_failures  bigint,
  median_active_ms     bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with scoped as (
    select * from public.assessment_analytics_events
     where vertical_id = p_vertical_id
       and (occurred_at at time zone 'utc')::date between p_from and p_to
  ),
  per_step as (
    select e.assessment_stage as stage,
           e.step_id,
           count(distinct e.assessment_session_id)
             filter (where e.event_name = 'assessment.step_viewed')      as entered_sessions,
           count(distinct e.assessment_session_id)
             filter (where e.event_name = 'assessment.step_completed')   as completed_sessions,
           count(*) filter (where e.event_name = 'assessment.validation_failed') as validation_failures,
           count(*) filter (where e.event_name = 'assessment.resumed')   as resumes,
           percentile_cont(0.5) within group (order by e.step_elapsed_ms)
             filter (where e.event_name = 'assessment.step_completed'
                       and e.step_elapsed_ms is not null)::bigint        as median_active_ms
      from scoped e
     where e.step_id is not null
     group by 1, 2
  ),
  -- A session is "visible" at a step if it reached at least that far, which is
  -- what separates "branched away" from "gave up here".
  visibility as (
    select e.assessment_stage as stage, e.step_id,
           count(distinct e.assessment_session_id) as visible_sessions
      from scoped e
     where e.event_name in ('assessment.step_viewed', 'assessment.step_completed')
     group by 1, 2
  )
  select p.stage,
         p.step_id,
         coalesce(v.visible_sessions, 0),
         p.entered_sessions,
         p.completed_sessions,
         greatest(p.entered_sessions - p.completed_sessions, 0) as exits,
         p.resumes,
         p.validation_failures,
         p.median_active_ms
    from per_step p
    left join visibility v on v.stage is not distinct from p.stage and v.step_id = p.step_id
   order by p.stage nulls first, nullif(regexp_replace(p.step_id, '\D', '', 'g'), '')::integer;
$$;

revoke all on function public.assessment_step_dropoff(text, date, date)
  from public, anon, authenticated;

comment on function public.assessment_step_dropoff is
  'Per-step drop-off counters, bucketed and defaulted on the UTC calendar. Rates and the minimum-sample rule live in shared/analytics/funnel.js, so there is exactly one definition of each.';

-- ------------------------------------------------------------
-- 10b. Server RPC permissions, stated rather than assumed
-- ------------------------------------------------------------
-- Every migration so far REVOKED execute from public, anon and authenticated
-- and then relied on `service_role` happening to have it. On a Supabase
-- project it does, through default privileges granted to that role in the
-- public schema. That is a property of how the project was created, not
-- something this schema states, and a project created differently — or one
-- whose default privileges are later tightened — would leave the Vercel
-- Function unable to call its own ingestion function.
--
-- So the grants are explicit. Two rules hold together:
--
--   · REVOKE from PUBLIC first, then GRANT to service_role. Order matters:
--     PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and
--     revoking after granting would take it back from nobody useful.
--   · anon and authenticated are never granted anything, ever. They are
--     revoked again below even though they were never granted, because a
--     future `grant ... to public` anywhere would otherwise reach them.
--
-- Signatures are written out in full. PostgREST resolves a function by its
-- argument names and types, so a grant on the wrong overload grants nothing
-- the endpoint can use.

do $$
declare
  v_signature text;
  -- Every function the SERVER calls. Trigger functions are deliberately
  -- absent: they run as part of a statement the server already had the right
  -- to make, and granting execute on them would let a caller invoke them
  -- outside a trigger context.
  c_server_rpcs constant text[] := array[
    -- ingestion
    'public.ingest_review(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb, text, uuid)',
    'public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb)',
    -- analytics
    'public.ingest_analytics_events(jsonb, jsonb, integer)',
    'public.refresh_assessment_funnel_daily(date, date)',
    'public.assessment_step_dropoff(text, date, date)',
    -- abuse controls
    'public.check_rate_limit(jsonb, integer, integer)',
    -- maintenance
    'public.purge_expired_idempotency_records(timestamptz, integer)',
    'public.purge_expired_rate_limit_buckets(timestamptz)',
    'public.purge_expired_analytics_events(timestamptz, integer)',
    'public.purge_expired_analytics_sessions(timestamptz, integer)',
    -- erasure, run by a maintenance operator through the same role
    'public.redact_business_pii(uuid, text, text, text)'
  ];
begin
  foreach v_signature in array c_server_rpcs
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end $$;

-- The helper 0006 adds is called only from inside ingest_analytics_events,
-- which is SECURITY DEFINER, so nothing outside needs to execute it.
revoke all on function public.analytics_review_type(text, text) from public, anon, authenticated;

-- Belt and braces on the tables themselves. service_role bypasses RLS, so it
-- needs no policy; anon and authenticated get nothing, and RLS is forced so
-- that even a future accidental grant would return no rows.
--
-- Schema USAGE is deliberately NOT revoked from anon and authenticated.
-- PostgREST connects as `authenticator` and switches into those roles, and
-- taking usage away changes how it reports every request. The table and
-- function grants are what actually protect the data, and they are the ones
-- stated here.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon, authenticated;

-- ------------------------------------------------------------
-- 11. Rerun safety
-- ------------------------------------------------------------
-- Every statement above is one of:
--   add column if not exists / create table if not exists
--   drop constraint if exists followed by add constraint
--   create index if not exists
--   create or replace function
--   drop trigger if exists followed by create trigger
--   insert ... on conflict do nothing
-- Running this file twice against the same database changes nothing the
-- second time. The one destructive-looking statement — dropping the
-- assessment_funnel_daily primary key — is immediately followed by its
-- replacement in the same transaction, and the added column is part of the
-- new key with a backfilled value, so no existing row changes identity.
