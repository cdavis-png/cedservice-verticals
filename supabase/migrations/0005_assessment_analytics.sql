-- ============================================================
-- CED Intelligence Platform — assessment analytics
--
-- Applied AFTER 0001-0004. Three tables, one ingest function,
-- one aggregation function, two purge functions.
--
-- ------------------------------------------------------------
-- THIS IS A SEPARATE STORE, ON PURPOSE
--
-- Analytics rows sit beside the Business Record and never touch
-- it. There is no foreign key from an analytics table to
-- business_records, assessment_submissions, or
-- business_intelligence_reports — deliberately:
--
--   · A funnel must never be able to cascade a delete, or block
--     one, on a record that holds a real person's data.
--   · Redaction of a Business Record must not require walking
--     an analytics table, and analytics retention must not be
--     hostage to the record's much longer life.
--   · business_id and submission_id are carried as plain UUIDs
--     for joining in reporting. They are references in the
--     analytic sense and constraints in no sense at all.
--
-- NOTHING HERE MAY BE READ BACK INTO THE ASSESSMENT. No trigger,
-- no function, and no view in this migration writes to any table
-- created by 0001-0004.
--
-- ------------------------------------------------------------
-- NO PII COLUMNS
--
-- There is no name, email, phone, address, free text, URL, or
-- user agent column anywhere below, and there is no column that
-- could hold one by accident: the jsonb columns are scrubbed by
-- shared/analytics/events.js on the way in, twice, and the
-- endpoint refuses a batch whose envelope is shaped like a
-- contact record.
--
-- attribution holds a path, a referrer HOST, and UTM values.
-- device holds a coarse class and bucketed viewport dimensions.
--
-- NOT EXECUTED. See docs/REAL_POSTGRES_VALIDATION.md §M for the
-- validation plan; run it only when explicitly asked.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Raw events — append-only
-- ------------------------------------------------------------

create table if not exists public.assessment_analytics_events (
  event_id                 uuid primary key,
  event_name               text        not null,
  event_version            integer     not null default 1,
  schema_version           integer     not null default 1,

  assessment_session_id    uuid        not null,
  submission_id            uuid,
  business_id              uuid,

  vertical_id              text        not null,
  assessment_version       text,
  question_set_version     text,
  assessment_stage         smallint,
  step_id                  text,
  question_id              text,

  occurred_at              timestamptz not null,
  received_at              timestamptz not null default now(),

  active_elapsed_ms        bigint      not null default 0,
  total_elapsed_ms         bigint      not null default 0,
  step_elapsed_ms          bigint,

  visible_question_count   integer,
  completed_question_count integer,

  attribution              jsonb       not null default '{}'::jsonb,
  device                   jsonb       not null default '{}'::jsonb,
  metadata                 jsonb       not null default '{}'::jsonb,

  -- Raw events expire. Aggregates do not; see section 3.
  expires_at               timestamptz not null,

  constraint analytics_events_stage_check
    check (assessment_stage is null or assessment_stage in (1, 2)),
  constraint analytics_events_schema_version_check
    check (schema_version between 1 and 1),
  -- The same clamp the timeline uses, for the same reason: a device clock
  -- running fast must not produce a row that claims to precede its own arrival.
  constraint analytics_events_recorded_after_occurred
    check (received_at >= occurred_at),
  constraint analytics_events_timing_sane
    check (active_elapsed_ms >= 0 and total_elapsed_ms >= 0
           and (step_elapsed_ms is null or step_elapsed_ms >= 0)
           -- Active time is time spent present; it can never exceed wall time.
           and active_elapsed_ms <= total_elapsed_ms),
  constraint analytics_events_expiry_future
    check (expires_at > received_at)
);

comment on table public.assessment_analytics_events is
  'Append-only product analytics for the assessment funnel. Contains no personal data and is never read back into the Business Record, the BIR, pricing, or close readiness.';
comment on column public.assessment_analytics_events.business_id is
  'Plain UUID for reporting joins. Deliberately NOT a foreign key: analytics must never block or cascade a Business Record deletion.';
comment on column public.assessment_analytics_events.attribution is
  'Path, referrer host, and UTM values only. Never a full URL — a query string can carry a token or an address.';

create index if not exists analytics_events_session_idx
  on public.assessment_analytics_events (assessment_session_id, occurred_at);
create index if not exists analytics_events_funnel_idx
  on public.assessment_analytics_events (vertical_id, event_name, occurred_at);
create index if not exists analytics_events_step_idx
  on public.assessment_analytics_events (vertical_id, assessment_stage, step_id, event_name);
create index if not exists analytics_events_expiry_idx
  on public.assessment_analytics_events (expires_at);
create index if not exists analytics_events_business_idx
  on public.assessment_analytics_events (business_id)
  where business_id is not null;
-- Campaign reporting reads utm_source out of the jsonb on every funnel query.
create index if not exists analytics_events_source_idx
  on public.assessment_analytics_events
  ((attribution -> 'firstTouch' -> 'utm' ->> 'utm_source'), occurred_at);

-- Append-only, enforced the same way as timeline_events. An analytics row that
-- can be edited is an analytics row that can be made to say anything.
drop trigger if exists analytics_events_no_update on public.assessment_analytics_events;
create trigger analytics_events_no_update
  before update on public.assessment_analytics_events
  for each row execute function public.reject_mutation();

-- ------------------------------------------------------------
-- 2. Session roll-up — the one mutable analytics surface
-- ------------------------------------------------------------
-- One row per assessment session, maintained by the ingest function. Mutable
-- because it is a SUMMARY: it answers "how far did this session get?" and the
-- answer changes as the session continues. Every update moves forward only
-- (see the GREATEST/LEAST logic in section 4), so an out-of-order or late
-- event can never make a session look less complete than it already was.

create table if not exists public.assessment_analytics_sessions (
  assessment_session_id  uuid primary key,
  business_id            uuid,
  vertical_id            text        not null,
  assessment_version     text,
  question_set_version   text,

  started_at             timestamptz not null,
  last_event_at          timestamptz not null,
  stage1_completed_at    timestamptz,
  stage2_started_at      timestamptz,
  stage2_completed_at    timestamptz,

  latest_step_id         text,
  max_step_reached       integer,
  max_stage_reached      smallint,
  result_state           text        not null default 'in_progress',

  abandoned_at           timestamptz,
  resumed_count          integer     not null default 0,
  validation_failures    integer     not null default 0,
  question_interactions  integer     not null default 0,
  event_count            integer     not null default 0,

  total_active_ms        bigint      not null default 0,
  total_elapsed_ms       bigint      not null default 0,

  first_touch            jsonb       not null default '{}'::jsonb,
  latest_touch           jsonb       not null default '{}'::jsonb,
  device                 jsonb       not null default '{}'::jsonb,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  expires_at             timestamptz not null,

  constraint analytics_sessions_result_state_check
    check (result_state in ('in_progress', 'preliminary_results', 'fit_review_available',
                            'fit_review_complete', 'activation_ready', 'abandoned')),
  constraint analytics_sessions_stage_check
    check (max_stage_reached is null or max_stage_reached in (1, 2)),
  constraint analytics_sessions_counts_sane
    check (resumed_count >= 0 and event_count >= 0
           and total_active_ms >= 0 and total_elapsed_ms >= 0
           and total_active_ms <= total_elapsed_ms)
);

comment on table public.assessment_analytics_sessions is
  'Per-session funnel summary. Mutable by design; every update moves forward only, so a late or out-of-order event cannot regress a session.';

create index if not exists analytics_sessions_vertical_idx
  on public.assessment_analytics_sessions (vertical_id, started_at);
create index if not exists analytics_sessions_state_idx
  on public.assessment_analytics_sessions (result_state, started_at);
create index if not exists analytics_sessions_expiry_idx
  on public.assessment_analytics_sessions (expires_at);
create index if not exists analytics_sessions_business_idx
  on public.assessment_analytics_sessions (business_id)
  where business_id is not null;

drop trigger if exists analytics_sessions_touch on public.assessment_analytics_sessions;
create trigger analytics_sessions_touch
  before update on public.assessment_analytics_sessions
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 3. Daily funnel aggregate — retained longer than raw events
-- ------------------------------------------------------------
-- Counters only. Every RATE is computed by shared/analytics/funnel.js, so
-- there is one definition of "Stage 2 start rate" rather than one here and a
-- different one in a report. Postgres counts; JavaScript divides.

create table if not exists public.assessment_funnel_daily (
  aggregate_date              date    not null,
  vertical_id                 text    not null,
  assessment_version          text    not null default 'unknown',
  question_set_version        text    not null default 'unknown',
  source                      text    not null default '(none)',
  device_class                text    not null default 'unknown',

  page_views                  integer not null default 0,
  starts                      integer not null default 0,
  resumes                     integer not null default 0,
  stage1_completions          integer not null default 0,
  preliminary_result_views    integer not null default 0,
  stage2_starts               integer not null default 0,
  stage2_completions          integer not null default 0,
  full_result_views           integer not null default 0,
  personal_review_clicks      integer not null default 0,
  recommended_system_clicks   integer not null default 0,
  improve_recommendation_clicks integer not null default 0,
  checkout_intents            integer not null default 0,
  report_requests             integer not null default 0,
  validation_failures         integer not null default 0,
  question_interactions       integer not null default 0,
  -- The denominator for questionInteractionRate: for each session, how many
  -- questions its path actually put on screen, summed across the group. NOT a
  -- sum of visible_question_count over events, which would count every
  -- question once per step view. Real-Postgres validation found this counter
  -- missing entirely, which left the rate permanently null.
  visible_question_total      integer not null default 0,
  abandonment_count           integer not null default 0,

  median_stage1_active_ms     bigint,
  median_stage2_active_ms     bigint,

  computed_at                 timestamptz not null default now(),

  -- One row per day, per vertical, per version pair, per segment. The segment
  -- columns are in the key because a funnel that cannot be cut by campaign or
  -- device answers half the questions anyone asks of it.
  primary key (aggregate_date, vertical_id, assessment_version,
               question_set_version, source, device_class)
);

comment on table public.assessment_funnel_daily is
  'Daily funnel counters. Retained after the raw events they were computed from expire — the aggregate is the long-lived record and cannot be recomputed once the events are gone.';

create index if not exists funnel_daily_date_idx
  on public.assessment_funnel_daily (aggregate_date, vertical_id);

-- ------------------------------------------------------------
-- 4. Ingestion — one call, one transaction
-- ------------------------------------------------------------
-- Inserts the batch and rolls the session summary forward atomically. A
-- duplicate event is a no-op rather than an error: the browser retries, and a
-- retry that already landed is a success from every point of view that matters.

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
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    raise exception 'analytics_empty_batch' using errcode = '22023';
  end if;

  -- One session per batch. Asserted here as well as at the endpoint, because
  -- the roll-up below is written for exactly one session and a mixed batch
  -- would silently attribute events to the wrong one.
  select distinct (e ->> 'assessmentSessionId')::uuid into v_session
    from jsonb_array_elements(p_events) e
   limit 2;

  if (select count(distinct e ->> 'assessmentSessionId') from jsonb_array_elements(p_events) e) <> 1 then
    raise exception 'analytics_mixed_sessions' using errcode = '22023';
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_id := (v_event ->> 'eventId')::uuid;

    insert into public.assessment_analytics_events (
      event_id, event_name, event_version, schema_version,
      assessment_session_id, submission_id, business_id,
      vertical_id, assessment_version, question_set_version,
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
      nullif(v_event ->> 'assessmentStage', '')::smallint,
      nullif(v_event ->> 'stepId', ''),
      nullif(v_event ->> 'questionId', ''),
      -- Clamped again here. The endpoint clamps too; this is the constraint's
      -- own guarantee rather than trust in the caller.
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

  -- --------------------------------------------------------
  -- Session roll-up, computed from what is now STORED rather
  -- than from the batch. Recomputing from the table is what
  -- makes a late or out-of-order event correct itself instead
  -- of double-counting.
  -- --------------------------------------------------------
  insert into public.assessment_analytics_sessions as s (
    assessment_session_id, business_id, vertical_id, assessment_version,
    question_set_version, started_at, last_event_at,
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
    min(e.occurred_at),
    max(e.occurred_at),
    min(e.occurred_at) filter (where e.event_name = 'assessment.stage1_completed'),
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
      when count(*) filter (where e.event_name = 'assessment.stage1_completed') > 0
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
    -- Forward only. A late event describing an earlier moment must not rewind
    -- a session that has since progressed.
    started_at            = least(s.started_at, excluded.started_at),
    last_event_at         = greatest(s.last_event_at, excluded.last_event_at),
    stage1_completed_at   = coalesce(s.stage1_completed_at, excluded.stage1_completed_at),
    stage2_started_at     = coalesce(s.stage2_started_at, excluded.stage2_started_at),
    stage2_completed_at   = coalesce(s.stage2_completed_at, excluded.stage2_completed_at),
    latest_step_id        = coalesce(excluded.latest_step_id, s.latest_step_id),
    -- greatest() SKIPS nulls in Postgres, which is exactly the semantics
    -- wanted here: greatest(null, null) is null, greatest(null, 2) is 2.
    --
    -- The obvious-looking greatest(coalesce(x,0), coalesce(y,0)) is a defect,
    -- found against real Postgres on 2026-08-05: a session whose events carry
    -- no stage — a lone page_viewed, for instance — has null on both sides, and
    -- the coalesce turned that into 0, which violates
    -- analytics_sessions_stage_check and aborted the whole batch on the SECOND
    -- ingest for that session. "Not reached yet" is null, never zero.
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

  -- A session that produced an abandonment event and later continued is NOT
  -- abandoned. The retraction happens here rather than in the client, which
  -- cannot know the future at the moment it guesses.
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

comment on function public.ingest_analytics_events is
  'Atomic analytics ingestion: inserts a batch idempotently and recomputes the session roll-up from stored rows. Server-role only. Writes to no table outside the analytics schema.';

-- ------------------------------------------------------------
-- 5. Daily aggregation
-- ------------------------------------------------------------
-- Counts sessions, not events, for every funnel stage: "1,000 page views"
-- must mean a thousand visits and not one visitor reloading. Click counters
-- count events, because clicking twice is two clicks.

create or replace function public.refresh_assessment_funnel_daily(
  p_from date default (current_date - 7),
  p_to   date default current_date
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
    aggregate_date, vertical_id, assessment_version, question_set_version,
    source, device_class,
    page_views, starts, resumes, stage1_completions, preliminary_result_views,
    stage2_starts, stage2_completions, full_result_views,
    personal_review_clicks, recommended_system_clicks, improve_recommendation_clicks,
    checkout_intents, report_requests, validation_failures, question_interactions,
    abandonment_count, median_stage1_active_ms, median_stage2_active_ms, computed_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.vertical_id,
    coalesce(e.assessment_version, 'unknown'),
    coalesce(e.question_set_version, 'unknown'),
    coalesce(nullif(e.attribution -> 'firstTouch' -> 'utm' ->> 'utm_source', ''), '(none)'),
    coalesce(nullif(e.device ->> 'deviceClass', ''), 'unknown'),

    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.page_viewed'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.started'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.resumed'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.stage1_completed'),
    count(distinct e.assessment_session_id) filter (where e.event_name = 'assessment.preliminary_results_viewed'),
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

    percentile_cont(0.5) within group (
      order by e.active_elapsed_ms) filter (where e.event_name = 'assessment.stage1_completed')::bigint,
    percentile_cont(0.5) within group (
      order by e.active_elapsed_ms) filter (where e.event_name = 'assessment.stage2_completed')::bigint,
    now()
  from public.assessment_analytics_events e
  where (e.occurred_at at time zone 'utc')::date between p_from and p_to
  group by 1, 2, 3, 4, 5, 6
  on conflict (aggregate_date, vertical_id, assessment_version,
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
      select aggregate_date, vertical_id, assessment_version, question_set_version,
             source, device_class, sum(per_session_max) as total
        from (
          select (e.occurred_at at time zone 'utc')::date        as aggregate_date,
                 e.vertical_id,
                 coalesce(e.assessment_version, 'unknown')       as assessment_version,
                 coalesce(e.question_set_version, 'unknown')     as question_set_version,
                 coalesce(nullif(e.attribution -> 'firstTouch' -> 'utm' ->> 'utm_source', ''), '(none)') as source,
                 coalesce(nullif(e.device ->> 'deviceClass', ''), 'unknown') as device_class,
                 e.assessment_session_id,
                 max(e.visible_question_count)                   as per_session_max
            from public.assessment_analytics_events e
           where (e.occurred_at at time zone 'utc')::date between p_from and p_to
             and e.visible_question_count is not null
           group by 1, 2, 3, 4, 5, 6, 7
        ) s
       group by 1, 2, 3, 4, 5, 6
    ) v
   where f.aggregate_date       = v.aggregate_date
     and f.vertical_id          = v.vertical_id
     and f.assessment_version   = v.assessment_version
     and f.question_set_version = v.question_set_version
     and f.source               = v.source
     and f.device_class         = v.device_class;

  return v_rows;
end;
$$;

revoke all on function public.refresh_assessment_funnel_daily(date, date)
  from public, anon, authenticated;

comment on function public.refresh_assessment_funnel_daily is
  'Recomputes daily funnel counters from raw events. Idempotent for a date range: re-running replaces rather than accumulates. Must be run BEFORE purge_expired_analytics_events for any day whose events are about to expire.';

-- ------------------------------------------------------------
-- 6. Drop-off, per step
-- ------------------------------------------------------------
-- Counters only, again. shared/analytics/funnel.js turns these into rates and
-- applies the minimum-sample rule.

create or replace function public.assessment_step_dropoff(
  p_vertical_id text,
  p_from        date default (current_date - 30),
  p_to          date default current_date
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
  'Per-step drop-off counters. Rates and the minimum-sample rule live in shared/analytics/funnel.js, so there is exactly one definition of each.';

-- ------------------------------------------------------------
-- 7. Retention
-- ------------------------------------------------------------
-- Raw events expire; aggregates do not. Deleting raw analytics rows is
-- permitted precisely because they hold no personal data and no evidence —
-- unlike timeline_events, which can never be deleted at all.

create or replace function public.purge_expired_analytics_events(
  p_now   timestamptz default now(),
  p_limit integer     default 50000
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with doomed as (
    select event_id from public.assessment_analytics_events
     where expires_at < p_now
     order by expires_at
     limit greatest(p_limit, 1)
     for update skip locked
  )
  delete from public.assessment_analytics_events e
   using doomed d
   where e.event_id = d.event_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_analytics_events(timestamptz, integer)
  from public, anon, authenticated;

comment on function public.purge_expired_analytics_events is
  'Deletes expired RAW analytics events. Run refresh_assessment_funnel_daily first: once an event is gone its day can never be recomputed.';

create or replace function public.purge_expired_analytics_sessions(
  p_now   timestamptz default now(),
  p_limit integer     default 10000
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with doomed as (
    select assessment_session_id from public.assessment_analytics_sessions
     where expires_at < p_now
     order by expires_at
     limit greatest(p_limit, 1)
     for update skip locked
  )
  delete from public.assessment_analytics_sessions s
   using doomed d
   where s.assessment_session_id = d.assessment_session_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_analytics_sessions(timestamptz, integer)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 8. Row Level Security
-- ------------------------------------------------------------
-- Enabled AND forced, with zero policies, exactly as every other table in this
-- schema. Only the service role reaches any of it, and that key lives only in
-- the Vercel Function environment.

alter table public.assessment_analytics_events   enable row level security;
alter table public.assessment_analytics_events   force  row level security;
alter table public.assessment_analytics_sessions enable row level security;
alter table public.assessment_analytics_sessions force  row level security;
alter table public.assessment_funnel_daily       enable row level security;
alter table public.assessment_funnel_daily       force  row level security;

revoke all on public.assessment_analytics_events   from anon, authenticated;
revoke all on public.assessment_analytics_sessions from anon, authenticated;
revoke all on public.assessment_funnel_daily       from anon, authenticated;
