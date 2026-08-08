-- ============================================================
-- CED Intelligence Platform — staff identity resolution (MVP)
--
-- Applied AFTER 0001, 0002, 0003, 0004, 0005, 0006.
--
-- 0001 created identity_resolution_cases and called it "the human
-- queue". Nothing has ever closed one. `resolved_at`,
-- `resolved_by` and `resolution_notes` have been written by no
-- function, no route and no test since the table was created, so
-- every submission that could not be resolved automatically has
-- stayed pending forever. This migration adds the smallest thing
-- that closes one honestly.
--
--   1. staff_operators — who is allowed to work the queue, keyed
--      to the Supabase Auth user UUID.
--   2. identity_resolution_requests — the idempotency ledger for
--      resolutions, so a retried request cannot resolve twice and
--      a reused key with different inputs is refused.
--   3. staff_identity_queue / staff_identity_case — the read
--      surface. Masked in SQL, never in the browser.
--   4. resolve_identity_case_link_existing — the one authoritative
--      mutation. Locks, rechecks, resolves, audits.
--
-- SCOPE, deliberately small. This migration links a queued
-- submission to a Business Record the case itself names — either
-- as a candidate, or as the record a contradicted or disagreeing
-- proposal pointed at. It does NOT create records, dismiss cases,
-- request more information, merge, or accept a target the case
-- does not name anywhere. Cases outside that scope stay open,
-- visibly, rather than being closed by a path nobody has agreed.
--
-- ============================================================
-- WHY A PROPOSAL-VETOED CASE IS RESOLVABLE
--
-- `candidate_business_ids` is populated only by the candidate lookup
-- in ingest_review. The two commonest escalations — a contradicted
-- proposal, and two proposals naming different records — never reach
-- that lookup, so their candidate array is empty. A candidate-only
-- rule made exactly the cases the queue exists for permanently
-- unresolvable.
--
-- The record each of them named is persisted, in
-- `conflicting_signals[].proposedBusinessId`, and its provenance was
-- traced before the set was widened: a continuation id survives only
-- an HMAC verification of a token this server signed, with any
-- client-supplied businessId stripped from the payload first; a
-- session id comes from assessment_sessions.business_id, which
-- carries a foreign key to business_records. Neither is reachable by
-- an assessment client, both are uuid-typed throughout, and 0006
-- re-checks both against a live unmerged record before proposing
-- either. See identity_case_eligible_targets.
--
-- ============================================================
-- WHY THE ROUTE SUPPLIES THE SIGNALS
--
-- The conflict rule must be re-run against the CURRENT target
-- immediately before linking. It needs the submission's normalized
-- signals, and those are not persisted for an unresolved
-- submission: ingest_review writes business_identifiers only once
-- a Business Record exists, which by definition has not happened.
--
-- What IS persisted is assessment_submissions.raw_payload. The
-- server route re-derives the signals from it with the same
-- committed functions ingestion used — extractIdentitySignals then
-- persistableSignals — and passes them in. That is server-side
-- evidence re-derived deterministically from a stored payload, not
-- evidence a browser sent: the route never reads a signal from the
-- request body, and this function refuses a signal set whose
-- payload hash does not match the submission it names.
--
-- Reimplementing the normalizers in SQL was the alternative and is
-- refused for the reason 0006 gives: a second normalizer that can
-- drift is worse than the gap it closes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. staff_operators
-- ------------------------------------------------------------
-- Keyed to auth.users.id, which is immutable. Email addresses are
-- not identifiers here: they change, they are reassigned, and they
-- are personal data with a retention rule of their own.
create table if not exists public.staff_operators (
  user_id     uuid        primary key,
  role        text        not null,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  disabled_at timestamptz,

  -- The smallest vocabulary that answers the only question asked today.
  -- `owner` provisions operators; `identity_resolver` works the queue.
  -- An owner may also resolve, because a system with one operator and a
  -- role that cannot act is a system nobody can run.
  constraint staff_operators_role_check check (role in ('owner', 'identity_resolver')),
  -- active and disabled_at are one fact written two ways; they may not
  -- disagree. Revocation is `active = false`, and it takes effect on the
  -- next request because every request looks the row up.
  constraint staff_operators_active_pair check ((active = false) = (disabled_at is not null)),
  constraint staff_operators_no_self_creation check (created_by is null or created_by <> user_id)
);

create index if not exists staff_operators_active_idx
  on public.staff_operators (user_id) where active;

comment on table public.staff_operators is
  'Who may work the identity-resolution queue. Keyed to the immutable Supabase Auth user UUID, never an email address. Provisioned deliberately; there is no self-registration path. Revocation is active = false and takes effect on the next request, because authorization is a live lookup rather than a JWT claim.';

-- The foreign key exists only where auth.users does. PGlite and any
-- plain PostgreSQL used for migration testing have no Supabase auth
-- schema, and a migration that cannot be applied to a disposable
-- database cannot be tested before it is deployed.
do $$
begin
  if to_regclass('auth.users') is not null
     and not exists (select 1 from pg_constraint where conname = 'staff_operators_user_fk') then
    alter table public.staff_operators
      add constraint staff_operators_user_fk
      foreign key (user_id) references auth.users (id) on delete restrict;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1b. A durable operator reference on the case
-- ------------------------------------------------------------
-- 0001 gave the case a `resolved_by text`. Text is not a reference: it can
-- hold an email, a display name, a typo, or the id of an operator who was
-- deleted last year, and nothing notices. The column stays — 0001 is
-- committed and legacy rows may need it — and a real reference is added
-- beside it.
--
-- ON DELETE RESTRICT and ON UPDATE RESTRICT, both deliberately: an operator
-- who has resolved a case is part of the audit trail of a permanent,
-- unerasable attachment, and neither deleting them nor renumbering them may
-- quietly detach that. Deactivation is how an operator leaves;
-- staff_operators.active exists precisely so deletion never has to.
--
-- Nullable, because rows resolved before this migration cannot be given an
-- operator retrospectively and inventing one would be worse than admitting
-- the gap. Every resolution through the authoritative mutation sets it, and
-- the check constraint below means the two columns can never disagree.
alter table public.identity_resolution_cases
  add column if not exists resolved_by_operator_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'irc_resolved_by_operator_fk') then
    alter table public.identity_resolution_cases
      add constraint irc_resolved_by_operator_fk
      foreign key (resolved_by_operator_id) references public.staff_operators (user_id)
      on delete restrict on update restrict;
  end if;

  -- One fact, two columns, and they may not drift. The text column is the
  -- canonical textual form of the uuid one whenever the uuid one is set.
  if not exists (select 1 from pg_constraint where conname = 'irc_resolved_by_agreement') then
    alter table public.identity_resolution_cases
      add constraint irc_resolved_by_agreement check (
        resolved_by_operator_id is null
        or resolved_by = resolved_by_operator_id::text);
  end if;
end $$;

comment on column public.identity_resolution_cases.resolved_by_operator_id is
  'The staff operator who resolved this case, as a real reference. Null only for rows resolved before 0007. resolved_by holds the same UUID in canonical text form and a check constraint keeps them in step.';

-- ------------------------------------------------------------
-- 1c. Case evidence is immutable once written
-- ------------------------------------------------------------
-- The eligible-target set below is derived from candidate_business_ids and
-- conflicting_signals, which makes those two columns security-relevant: a
-- write to either of them is a write to "which records may this submission
-- be attached to".
--
-- Today nothing updates them. Only ingestion inserts them, RLS is forced with
-- no policies, and anon and authenticated are revoked from every table — so
-- they are unreachable rather than protected. Unreachable is a property of the
-- current code; protected is a property of the schema, and this is the second
-- one. The resolution columns stay writable, because closing a case is the
-- whole point.
create or replace function public.reject_case_evidence_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.assessment_submission_id is distinct from old.assessment_submission_id
     or new.candidate_business_ids is distinct from old.candidate_business_ids
     or new.contributing_signals   is distinct from old.contributing_signals
     or new.conflicting_signals    is distinct from old.conflicting_signals
     or new.resolution_status      is distinct from old.resolution_status
     or new.recommended_action     is distinct from old.recommended_action
     or new.created_at             is distinct from old.created_at then
    raise exception 'case_evidence_immutable: the evidence on an identity-resolution case may not be rewritten; only its resolution may be set'
      using errcode = 'raise_exception';
  end if;
  return new;
end;
$$;

drop trigger if exists identity_resolution_cases_evidence_immutable on public.identity_resolution_cases;
create trigger identity_resolution_cases_evidence_immutable
  before update on public.identity_resolution_cases
  for each row execute function public.reject_case_evidence_change();

revoke all on function public.reject_case_evidence_change() from public, anon, authenticated;

comment on function public.reject_case_evidence_change is
  'Keeps the evidence on an identity-resolution case immutable after ingestion writes it. The eligible-target set is derived from that evidence, so a write to it is a write to what a case may resolve against.';

-- ------------------------------------------------------------
-- 2. identity_resolution_requests — the idempotency ledger
-- ------------------------------------------------------------
-- One row per resolution attempt the client names. Repeating the
-- identical request returns the stored outcome; reusing the id with
-- different inputs is refused rather than silently applied.
create table if not exists public.identity_resolution_requests (
  resolution_request_id  uuid        primary key,
  identity_resolution_id uuid        not null references public.identity_resolution_cases (identity_resolution_id),
  operator_user_id       uuid        not null references public.staff_operators (user_id),
  action                 text        not null,
  request_hash           text        not null,
  outcome                jsonb       not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),

  constraint irr_action_check check (action in ('link_existing')),
  constraint irr_hash_check check (request_hash ~ '^[0-9a-f]{64}$')
);

-- A case may be resolved once. This is the database's answer to two
-- browser tabs, and it is the answer that decides — not the tab.
create unique index if not exists irr_one_per_case
  on public.identity_resolution_requests (identity_resolution_id);

comment on table public.identity_resolution_requests is
  'Idempotency ledger for identity-resolution mutations. One row per case: the unique index is what makes two competing resolutions impossible regardless of what either browser believes.';

-- ------------------------------------------------------------
-- 3. RLS — enabled, forced, no policies
-- ------------------------------------------------------------
-- Same posture as every table since 0001: RLS on and FORCED, zero
-- policies, so the only way in is a SECURITY DEFINER function whose
-- execute grant is explicit. Authentication is not authorization
-- here: `authenticated` gets nothing at all.
alter table public.staff_operators                enable row level security;
alter table public.identity_resolution_requests   enable row level security;
alter table public.staff_operators                force row level security;
alter table public.identity_resolution_requests   force row level security;

revoke all on public.staff_operators              from public, anon, authenticated;
revoke all on public.identity_resolution_requests from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. staff_operator_guard — one definition of "may work the queue"
-- ------------------------------------------------------------
-- Called by every read and by the mutation. A live lookup, every
-- time: a JWT may say `staff` for another fifty minutes after the
-- row was disabled, and this is the thing that says no.
create or replace function public.staff_operator_guard(
  p_user_id uuid,
  p_aal     text
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_role   text;
  v_active boolean;
begin
  if p_user_id is null then
    raise exception 'staff_unauthenticated: no operator identity was supplied'
      using errcode = '42501';
  end if;

  -- AAL is asserted by the route from the verified access token. The
  -- database cannot verify a JWT, so it does the half it can: it refuses
  -- anything that is not aal2, and it refuses an absent claim rather than
  -- treating absence as satisfaction.
  if p_aal is distinct from 'aal2' then
    raise exception 'staff_aal2_required: identity resolution requires a second factor'
      using errcode = '42501';
  end if;

  select role, active into v_role, v_active
    from public.staff_operators
   where user_id = p_user_id;

  if not found then
    raise exception 'staff_not_an_operator: this account is not provisioned for staff access'
      using errcode = '42501';
  end if;

  if not v_active then
    raise exception 'staff_operator_disabled: this operator has been revoked'
      using errcode = '42501';
  end if;

  if v_role not in ('owner', 'identity_resolver') then
    raise exception 'staff_insufficient_role: this operator may not resolve identity cases'
      using errcode = '42501';
  end if;

  return v_role;
end;
$$;

revoke all on function public.staff_operator_guard(uuid, text) from public, anon, authenticated;
grant execute on function public.staff_operator_guard(uuid, text) to service_role;

comment on function public.staff_operator_guard is
  'The single definition of "may work the identity-resolution queue": provisioned, active, sufficient role, and AAL2. A live row lookup on every call, so revocation blocks the next request rather than the next token refresh.';

-- ------------------------------------------------------------
-- 5. Masking — values never leave the database
-- ------------------------------------------------------------
-- The queue shows enough to decide and no more. Masking happens
-- here rather than in the browser, because a value sent to a
-- browser to be hidden by JavaScript has already left.
-- `set search_path` even though this is not SECURITY DEFINER. It is called
-- from inside definer functions, and a helper whose name resolution depends
-- on where it happens to be called from is a helper nobody can reason about
-- in isolation. Every other function in this file pins it; so does this one.
create or replace function public.mask_contact_value(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_value is null or length(p_value) = 0 then null
    when position('@' in p_value) > 1 then
      left(p_value, 1) || '***@' ||
      left(split_part(p_value, '@', 2), 1) || '***.' ||
      reverse(split_part(reverse(split_part(p_value, '@', 2)), '.', 1))
    when length(p_value) <= 4 then repeat('*', length(p_value))
    else left(p_value, 1) || repeat('*', least(length(p_value) - 2, 8)) || right(p_value, 1)
  end;
$$;

-- service_role is revoked too. This is only ever called from inside
-- staff_identity_case, which is SECURITY DEFINER and therefore runs it as the
-- owner. A direct grant would add a caller nobody needs.
revoke all on function public.mask_contact_value(text)
  from public, anon, authenticated, service_role;

comment on function public.mask_contact_value is
  'Reduces a contact value to a shape a person can recognise without reading it. Applied in SQL so a full value is never sent to a browser to be masked there.';

-- ------------------------------------------------------------
-- 5b. identity_case_eligible_targets — what a case may resolve against
-- ------------------------------------------------------------
-- THE ELIGIBLE SET IS DERIVED HERE, IN SQL, FROM PERSISTED EVIDENCE. Not in
-- JavaScript, not from anything a browser sends, and not from anything on a
-- screen. The route passes a case id and a chosen target; this function is
-- what decides whether that pair is allowed, and the mutation calls it inside
-- the transaction.
--
-- Two sources, both written by ingestion and neither reachable by a client:
--
--   candidate_business_ids
--       The candidate lookup — records that share an identifier value with
--       the submission. Provenance `candidate_set`.
--
--   conflicting_signals[].proposedBusinessId
--       The record a CONTRADICTED proposal named. Provenance
--       `proposal_vetoed`. Without this the two commonest escalations were
--       permanently unresolvable, because they never reach the candidate
--       lookup and their candidate array is empty.
--
--   conflicting_signals[].proposedBusinessIds[]
--       The two records that DISAGREED. Provenance `proposals_disagreed`.
--       Both are eligible and staff choose exactly one; choosing is the whole
--       reason the case exists.
--
-- Provenance of both proposal kinds is what makes this safe, and it was
-- traced before the set was widened: a continuation id survives only an HMAC
-- verification of a token this server signed, with any client-supplied
-- businessId stripped from the payload first; a session id is read from
-- assessment_sessions.business_id, which carries a foreign key to
-- business_records. Both are uuid-typed all the way through, and 0006
-- re-checks both against a live, unmerged record before it will propose
-- either.
--
-- Malformed evidence is IGNORED rather than raised on: a value that is not a
-- uuid is not a target, and a case with one bad entry and one good one must
-- still be resolvable against the good one. The regex is the gate — a bare
-- `::uuid` cast would abort the whole function on one bad row.
--
-- Existence, canonical status and merge state are NOT filtered here. They are
-- rechecked in the mutation, under lock, so that a merged-away target is
-- refused as `target_merged_away` rather than silently vanishing into "not
-- eligible" — two different facts a person needs told apart.
create or replace function public.identity_case_eligible_targets(p_case_id uuid)
returns table (business_id uuid, provenance text)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with c as (
    select candidate_business_ids, conflicting_signals
      from public.identity_resolution_cases
     where identity_resolution_id = p_case_id
  ),
  uuid_re as (select '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text as re),
  from_candidates as (
    select coalesce(e ->> 'businessId', e #>> '{}') as raw, 'candidate_set'::text as prov
      from c, uuid_re, lateral jsonb_array_elements(c.candidate_business_ids) e
     where jsonb_typeof(e) in ('object', 'string')
  ),
  from_vetoed as (
    select x ->> 'proposedBusinessId' as raw, 'proposal_vetoed'::text as prov
      from c, uuid_re, lateral jsonb_array_elements(c.conflicting_signals) x
     where jsonb_typeof(x) = 'object'
       and x ->> 'kind' in ('continuation_context_contradicted', 'session_contradicted')
  ),
  from_disagreed as (
    select v #>> '{}' as raw, 'proposals_disagreed'::text as prov
      from c, uuid_re, lateral jsonb_array_elements(c.conflicting_signals) x
      cross join lateral jsonb_array_elements(coalesce(x -> 'proposedBusinessIds', '[]'::jsonb)) v
     where jsonb_typeof(x) = 'object'
       and x ->> 'kind' = 'proposals_disagree'
       and jsonb_typeof(v) = 'string'
  ),
  everything as (
    select * from from_candidates
    union all select * from from_vetoed
    union all select * from from_disagreed
  )
  -- min() rather than an arbitrary pick: a target that arrives by two routes
  -- gets one deterministic provenance, and the alphabetical order happens to
  -- put the narrowest source first.
  select e.raw::uuid, min(e.prov)
    from everything e, uuid_re
   where e.raw is not null and e.raw ~ uuid_re.re
   group by e.raw;
$$;

-- service_role is revoked as well, for the reason 0006 gives for
-- identity_proposal_conflict: a direct grant would let anyone holding the
-- server credential ask "which Business Records may this case attach to"
-- with no operator guard in front of it. Every legitimate caller is a
-- SECURITY DEFINER function in this file, and those run as the owner.
revoke all on function public.identity_case_eligible_targets(uuid)
  from public, anon, authenticated, service_role;

comment on function public.identity_case_eligible_targets is
  'The records an identity-resolution case may be resolved against, derived in SQL from persisted evidence only: the candidate set, and the records that contradicted or disagreeing proposals named. Returns each with its provenance. Malformed entries are ignored; existence and merge state are rechecked under lock by the mutation.';

-- ------------------------------------------------------------
-- 6. staff_identity_queue — the list
-- ------------------------------------------------------------
create or replace function public.staff_identity_queue(
  p_operator_user_id uuid,
  p_aal              text,
  p_limit            integer default 25,
  p_offset           integer default 0
)
returns table (
  identity_resolution_id uuid,
  created_at             timestamptz,
  age_seconds            bigint,
  resolution_status      text,
  recommended_action     text,
  review_type            text,
  confidence             numeric,
  candidate_count        integer,
  proposal_kinds         text[],
  agreed_types           text[],
  contradicted_types     text[],
  escalation_reason      text,
  submitted_label        text,
  resolvable             boolean,
  total_count            bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.staff_operator_guard(p_operator_user_id, p_aal);

  return query
  with open_cases as (
    select c.*, s.review_type as sub_review_type, s.raw_payload as sub_payload
      from public.identity_resolution_cases c
      join public.assessment_submissions s on s.submission_id = c.assessment_submission_id
     where c.resolved_at is null
  ),
  counted as (select count(*) as n from open_cases)
  select
    oc.identity_resolution_id,
    oc.created_at,
    floor(extract(epoch from (now() - oc.created_at)))::bigint,
    oc.resolution_status,
    oc.recommended_action,
    oc.sub_review_type,
    oc.confidence,
    (select count(*)::integer from public.identity_case_eligible_targets(oc.identity_resolution_id)),
    coalesce((select array_agg(distinct x ->> 'kind')
                from jsonb_array_elements(oc.conflicting_signals) x
               where x ->> 'kind' is not null), array[]::text[]),
    coalesce((select array_agg(distinct t)
                from jsonb_array_elements(oc.conflicting_signals) x
                cross join lateral jsonb_array_elements_text(coalesce(x -> 'agreedTypes', '[]'::jsonb)) t
             ), array[]::text[]),
    coalesce((select array_agg(distinct t)
                from jsonb_array_elements(oc.conflicting_signals) x
                cross join lateral jsonb_array_elements_text(coalesce(x -> 'contradictedTypes', '[]'::jsonb)) t
             ), array[]::text[]),
    case
      when exists (select 1 from jsonb_array_elements(oc.conflicting_signals) x
                    where x ->> 'kind' = 'proposals_disagree')
        then 'Two saved proposals name different Business Records.'
      when exists (select 1 from jsonb_array_elements(oc.conflicting_signals) x
                    where x ->> 'kind' in ('continuation_context_contradicted', 'session_contradicted'))
        then 'A saved identity proposal was contradicted by submitted identity evidence.'
      when exists (select 1 from jsonb_array_elements(oc.conflicting_signals) x
                    where x ->> 'kind' = 'cross_business_claim')
        then 'A claimed identifier is already held, verified, by another business.'
      else 'No unique verified strong identifier among candidates.'
    end,
    coalesce(oc.sub_payload #>> '{contact,salonName}',
             oc.sub_payload #>> '{contact,businessName}',
             '(no business name supplied)'),
    -- Resolvable by THIS milestone: link-to-existing needs at least one
    -- authoritative target, from the candidate set or from a proposal the
    -- case itself recorded.
    exists (select 1 from public.identity_case_eligible_targets(oc.identity_resolution_id)),
    counted.n
    from open_cases oc cross join counted
   -- Deterministic: oldest first, and the id breaks every tie, so the same
   -- page is the same page however the planner feels about it today.
   order by oc.created_at asc, oc.identity_resolution_id asc
   limit v_limit offset v_offset;
end;
$$;

revoke all on function public.staff_identity_queue(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.staff_identity_queue(uuid, text, integer, integer) to service_role;

comment on function public.staff_identity_queue is
  'Open identity-resolution cases, oldest first with the case id as tie-breaker. Type names, counts and reasons only: no identifier value, no business id, and no contact detail beyond the submitted business label.';

-- ------------------------------------------------------------
-- 7. staff_identity_case — the detail
-- ------------------------------------------------------------
create or replace function public.staff_identity_case(
  p_operator_user_id uuid,
  p_aal              text,
  p_case_id          uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_case public.identity_resolution_cases%rowtype;
  v_sub  public.assessment_submissions%rowtype;
  v_out  jsonb;
begin
  perform public.staff_operator_guard(p_operator_user_id, p_aal);

  select * into v_case from public.identity_resolution_cases where identity_resolution_id = p_case_id;
  if not found then
    raise exception 'case_not_found: no such identity-resolution case' using errcode = 'no_data_found';
  end if;

  select * into v_sub from public.assessment_submissions where submission_id = v_case.assessment_submission_id;

  select jsonb_build_object(
    'caseId',            v_case.identity_resolution_id,
    'submissionId',      v_case.assessment_submission_id,
    'createdAt',         v_case.created_at,
    'resolvedAt',        v_case.resolved_at,
    'resolutionStatus',  v_case.resolution_status,
    'recommendedAction', v_case.recommended_action,
    'confidence',        v_case.confidence,
    'reviewType',        v_sub.review_type,
    'submitted', jsonb_build_object(
      'label',  coalesce(v_sub.raw_payload #>> '{contact,salonName}',
                         v_sub.raw_payload #>> '{contact,businessName}'),
      'email',  public.mask_contact_value(v_sub.raw_payload #>> '{contact,email}'),
      'mobile', public.mask_contact_value(v_sub.raw_payload #>> '{contact,mobile}'),
      'submittedAt', v_sub.submitted_at,
      'vertical', v_sub.vertical_id),
    -- Type names and the shape of the disagreement. Never a value.
    'conflicts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind',              x ->> 'kind',
               'agreedTypes',       coalesce(x -> 'agreedTypes', '[]'::jsonb),
               'contradictedTypes', coalesce(x -> 'contradictedTypes', '[]'::jsonb),
               'reason',            x ->> 'reason')), '[]'::jsonb)
        from jsonb_array_elements(v_case.conflicting_signals) x
       where jsonb_typeof(x) = 'object'),
    'contributingSignals', v_case.contributing_signals,
    'candidates', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'businessId',          br.business_id,
               'label',               br.display_name,
               'vertical',            br.vertical_id,
               'lifecycleState',      br.lifecycle_state,
               'identityStatus',      br.identity_status,
               'mergedAway',          br.merged_into_business_id is not null,
               /* Why this record is offered at all. The operator is choosing
                  between "shares an identifier with the submission" and "a
                  saved pointer named it and was set aside", and those are
                  different questions. */
               'provenance',          t.provenance,
               'matchedTypes',        coalesce(cand.c -> 'matchedTypes', '[]'::jsonb),
               'verifiedStrongTypes', coalesce(cand.c -> 'verifiedStrongTypes', '[]'::jsonb),
               'claimedStrongTypes',  coalesce(cand.c -> 'claimedStrongTypes', '[]'::jsonb),
               'priorReviews', (
                  select coalesce(jsonb_agg(jsonb_build_object(
                           'reviewType',      st.review_type,
                           'completedCount',  st.completed_count,
                           'lastCompletedAt', st.last_completed_at)), '[]'::jsonb)
                    from public.business_review_states st
                   where st.business_id = br.business_id)
             ) order by br.display_name, br.business_id), '[]'::jsonb)
        from public.identity_case_eligible_targets(v_case.identity_resolution_id) t
        join public.business_records br on br.business_id = t.business_id
        /* A proposed target has no candidate row, so the matched-type arrays
           are genuinely empty for it rather than missing. */
        left join lateral (
          select e as c
            from jsonb_array_elements(v_case.candidate_business_ids) e
           where coalesce(e ->> 'businessId', e #>> '{}') = t.business_id::text
           limit 1) cand on true),
    /* A CLOSED case is not resolvable, whatever its evidence still names.
       Reporting `true` here offered the interface a control whose only
       possible outcome was `case_already_resolved`, and told a person that a
       decision already taken was still open. The queue never shows a resolved
       case, so this is only reachable by asking for one directly — which is
       exactly when the answer has to be right. */
    'resolvable', v_case.resolved_at is null
                  and exists (select 1 from public.identity_case_eligible_targets(v_case.identity_resolution_id)),
    'unsupportedReason', case
      when v_case.resolved_at is not null
        then 'This case was already resolved. Its resolution is final and cannot be changed here.'
      when exists (select 1 from public.identity_case_eligible_targets(v_case.identity_resolution_id)) then null
      else 'This case names no Business Record at all — no candidate, and no proposal that was set aside. '
           || 'It stays open until a resolution path for its escalation reason is approved.' end
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.staff_identity_case(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.staff_identity_case(uuid, text, uuid) to service_role;

comment on function public.staff_identity_case is
  'One case, with everything a person needs to decide and nothing else: masked contact shapes, candidate labels, agreeing and contradicting identifier TYPES, prior reviews, and merged-away warnings.';

-- ------------------------------------------------------------
-- 7b. identity_resolution_replay — one definition of "this is a retry"
-- ------------------------------------------------------------
-- The ledger is consulted twice by the mutation below: once before any work,
-- and again after waiting on the case lock. Both places must answer the
-- question identically, so the answer lives here rather than being written
-- out twice and drifting.
--
-- A replay must match on BOTH the hash and the operator:
--
--   · the hash, because the same id with a different decision is a mistake,
--     and a mistake that resolves a case against a different record is the
--     mistake this subsystem exists to prevent;
--   · the OPERATOR, because a resolution is attributed to a person. A second
--     operator reusing the first one's request id would otherwise be handed
--     the first one's outcome and a 200, and the interface would tell them
--     they had resolved something they never touched. The route also folds the
--     operator into the hash, so this is the second of two independent
--     defences rather than the only one.
create or replace function public.identity_resolution_replay(
  p_existing     public.identity_resolution_requests,
  p_request_hash text,
  p_operator     uuid
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_existing.request_hash <> p_request_hash
     or p_existing.operator_user_id is distinct from p_operator then
    raise exception 'resolution_request_conflict: this request id was already used with different inputs'
      using errcode = '23505';
  end if;
  return p_existing.outcome || jsonb_build_object('replayed', true);
end;
$$;

revoke all on function public.identity_resolution_replay(
  public.identity_resolution_requests, text, uuid)
  from public, anon, authenticated, service_role;

comment on function public.identity_resolution_replay is
  'Decides whether a ledger row is a legitimate replay of the request in hand. Matches on the request hash AND the operator, so a second operator reusing a request id is refused rather than handed someone else''s outcome.';

-- ------------------------------------------------------------
-- 8. resolve_identity_case_link_existing — the authoritative mutation
-- ------------------------------------------------------------
-- One transaction. Locks the case, the submission, the report, the
-- target and the review state, rechecks every one of them, and
-- either commits the whole thing or leaves nothing behind.
create or replace function public.resolve_identity_case_link_existing(
  p_operator_user_id      uuid,
  p_aal                   text,
  p_case_id               uuid,
  p_target_business_id    uuid,
  p_resolution_request_id uuid,
  p_request_hash          text,
  p_note                  text,
  p_signals               jsonb,
  p_payload_hash          text,
  p_override_conflict     boolean default false,
  p_override_reason       text    default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c_override_reasons constant text[] := array[
    'verified_same_business', 'business_rebrand', 'contact_information_changed',
    'source_information_incorrect', 'other_verified_evidence'];
  v_role         text;
  v_existing     public.identity_resolution_requests%rowtype;
  v_case         public.identity_resolution_cases%rowtype;
  v_sub          public.assessment_submissions%rowtype;
  v_bir          public.business_intelligence_reports%rowtype;
  v_target       public.business_records%rowtype;
  v_state        public.business_review_states%rowtype;
  v_material     boolean;
  v_provenance   text;
  v_agreed       text[];
  v_contradicted text[];
  v_completed_at timestamptz;
  v_is_newer     boolean;
  v_outcome      jsonb;
  v_now          timestamptz := now();
begin
  -- 0. The operator, live. Before anything is read or written.
  v_role := public.staff_operator_guard(p_operator_user_id, p_aal);

  if p_resolution_request_id is null or p_request_hash is null then
    raise exception 'resolution_request_required: a resolution request id and hash are required'
      using errcode = '22023';
  end if;
  if p_note is null or length(btrim(p_note)) < 8 then
    raise exception 'resolution_note_required: a resolution note of at least 8 characters is required'
      using errcode = '22023';
  end if;

  -- 1. Idempotency, before any work. The ledger row is the arbiter.
  select * into v_existing
    from public.identity_resolution_requests
   where resolution_request_id = p_resolution_request_id
     for update;

  if found then
    return public.identity_resolution_replay(v_existing, p_request_hash, p_operator_user_id);
  end if;

  -- 2. The case. Locked, so a second tab cannot pass this line at the
  --    same moment as the first.
  select * into v_case
    from public.identity_resolution_cases
   where identity_resolution_id = p_case_id
     for update;

  if not found then
    raise exception 'case_not_found: no such identity-resolution case' using errcode = 'no_data_found';
  end if;
  if v_case.resolved_at is not null then
    -- RECHECK THE LEDGER BEFORE REFUSING.
    --
    -- Step 1 read the ledger; this line is reached after WAITING on the case
    -- lock, and the transaction that held it may have been the other half of
    -- this very request. Two simultaneous sends of one retry both found no
    -- ledger row at step 1, and the loser used to arrive here and raise
    -- `case_already_resolved` — turning the idempotent replay the contract
    -- promises into a conflict, purely because the two happened to overlap.
    --
    -- Re-reading is safe and sufficient: the winner's ledger row was written
    -- inside the transaction that set `resolved_at`, so if `resolved_at` is
    -- visible the ledger row is too.
    select * into v_existing
      from public.identity_resolution_requests
     where resolution_request_id = p_resolution_request_id;

    if found then
      return public.identity_resolution_replay(v_existing, p_request_hash, p_operator_user_id);
    end if;

    raise exception 'case_already_resolved: this case was resolved at %', v_case.resolved_at
      using errcode = '23505';
  end if;

  -- 3. The target must be one the CASE names. Not one the browser names, not
  --    one read off a screen, not one from an unrelated event. The eligible
  --    set is derived in SQL from this case's own persisted evidence, and the
  --    provenance comes back with it so the audit trail can record WHY this
  --    record was offered at all.
  select t.provenance into v_provenance
    from public.identity_case_eligible_targets(p_case_id) t
   where t.business_id = p_target_business_id;

  if p_target_business_id is null or v_provenance is null then
    raise exception 'target_not_a_candidate: the selected record is not an eligible target on this case'
      using errcode = '42501';
  end if;

  -- 4. The target, locked and rechecked. A merged-away record is REFUSED,
  --    never followed: following the pointer would silently resolve
  --    against a record the operator never looked at.
  select * into v_target
    from public.business_records
   where business_id = p_target_business_id
     for update;

  if not found then
    raise exception 'target_missing: the selected Business Record no longer exists'
      using errcode = 'no_data_found';
  end if;
  if v_target.merged_into_business_id is not null then
    raise exception 'target_merged_away: the selected record has been merged into another; resolve against the surviving record instead'
      using errcode = '42501';
  end if;
  if v_target.identity_status not in ('linked', 'manually_verified') then
    raise exception 'target_not_canonical: the selected record is not in a linkable state'
      using errcode = '42501';
  end if;

  -- 5. The submission, locked and rechecked.
  select * into v_sub
    from public.assessment_submissions
   where submission_id = v_case.assessment_submission_id
     for update;

  if not found then
    raise exception 'submission_missing: the case names a submission that no longer exists'
      using errcode = 'no_data_found';
  end if;
  if v_sub.business_id is not null or v_sub.identity_status <> 'resolution_pending' then
    raise exception 'submission_already_attached: this submission is no longer pending resolution'
      using errcode = '23505';
  end if;
  -- The signals must belong to THIS submission. The route re-derives them
  -- from raw_payload; this is the check that says it derived them from the
  -- right payload.
  if p_payload_hash is distinct from v_sub.payload_hash then
    raise exception 'signals_payload_mismatch: the supplied evidence does not belong to this submission'
      using errcode = '22023';
  end if;

  -- 6. The report, locked if it exists.
  select * into v_bir
    from public.business_intelligence_reports
   where assessment_submission_id = v_sub.submission_id
     for update;

  -- 7. Re-run the authoritative conflict rule against the CURRENT target.
  --    Not the verdict recorded at ingestion: the record may have gained or
  --    lost identifiers since, and the operator is deciding about it now.
  select conflict.material, conflict.agreed_types, conflict.contradicted_types
    into v_material, v_agreed, v_contradicted
    from public.identity_proposal_conflict(p_signals, p_target_business_id) conflict;

  if v_material and not coalesce(p_override_conflict, false) then
    raise exception 'material_conflict: the submitted identity contradicts this record; an explicit, documented override is required'
      using errcode = '42501';
  end if;

  if coalesce(p_override_conflict, false) then
    if not v_material then
      raise exception 'override_not_applicable: this link does not contradict the record, so it may not be recorded as an override'
        using errcode = '22023';
    end if;
    if p_override_reason is null or not (p_override_reason = any (c_override_reasons)) then
      raise exception 'override_reason_required: an override requires one of the approved reason codes'
        using errcode = '22023';
    end if;
    if p_override_reason = 'other_verified_evidence' and length(btrim(p_note)) < 40 then
      raise exception 'override_note_required: other_verified_evidence requires a substantive written explanation'
        using errcode = '22023';
    end if;
  end if;

  -- 8. Attach the submission. manually_verified is the existing legal
  --    status for "attached by a person"; raw_payload, consent and
  --    attribution are untouched.
  update public.assessment_submissions
     set business_id = p_target_business_id,
         identity_status = 'manually_verified'
   where submission_id = v_sub.submission_id;

  -- 9. Attach the report, WITHOUT splicing it into a chain. A report
  --    resolved by hand weeks later is not the successor of whatever is
  --    current; supersedes_bir_id stays exactly as it was.
  if v_bir.bir_id is not null then
    update public.business_intelligence_reports
       set business_id = p_target_business_id
     where bir_id = v_bir.bir_id;
  end if;

  -- 10. Review state. The completed timestamp is the same clamp ingestion
  --     uses, so a manual attachment and an automatic one are comparable.
  v_completed_at := least(v_sub.submitted_at, v_sub.received_at);

  select * into v_state
    from public.business_review_states
   where business_id = p_target_business_id and review_type = v_sub.review_type
     for update;

  if not found then
    insert into public.business_review_states (
      business_id, review_type, current_bir_id,
      original_submission_id, latest_submission_id,
      last_completed_at, next_reassessment_due_at, next_reassessment_kind,
      completed_count, state)
    values (
      p_target_business_id, v_sub.review_type, v_bir.bir_id,
      v_sub.submission_id, v_sub.submission_id,
      v_completed_at, v_completed_at + interval '90 days', 'quick_recheck',
      1, jsonb_build_object('lastResolution', 'manual_link'));
    v_is_newer := true;
  else
    -- Newer by completed time, with the BIR id as a deterministic
    -- tie-breaker. An older review is attached and counted; it never
    -- drags a current pointer backwards.
    v_is_newer := (v_completed_at, coalesce(v_bir.bir_id, '00000000-0000-0000-0000-000000000000'::uuid))
                  > (coalesce(v_state.last_completed_at, '-infinity'::timestamptz),
                     coalesce(v_state.current_bir_id, '00000000-0000-0000-0000-000000000000'::uuid));

    update public.business_review_states
       set completed_count = completed_count + 1,
           current_bir_id = case when v_is_newer and v_bir.bir_id is not null
                                 then v_bir.bir_id else current_bir_id end,
           latest_submission_id = case when v_is_newer
                                       then v_sub.submission_id else latest_submission_id end,
           last_completed_at = case when v_is_newer
                                    then v_completed_at else last_completed_at end,
           next_reassessment_due_at = case when v_is_newer
                                           then v_completed_at + interval '90 days'
                                           else next_reassessment_due_at end,
           original_submission_id = coalesce(original_submission_id, v_sub.submission_id),
           updated_at = v_now
     where business_id = p_target_business_id and review_type = v_sub.review_type;
  end if;

  -- 11. business_records.current_bir_id is the current GROWTH report and
  --     refuses anything else at the database (0006). Only a Growth BIR
  --     that is genuinely the newest may move it.
  if v_sub.review_type = 'growth_review' and v_is_newer and v_bir.bir_id is not null then
    update public.business_records
       set current_bir_id = v_bir.bir_id, updated_at = v_now
     where business_id = p_target_business_id;
  end if;

  -- 12. Close the case. recommended_action is preserved: it is what the
  --     engine advised, and overwriting it would erase why this was queued.
  update public.identity_resolution_cases
     set resolved_at = v_now,
         -- Both columns, always. irc_resolved_by_agreement refuses them apart,
         -- and irc_resolved_by_operator_fk means the operator cannot later be
         -- deleted out from under the record of what they did.
         resolved_by = p_operator_user_id::text,
         resolved_by_operator_id = p_operator_user_id,
         resolution_notes = p_note
   where identity_resolution_id = p_case_id;

  -- 13. Evidence. Type names, ids and the override facts — never a value.
  insert into public.timeline_events (
    business_id, event_name, event_version, occurred_at, producer,
    idempotency_key, summary, payload, correlation_id)
  values (
    p_target_business_id, 'identity.review_resolved', 1, v_now, 'staff-identity-resolution',
    p_resolution_request_id::text,
    'A queued review was attached to this record by a member of staff.',
    jsonb_build_object(
      'identityResolutionId', p_case_id,
      'submissionId', v_sub.submission_id,
      'birId', v_bir.bir_id,
      'reviewType', v_sub.review_type,
      'reviewTypeIsNewer', v_is_newer,
      'targetProvenance', v_provenance,
      'conflictOverridden', coalesce(p_override_conflict, false),
      'overrideReason', p_override_reason,
      'agreedTypes', to_jsonb(coalesce(v_agreed, array[]::text[])),
      'contradictedTypes', to_jsonb(coalesce(v_contradicted, array[]::text[])),
      'operatorUserId', p_operator_user_id),
    p_resolution_request_id::text);

  insert into public.audit_events (
    business_id, action, actor_type, actor_id, reason,
    previous_value, new_value, correlation_id)
  values (
    p_target_business_id, 'identity_resolution.link_existing', 'human',
    p_operator_user_id::text,
    case when coalesce(p_override_conflict, false)
         then 'Manual identity resolution; automatic identity protection was overridden.'
         else 'Manual identity resolution of a queued submission.' end,
    jsonb_build_object('identityStatus', v_sub.identity_status, 'businessId', null),
    jsonb_build_object(
      'identityResolutionId', p_case_id,
      'submissionId', v_sub.submission_id,
      'birId', v_bir.bir_id,
      'targetBusinessId', p_target_business_id,
      'reviewType', v_sub.review_type,
      'identityStatus', 'manually_verified',
      'targetProvenance', v_provenance,
      'conflictOverridden', coalesce(p_override_conflict, false),
      'overrideReason', p_override_reason,
      'operatorUserId', p_operator_user_id,
      'operatorRole', v_role),
    p_resolution_request_id::text);

  v_outcome := jsonb_build_object(
    'ok', true,
    'replayed', false,
    'caseId', p_case_id,
    'submissionId', v_sub.submission_id,
    'birId', v_bir.bir_id,
    'businessId', p_target_business_id,
    'reviewType', v_sub.review_type,
    'identityStatus', 'manually_verified',
    'targetProvenance', v_provenance,
    'becameCurrent', v_is_newer,
    'conflictOverridden', coalesce(p_override_conflict, false),
    'overrideReason', p_override_reason,
    'resolvedAt', v_now);

  -- 14. The ledger last, so it records an outcome that actually happened.
  --     irr_one_per_case is what makes two concurrent winners impossible.
  insert into public.identity_resolution_requests (
    resolution_request_id, identity_resolution_id, operator_user_id,
    action, request_hash, outcome)
  values (
    p_resolution_request_id, p_case_id, p_operator_user_id,
    'link_existing', p_request_hash, v_outcome);

  return v_outcome;
end;
$$;

revoke all on function public.resolve_identity_case_link_existing(
  uuid, text, uuid, uuid, uuid, text, text, jsonb, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.resolve_identity_case_link_existing(
  uuid, text, uuid, uuid, uuid, text, text, jsonb, text, boolean, text) to service_role;

comment on function public.resolve_identity_case_link_existing is
  'Attaches a queued submission and its report to a Business Record the case already names as a candidate. One transaction: locks the case, submission, report, target and review state, rechecks every one, re-runs the conflict rule against the current target, and refuses a material contradiction unless an approved override reason and a written explanation are supplied. Writes no identifier, repoints no session, and splices no supersession chain.';

-- ------------------------------------------------------------
-- 8b. bootstrap_staff_owner — the one-time first operator
-- ------------------------------------------------------------
-- Section 1 states there is no self-registration path, and there still is
-- not. But "provisioned deliberately" was not a procedure: the table shipped
-- with no way at all to create the first row, so `staff_operator_guard`
-- refused everyone and the queue no operator could ever be added to was
-- exactly as unworkable as the queue nobody could close.
--
-- This is the smallest thing that fixes that, and every property below is a
-- refusal rather than a capability:
--
--   · It works ONLY when the table is empty. It is a bootstrap, not a
--     provisioning API — the second operator is created by the first, with
--     `created_by` recorded, per the runbook.
--   · It requires an EXISTING, CONFIRMED Auth user, where auth.users exists.
--     An unconfirmed invite is not an account yet, and the route refuses one
--     as well.
--   · It creates exactly one row, active, role `owner`, `created_by` null —
--     the only row in this table that legitimately has no creator, because
--     there was nobody to be it.
--   · It is idempotent for the IDENTICAL user and refuses every other
--     caller, so two competing bootstraps cannot both believe they won.
--
-- Serialised by an advisory transaction lock rather than by hoping: two
-- concurrent calls would otherwise both see an empty table.
--
-- No anon or authenticated grant, and no route calls it. It is run once by a
-- person holding the server credential. See
-- docs/STAFF_IDENTITY_RESOLUTION_OPERATIONS.md.
create or replace function public.bootstrap_staff_owner(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_count    integer;
  v_existing public.staff_operators%rowtype;
  v_ok       boolean;
begin
  if p_user_id is null then
    raise exception 'staff_bootstrap_user_required: an Auth user id is required'
      using errcode = '22023';
  end if;

  -- One bootstrap at a time, cluster-wide, for the life of this transaction.
  perform pg_advisory_xact_lock(hashtext('ced.staff_operators.bootstrap'));

  -- The Auth user must exist and have confirmed its email. auth.users is
  -- absent from PGlite and from any plain PostgreSQL used for migration
  -- testing, so the check applies where the schema does and is recorded as
  -- skipped where it does not — the same rule the foreign key follows.
  if to_regclass('auth.users') is not null then
    execute 'select exists (select 1 from auth.users u
                             where u.id = $1
                               and (u.email_confirmed_at is not null
                                    or u.confirmed_at is not null))'
      into v_ok using p_user_id;
    if not coalesce(v_ok, false) then
      raise exception 'staff_bootstrap_user_unconfirmed: the Auth user does not exist or has not confirmed its email'
        using errcode = '42501';
    end if;
  end if;

  select count(*) into v_count from public.staff_operators;

  if v_count > 0 then
    select * into v_existing from public.staff_operators where user_id = p_user_id;
    -- Idempotent for the identical user, and ONLY when that user is still the
    -- sole operator. Once a second operator exists this is no longer a
    -- bootstrap and must not answer as though it were.
    if found and v_count = 1 and v_existing.active and v_existing.role = 'owner' then
      return jsonb_build_object(
        'ok', true, 'bootstrapped', false, 'userId', p_user_id,
        'role', v_existing.role, 'createdAt', v_existing.created_at);
    end if;
    raise exception 'staff_bootstrap_already_done: staff operators already exist; create further operators as an existing owner'
      using errcode = '42501';
  end if;

  insert into public.staff_operators (user_id, role, active, created_by)
  values (p_user_id, 'owner', true, null);

  return jsonb_build_object(
    'ok', true, 'bootstrapped', true, 'userId', p_user_id,
    'role', 'owner', 'createdAt', now());
end;
$$;

revoke all on function public.bootstrap_staff_owner(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_staff_owner(uuid) to service_role;

comment on function public.bootstrap_staff_owner is
  'Creates the FIRST staff operator and nothing else. Refuses once any operator exists, refuses an Auth user that has not confirmed its email, and is serialised by an advisory lock so two competing bootstraps cannot both succeed. Idempotent only for the identical sole operator. Run once, by a person holding the server credential.';

-- ------------------------------------------------------------
-- 8c. redact_business_pii — resolution notes join the erasure
-- ------------------------------------------------------------
-- 0007 introduced the first free-text field a member of staff can type
-- against a business: identity_resolution_cases.resolution_notes. It is
-- reachable from the erasure path's own subject — the case names a
-- submission, and the submission names the business — and 0003's function
-- predates it, so a redaction ran to completion while the note it never
-- heard of stayed exactly as written.
--
-- 0003 is committed and is NOT edited. This replaces the function body, which
-- is how every other migration in this chain has amended one.
--
-- The note is REPLACED, not deleted: the row is evidence that a person made a
-- decision, and an empty note would misreport "no reason was recorded". The
-- replacement is deterministic and states why it is there. The case's own
-- evidence columns are untouched — the immutability trigger refuses them
-- anyway, and they carry ids and type names rather than values.
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
  v_notes          integer := 0;
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

  -- 5d-bis. Staff resolution notes (0007). Free text a person typed, reached
  --         through the submission that names this business. Every OTHER
  --         column on the case is left alone; the immutability trigger permits
  --         exactly this one and refuses the evidence columns.
  update public.identity_resolution_cases c
     set resolution_notes = v_token
    from public.assessment_submissions s
   where s.submission_id = c.assessment_submission_id
     and s.business_id = p_business_id
     and c.resolution_notes is not null
     and c.resolution_notes is distinct from v_token;
  get diagnostics v_notes = row_count;

  -- 5e. Audit. Append-only, and deliberately free of the values removed.
  insert into public.audit_events (business_id, action, actor_type, actor_id, reason, new_value, correlation_id)
  values (
    p_business_id, 'business.pii_redacted', p_actor_type, p_actor, p_reason,
    jsonb_build_object(
      'submissionsRedacted', v_submissions,
      'identifiersRedacted', v_identifiers,
      'reportsDisplayNameRedacted', v_reports,
      'resolutionNotesRedacted', v_notes,
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
      'birDisplayName', v_reports,
      'identityResolutionNotes', v_notes
    ),
    'preserved', jsonb_build_object(
      'businessId', 'permanent, opaque, not derived from contact data',
      'timelineEvents', 'append-only skeleton retained; payloads carry no contact data',
      'auditEvents', 'append-only, retained in full',
      'assessmentScoresAndAnswers', 'operational answers and all scoring retained',
      'birAnalysis', 'every score, band, estimate, and rationale retained unchanged',
      'consentRecords', 'retained as proof of what was shown and agreed',
      'attribution', 'campaign attribution retained; review separately if a URL can carry contact data',
      'identityResolutionEvidence', 'candidate set, conflicting signals and the operator reference retained; only the free-text note is replaced'
    ),
    'notes', jsonb_build_array(
      'Timeline and audit history cannot be updated by design; they are retained in structural form.',
      'External systems (payment processor, CRM, email provider) are NOT touched by this function.',
      'This function makes no claim of compliance with any law or regulation.'
    )
  );
end;
$$;

revoke all on function public.redact_business_pii(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.redact_business_pii(uuid, text, text, text) to service_role;

comment on function public.redact_business_pii is
  'Controlled PII redaction for one Business Record, including the staff resolution notes 0007 introduced. Maintenance role only. Not a compliance guarantee.';

-- ------------------------------------------------------------
-- 9. Grants, restated
-- ------------------------------------------------------------
-- `authenticated` means "this browser proved who it is", which is not the
-- same as "this person may work the queue" — the second question is answered
-- by staff_operators, in the database, on every call.
--
-- service_role is granted on the two new tables EXPLICITLY, for the reason
-- 0006 gives: the other fourteen tables got `grant all ... to service_role`
-- from 0006, and these two were created afterwards, so without this line
-- whether the server can reach them depends on how the Supabase project
-- happened to be created rather than on anything this schema states. RLS
-- stays enabled and FORCED with no policies; BYPASSRLS on the role is what
-- makes the grant usable, exactly as for every other table.
grant all on public.staff_operators              to service_role;
grant all on public.identity_resolution_requests to service_role;

revoke all on all tables in schema public from anon, authenticated;

-- ------------------------------------------------------------
-- 10. Server-callable functions, restated as catalog facts
-- ------------------------------------------------------------
-- Written out in full, the way 0006 does it, because PostgREST resolves a
-- function by its argument types and a grant on the wrong overload grants
-- nothing the endpoint can use. Re-running this file re-asserts the whole
-- set rather than trusting the order statements happened to appear in above.
--
-- staff_operator_guard IS on this list, deliberately. The route calls it
-- directly, before it reads anything, so that a caller who is not a
-- provisioned, active, AAL2 operator is refused BEFORE any case row or
-- raw_payload is read with the server credential. That ordering is the whole
-- point, and it needs the grant.
do $$
declare
  v_signature text;
  c_server_rpcs constant text[] := array[
    'public.staff_operator_guard(uuid, text)',
    'public.staff_identity_queue(uuid, text, integer, integer)',
    'public.staff_identity_case(uuid, text, uuid)',
    'public.resolve_identity_case_link_existing(uuid, text, uuid, uuid, uuid, text, text, jsonb, text, boolean, text)',
    'public.bootstrap_staff_owner(uuid)'
  ];
  -- Called only from inside the functions above, which are SECURITY DEFINER
  -- and run them as the owner. A grant here would add a caller with no guard
  -- in front of it.
  c_internal constant text[] := array[
    'public.identity_case_eligible_targets(uuid)',
    'public.mask_contact_value(text)',
    'public.identity_resolution_replay(public.identity_resolution_requests, text, uuid)',
    'public.reject_case_evidence_change()'
  ];
begin
  foreach v_signature in array c_server_rpcs loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;

  foreach v_signature in array c_internal loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end $$;
