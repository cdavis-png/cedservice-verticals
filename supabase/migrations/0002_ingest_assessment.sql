-- ============================================================
-- CED Intelligence Platform — atomic ingestion
--
-- One RPC call = one Postgres transaction. Either every artifact
-- exists (idempotency claim, submission, business or resolution
-- case, BIR, timeline, audit, stored response) or none does.
-- There is no code path that creates a Business Record without
-- an assessment and a timeline event.
--
-- Identity STRENGTH is data, not logic: it comes from the
-- identifier_type of the matched row, which is the same
-- classification shared/business-record/resolve-identity.js
-- uses. The two cannot disagree about what counts as strong.
-- ============================================================

create or replace function public.ingest_assessment(
  p_idempotency_key text,
  p_request_hash    text,
  p_payload         jsonb,
  p_signals         jsonb,
  p_bir             jsonb,
  p_bir_id          uuid,
  p_retention_days  integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now             timestamptz := now();
  v_submission_id   uuid := (p_payload ->> 'submissionId')::uuid;
  v_session_id      uuid := (p_payload ->> 'assessmentSessionId')::uuid;
  v_vertical_id     text := coalesce(p_payload -> 'vertical' ->> 'id', 'unknown');
  v_display_name    text := coalesce(nullif(p_payload -> 'contact' ->> 'salonName', ''), 'Unnamed business');
  v_submitted_at    timestamptz := coalesce((p_payload ->> 'submittedAt')::timestamptz, v_now);
  v_payload_hash    text := md5(p_payload::text);

  v_existing        public.idempotency_records%rowtype;
  v_claimed         boolean := false;

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
  v_strong_ids      uuid[];
  v_all_ids         uuid[];
  v_contributing    jsonb := '[]'::jsonb;
  v_conflicting     jsonb := '[]'::jsonb;

  v_bir_business    uuid;
  v_report          jsonb;
  v_event_ids       uuid[] := array[]::uuid[];
  v_event_id        uuid;
  v_response        jsonb;
  v_next_action     text;
  v_signal          jsonb;

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

  get diagnostics v_claimed = row_count;

  if v_claimed = false or v_claimed is null then
    select * into v_existing
      from public.idempotency_records
     where idempotency_key = p_idempotency_key
       for update;

    if v_existing.request_hash is distinct from p_request_hash then
      raise exception 'idempotency_key_conflict' using errcode = '23505';
    end if;

    if v_existing.response_body is not null then
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
    -- Candidate lookup: exact match on normalized values, excluding context-only
    -- signal types and records that have been merged away.
    with matches as (
      select bi.business_id,
             array_agg(distinct bi.identifier_type) as matched_types
        from public.business_identifiers bi
        join public.business_records br on br.business_id = bi.business_id
       where bi.valid_to is null
         and br.merged_into_business_id is null
         and exists (
               select 1
                 from jsonb_array_elements(coalesce(p_signals, '[]'::jsonb)) s
                where s ->> 'type' = bi.identifier_type
                  and s ->> 'normalizedValue' = bi.normalized_value
                  and not (s ->> 'type' = any (c_context_types))
             )
       group by bi.business_id
    )
    select
      coalesce(jsonb_agg(jsonb_build_object('businessId', business_id, 'matchedTypes', to_jsonb(matched_types))), '[]'::jsonb),
      array_agg(business_id) filter (where matched_types && c_strong_types),
      array_agg(business_id)
      into v_candidates, v_strong_ids, v_all_ids
      from matches;

    v_strong_ids := coalesce(v_strong_ids, array[]::uuid[]);
    v_all_ids    := coalesce(v_all_ids, array[]::uuid[]);

    if array_length(v_all_ids, 1) is null then
      -- Rule B4: no credible candidate -> create.
      v_business_id        := gen_random_uuid();
      v_identity_status    := 'linked';
      v_resolution_status  := 'no_match';
      v_recommended_action := 'create_new_record';
      v_link_method        := 'auto';
      v_confidence         := 0.00;
      v_created_business   := true;

    elsif array_length(v_strong_ids, 1) = 1 then
      -- Rule B3: exactly one candidate carries a strong identifier.
      v_business_id        := v_strong_ids[1];
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
                                when array_length(v_strong_ids, 1) > 1 then 'possible_duplicate'
                                when array_length(v_all_ids, 1) = 1 then 'probable_match'
                                else 'possible_duplicate'
                              end;
      v_recommended_action := 'queue_for_review';
      v_link_method        := null;
      v_confidence         := case when array_length(v_strong_ids, 1) > 1 then 0.75 else 0.60 end;
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
    consent_snapshot, attribution_snapshot
  ) values (
    v_submission_id, v_session_id, v_business_id,
    coalesce(p_payload ->> 'assessmentVersion', 'unknown'), v_vertical_id,
    p_payload, v_identity_status, v_submitted_at, v_now, v_payload_hash,
    coalesce(p_payload -> 'consent', '{}'::jsonb),
    coalesce(p_payload -> 'attribution', '{}'::jsonb)
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
      begin
        insert into public.business_identifiers (
          business_id, identifier_type, normalized_value, raw_value, source, confidence, verified
        ) values (
          v_business_id,
          v_signal ->> 'type',
          v_signal ->> 'normalizedValue',
          v_signal ->> 'rawValue',
          'assessment',
          case when (v_signal ->> 'strength') = 'strong' then 0.95
               when (v_signal ->> 'strength') = 'moderate' then 0.70
               else 0.35 end,
          false
        );
      exception when unique_violation then
        -- Already recorded for this business, or held by another business under
        -- the strong-identifier unique index. Either way, evidence is not
        -- duplicated and no record is created or altered.
        null;
      end;
    end loop;
  end if;

  -- --------------------------------------------------------
  -- 7. BIR — businessId injected only once identity is known
  -- --------------------------------------------------------
  v_bir_business := v_business_id;
  v_report := jsonb_set(p_bir, '{identity,businessId}',
                        case when v_bir_business is null then 'null'::jsonb
                             else to_jsonb(v_bir_business::text) end);
  v_report := jsonb_set(v_report, '{identity,identityStatus}', to_jsonb(v_identity_status));

  insert into public.business_intelligence_reports (
    bir_id, business_id, assessment_submission_id, schema_version,
    generated_at, report, confidence_band, missing_critical_fields
  ) values (
    p_bir_id, v_bir_business, v_submission_id,
    (v_report ->> 'schemaVersion')::integer,
    v_now, v_report,
    coalesce(v_report -> 'estimateConfidence' ->> 'band', 'low'),
    coalesce(v_report -> 'qualificationProfile' -> 'missingCriticalFields', '[]'::jsonb)
  );

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
    values (v_business_id, 'business.created', 1, v_now, 'business-record-engine', v_business_id::text,
            'Business Record created from a completed assessment.',
            jsonb_build_object('createdFrom','assessment','verticalId',v_vertical_id), v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'identity.resolved', 1, v_now, 'business-record-engine', v_submission_id::text,
          format('Identity resolution: %s.', v_resolution_status),
          jsonb_build_object('resolutionStatus', v_resolution_status, 'resolutionConfidence', v_confidence,
                             'recommendedAction', v_recommended_action, 'candidateCount', coalesce(array_length(v_all_ids,1),0)),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  if v_business_id is not null then
    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (v_business_id, 'identity.linked', 1, v_now, 'business-record-engine', 'submission:' || v_submission_id::text,
            'Assessment submission linked to this Business Record.',
            jsonb_build_object('linkedBusinessId', v_business_id, 'linkedArtifactKind','assessment_submission',
                               'linkedArtifactId', v_submission_id, 'linkMethod', v_link_method),
            v_submission_id::text)
    returning event_id into v_event_id;
    v_event_ids := v_event_ids || v_event_id;
  end if;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, source_record_id, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'assessment.completed', 2, v_submitted_at, 'assessment-engine', v_submission_id::text, v_submission_id::text,
          'Assessment completed.',
          jsonb_build_object('assessmentSessionId', v_session_id, 'submissionId', v_submission_id,
                             'verticalId', v_vertical_id, 'assessmentVersion', p_payload ->> 'assessmentVersion'),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, source_record_id, idempotency_key, summary, payload, correlation_id)
  values (v_business_id, 'bir.generated', 1, v_now, 'business-intelligence-engine', p_bir_id::text, p_bir_id::text,
          'Business Intelligence Report generated.',
          jsonb_build_object('birId', p_bir_id, 'confidenceBand', v_report -> 'estimateConfidence' ->> 'band',
                             'closeReadinessBand', v_report -> 'closeReadinessProfile' ->> 'band'),
          v_submission_id::text)
  returning event_id into v_event_id;
  v_event_ids := v_event_ids || v_event_id;

  -- --------------------------------------------------------
  -- 9. Ambiguity -> a case for a human. Never a second record.
  -- --------------------------------------------------------
  if v_identity_status = 'resolution_pending' then
    insert into public.identity_resolution_cases (
      assessment_submission_id, candidate_business_ids, contributing_signals,
      conflicting_signals, confidence, resolution_status, recommended_action
    ) values (
      v_submission_id, v_candidates, v_contributing, v_conflicting,
      v_confidence, v_resolution_status, v_recommended_action
    ) returning identity_resolution_id into v_case_id;

    insert into public.timeline_events (business_id, event_name, event_version, occurred_at, producer, idempotency_key, summary, payload, correlation_id)
    values (null, 'identity.review_required', 1, v_now, 'business-record-engine', v_case_id::text,
            'Identity could not be resolved automatically; queued for review.',
            jsonb_build_object('identityResolutionId', v_case_id, 'resolutionStatus', v_resolution_status,
                               'reason', 'No unique strong identifier among candidates.',
                               'candidateBusinessIds', v_candidates),
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
                             'identityStatus', v_identity_status, 'resolutionStatus', v_resolution_status),
          v_submission_id::text);

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
    'identityStatus', v_identity_status,
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

revoke all on function public.ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer) from public, anon, authenticated;

comment on function public.ingest_assessment is
  'Atomic assessment ingestion. One call = one transaction. Server-role only.';
