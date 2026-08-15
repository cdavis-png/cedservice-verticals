-- ============================================================
-- 0010 — sales handoff foreign-key indexes
-- ============================================================
-- RECONCILED, NOT PENDING. Already applied to the hosted development project
-- (`qkpptajglstgucadhfwq`) and recorded in
-- `supabase_migrations.schema_migrations` at version `20260814182839`. The SQL
-- below was recovered from `schema_migrations.statements`; only this comment
-- block was added. See the header of 0009 for the full explanation of why
-- these two files are records rather than pending work.
--
-- DO NOT APPLY THIS FILE TO `qkpptajglstgucadhfwq`. Both indexes exist.
--
-- WHY IT EXISTS. 0009 gave `sales_handoffs` two foreign keys into
-- `staff_operators` — `qualified_by` and `pursuit_approved_by` — and indexed
-- neither. An unindexed foreign key makes the REFERENCED side slow to change:
-- every `staff_operators` update or delete has to scan `sales_handoffs` to
-- check the constraint. Operator revocation is exactly that kind of write, and
-- it is the one that must not be slow, because §12 makes authorization a live
-- lookup and revocation is expected to take effect on the next request.
--
-- The second index is PARTIAL because `pursuit_approved_by` is null for every
-- handoff that has been qualified but not yet approved for pursuit — which is
-- the normal resting state, and by design the majority of rows. Indexing the
-- nulls would store the common case to answer a question nobody asks.
-- `qualified_by` is `not null` on the table, so its index is unconditional.

create index sales_handoffs_qualified_by_idx
  on public.sales_handoffs (qualified_by);
create index sales_handoffs_pursuit_approved_by_idx
  on public.sales_handoffs (pursuit_approved_by)
  where pursuit_approved_by is not null;
