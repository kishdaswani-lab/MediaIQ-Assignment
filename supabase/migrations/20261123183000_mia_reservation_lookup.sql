-- Owner-scoped lookup of one eligible unknown-billing reservation.
-- This migration does not call reconciliation and does not change a hold.

create role mediaiq_mia_reservation_reader
  nologin
  noinherit
  bypassrls
  nocreaterole
  nocreatedb;

alter role mediaiq_mia_reservation_reader set search_path = '';
grant usage on schema private to mediaiq_mia_reservation_reader;

grant select (
  accounting_ref,
  attempt_number,
  owner_id,
  outcome,
  billing_status
) on table private.mia_usage to mediaiq_mia_reservation_reader;

grant select (
  id,
  owner_id,
  state
) on table private.mia_request to mediaiq_mia_reservation_reader;

grant select (
  singleton,
  php_reserved,
  php_hold,
  usd_reserved,
  usd_hold
) on table private.mia_test_budget to mediaiq_mia_reservation_reader;

grant select (
  accounting_ref,
  attempt_number
) on table private.mia_reservation_reconciliation to mediaiq_mia_reservation_reader;

create function private.list_eligible_mia_reservations(p_owner_id uuid)
returns table (
  request_id uuid,
  attempt_number integer,
  billing_status text,
  php_amount text,
  usd_amount text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null then
    raise exception 'reservation owner is required' using errcode = '22023';
  end if;

  return query
  select
    usage.accounting_ref,
    usage.attempt_number,
    usage.billing_status,
    budget.php_hold::text,
    budget.usd_hold::text
  from private.mia_usage as usage
  left join private.mia_request as request
    on request.id = usage.accounting_ref
   and request.owner_id = usage.owner_id
  join private.mia_test_budget as budget
    on budget.singleton
  where usage.owner_id = p_owner_id
    and usage.attempt_number = 1
    and usage.billing_status = 'unknown'
    and usage.outcome in ('failed', 'timed_out', 'refused', 'reconciliation_required')
    and (request.id is null or request.state = usage.outcome)
    and budget.php_reserved = budget.php_hold
    and budget.usd_reserved = budget.usd_hold
    and budget.php_hold > 0
    and budget.usd_hold > 0
    and not exists (
      select 1
      from private.mia_reservation_reconciliation as reconciliation
      where reconciliation.accounting_ref = usage.accounting_ref
        and reconciliation.attempt_number = usage.attempt_number
    )
    and (
      select count(*)::integer
      from private.mia_usage as open_usage
      where open_usage.billing_status = 'unknown'
        and not exists (
          select 1
          from private.mia_reservation_reconciliation as recorded
          where recorded.accounting_ref = open_usage.accounting_ref
            and recorded.attempt_number = open_usage.attempt_number
        )
    ) = 1
    and (
      select count(*)::integer
      from private.mia_usage as processing_usage
      where processing_usage.outcome = 'processing'
    ) = 0;
end;
$$;

comment on function private.list_eligible_mia_reservations(uuid) is
  'Returns the caller owner''s eligible unknown-billing hold as decimal text. It does not release the hold or return another owner''s request.';

revoke all on function private.list_eligible_mia_reservations(uuid)
  from public, anon, authenticated, service_role, mediaiq_evidence_owner,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.list_eligible_mia_reservations(uuid)
  to mediaiq_evidence_writer;

alter function private.list_eligible_mia_reservations(uuid) owner to mediaiq_mia_reservation_reader;
