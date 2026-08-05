-- ============================================================
-- CED Intelligence Platform — Assessment Intelligence Expansion
-- and the two-stage progressive assessment
--
-- Applied AFTER 0001, 0002, 0003.
--
--   1. BIR schema versions 3 and 4 become valid. Version 2 stays
--      valid, because reports already written are still correct
--      reports and nothing rewrites history here.
--   2. Payload schema versions 4 and 5 are accepted, keeping 2
--      and 3 inside the documented migration window.
--   3. Reporting indexes for the readiness band and for the
--      assessment stage, both of which live inside jsonb.
--   4. Stage-aware timeline events, appended by triggers.
--
-- WHY TRIGGERS AND NOT A NEW ingest_assessment
--
-- The five stage events are facts ABOUT a row that ingestion
-- already writes, in the same transaction, from data already on
-- that row. Redefining the 490-line function to add five inserts
-- would duplicate the whole of it in this file, and a
-- transcription error in the parts that did not change is a far
-- likelier failure than anything the change itself introduces.
--
-- The existing assessment.completed and bir.generated events are
-- NOT renamed. They are a published contract with consumers and
-- with the response body, and renaming an append-only event
-- retroactively is not something an append-only store can do.
-- The stage events are additional facts, not replacements.
--
-- NOT EXECUTED against a real Postgres yet. 0001-0003 were
-- validated against Supabase 17.6; this one has not been.
-- See docs/REAL_POSTGRES_VALIDATION.md for the procedure.
-- ============================================================

-- ------------------------------------------------------------
-- 1. BIR schema version
-- ------------------------------------------------------------
-- 0001 pinned this to exactly 2, which was correct while only one
-- version existed and wrong the moment a second did. A range keeps
-- old reports readable instead of stranding them.

alter table public.business_intelligence_reports
  drop constraint if exists bir_schema_version_check;

alter table public.business_intelligence_reports
  add constraint bir_schema_version_check
  check (schema_version between 2 and 4);

comment on column public.business_intelligence_reports.schema_version is
  'BIR structural version. 2 = Milestone 1. 3 = Assessment Intelligence Expansion. 4 = two-stage progressive assessment (assessmentProgress, result states, stage-scoped close readiness). Widen deliberately; never narrow while reports of that version exist.';

-- ------------------------------------------------------------
-- 2. Payload schema version
-- ------------------------------------------------------------
-- 4 added `intelligence` and `branching`. 5 adds `assessmentStage`
-- and the visible opportunity range. 2 and 3 remain accepted so a
-- page cached before this deploy is not punished for it — see
-- docs/PRODUCTION_HARDENING.md §10.

alter table public.assessment_submissions
  drop constraint if exists assessment_submissions_payload_version_check;

alter table public.assessment_submissions
  add constraint assessment_submissions_payload_version_check
  check (payload_schema_version is null or payload_schema_version between 2 and 5);

comment on column public.assessment_submissions.payload_schema_version is
  'Accepted payload schema range, currently 2-5. A version may only be retired once no queued submission of that version can still be inside CED_SUBMISSION_MAX_AGE_DAYS.';

-- ------------------------------------------------------------
-- 3. Reporting indexes
-- ------------------------------------------------------------
-- The identity-review queue and any future close-readiness view both
-- filter on the readiness band, which lives inside the report jsonb.

create index if not exists bir_readiness_band_idx
  on public.business_intelligence_reports
  ((report -> 'closeReadinessProfile' ->> 'band'))
  where business_id is not null;

comment on index public.bir_readiness_band_idx is
  'Supports filtering reports by close-readiness band without scanning the jsonb.';

-- "How many people stop after the Growth Review" is the question this
-- whole milestone exists to answer, so it must be answerable without a
-- sequential scan over every stored payload.
create index if not exists submissions_assessment_stage_idx
  on public.assessment_submissions
  ((raw_payload -> 'assessmentStage' ->> 'stage'), received_at);

comment on index public.submissions_assessment_stage_idx is
  'Supports stage-completion and drop-off reporting across the two-stage review.';

-- A preliminary report and the full report that supersedes it are both
-- current-looking rows until you read the state, so the state is indexed.
create index if not exists bir_result_state_idx
  on public.business_intelligence_reports
  ((report -> 'assessmentProgress' ->> 'resultState'))
  where business_id is not null;

comment on index public.bir_result_state_idx is
  'Supports separating preliminary reports from full ones without scanning the jsonb.';

-- ------------------------------------------------------------
-- 4. Stage-aware timeline events
-- ------------------------------------------------------------
-- Append-only, one row per fact, inside the ingestion transaction.
--
-- occurred_at is clamped to now() in every case. A device clock running
-- fast must never abort ingestion against
-- timeline_events.recorded_at >= occurred_at — the same rule ingestion
-- itself follows, for the same reason.
--
-- A payload with no assessmentStage block predates progressive profiling
-- and carried the whole question set in one pass. It emits nothing here:
-- inventing a "stage 2" event for a review that had no stages would put a
-- false fact into a store that cannot correct one.

create or replace function public.append_stage_timeline_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_stage        integer;
  v_started_at   timestamptz;
  v_occurred_at  timestamptz := least(new.submitted_at, now());
begin
  v_stage := nullif(new.raw_payload -> 'assessmentStage' ->> 'stage', '')::integer;
  if v_stage is null then
    return null;
  end if;

  if v_stage = 1 then
    insert into public.timeline_events (
      business_id, event_name, event_version, occurred_at, producer,
      source_record_id, idempotency_key, summary, payload, correlation_id
    ) values (
      new.business_id, 'stage1.completed', 1, v_occurred_at, 'assessment-engine',
      new.submission_id::text, new.submission_id::text,
      'Growth Review completed. Preliminary results delivered.',
      jsonb_build_object(
        'submissionId', new.submission_id,
        'assessmentSessionId', new.assessment_session_id,
        'verticalId', new.vertical_id,
        'assessmentVersion', new.assessment_version,
        'trigger', new.raw_payload -> 'assessmentStage' ->> 'trigger'),
      new.submission_id::text
    );

  elsif v_stage = 2 then
    -- The fit review began on the visitor's device, before this submission
    -- existed. Its own timestamp is used, clamped, so the gap between
    -- starting and finishing is recoverable from the timeline.
    v_started_at := least(
      coalesce(
        nullif(new.raw_payload -> 'assessmentStage' ->> 'stage2StartedAt', '')::timestamptz,
        v_occurred_at),
      v_occurred_at);

    insert into public.timeline_events (
      business_id, event_name, event_version, occurred_at, producer,
      source_record_id, idempotency_key, summary, payload, correlation_id
    ) values (
      new.business_id, 'stage2.started', 1, v_started_at, 'assessment-engine',
      new.submission_id::text, new.submission_id::text,
      'Fit and Activation Review opened by the visitor.',
      jsonb_build_object(
        'submissionId', new.submission_id,
        'assessmentSessionId', new.assessment_session_id,
        'trigger', new.raw_payload -> 'assessmentStage' ->> 'trigger',
        'continuesSubmissionId',
          new.raw_payload -> 'assessmentStage' ->> 'supersedesSubmissionId'),
      new.submission_id::text
    );

    insert into public.timeline_events (
      business_id, event_name, event_version, occurred_at, producer,
      source_record_id, idempotency_key, summary, payload, correlation_id
    ) values (
      new.business_id, 'stage2.completed', 1, v_occurred_at, 'assessment-engine',
      new.submission_id::text, new.submission_id::text,
      'Fit and Activation Review completed.',
      jsonb_build_object(
        'submissionId', new.submission_id,
        'assessmentSessionId', new.assessment_session_id,
        'verticalId', new.vertical_id,
        'assessmentVersion', new.assessment_version,
        'continuesSubmissionId',
          new.raw_payload -> 'assessmentStage' ->> 'supersedesSubmissionId'),
      new.submission_id::text
    );
  end if;

  return null;
end;
$$;

drop trigger if exists assessment_submissions_stage_events on public.assessment_submissions;

create trigger assessment_submissions_stage_events
  after insert on public.assessment_submissions
  for each row execute function public.append_stage_timeline_events();

revoke all on function public.append_stage_timeline_events() from public, anon, authenticated;

comment on function public.append_stage_timeline_events is
  'Appends stage1.completed, or stage2.started plus stage2.completed, for a staged submission. Emits nothing for a payload that declares no stage.';

-- A preliminary report and a full report are different claims and are
-- named differently on the timeline. Neither replaces the other: the
-- supersession chain in business_intelligence_reports.supersedes_bir_id
-- keeps both readable.

-- occurred_at is taken from the SUBMISSION, clamped, and not from
-- generated_at. bir.generated — written by ingest_assessment for the same row,
-- in the same transaction — uses least(submitted_at, now()); anchoring this
-- event on generated_at instead made the two disagree. Real-Postgres
-- validation on 2026-08-05 measured 104 seconds of drift between them, and
-- the browser retry queue holds submissions for up to 30 days, so the gap is
-- bounded only by that window. Two events describing one insert must carry
-- one timestamp.
create or replace function public.append_bir_stage_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_stage       integer;
  v_name        text;
  v_occurred_at timestamptz;
begin
  -- assessmentStageCompleted is always present; stageDeclared says whether the
  -- SUBMISSION actually named a stage. A report from a review that had no
  -- stages emits only bir.generated: naming it "generated from the completed
  -- Fit and Activation Review" would assert a review that never happened, and
  -- this store cannot take that back.
  if coalesce((new.report -> 'assessmentProgress' ->> 'stageDeclared')::boolean, false) is not true then
    return null;
  end if;

  v_stage := nullif(new.report -> 'assessmentProgress' ->> 'assessmentStageCompleted', '')::integer;
  if v_stage is null then
    return null;
  end if;

  v_name := case when v_stage = 1 then 'preliminary_bir.generated'
                 else 'full_bir.generated' end;

  -- Primary-key lookup on the row this report was generated from. The
  -- coalesce covers a BIR written without a submission, which the schema does
  -- not currently allow but which must not silently produce a null timestamp.
  select least(s.submitted_at, now()) into v_occurred_at
    from public.assessment_submissions s
   where s.submission_id = new.assessment_submission_id;
  v_occurred_at := coalesce(v_occurred_at, least(new.generated_at, now()));

  insert into public.timeline_events (
    business_id, event_name, event_version, occurred_at, producer,
    source_record_id, idempotency_key, summary, payload, correlation_id
  ) values (
    new.business_id, v_name, 1, v_occurred_at,
    'business-intelligence-engine',
    new.bir_id::text, new.bir_id::text,
    case when v_stage = 1
         then 'Preliminary Business Intelligence Report generated from the Growth Review.'
         else 'Full Business Intelligence Report generated from the completed Fit and Activation Review.' end,
    jsonb_build_object(
      'birId', new.bir_id,
      'supersedesBirId', new.supersedes_bir_id,
      'assessmentStageCompleted', v_stage,
      'resultState', new.report -> 'assessmentProgress' ->> 'resultState',
      'confidenceKind', new.report -> 'assessmentProgress' ->> 'confidenceKind',
      'closeReadinessProvisional',
        coalesce((new.report -> 'assessmentProgress' ->> 'closeReadinessProvisional')::boolean, false),
      'closeReadinessBand', new.report -> 'closeReadinessProfile' ->> 'band'),
    new.assessment_submission_id::text
  );

  return null;
end;
$$;

drop trigger if exists bir_stage_event on public.business_intelligence_reports;

create trigger bir_stage_event
  after insert on public.business_intelligence_reports
  for each row execute function public.append_bir_stage_event();

revoke all on function public.append_bir_stage_event() from public, anon, authenticated;

comment on function public.append_bir_stage_event is
  'Appends preliminary_bir.generated or full_bir.generated. Emits nothing for a report that declares no stage.';
