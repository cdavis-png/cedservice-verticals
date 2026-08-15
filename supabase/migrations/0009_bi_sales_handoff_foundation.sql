-- ============================================================
-- 0009 — BI to Sales handoff foundation
-- ============================================================
-- RECONCILED, NOT PENDING. This file is a RECORD of a migration that has
-- ALREADY been applied to the hosted development project
-- (`qkpptajglstgucadhfwq`) and recorded in
-- `supabase_migrations.schema_migrations` at version `20260814182709`.
--
-- It was applied before it was committed. That is the wrong order and this
-- header exists so nobody has to guess which way round it happened. The SQL
-- below was recovered from `schema_migrations.statements` — it is what
-- actually ran, character for character, with only this comment block added.
-- It was NOT reconstructed from the live schema, and it was not rewritten to
-- match what a reviewer might have preferred.
--
-- DO NOT APPLY THIS FILE TO `qkpptajglstgucadhfwq`. The ledger row exists and
-- the objects exist. Applying it again fails at the first `create table`, and
-- the failure would be the harmless outcome — a partially-succeeding re-run
-- would be worse.
--
-- IT IS DELIBERATELY NOT RE-RUNNABLE, and that is a departure from the rule in
-- CLAUDE.md §14. Every `create table`, `create index` and `create trigger`
-- below is bare, with no `if not exists`. Making them re-runnable now would
-- mean this file no longer describes what ran, and a migration record that
-- flatters history is worse than one that admits an awkward shape. A fresh
-- database applies it exactly once, in order, and that is the only supported
-- use.
--
-- WHAT IT ESTABLISHES, and the boundary it is drawing:
--
--   Supabase owns business identity, research evidence, qualification
--   handoffs, cross-system links and historical milestones. GHL owns
--   communications, sales execution, current opportunity state, and
--   Won/Lost/client status. These four tables are the seam between them.
--   They are not a second CRM, and nothing here may become one.
--
--   Qualification and approval-to-pursue are SEPARATE human decisions, and
--   the schema refuses to let one imply the other:
--   `sales_handoffs_pursuit_requires_qualified` stops approval preceding
--   qualification, and `enforce_external_record_link_handoff` refuses an
--   Opportunity link unless BOTH have happened.
--
--   No trigger here calls GHL. Nothing in this file reaches outside the
--   database; the promotion boundary is server-side by design.
--
-- ON THE LEGACY `lead_assessed` ROWS: 14 exist and they are ambiguous —
-- nobody can now say whether a given row was a researched entity or a
-- qualified lead. They are left exactly as they are. The check constraint
-- still ADMITS the value so those rows stay valid; the trigger blocks only
-- NEW assignment. Mass-converting them would invent a decision that was
-- never made.

-- ------------------------------------------------------------
-- Business Record lifecycle semantics
-- ------------------------------------------------------------

-- Correct Business Record lifecycle semantics without rewriting ambiguous legacy rows.
alter table public.business_records
  alter column lifecycle_state set default 'business_record';

comment on column public.business_records.lifecycle_state is
  'BI/entity lifecycle only. Allowed current values: business_record, researched, inactive, merged. Legacy lead_assessed rows are ambiguous and must be reviewed individually; lead_assessed is blocked for new assignments.';

alter table public.business_records
  add constraint business_records_lifecycle_state_check
  check (lifecycle_state in ('lead_assessed','business_record','researched','inactive','merged'));

create or replace function public.enforce_business_record_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.lifecycle_state = 'lead_assessed' then
    raise exception 'lead_assessed is a legacy ambiguous value and cannot be assigned to a new Business Record'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and new.lifecycle_state = 'lead_assessed'
     and old.lifecycle_state is distinct from new.lifecycle_state then
    raise exception 'lead_assessed is a legacy ambiguous value and cannot be assigned'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger business_records_lifecycle_semantics
before insert or update of lifecycle_state on public.business_records
for each row execute function public.enforce_business_record_lifecycle();

-- The assessment ingester explicitly used the old sales-like lifecycle term.
-- Replace only that guarded literal; preserve every identity-resolution safeguard.
do $migration$
declare
  v_oid oid;
  v_definition text;
  v_old text := 'v_vertical_id, ''lead_assessed'', v_now, v_now,';
  v_new text := 'v_vertical_id, ''researched'', v_now, v_now,';
begin
  select p.oid, pg_get_functiondef(p.oid)
    into v_oid, v_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'ingest_review'
     and p.prokind = 'f';

  if v_oid is null then
    raise exception 'public.ingest_review was not found';
  end if;

  if position(v_old in v_definition) = 0 then
    raise exception 'expected legacy lifecycle assignment was not found in public.ingest_review';
  end if;

  if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'expected exactly one legacy lifecycle assignment in public.ingest_review';
  end if;

  execute replace(v_definition, v_old, v_new);
end
$migration$;

-- ------------------------------------------------------------
-- sales_handoffs — the qualification decision
-- ------------------------------------------------------------

create table public.sales_handoffs (
  handoff_id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_records(business_id),
  need_key text not null,
  need_summary text not null,
  offer_key text,
  qualification_status text not null,
  evidence_references jsonb not null default '[]'::jsonb,
  confidence numeric(3,2) not null,
  decision_reason text not null,
  qualified_by uuid not null references public.staff_operators(user_id),
  qualified_at timestamptz not null,
  disqualification_reason text,
  pursuit_approved_by uuid references public.staff_operators(user_id),
  pursuit_approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sales_handoffs_need_key_format
    check (need_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
  constraint sales_handoffs_offer_key_format
    check (offer_key is null or offer_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
  constraint sales_handoffs_need_summary_present
    check (length(btrim(need_summary)) between 1 and 500),
  constraint sales_handoffs_qualification_status
    check (qualification_status in ('qualified','not_qualified','deferred','withdrawn')),
  constraint sales_handoffs_evidence_array
    check (jsonb_typeof(evidence_references) = 'array'),
  constraint sales_handoffs_qualified_evidence
    check (qualification_status <> 'qualified' or jsonb_array_length(evidence_references) > 0),
  constraint sales_handoffs_confidence_range
    check (confidence >= 0 and confidence <= 1),
  constraint sales_handoffs_decision_reason_present
    check (length(btrim(decision_reason)) between 1 and 1000),
  constraint sales_handoffs_disqualification_reason
    check (
      qualification_status <> 'not_qualified'
      or length(btrim(coalesce(disqualification_reason, ''))) > 0
    ),
  constraint sales_handoffs_pursuit_approval_pair
    check ((pursuit_approved_by is null) = (pursuit_approved_at is null)),
  constraint sales_handoffs_pursuit_requires_qualified
    check (pursuit_approved_at is null or qualification_status = 'qualified')
);

comment on table public.sales_handoffs is
  'Auditable human-controlled BI-to-sales decisions. A qualified handoff makes a Lead; pursuit_approved_at is the separate decision that permits an Opportunity.';
comment on column public.sales_handoffs.evidence_references is
  'Array of stable references to BI reports, observations, sources, or timeline evidence; do not copy large evidence bodies here.';
comment on column public.sales_handoffs.pursuit_approved_at is
  'Separate human approval required before creating a GHL Opportunity. Qualification alone is insufficient.';

create unique index sales_handoffs_business_need_offer_uidx
  on public.sales_handoffs (business_id, need_key, coalesce(offer_key, ''));
create index sales_handoffs_business_idx
  on public.sales_handoffs (business_id, qualified_at desc);
create index sales_handoffs_status_idx
  on public.sales_handoffs (qualification_status, pursuit_approved_at);

create trigger sales_handoffs_touch
before update on public.sales_handoffs
for each row execute function public.touch_updated_at();

create or replace function public.enforce_sales_handoff_identity_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.business_id is distinct from old.business_id
     or new.need_key is distinct from old.need_key
     or new.offer_key is distinct from old.offer_key then
    raise exception 'A sales handoff business/need/offer identity is immutable; create a new handoff decision instead'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sales_handoffs_identity_immutable
before update of business_id, need_key, offer_key on public.sales_handoffs
for each row execute function public.enforce_sales_handoff_identity_immutable();

create trigger sales_handoffs_no_delete
before delete on public.sales_handoffs
for each row execute function public.reject_mutation();

-- ------------------------------------------------------------
-- external_record_links — the cross-system seam
-- ------------------------------------------------------------

create table public.external_record_links (
  link_id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_records(business_id),
  external_system text not null,
  external_account_key text not null,
  record_type text not null,
  external_record_id text not null,
  handoff_id uuid references public.sales_handoffs(handoff_id),
  is_active boolean not null default true,
  linked_at timestamptz not null default now(),
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint external_record_links_system
    check (external_system = 'ghl'),
  constraint external_record_links_type
    check (record_type in ('contact','opportunity')),
  constraint external_record_links_ids_present
    check (
      length(btrim(external_account_key)) > 0
      and length(btrim(external_record_id)) > 0
    ),
  constraint external_record_links_opportunity_handoff
    check (record_type <> 'opportunity' or handoff_id is not null),
  constraint external_record_links_deactivation
    check (
      (is_active and deactivated_at is null)
      or (not is_active and deactivated_at is not null)
    )
);

comment on table public.external_record_links is
  'Cross-system identity links only. GHL contact/opportunity IDs do not belong in business_identifiers.';
comment on column public.external_record_links.is_active is
  'For opportunities, true mirrors an open GHL opportunity; false preserves the historical link after Won/Lost/Abandoned.';

create unique index external_record_links_external_uidx
  on public.external_record_links
  (external_system, external_account_key, record_type, external_record_id);

create unique index external_record_links_active_contact_uidx
  on public.external_record_links
  (business_id, external_system, external_account_key)
  where record_type = 'contact' and is_active;

create unique index external_record_links_active_opportunity_uidx
  on public.external_record_links (handoff_id)
  where record_type = 'opportunity' and is_active;

create index external_record_links_business_idx
  on public.external_record_links (business_id, record_type, is_active);
create index external_record_links_handoff_idx
  on public.external_record_links (handoff_id)
  where handoff_id is not null;

create trigger external_record_links_touch
before update on public.external_record_links
for each row execute function public.touch_updated_at();

create trigger external_record_links_no_delete
before delete on public.external_record_links
for each row execute function public.reject_mutation();

create or replace function public.enforce_external_record_link_handoff()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_business_id uuid;
  v_status text;
  v_pursuit_approved_at timestamptz;
begin
  if new.handoff_id is not null then
    select business_id, qualification_status, pursuit_approved_at
      into v_business_id, v_status, v_pursuit_approved_at
      from public.sales_handoffs
     where handoff_id = new.handoff_id;

    if not found then
      raise exception 'Unknown sales handoff'
        using errcode = '23503';
    end if;

    if v_business_id is distinct from new.business_id then
      raise exception 'External record link business does not match its sales handoff'
        using errcode = '23514';
    end if;

    if new.record_type = 'opportunity'
       and (v_status <> 'qualified' or v_pursuit_approved_at is null) then
      raise exception 'A GHL Opportunity requires a qualified handoff and separate pursuit approval'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger external_record_links_handoff_guard
before insert or update of business_id, record_type, handoff_id
on public.external_record_links
for each row execute function public.enforce_external_record_link_handoff();

-- ------------------------------------------------------------
-- sales_promotion_requests — idempotency and in-process locking
-- ------------------------------------------------------------

create table public.sales_promotion_requests (
  promotion_request_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  handoff_id uuid not null references public.sales_handoffs(handoff_id),
  request_hash text not null,
  create_opportunity boolean not null default false,
  status text not null default 'processing',
  response_body jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint sales_promotion_requests_idempotency_present
    check (length(btrim(idempotency_key)) between 1 and 200),
  constraint sales_promotion_requests_hash
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint sales_promotion_requests_status
    check (status in ('processing','completed','failed')),
  constraint sales_promotion_requests_completion
    check (
      (status = 'processing' and completed_at is null)
      or (status in ('completed','failed') and completed_at is not null)
    )
);

comment on table public.sales_promotion_requests is
  'Idempotency and concurrency ledger for the server-side Promote to Sales operation.';

create unique index sales_promotion_requests_idempotency_uidx
  on public.sales_promotion_requests (idempotency_key);
create unique index sales_promotion_requests_one_processing_uidx
  on public.sales_promotion_requests (handoff_id)
  where status = 'processing';
create index sales_promotion_requests_handoff_idx
  on public.sales_promotion_requests (handoff_id, created_at desc);

create trigger sales_promotion_requests_no_delete
before delete on public.sales_promotion_requests
for each row execute function public.reject_mutation();

-- ------------------------------------------------------------
-- crm_webhook_receipts — inbound delivery ledger
-- ------------------------------------------------------------

create table public.crm_webhook_receipts (
  receipt_id uuid primary key default gen_random_uuid(),
  external_system text not null,
  delivery_key text not null,
  payload_hash text not null,
  event_type text not null,
  external_record_id text,
  event_occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received',
  rejection_reason text,

  constraint crm_webhook_receipts_system
    check (external_system = 'ghl'),
  constraint crm_webhook_receipts_delivery_key_present
    check (length(btrim(delivery_key)) between 1 and 200),
  constraint crm_webhook_receipts_payload_hash
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint crm_webhook_receipts_event_type_present
    check (length(btrim(event_type)) between 1 and 160),
  constraint crm_webhook_receipts_status
    check (processing_status in ('received','processed','ignored','rejected')),
  constraint crm_webhook_receipts_processing
    check (
      (processing_status = 'received' and processed_at is null)
      or (processing_status in ('processed','ignored','rejected') and processed_at is not null)
    ),
  constraint crm_webhook_receipts_rejection
    check (
      processing_status <> 'rejected'
      or length(btrim(coalesce(rejection_reason, ''))) > 0
    )
);

comment on table public.crm_webhook_receipts is
  'Minimal webhook delivery ledger for deduplication, replay detection, and reconciliation. Raw CRM payloads are intentionally not retained here.';

create unique index crm_webhook_receipts_delivery_uidx
  on public.crm_webhook_receipts (external_system, delivery_key);
create index crm_webhook_receipts_record_idx
  on public.crm_webhook_receipts
  (external_system, external_record_id, event_occurred_at desc)
  where external_record_id is not null;

create trigger crm_webhook_receipts_no_delete
before delete on public.crm_webhook_receipts
for each row execute function public.reject_mutation();

-- ------------------------------------------------------------
-- Access — internal, server-only, no public policy
-- ------------------------------------------------------------
-- RLS is enabled with NO policies, exactly as every table since 0001. These
-- four are reached only by the service role from a Vercel Function. The
-- absence of a policy is the design, not an oversight: the security advisor
-- reports `rls_enabled_no_policy` at INFO for each and that is the expected
-- reading.

alter table public.sales_handoffs enable row level security;
alter table public.external_record_links enable row level security;
alter table public.sales_promotion_requests enable row level security;
alter table public.crm_webhook_receipts enable row level security;

revoke all on table public.sales_handoffs from public, anon, authenticated;
revoke all on table public.external_record_links from public, anon, authenticated;
revoke all on table public.sales_promotion_requests from public, anon, authenticated;
revoke all on table public.crm_webhook_receipts from public, anon, authenticated;

grant select, insert, update on table public.sales_handoffs to service_role;
grant select, insert, update on table public.external_record_links to service_role;
grant select, insert, update on table public.sales_promotion_requests to service_role;
grant select, insert, update on table public.crm_webhook_receipts to service_role;

-- No DELETE is granted anywhere above, and each table additionally carries a
-- `before delete` trigger routed to `reject_mutation()`. Two layers, because
-- a grant can be changed by a later migration and the trigger states the
-- intent in the schema itself.

comment on table public.timeline_events is
  'Append-only history. Sales milestones supported: sales.lead_qualified, sales.handoff_approved, crm.contact_linked, sales.opportunity_created, sales.outreach_started, sales.artifact_delivered, sales.proposal_sent, sales.won, sales.lost, sales.disqualified. GHL remains authoritative for current opportunity state.';
