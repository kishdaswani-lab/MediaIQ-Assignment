-- Disposable reservation lookup checks. Do not run against supabase_db_MediaIQ.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'authenticated', 'authenticated',
  'lookup-a@lookup-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
), (
  '00000000-0000-0000-0000-000000000000',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'authenticated', 'authenticated',
  'lookup-b@lookup-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

update private.mia_test_budget
set
  php_reserved = 0.03872,
  php_hold = 0.03872,
  usd_reserved = 0.00055,
  usd_hold = 0.00055,
  php_spent = 0,
  usd_spent = 0
where singleton;

insert into private.mia_usage (
  accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
) values (
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  1, 'openai', 'gpt-6-luna', 'failed', 'unknown'
);

do $$
declare
  visible_count integer;
  php_text text;
  usd_text text;
  spent_php numeric;
  spent_usd numeric;
  usage_outcome text;
  usage_billing text;
begin
  if pg_catalog.to_regprocedure('private.list_eligible_mia_reservations(uuid)') is null then
    raise exception 'lookup migration is not applied';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc as proc
    where proc.oid = pg_catalog.to_regprocedure('private.list_eligible_mia_reservations(uuid)')
      and pg_catalog.pg_get_userbyid(proc.proowner) = 'mediaiq_mia_reservation_reader'
      and proc.prosecdef
      and proc.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception 'lookup function security attributes are wrong';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where granted.rolname = 'mediaiq_mia_reservation_reader'
  ) or exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'mediaiq_mia_reservation_reader'
      and (rolcanlogin or rolinherit or rolsuper or rolcreaterole or rolcreatedb or not rolbypassrls)
  ) then
    raise exception 'lookup reader role is not a confined bypass role';
  end if;

  if pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_usage', 'select')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_request', 'select')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_test_budget', 'select')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.mia_reservation_reconciliation', 'select')
    or pg_catalog.has_table_privilege('mediaiq_mia_reservation_reader', 'private.mia_usage', 'insert')
    or pg_catalog.has_column_privilege('mediaiq_mia_reservation_reader', 'private.mia_usage', 'transport_outcome', 'select')
    or pg_catalog.has_column_privilege('mediaiq_mia_reservation_reader', 'private.mia_usage', 'provider_request_id', 'select')
    or not pg_catalog.has_column_privilege('mediaiq_mia_reservation_reader', 'private.mia_usage', 'billing_status', 'select')
    or not pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('public', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('anon', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('authenticated', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('service_role', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_evidence_owner', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_security_owner', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_security_writer', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_security_maintainer', 'private.list_eligible_mia_reservations(uuid)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_security_operator', 'private.list_eligible_mia_reservations(uuid)', 'execute')
  then
    raise exception 'lookup privileges are wrong';
  end if;

  set local role mediaiq_evidence_writer;
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 1 then
    raise exception 'owner A did not see the eligible reservation';
  end if;
  select listed.php_amount, listed.usd_amount
    into php_text, usd_text
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') as listed;
  if php_text is distinct from (0.03872::numeric)::text
    or usd_text is distinct from (0.00055::numeric)::text
    or php_text::numeric <> 0.03872
    or usd_text::numeric <> 0.00055
    or pg_catalog.strpos(php_text, 'e') <> 0
    or pg_catalog.strpos(usd_text, 'e') <> 0
  then
    raise exception 'lookup decimal text changed the amount';
  end if;
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2');
  if visible_count <> 0 then
    raise exception 'owner B saw owner A reservation';
  end if;
  begin
    perform 1 from private.mia_usage;
    raise exception 'writer read usage directly';
  exception
    when insufficient_privilege then
      null;
  end;
  reset role;

  select usage.outcome, usage.billing_status, budget.php_spent, budget.usd_spent
    into usage_outcome, usage_billing, spent_php, spent_usd
  from private.mia_usage as usage
  cross join private.mia_test_budget as budget
  where usage.accounting_ref = '11111111-1111-4111-8111-111111111111';
  if usage_outcome is distinct from 'failed'
    or usage_billing is distinct from 'unknown'
    or spent_php <> 0
    or spent_usd <> 0
  then
    raise exception 'lookup changed usage or spent balances';
  end if;
end;
$$;

savepoint reconciled_attempt;
insert into private.mia_reservation_reconciliation (
  accounting_ref, attempt_number, owner_id, php_released, usd_released,
  php_spent_observed, usd_spent_observed, reason_code
) values (
  '11111111-1111-4111-8111-111111111111', 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  0.03872, 0.00055, 0, 0,
  'owner_authorized_unknown_billing_release'
);
do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 0 then
    raise exception 'reconciled attempt remained eligible';
  end if;
end;
$$;
rollback to savepoint reconciled_attempt;

savepoint processing_attempt;
insert into private.mia_usage (
  accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status, actual_cost
) values (
  '12121212-1212-4121-8121-121212121212',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  1, 'openai', 'gpt-6-luna', 'processing', 'reported', 0
);
do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 0 then
    raise exception 'processing attempt left a reservation eligible';
  end if;
end;
$$;
rollback to savepoint processing_attempt;

savepoint mismatched_hold;
update private.mia_test_budget
set php_reserved = php_hold + 1
where singleton;
do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 0 then
    raise exception 'mismatched reserved and hold remained eligible';
  end if;
end;
$$;
rollback to savepoint mismatched_hold;

savepoint other_unknown;
insert into private.mia_usage (
  accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
) values (
  '13131313-1313-4131-8131-131313131313',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  1, 'openai', 'gpt-6-luna', 'failed', 'unknown'
);
do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 0 then
    raise exception 'two unknown attempts remained attributable';
  end if;
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2');
  if visible_count <> 0 then
    raise exception 'owner B saw a reservation while attribution was ambiguous';
  end if;
end;
$$;
rollback to savepoint other_unknown;

savepoint state_mismatch;
insert into private.campaign_evidence (
  id, owner_id, source_text, summary, parser_version, calculation_version
) values (
  '14141414-1414-4141-8141-141414141414',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'date,campaign,channel,spend,impressions,clicks',
  '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1"}'::jsonb,
  'monday-csv-1',
  'campaign-descriptive-1'
);
insert into private.mia_request (
  id, owner_id, evidence_id, request_type, state, idempotency_key, payload_fingerprint, question_text
) values (
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  '14141414-1414-4141-8141-141414141414',
  'evidence_question',
  'refused',
  'lookup-mismatch',
  repeat('ab', 32),
  'What is spend?'
);
do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 0 then
    raise exception 'request state that differs from usage remained eligible';
  end if;
end;
$$;
rollback to savepoint state_mismatch;

do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from private.list_eligible_mia_reservations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  if visible_count <> 1 then
    raise exception 'eligible reservation did not return after exclusions';
  end if;
end;
$$;

rollback;
