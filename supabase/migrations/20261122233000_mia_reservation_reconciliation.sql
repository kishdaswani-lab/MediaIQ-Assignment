-- Owner-authorized release of one unknown-billing reservation.
-- This migration does not call the function and does not change the live hold.
-- Unknown billing on the usage row stays unknown. Spent balances are not assigned.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

-- Counts rows for every owner. BYPASSRLS is confined to this nologin role.
-- mediaiq_evidence_owner remains subject to its owner-scoped policies.
-- claim_mia_dispatch is unchanged: its processing count stays owner-scoped,
-- and a non-zero reserved balance still blocks another claim.
create role mediaiq_mia_reservation_counter
  nologin
  noinherit
  bypassrls
  nocreaterole
  nocreatedb;

alter role mediaiq_mia_reservation_counter set search_path = '';
grant usage on schema private to mediaiq_mia_reservation_counter;

create table private.mia_reservation_reconciliation (
  accounting_ref uuid not null,
  attempt_number integer not null,
  owner_id uuid not null,
  php_released numeric not null,
  usd_released numeric not null,
  php_spent_observed numeric not null,
  usd_spent_observed numeric not null,
  reason_code text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint mia_reservation_reconciliation_pk primary key (accounting_ref, attempt_number),
  constraint mia_reservation_reconciliation_usage_fk
    foreign key (accounting_ref, attempt_number)
    references private.mia_usage (accounting_ref, attempt_number),
  constraint mia_reservation_reconciliation_attempt_check check (attempt_number = 1),
  constraint mia_reservation_reconciliation_amount_check check (php_released > 0 and usd_released > 0),
  constraint mia_reservation_reconciliation_spent_check check (
    php_spent_observed >= 0 and usd_spent_observed >= 0
  ),
  constraint mia_reservation_reconciliation_reason_check check (
    reason_code = 'owner_authorized_unknown_billing_release'
  )
);

comment on table private.mia_reservation_reconciliation is
  'Append-only owner decision to release an unknown-billing hold. It is not a provider receipt and it does not change the usage outcome.';

create function private.prevent_reservation_reconciliation_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'reservation reconciliation records are immutable'
    using errcode = '42501';
end;
$$;

create trigger mia_reservation_reconciliation_immutable
  before update or delete on private.mia_reservation_reconciliation
  for each row
  execute function private.prevent_reservation_reconciliation_mutation();

alter table private.mia_reservation_reconciliation enable row level security;
alter table private.mia_reservation_reconciliation force row level security;

revoke all on table private.mia_reservation_reconciliation
  from public, anon, authenticated, service_role, mediaiq_evidence_owner, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant select, insert on table private.mia_reservation_reconciliation to mediaiq_evidence_owner;

create policy mia_reservation_reconciliation_owner_select
  on private.mia_reservation_reconciliation
  for select
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_reservation_reconciliation_owner_insert
  on private.mia_reservation_reconciliation
  for insert
  to mediaiq_evidence_owner
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

grant select on table private.mia_usage to mediaiq_mia_reservation_counter;
grant select on table private.mia_reservation_reconciliation to mediaiq_mia_reservation_counter;

create function private.count_unreconciled_mia_usage()
returns table (
  unreconciled_unknown integer,
  processing_usage integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    (
      select count(*)::integer
      from private.mia_usage as usage
      where usage.billing_status = 'unknown'
        and not exists (
          select 1
          from private.mia_reservation_reconciliation as reconciliation
          where reconciliation.accounting_ref = usage.accounting_ref
            and reconciliation.attempt_number = usage.attempt_number
        )
    ),
    (
      select count(*)::integer
      from private.mia_usage as usage
      where usage.outcome = 'processing'
    );
end;
$$;

comment on function private.count_unreconciled_mia_usage() is
  'Returns only the unreconciled unknown count and the processing count. It does not return usage rows. claim_mia_dispatch does not call it.';

revoke all on function private.count_unreconciled_mia_usage()
  from public, anon, authenticated, service_role, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.count_unreconciled_mia_usage()
  to mediaiq_evidence_owner;

alter function private.count_unreconciled_mia_usage() owner to mediaiq_mia_reservation_counter;

create function private.reconcile_unknown_reservation(
  p_owner_id uuid,
  p_request_id uuid,
  p_php_amount numeric,
  p_usd_amount numeric,
  p_reason_code text
) returns table (
  reconciled boolean,
  already_recorded boolean,
  php_reserved numeric,
  usd_reserved numeric,
  php_spent numeric,
  usd_spent numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  budget private.mia_test_budget%rowtype;
  existing private.mia_reservation_reconciliation%rowtype;
  request_owner uuid;
  request_state text;
  usage_owner uuid;
  usage_outcome text;
  usage_billing text;
  open_unknown integer;
  processing_count integer;
  spent_php numeric;
  spent_usd numeric;
begin
  if p_owner_id is null or p_request_id is null or p_php_amount is null or p_usd_amount is null then
    raise exception 'reservation identity and amounts are required' using errcode = '22023';
  end if;
  if p_php_amount <= 0 or p_usd_amount <= 0 then
    raise exception 'reservation amounts must be positive' using errcode = '22023';
  end if;
  if p_reason_code is distinct from 'owner_authorized_unknown_billing_release' then
    raise exception 'reservation reason is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  select * into budget
  from private.mia_test_budget as account
  where account.singleton
  for update;

  if budget.singleton is distinct from true then
    raise exception 'testing budget is missing' using errcode = 'P0002';
  end if;

  select * into existing
  from private.mia_reservation_reconciliation as reconciliation
  where reconciliation.accounting_ref = p_request_id
    and reconciliation.attempt_number = 1;

  if found then
    if existing.owner_id is distinct from p_owner_id
      or existing.php_released is distinct from p_php_amount
      or existing.usd_released is distinct from p_usd_amount
      or existing.reason_code is distinct from p_reason_code
    then
      raise exception 'reconciliation does not match the recorded release' using errcode = '22023';
    end if;
    return query
    select true, true, budget.php_reserved, budget.usd_reserved, budget.php_spent, budget.usd_spent;
    return;
  end if;

  select request.owner_id, request.state
    into request_owner, request_state
  from private.mia_request as request
  where request.id = p_request_id
    and request.owner_id = p_owner_id
  for update;

  select usage.owner_id, usage.outcome, usage.billing_status
    into usage_owner, usage_outcome, usage_billing
  from private.mia_usage as usage
  where usage.accounting_ref = p_request_id
    and usage.attempt_number = 1
    and usage.owner_id = p_owner_id
  for update;

  if usage_owner is null then
    raise exception 'mia usage attempt was not found' using errcode = 'P0002';
  end if;
  if usage_outcome = 'processing' then
    raise exception 'a provider attempt is still processing' using errcode = '22023';
  end if;
  if usage_billing is distinct from 'unknown' then
    raise exception 'only unknown billing can be reconciled' using errcode = '22023';
  end if;
  if usage_outcome not in ('failed', 'timed_out', 'refused', 'reconciliation_required') then
    raise exception 'the usage outcome cannot be reconciled' using errcode = '22023';
  end if;
  -- A deleted evidence row cascades the request and leaves the usage row.
  -- The surviving usage row keeps the owner check. No request row is recreated.
  if request_owner is not null and request_state is distinct from usage_outcome then
    raise exception 'the usage outcome cannot be reconciled' using errcode = '22023';
  end if;

  select counts.unreconciled_unknown, counts.processing_usage
    into open_unknown, processing_count
  from private.count_unreconciled_mia_usage() as counts;

  if processing_count > 0 or open_unknown is distinct from 1 then
    raise exception 'the outstanding reservation cannot be attributed' using errcode = '22023';
  end if;
  if budget.php_reserved is distinct from budget.php_hold
    or budget.usd_reserved is distinct from budget.usd_hold
    or budget.php_hold is distinct from p_php_amount
    or budget.usd_hold is distinct from p_usd_amount
    or budget.php_hold <= 0
    or budget.usd_hold <= 0
  then
    raise exception 'the reservation does not match the authorized hold' using errcode = '22023';
  end if;

  spent_php := budget.php_spent;
  spent_usd := budget.usd_spent;

  insert into private.mia_reservation_reconciliation (
    accounting_ref,
    attempt_number,
    owner_id,
    php_released,
    usd_released,
    php_spent_observed,
    usd_spent_observed,
    reason_code
  ) values (
    p_request_id,
    1,
    p_owner_id,
    p_php_amount,
    p_usd_amount,
    spent_php,
    spent_usd,
    p_reason_code
  );

  update private.mia_test_budget as account
  set
    php_reserved = account.php_reserved - account.php_hold,
    usd_reserved = account.usd_reserved - account.usd_hold,
    php_hold = 0,
    usd_hold = 0
  where account.singleton
    and account.php_reserved = account.php_hold
    and account.usd_reserved = account.usd_hold
    and account.php_hold = p_php_amount
    and account.usd_hold = p_usd_amount;

  if not found then
    raise exception 'the reservation changed before release' using errcode = '22023';
  end if;

  select account.php_reserved, account.usd_reserved, account.php_spent, account.usd_spent
    into budget.php_reserved, budget.usd_reserved, budget.php_spent, budget.usd_spent
  from private.mia_test_budget as account
  where account.singleton;

  if budget.php_spent is distinct from spent_php
    or budget.usd_spent is distinct from spent_usd
    or budget.php_reserved <> 0
    or budget.usd_reserved <> 0
  then
    raise exception 'reservation release changed spent balances or left a remainder' using errcode = '22023';
  end if;

  return query
  select true, false, budget.php_reserved, budget.usd_reserved, budget.php_spent, budget.usd_spent;
end;
$$;

comment on function private.reconcile_unknown_reservation(uuid, uuid, numeric, numeric, text) is
  'Releases one attributed unknown-billing hold without changing spent balances or the historical usage row. A repeated call returns the recorded release and does not subtract again.';

revoke all on function private.reconcile_unknown_reservation(uuid, uuid, numeric, numeric, text)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.reconcile_unknown_reservation(uuid, uuid, numeric, numeric, text)
  to mediaiq_evidence_writer;

revoke all on function private.prevent_reservation_reconciliation_mutation()
  from public, anon, authenticated, service_role, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

alter table private.mia_reservation_reconciliation owner to mediaiq_evidence_owner;
alter function private.prevent_reservation_reconciliation_mutation() owner to mediaiq_evidence_owner;
alter function private.reconcile_unknown_reservation(uuid, uuid, numeric, numeric, text) owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
