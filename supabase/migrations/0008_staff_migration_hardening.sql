-- ============================================================
-- 0008 — staff migration hardening
-- ============================================================
-- A FORWARD-ONLY corrective migration. It rewrites no history.
--
-- Migrations 0006 and 0007 are present in the hosted development project
-- (`qkpptajglstgucadhfwq`). That was established by read-only PostgREST
-- existence-versus-permission probes: the objects resolve, and they answer
-- "permission denied" rather than "not found". What those probes did NOT
-- establish is that the deployed definitions are byte-for-byte the ones in
-- this repository, when they were applied, by what method, or whether
-- `supabase_migrations.schema_migrations` records them. See
-- docs/REAL_POSTGRES_VALIDATION.md, run 14.
--
-- That distinction shapes this file. Because a hosted definition may differ
-- from the committed one, 0008 prefers the narrowest statement that fixes the
-- defect:
--
--   · F7 uses `alter function … set search_path`, which pins the setting and
--     leaves the body exactly as deployed.
--   · F6 uses `revoke`, which touches an ACL and no definition at all.
--   · F3 is the one place a body must change, because the rule has to learn
--     about UPDATE. It is a `create or replace`, and it therefore OVERWRITES
--     whatever is currently deployed under that name. Verify the deployed
--     definition before applying — the procedure in docs/SUPABASE_SETUP.md §2
--     says how, and why that step is not optional here.
--
-- Every statement is re-runnable. Running this file twice changes nothing the
-- second time.
--
-- What this file does NOT do: it adds no table, no column, no index, no
-- policy, and no grant to anon or authenticated. It removes access and pins
-- resolution. Nothing here can widen a surface.

-- ------------------------------------------------------------
-- F3. The supersession scope rule was enforced on INSERT only
-- ------------------------------------------------------------
-- 0006 section 5 states the invariant without qualification: supersession is
-- closed within one Business Record and one review type, and it is enforced in
-- two layers so that it is "a rule" rather than "a convention". The database
-- layer was `before insert` only, so the rule described a moment rather than
-- an invariant: a row that satisfied it at insert could be moved out of scope
-- by any later UPDATE, and nothing would object.
--
-- HOW REACHABLE IS THIS TODAY? Stated precisely, because overstating it would
-- be its own defect. There is exactly one UPDATE in the chain that touches a
-- field the rule reads —
--
--     0007_staff_identity_resolution.sql :: resolve_identity_case_link_existing
--     update public.business_intelligence_reports
--        set business_id = p_target_business_id
--      where bir_id = v_bir.bir_id;
--
-- — and it cannot currently produce a violation, because the report it moves
-- belongs to a queued submission, and ingest_review only reads a supersession
-- chain when `v_business_id is not null` (0006 section 7). A queued report
-- therefore has `supersedes_bir_id is null`, and a null chain is in scope
-- everywhere.
--
-- So this is not a live escape. It is a rule whose coverage does not match the
-- invariant it claims, held true by a coincidence in a different file that
-- nothing tests and nothing states. `grant all on all tables … to service_role`
-- (0006 section 10b) means the route's own credential can UPDATE this table
-- directly, and the staff route already does direct table work through
-- `db.from(...)`. The trigger is what is supposed to make a mistake there
-- impossible. Now it does.
--
-- The re-check is CONDITIONAL, and the condition matters. `redact_business_pii`
-- (0003 and 0007) rewrites `report` on every row belonging to a business, and
-- erasure must never be made to re-prove a chain it did not touch — a report
-- whose predecessor was itself redacted must still be erasable. So the rule
-- fires only when one of the three fields it actually reads changes.
--
-- OLD is read only inside the `tg_op = 'UPDATE'` branch. PL/pgSQL evaluates an
-- IF condition as a single SQL expression and SQL does not promise to
-- short-circuit AND, so a flat `tg_op = 'UPDATE' and old.…` could evaluate the
-- OLD reference on an INSERT, where OLD is unassigned. Nesting is not a style
-- choice here.

create or replace function public.enforce_bir_supersession_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_prev public.business_intelligence_reports%rowtype;
begin
  if tg_op = 'UPDATE' then
    -- Nothing the rule reads has moved. Redaction, and every other rewrite of
    -- the report body, passes straight through.
    if new.supersedes_bir_id is not distinct from old.supersedes_bir_id
       and new.business_id   is not distinct from old.business_id
       and new.review_type   is not distinct from old.review_type then
      return new;
    end if;
  end if;

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
  before insert or update on public.business_intelligence_reports
  for each row execute function public.enforce_bir_supersession_scope();

comment on function public.enforce_bir_supersession_scope is
  'Refuses a supersedes_bir_id pointing at another business or another review type, on INSERT and on any UPDATE that moves the chain, the business, or the review type. A Service Mix report may reference a Growth report; it may never supersede one.';

-- ------------------------------------------------------------
-- F6. "Callable by nobody" was never true of service_role
-- ------------------------------------------------------------
-- 0006 revokes its trigger and helper functions `from public, anon,
-- authenticated`, and tests/migration/0006-rpc-roles.test.mjs asserts that
-- service_role cannot execute any of them. Both are correct on PGlite, and
-- neither is correct on Supabase.
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC; a Supabase project
-- ALSO carries `alter default privileges in schema public grant all on
-- functions to postgres, anon, authenticated, service_role`, which is a
-- SEPARATE, DIRECT grant to each of those roles. Revoking from `public, anon,
-- authenticated` removes three of the four. service_role's direct grant is
-- untouched, and the test cannot see it, because the local fixture
-- (tests/helpers/local-pg.mjs :: bootstrapSupabaseRoles) creates the roles
-- without the default privileges that a real project has. The assertion passes
-- against an absence.
--
-- 0007 got this right — its `c_internal` loop revokes `from public, anon,
-- authenticated, service_role` — which is what makes this an inconsistency
-- with a known-correct side rather than a judgement call.
--
-- Why it is worth closing. Most of these are trigger functions, and a direct
-- grant on one is close to harmless: PostgreSQL checks EXECUTE at CREATE
-- TRIGGER, not when the trigger fires, and calling a trigger function directly
-- is refused for being called outside a trigger context. The ones that matter
-- are the four that are ordinary functions:
--
--   · identity_proposal_conflict answers "does this evidence contradict that
--     Business Record?" — one question at a time, with no operator guard in
--     front of it. 0006's own comment gives exactly this reason for refusing
--     it a grant, and then does not refuse it.
--   · identity_value_acceptable and identity_evidence_fault are the value and
--     shape contracts. They are not even NAMED in the test's list, so nothing
--     asserts anything about them at all.
--   · analytics_review_type is the one 0006 documents as internal in the same
--     breath as leaving it reachable.
--
-- The whole internal set is restated here, 0007's four included, so that one
-- place says the whole truth rather than two places each saying part of it.
-- Re-revoking a privilege nobody holds is a no-op.
--
-- The trigger functions are named with their signatures written out. PostgREST
-- resolves a function by its argument types, and so does `revoke`: a revoke on
-- the wrong overload revokes nothing.

do $$
declare
  v_signature text;
  -- Called only from inside a trigger, or from inside a SECURITY DEFINER
  -- function that runs them as the owner. Nothing outside needs to execute
  -- any of them, and that now includes the server credential.
  c_internal constant text[] := array[
    -- 0001
    'public.reject_mutation()',
    'public.touch_updated_at()',
    -- 0004
    'public.append_stage_timeline_events()',
    'public.append_bir_stage_event()',
    -- 0006
    'public.append_service_mix_timeline_event()',
    'public.append_service_mix_bir_event()',
    'public.enforce_bir_supersession_scope()',
    'public.enforce_growth_only_current_bir()',
    'public.analytics_review_type(text, text)',
    'public.identity_proposal_conflict(jsonb, uuid)',
    'public.identity_value_acceptable(text, text)',
    'public.identity_evidence_fault(jsonb)',
    -- 0007. Already correct; restated so this list is the complete one.
    'public.identity_case_eligible_targets(uuid)',
    'public.mask_contact_value(text)',
    'public.identity_resolution_replay(public.identity_resolution_requests, text, uuid)',
    'public.reject_case_evidence_change()'
  ];
begin
  foreach v_signature in array c_internal
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_signature);
  end loop;
end $$;

-- ------------------------------------------------------------
-- F7. Two helper functions never pinned their search_path
-- ------------------------------------------------------------
-- Every other function in the chain carries
-- `set search_path = pg_catalog, public, pg_temp`. These two — added by 0006
-- section 6a — do not, and they are the only two that do not.
--
-- They are `language sql` and SECURITY INVOKER, so this is a smaller hole than
-- an unpinned SECURITY DEFINER function would be: they run with the caller's
-- privileges, and after F6 above the only callers left are the owner, through
-- identity_proposal_conflict. Pinning is still right, for two reasons. A
-- function that resolves `length`, `jsonb_typeof` and `=` against whatever
-- search_path a future caller happens to have is a function whose meaning is
-- decided elsewhere; and a lone exception to a chain-wide convention is a
-- thing every later audit has to re-derive as deliberate.
--
-- `alter function … set` rather than `create or replace`: it pins the setting
-- and leaves the deployed body untouched, which is the right instrument when
-- the deployed body has not been compared against this repository. It is also
-- idempotent — setting the same value twice is the same catalog row.
--
-- KNOWN COST, accepted. A SQL function carrying a SET clause cannot be inlined
-- by the planner, so these become real per-row function calls instead of
-- folded-in expressions. Both call sites are bounded and small: one scans the
-- entries of a single submission's signal array, the other the active
-- identifiers of ONE business, already narrowed by
-- business_identifiers_lookup_idx. Neither is a table scan, and neither
-- depends on an expression index — no index in this schema is defined over
-- either function.
--
-- `public` is kept in the list although neither body references anything in
-- it, so that all seventeen functions in the chain carry one identical
-- setting. One convention is easier to audit than one convention and an
-- exception.

alter function public.identity_value_acceptable(text, text)
  set search_path = pg_catalog, public, pg_temp;

alter function public.identity_evidence_fault(jsonb)
  set search_path = pg_catalog, public, pg_temp;

-- ------------------------------------------------------------
-- Rerun safety
-- ------------------------------------------------------------
-- Every statement above is one of:
--   create or replace function
--   drop trigger if exists followed by create trigger
--   revoke (idempotent by definition)
--   alter function … set (idempotent by definition)
--   comment on
-- There is no DDL that adds, drops, or rewrites data, and nothing here can
-- fail differently on a second run than it did on the first.
