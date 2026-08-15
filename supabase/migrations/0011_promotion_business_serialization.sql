-- ============================================================
-- 0011 — business-level serialization for Promote to Sales
-- ============================================================
-- FORWARD-ONLY. It rewrites no history and touches neither 0009 nor 0010.
--
-- NOT YET APPLIED. Unlike 0009 and 0010, this file is pending work. Apply it
-- through the tracked `apply_migration` operation described in CLAUDE.md §14
-- and docs/SUPABASE_SETUP.md §2, with explicit human authorization immediately
-- beforehand. Every statement below is re-runnable.
--
-- ------------------------------------------------------------
-- THE DEFECT
-- ------------------------------------------------------------
-- 0009 gave `sales_promotion_requests` this index:
--
--     sales_promotion_requests_one_processing_uidx
--       on (handoff_id) where status = 'processing'
--
-- which serializes promotions PER HANDOFF. That is not the unit that
-- matters. A GHL contact belongs to a BUSINESS, not to a handoff, and a
-- business can legitimately have several handoffs — one per need/offer,
-- which is exactly what `sales_handoffs_business_need_offer_uidx` is shaped
-- to allow.
--
-- So two DIFFERENT handoffs for the SAME business can be promoted at the same
-- instant. Both pass the per-handoff index. Both then reach the step that
-- resolves a contact, and the sequence is:
--
--     A: no link found -> search GHL by CED Business ID -> no match
--     B: no link found -> search GHL by CED Business ID -> no match
--     A: create contact                                  -> contact 1
--     B: create contact                                  -> contact 2   <-- duplicate
--
-- `external_record_links_active_contact_uidx` catches the SECOND link insert,
-- so Supabase never holds two active contact links. That is the protection
-- working, and it arrives one step too late: the duplicate contact already
-- exists in GHL, and the promotion that created it fails after the write.
-- The result is an orphaned CRM contact and a failed request, which is the
-- worst of both — the CRM is dirty and the caller was told it did not work.
--
-- GHL'S OWN DEDUPLICATION DOES NOT COVER THIS. The location sets
-- `allowDuplicateContact: false` and deduplicates on email, then phone. A
-- business discovered by BI research frequently has neither at the moment it
-- is promoted — that is what makes it researched outbound rather than an
-- inbound enquiry. With both absent there is nothing for GHL to match on and
-- two contacts are created.
--
-- ------------------------------------------------------------
-- WHY A ROW AND NOT A LOCK
-- ------------------------------------------------------------
-- The obvious instrument is `pg_advisory_xact_lock(hashtext(business_id))`
-- taken in the promotion path. It does not work in this architecture, and the
-- reason is worth recording so nobody reaches for it again.
--
-- A transaction-scoped advisory lock is released when its transaction ends.
-- The promotion boundary reaches Postgres through PostgREST, where each call
-- is its own transaction, and the window that needs guarding SPANS SEVERAL
-- CALLS with outbound HTTP to GHL in the middle. The lock would be released
-- at the end of the statement that took it, long before the contact is
-- created. A session-scoped lock is worse: PostgREST pools connections, so
-- the session is not the request, and a leaked lock would wedge a pooled
-- connection for every later caller.
--
-- The mutual exclusion therefore has to be durable state that outlives a
-- statement. `sales_promotion_requests` already IS that state — it is the
-- in-process ledger. It simply records the wrong grain.
--
-- ------------------------------------------------------------
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
-- ------------------------------------------------------------
-- It does NOT stop a business having several handoffs, and it does not stop
-- them all being promoted. It stops them being promoted CONCURRENTLY. The
-- second caller is refused immediately with a retryable conflict; by the time
-- it retries the first has completed, the contact link exists, and the retry
-- resolves the existing contact instead of creating one. Serialized, not
-- excluded.
--
-- Fail-fast rather than block, because this runs in a Vercel Function with a
-- 15-second ceiling: waiting on a lock spends the caller's whole budget doing
-- nothing, and a queue of blocked invocations is how a slow CRM becomes an
-- outage.

-- ------------------------------------------------------------
-- 1. Carry the business on the request
-- ------------------------------------------------------------
-- Denormalised from the handoff deliberately: a partial unique index cannot
-- reach through a foreign key, so the column that constrains concurrency has
-- to live on the row being constrained. The trigger below is what keeps the
-- copy honest.

alter table public.sales_promotion_requests
  add column if not exists business_id uuid references public.business_records(business_id);

comment on column public.sales_promotion_requests.business_id is
  'Denormalised from the handoff so business-level concurrency can be enforced by a partial unique index. Verified against the handoff by enforce_promotion_request_business(); never set independently.';

-- The table is empty on the development project, so there is nothing to
-- backfill. This statement is here so the migration is correct against any
-- database where it is not — it must run BEFORE the not-null constraint.
update public.sales_promotion_requests r
   set business_id = h.business_id
  from public.sales_handoffs h
 where h.handoff_id = r.handoff_id
   and r.business_id is null;

alter table public.sales_promotion_requests
  alter column business_id set not null;

-- ------------------------------------------------------------
-- 2. Keep the denormalised copy truthful
-- ------------------------------------------------------------
-- A denormalised column that nothing checks is a column that will eventually
-- disagree with its source, and this one decides whether two CRM writes may
-- run at once. The trigger refuses a mismatch rather than silently correcting
-- it: a caller passing the wrong business is a bug worth surfacing, and
-- quietly rewriting the value would hide it.

create or replace function public.enforce_promotion_request_business()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_business_id uuid;
begin
  select business_id into v_business_id
    from public.sales_handoffs
   where handoff_id = new.handoff_id;

  if not found then
    raise exception 'Unknown sales handoff'
      using errcode = '23503';
  end if;

  if new.business_id is distinct from v_business_id then
    raise exception 'Promotion request business does not match its sales handoff'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists sales_promotion_requests_business_guard
  on public.sales_promotion_requests;

create trigger sales_promotion_requests_business_guard
before insert or update of business_id, handoff_id
on public.sales_promotion_requests
for each row execute function public.enforce_promotion_request_business();

-- ------------------------------------------------------------
-- 3. One promotion in flight per business
-- ------------------------------------------------------------
-- The per-handoff index from 0009 is NOT dropped. The two answer different
-- questions and both are wanted: this one prevents two businesses' worth of
-- CRM writes racing, and the original still prevents the same handoff being
-- promoted twice concurrently, which would be a duplicate OPPORTUNITY rather
-- than a duplicate contact.

create unique index if not exists sales_promotion_requests_one_business_processing_uidx
  on public.sales_promotion_requests (business_id)
  where status = 'processing';

comment on index public.sales_promotion_requests_one_business_processing_uidx is
  'At most one in-flight promotion per business. Two handoffs for one business are serialized rather than excluded: the second is refused with a retryable conflict and resolves the existing contact link on retry.';

-- Supporting index for the reconciliation read "what has been promoted for
-- this business", which is otherwise a sequential scan once the ledger grows.
create index if not exists sales_promotion_requests_business_idx
  on public.sales_promotion_requests (business_id, created_at desc);

-- ------------------------------------------------------------
-- 4. RLS is FORCED, not merely enabled
-- ------------------------------------------------------------
-- A SECOND DEFECT IN 0009, found by tests/migration/0006-clean-install, which
-- asserts the invariant CLAUDE.md §12 states without qualification: RLS is
-- enabled and FORCED with no policies, exactly as every table since 0001.
--
-- 0009 wrote `enable row level security` and stopped there. Confirmed against
-- the hosted development project: `business_records`, `timeline_events` and
-- `staff_operators` all report relforcerowsecurity = true, and all four tables
-- 0009 created report FALSE.
--
-- WHAT THE GAP ACTUALLY IS, stated precisely rather than alarmingly. ENABLE
-- applies RLS to ordinary roles; it does NOT apply to the table's OWNER, which
-- is exempt until RLS is FORCED. `anon` and `authenticated` were never able to
-- reach these tables — they hold no grant at all, which
-- tests/migration/0007-anon-grants proves for the staff surface and the
-- revokes in 0009 repeat here. So this is not a live exposure through the
-- publishable key.
--
-- It matters anyway, for the reason the invariant exists: the owner is the
-- role migrations and maintenance run as, and "every table in this schema
-- behaves the same way" is what makes the rule checkable. One table that is
-- enabled-but-not-forced is the one nobody remembers when a policy is finally
-- added, and a policy added to an unforced table silently does not apply to
-- the role most likely to be running the query.
--
-- Re-runnable, and narrow: it changes a flag and touches no definition, no
-- grant and no data.

alter table public.sales_handoffs force row level security;
alter table public.external_record_links force row level security;
alter table public.sales_promotion_requests force row level security;
alter table public.crm_webhook_receipts force row level security;
