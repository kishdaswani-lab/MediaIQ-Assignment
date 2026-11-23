-- Transport diagnostic constraints and settlement preservation. Rolls back.
-- Does not change prices, approval, or the committed reservation.

begin;

create function pg_temp.usage_diag(p_id uuid) returns table (
  transport_outcome text,
  http_response_received boolean,
  http_status integer,
  provider_request_id text,
  usage_validated boolean,
  outcome text,
  billing_status text,
  actual_cost numeric
)
language sql security definer set search_path = ''
as $$
  select
    usage.transport_outcome,
    usage.http_response_received,
    usage.http_status,
    usage.provider_request_id,
    usage.usage_validated,
    usage.outcome,
    usage.billing_status,
    usage.actual_cost
  from private.mia_usage as usage
  where usage.accounting_ref = p_id
$$;

create function pg_temp.exchange_question(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select evidence.latest_question from private.campaign_evidence as evidence where evidence.id = p_id $$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '3e101001-0000-4000-8000-000000000010',
  'authenticated', 'authenticated',
  'mia-transport@mia-transport-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '3e101001-0000-4000-8000-000000000010';
  evidence_id uuid;
  question_id uuid;
  second_id uuid;
  accepted_id uuid;
  mismatch_id uuid;
  overage_id uuid;
  opened record;
  outcome record;
  diag record;
  php_reserved numeric;
  usd_reserved numeric;
  php_hold numeric;
  usd_hold numeric;
  php_spent numeric;
  usd_spent numeric;
  php_reserved_after numeric;
  usd_reserved_after numeric;
  php_hold_after numeric;
  usd_hold_after numeric;
  php_spent_after numeric;
  usd_spent_after numeric;
  reader_result text;
begin
  reader_result := pg_catalog.pg_get_function_result('private.read_mia_request(uuid, uuid, uuid)'::regprocedure);
  if reader_result ilike '%transport_outcome%'
    or reader_result ilike '%http_status%'
    or reader_result ilike '%provider_request_id%'
    or reader_result ilike '%usage_validated%'
  then
    raise exception 'request reader exposes transport diagnostics: %', reader_result;
  end if;

  select account.php_reserved, account.usd_reserved, account.php_hold, account.usd_hold, account.php_spent, account.usd_spent
    into php_reserved, usd_reserved, php_hold, usd_hold, php_spent, usd_spent
  from private.mia_test_budget as account
  where account.singleton;

  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'transport-rejected', repeat('a', 64), 'What is the spend for the file?'
  );
  question_id := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'transport-second', repeat('b', 64), 'What is the clicks for the file?'
  );
  second_id := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'transport-accepted', repeat('c', 64), 'What is the impressions for the file?'
  );
  accepted_id := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'transport-mismatch', repeat('d', 64), 'What is the conversions for the file?'
  );
  mismatch_id := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'transport-overage', repeat('e', 64), 'What is the revenue for the file?'
  );
  overage_id := opened.request_id;
  reset role;

  update private.campaign_evidence as evidence
  set latest_question = 'Earlier question?',
      latest_answer = 'Spend for the file in USD was $25.30 USD.',
      latest_exchange_at = pg_catalog.now()
  where evidence.id = evidence_id;

  update private.mia_request as request
  set state = 'processing'
  where request.id in (question_id, second_id, accepted_id, mismatch_id, overage_id);

  insert into private.mia_usage (
    accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
  ) values
    (question_id, owner, 1, 'openai', 'gpt-6-luna', 'processing', 'unknown'),
    (second_id, owner, 1, 'openai', 'gpt-6-luna', 'processing', 'unknown'),
    (accepted_id, owner, 1, 'openai', 'gpt-6-luna', 'processing', 'unknown'),
    (mismatch_id, owner, 1, 'openai', 'gpt-6-luna', 'processing', 'unknown'),
    (overage_id, owner, 1, 'openai', 'gpt-6-luna', 'processing', 'unknown');

  begin
    insert into private.mia_usage (
      accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
    ) values (
      question_id, owner, 2, 'openai', 'gpt-6-luna', 'processing', 'unknown'
    );
    raise exception 'a second usage attempt was accepted';
  exception
    when check_violation then
      null;
  end;

  set local role mediaiq_evidence_writer;
  select * into outcome
  from private.record_mia_attempt_outcome(
    owner, question_id, 1, 'failed', 'unknown',
    null, null, null, null, null, 40, null, null, 'provider_rejected', null, null,
    null, 'http_rejected', true, 401, 'req_denied.1', false
  );
  if outcome.usage_updated is distinct from true or outcome.usage_outcome is distinct from 'failed' then
    raise exception 'http rejection was not recorded';
  end if;
  reset role;

  select * into diag from pg_temp.usage_diag(question_id);
  if diag.transport_outcome is distinct from 'http_rejected'
    or diag.http_response_received is distinct from true
    or diag.http_status is distinct from 401
    or diag.provider_request_id is distinct from 'req_denied.1'
    or diag.usage_validated is distinct from false
    or diag.billing_status is distinct from 'unknown'
    or diag.actual_cost is not null
  then
    raise exception 'http rejection diagnostics were %', diag;
  end if;

  set local role mediaiq_evidence_writer;
  select * into outcome
  from private.record_mia_attempt_outcome(
    owner, question_id, 1, 'failed', 'unknown',
    null, null, null, null, null, 40, null, null, 'provider_rejected', null, null,
    null, 'http_rejected', true, 500, 'req_other', false
  );
  if outcome.usage_updated is distinct from false then
    raise exception 'a terminal usage row was overwritten';
  end if;
  reset role;
  select * into diag from pg_temp.usage_diag(question_id);
  if diag.http_status is distinct from 401 or diag.provider_request_id is distinct from 'req_denied.1' then
    raise exception 'replay changed the stored diagnostics';
  end if;

  set local role mediaiq_evidence_writer;
  select * into outcome
  from private.record_mia_attempt_outcome(
    owner, second_id, 1, 'failed', 'unknown',
    null, null, null, null, null, 12, null, null, 'provider_unreachable', null, null,
    null, 'network', false, null, 'bad id', false
  );
  reset role;
  select * into diag from pg_temp.usage_diag(second_id);
  if diag.transport_outcome is distinct from 'network'
    or diag.http_response_received is distinct from false
    or diag.http_status is not null
    or diag.provider_request_id is not null
    or diag.usage_validated is distinct from false
  then
    raise exception 'invalid request id was stored: %', diag.provider_request_id;
  end if;

  begin
    update private.mia_usage as usage
    set http_status = 500
    where usage.accounting_ref = second_id;
    raise exception 'network outcome accepted an HTTP status';
  exception
    when check_violation then
      null;
  end;

  update private.mia_usage as usage
  set transport_outcome = 'timeout', http_response_received = false, http_status = null, provider_request_id = null
  where usage.accounting_ref = second_id;
  begin
    update private.mia_usage as usage
    set transport_outcome = 'malformed_response', http_response_received = true, http_status = 500
    where usage.accounting_ref = second_id;
    raise exception 'malformed response accepted a non-2xx status';
  exception
    when check_violation then
      null;
  end;
  update private.mia_usage as usage
  set transport_outcome = 'malformed_response', http_response_received = true, http_status = 200, provider_request_id = null
  where usage.accounting_ref = second_id;

  select account.php_reserved, account.usd_reserved, account.php_hold, account.usd_hold, account.php_spent, account.usd_spent
    into php_reserved_after, usd_reserved_after, php_hold_after, usd_hold_after, php_spent_after, usd_spent_after
  from private.mia_test_budget as account
  where account.singleton;
  if php_reserved_after is distinct from php_reserved
    or usd_reserved_after is distinct from usd_reserved
    or php_hold_after is distinct from php_hold
    or usd_hold_after is distinct from usd_hold
    or php_spent_after is distinct from php_spent
    or usd_spent_after is distinct from usd_spent
  then
    raise exception 'transport diagnostics changed the budget';
  end if;
  if pg_temp.exchange_question(evidence_id) is distinct from 'Earlier question?' then
    raise exception 'transport failure replaced the saved exchange';
  end if;

  begin
    perform private.record_mia_attempt_outcome(
      owner, mismatch_id, 1, 'failed', 'unknown',
      null, null, null, null, null, null, null, null, 'provider_error', null, null,
      null, null, null, null, null, true
    );
    raise exception 'invalid usage accepted a true validation flag';
  exception
    when sqlstate '22023' then
      null;
  end;
  select * into diag from pg_temp.usage_diag(mismatch_id);
  if diag.outcome is distinct from 'processing' or diag.usage_validated is not null then
    raise exception 'a rejected validation flag changed the usage row';
  end if;

  set local role mediaiq_evidence_writer;
  select * into outcome
  from private.record_mia_attempt_outcome(
    owner, mismatch_id, 1, 'completed', 'reported',
    20, 501, null, null, 0, 15, null, null, null, null, null,
    0, 'accepted', true, 200, null, false
  );
  reset role;
  select * into diag from pg_temp.usage_diag(mismatch_id);
  if diag.outcome is distinct from 'reconciliation_required'
    or diag.billing_status is distinct from 'unknown'
    or diag.actual_cost is not null
    or diag.usage_validated is distinct from false
    or diag.transport_outcome is distinct from 'accepted'
  then
    raise exception 'invalid usage released the reservation: %', diag;
  end if;
  select account.php_hold, account.usd_hold, account.php_spent, account.usd_spent
    into php_hold_after, usd_hold_after, php_spent_after, usd_spent_after
  from private.mia_test_budget as account
  where account.singleton;
  if php_hold_after is distinct from php_hold
    or usd_hold_after is distinct from usd_hold
    or php_spent_after is distinct from php_spent
    or usd_spent_after is distinct from usd_spent
  then
    raise exception 'invalid usage changed the reservation';
  end if;

  update private.mia_test_budget as account
  set php_hold = 0.0000001, usd_hold = 0.0000001
  where account.singleton;
  set local role mediaiq_evidence_writer;
  select * into outcome
  from private.record_mia_attempt_outcome(
    owner, overage_id, 1, 'completed', 'reported',
    10, 2, null, null, 0, 15, null, null, null, null, null,
    0, 'accepted', true, 200, 'req_over_1', true
  );
  reset role;
  select * into diag from pg_temp.usage_diag(overage_id);
  select account.php_hold, account.usd_hold, account.php_spent
    into php_hold_after, usd_hold_after, php_spent_after
  from private.mia_test_budget as account
  where account.singleton;
  if diag.billing_status is distinct from 'unknown'
    or diag.actual_cost is not null
    or diag.usage_validated is distinct from true
    or diag.outcome is distinct from 'reconciliation_required'
    or php_hold_after is distinct from 0.0000001
    or usd_hold_after is distinct from 0.0000001
    or php_spent_after is distinct from php_spent
  then
    raise exception 'usage above the temporary hold settled a cost: %', diag;
  end if;
  declare
    restore_php_reserved numeric := php_reserved;
    restore_usd_reserved numeric := usd_reserved;
    restore_php_hold numeric := php_hold;
    restore_usd_hold numeric := usd_hold;
    restore_php_spent numeric := php_spent;
    restore_usd_spent numeric := usd_spent;
  begin
    update private.mia_test_budget as account
    set
      php_reserved = restore_php_reserved,
      usd_reserved = restore_usd_reserved,
      php_hold = restore_php_hold,
      usd_hold = restore_usd_hold,
      php_spent = restore_php_spent,
      usd_spent = restore_usd_spent
    where account.singleton;
  end;

  set local role mediaiq_evidence_writer;
  select * into outcome
  from private.record_mia_attempt_outcome(
    owner, accepted_id, 1, 'completed', 'reported',
    10, 2, null, null, 0, 30, 'Spend for the file in USD was $25.30 USD.', '[]'::jsonb, null,
    'What is the impressions for the file?', 'Spend for the file in USD was $25.30 USD.',
    0, 'accepted', true, 200, 'req_valid_1', true
  );
  reset role;
  select * into diag from pg_temp.usage_diag(accepted_id);
  if diag.transport_outcome is distinct from 'accepted'
    or diag.http_status is distinct from 200
    or diag.provider_request_id is distinct from 'req_valid_1'
    or diag.usage_validated is distinct from true
    or diag.billing_status is distinct from 'reported'
    or diag.actual_cost is distinct from 0.000002
  then
    raise exception 'accepted diagnostics changed settlement: %', diag;
  end if;

  raise notice 'transport diagnostics persisted without releasing the reservation';
end $$;

rollback;
