-- Reservation reconciliation fixture. Rolls back.
-- Run only against a disposable database that has the schema and this migration
-- and does not contain the live MediaIQ reservation. The guard below refuses a
-- database that already has a hold or an unknown usage row.
--
-- Setup, from the repository root, against the disposable server only:
--   docker run --name mediaiq_reconcile_fixture --rm -d --publish 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
--   Apply supabase/tests/mia_reconcile_fixture_bootstrap.sql, then every file in supabase/migrations, in filename order.
-- Test:
--   Get-Content -Raw -Encoding utf8 supabase/tests/mia_reservation_reconciliation.sql | docker exec -i mediaiq_reconcile_fixture psql -U postgres -d postgres -v ON_ERROR_STOP=1
-- Cleanup:
--   docker rm -f mediaiq_reconcile_fixture
--
-- Do not point this file at supabase_db_MediaIQ.

begin;

do $$
declare
  owner uuid := '14141414-1414-4141-8141-141414141414';
  other_owner uuid := '15151515-1515-4151-8151-151515151515';
  evidence_id uuid;
  replacement_evidence uuid;
  target_request uuid;
  second_request uuid;
  fixture_php numeric;
  fixture_usd numeric;
  spent_php numeric;
  spent_usd numeric;
  released record;
  replay record;
  claimed record;
  usage_outcome text;
  usage_billing text;
  transport_outcome text;
  http_received boolean;
  http_status integer;
  stored_request_id text;
  usage_validated boolean;
  reconciliation_rows integer;
  request_rows integer;
  revoked_role text;
  revoked_roles text[] := array[
    'public', 'anon', 'authenticated', 'service_role',
    'mediaiq_security_owner', 'mediaiq_security_writer',
    'mediaiq_security_maintainer', 'mediaiq_security_operator'
  ];
begin
  if pg_catalog.to_regprocedure('private.reconcile_unknown_reservation(uuid,uuid,numeric,numeric,text)') is null
    or pg_catalog.to_regprocedure('private.count_unreconciled_mia_usage()') is null
  then
    raise exception 'migration is not applied; reconciliation fixture tests were not run';
  end if;

  foreach revoked_role in array revoked_roles loop
    if pg_catalog.has_function_privilege(revoked_role, 'private.reconcile_unknown_reservation(uuid,uuid,numeric,numeric,text)', 'execute')
      or pg_catalog.has_function_privilege(revoked_role, 'private.count_unreconciled_mia_usage()', 'execute')
    then
      raise exception 'revoked role % can execute reconciliation', revoked_role;
    end if;
  end loop;

  if not pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.reconcile_unknown_reservation(uuid,uuid,numeric,numeric,text)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.count_unreconciled_mia_usage()', 'execute')
    or not pg_catalog.has_function_privilege('mediaiq_evidence_owner', 'private.count_unreconciled_mia_usage()', 'execute')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_test_budget', 'update')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_usage', 'select')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_reservation_reconciliation', 'select')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_reservation_reconciliation', 'update')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_reservation_reconciliation', 'delete')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_reservation_reconciliation', 'truncate')
  then
    raise exception 'reconciliation privileges are wrong';
  end if;

  if exists (
    select 1 from private.mia_test_budget
    where php_reserved <> 0 or usd_reserved <> 0 or php_hold <> 0 or usd_hold <> 0
  ) or exists (
    select 1 from private.mia_usage
    where billing_status = 'unknown' or outcome = 'processing'
  ) then
    raise exception 'live reservation or unknown usage exists; reconciliation fixture tests were not run';
  end if;

  insert into private.mia_approved_provider (singleton, provider, model)
  values (true, 'openai', 'gpt-6-luna');

  update private.mia_test_budget
  set
    php_per_million_uncached_input = 7.04,
    php_per_million_cached_input = 0.704,
    php_per_million_output = 35.20,
    usd_per_million_uncached_input = 0.10,
    usd_per_million_cached_input = 0.01,
    usd_per_million_output = 0.50
  where singleton;

  select php_spent, usd_spent into spent_php, spent_usd
  from private.mia_test_budget
  where singleton;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    owner,
    'authenticated', 'authenticated',
    'mia-reconciliation@mia-reconciliation-test.mediaiq.invalid',
    '', pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    pg_catalog.now(), pg_catalog.now(), '', '', '', ''
  ), (
    '00000000-0000-0000-0000-000000000000',
    other_owner,
    'authenticated', 'authenticated',
    'mia-reconciliation-other@mia-reconciliation-test.mediaiq.invalid',
    '', pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    pg_catalog.now(), pg_catalog.now(), '', '', '', ''
  );

  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"1.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  target_request := (
    select opened.request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'reconcile-fixture', repeat('c', 64), 'What is spend?'
    ) as opened
  );
  select * into claimed
  from private.claim_mia_dispatch(owner, target_request);
  reset role;

  if claimed.authorized is distinct from true or claimed.state is distinct from 'processing' then
    raise exception 'fixture claim was not authorized';
  end if;

  set local role mediaiq_evidence_writer;
  begin
    update private.mia_test_budget set php_spent = php_spent where singleton;
    raise exception 'writer updated the budget';
  exception
    when insufficient_privilege then
      null;
  end;
  begin
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, 1, 1, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'processing usage was released';
  exception
    when sqlstate '22023' then
      null;
  end;
  reset role;

  update private.mia_request
  set state = 'failed', failure_category = 'provider_error', completed_at = pg_catalog.now()
  where id = target_request
    and state = 'processing';
  update private.mia_usage
  set
    outcome = 'failed',
    transport_outcome = 'network',
    http_response_received = false,
    http_status = null,
    provider_request_id = null,
    usage_validated = false
  where accounting_ref = target_request
    and outcome = 'processing'
    and billing_status = 'unknown';

  select php_hold, usd_hold into fixture_php, fixture_usd
  from private.mia_test_budget
  where singleton;

  set local role mediaiq_evidence_writer;
  begin
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, fixture_php + 1, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'a different amount was released';
  exception
    when sqlstate '22023' then
      null;
  end;
  begin
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, fixture_php, fixture_usd, 'owner_authorized_no_provider_charge'
    );
    raise exception 'a different reason was released';
  exception
    when sqlstate '22023' then
      null;
  end;
  begin
    perform * from private.reconcile_unknown_reservation(
      other_owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'another owner released the reservation';
  exception
    when sqlstate 'P0002' then
      null;
  end;
  begin
    perform * from private.reconcile_unknown_reservation(
      owner, '16161616-1616-4161-8161-161616161616', fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'a missing request was released';
  exception
    when sqlstate 'P0002' then
      null;
  end;
  reset role;

  begin
    update private.mia_usage
    set billing_status = 'reported', actual_cost = 0
    where accounting_ref = target_request;
    set local role mediaiq_evidence_writer;
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'reported billing was released';
  exception
    when sqlstate '22023' then
      null;
  end;
  reset role;

  begin
    insert into private.mia_usage (
      accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
    ) values (
      '17171717-1717-4171-8171-171717171717', owner, 1, 'openai', 'gpt-6-luna', 'failed', 'unknown'
    );
    set local role mediaiq_evidence_writer;
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'two unknown rows for one owner were released';
  exception
    when sqlstate '22023' then
      null;
  end;
  reset role;

  begin
    insert into private.mia_usage (
      accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
    ) values (
      '18181818-1818-4181-8181-181818181818', other_owner, 1, 'openai', 'gpt-6-luna', 'failed', 'unknown'
    );
    set local role mediaiq_evidence_writer;
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'another owner unknown usage was ignored';
  exception
    when sqlstate '22023' then
      null;
  end;
  reset role;

  begin
    update private.mia_test_budget
    set php_reserved = php_hold + 1
    where singleton;
    set local role mediaiq_evidence_writer;
    perform * from private.reconcile_unknown_reservation(
      owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
    );
    raise exception 'reserved above hold was released';
  exception
    when sqlstate '22023' then
      null;
  end;
  reset role;

  delete from private.campaign_evidence
  where id = evidence_id
    and owner_id = owner;
  select count(*) into request_rows
  from private.mia_request
  where id = target_request;
  if request_rows <> 0 then
    raise exception 'deleting evidence left the request row';
  end if;

  set local role mediaiq_evidence_writer;
  select * into released
  from private.reconcile_unknown_reservation(
    owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
  );
  select * into replay
  from private.reconcile_unknown_reservation(
    owner, target_request, fixture_php, fixture_usd, 'owner_authorized_unknown_billing_release'
  );
  begin
    update private.mia_reservation_reconciliation
    set reason_code = reason_code
    where accounting_ref = target_request;
    raise exception 'writer updated a reconciliation row';
  exception
    when insufficient_privilege then
      null;
  end;
  begin
    delete from private.mia_reservation_reconciliation
    where accounting_ref = target_request;
    raise exception 'writer deleted a reconciliation row';
  exception
    when insufficient_privilege then
      null;
  end;
  reset role;

  begin
    update private.mia_reservation_reconciliation
    set reason_code = reason_code
    where accounting_ref = target_request;
    raise exception 'superuser updated a reconciliation row';
  exception
    when sqlstate '42501' then
      null;
  end;

  set local role mediaiq_evidence_owner;
  perform pg_catalog.set_config('mediaiq.evidence_owner_id', owner::text, true);
  delete from private.mia_reservation_reconciliation
  where accounting_ref = target_request;
  reset role;
  if (select count(*) from private.mia_reservation_reconciliation where accounting_ref = target_request) <> 1 then
    raise exception 'evidence owner deleted a reconciliation row';
  end if;

  begin
    delete from private.mia_reservation_reconciliation
    where accounting_ref = target_request;
    raise exception 'superuser deleted a reconciliation row';
  exception
    when sqlstate '42501' then
      null;
  end;

  begin
    truncate private.mia_reservation_reconciliation;
    raise exception 'superuser truncate bypasses the row trigger';
  exception
    when sqlstate 'P0001' then
      if sqlerrm is distinct from 'superuser truncate bypasses the row trigger' then
        raise;
      end if;
  end;

  select usage.outcome, usage.billing_status, usage.transport_outcome, usage.http_response_received, usage.http_status, usage.provider_request_id, usage.usage_validated
    into usage_outcome, usage_billing, transport_outcome, http_received, http_status, stored_request_id, usage_validated
  from private.mia_usage as usage
  where usage.accounting_ref = target_request;
  select count(*) into reconciliation_rows
  from private.mia_reservation_reconciliation
  where accounting_ref = target_request;

  if released.reconciled is distinct from true
    or released.already_recorded is distinct from false
    or released.php_reserved <> 0
    or released.usd_reserved <> 0
    or released.php_spent is distinct from spent_php
    or released.usd_spent is distinct from spent_usd
    or replay.already_recorded is distinct from true
    or replay.php_reserved <> 0
    or replay.php_spent is distinct from spent_php
    or usage_outcome is distinct from 'failed'
    or usage_billing is distinct from 'unknown'
    or transport_outcome is distinct from 'network'
    or http_received is distinct from false
    or http_status is not null
    or stored_request_id is not null
    or usage_validated is distinct from false
    or reconciliation_rows is distinct from 1
  then
    raise exception 'exact release did not preserve usage, transport, and spent balances';
  end if;

  set local role mediaiq_evidence_writer;
  replacement_evidence := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"1.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  second_request := (
    select opened.request_id from private.open_mia_request(
      owner, replacement_evidence, 'evidence_question', 'reconcile-second', repeat('d', 64), 'What is clicks?'
    ) as opened
  );
  select * into claimed
  from private.claim_mia_dispatch(owner, second_request);
  reset role;
  if claimed.authorized is distinct from true then
    raise exception 'a fixture could not be claimed after the release';
  end if;

  raise notice 'reservation reconciliation fixture tests passed inside a rollback transaction';
end;
$$;

rollback;
