-- Settlement gaps from the Stage 3E-9 audit.
-- Each scenario is its own transaction and rolls back.
-- Prices below are test fixtures. They are not a provider price card.
-- PHP per million: uncached input 10, cached input 1, output 10.
-- USD per million: uncached input 1, cached input 0.1, output 1.
-- Worst-case hold: (3000 * uncached input + 500 * output) / 1000000
--   PHP 0.035, USD 0.0035.
-- Reported cost: ((input - cached) * uncached + cached * cached price + output * output price) / 1000000.

create function pg_temp.settlement_budget() returns table (
  php_reserved numeric,
  php_spent numeric,
  php_hold numeric,
  usd_reserved numeric,
  usd_spent numeric,
  usd_hold numeric
)
language sql
security definer
set search_path = ''
as $$
  select php_reserved, php_spent, php_hold, usd_reserved, usd_spent, usd_hold
  from private.mia_test_budget
  where singleton
$$;

create function pg_temp.prepare_settlement_prices() returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from private.mia_approved_provider) <> 0 then
    raise exception 'approval table is not empty';
  end if;
  if (
    select php_reserved <> 0 or usd_reserved <> 0
      or php_spent <> 0 or usd_spent <> 0
      or php_hold <> 0 or usd_hold <> 0
    from private.mia_test_budget
    where singleton
  ) then
    raise exception 'budget already has a reservation or spent balance';
  end if;
  update private.mia_test_budget
  set
    php_per_million_uncached_input = 10,
    php_per_million_cached_input = 1,
    php_per_million_output = 10,
    usd_per_million_uncached_input = 1,
    usd_per_million_cached_input = 0.1,
    usd_per_million_output = 1
  where singleton;
  insert into private.mia_approved_provider (provider, model)
  values ('openai', 'gpt-6-luna');
end;
$$;

-- Test A. Reported output of 501 becomes reconciliation and keeps the hold.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '3e9a0001-0000-4000-8000-00000000000a',
  'authenticated', 'authenticated',
  'mia-settlement-a@mia-settlement-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '3e9a0001-0000-4000-8000-00000000000a';
  evidence_id uuid;
  first_request uuid;
  second_request uuid;
  claimed record;
  outcome record;
  repeated record;
  budget record;
  stored record;
  exchange record;
  token_input integer;
  token_output integer;
  token_cached integer;
  token_other integer;
  token_cost numeric;
  token_estimate numeric;
  billing text;
begin
  perform pg_temp.prepare_settlement_prices();
  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  reset role;
  update private.campaign_evidence
  set latest_question = 'What is spend?', latest_answer = 'Spend is 10.00.', latest_exchange_at = pg_catalog.now()
  where id = evidence_id and owner_id = owner;
  set local role mediaiq_evidence_writer;
  first_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-output-cap', repeat('a', 64), 'What is spend?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  select * into budget from pg_temp.settlement_budget();
  if claimed.authorized is distinct from true
    or claimed.provider is distinct from 'openai'
    or claimed.model is distinct from 'gpt-6-luna'
    or budget.php_reserved is distinct from 0.035
    or budget.usd_reserved is distinct from 0.0035
    or budget.php_hold is distinct from 0.035
    or budget.usd_hold is distinct from 0.0035
    or budget.php_spent is distinct from 0
    or budget.usd_spent is distinct from 0
  then
    raise exception 'output-cap reservation was not the worst-case hold';
  end if;

  select * into outcome from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'completed', 'reported',
    20, 501, null, null, 0, 5,
    'must not remain', '[{"metricId":"spend"}]'::jsonb, 'should be replaced', null, null,
    0
  );
  reset role;
  select input_tokens, output_tokens, cached_input_tokens, other_billable_tokens, actual_cost, estimated_cost, billing_status
    into token_input, token_output, token_cached, token_other, token_cost, token_estimate, billing
  from private.mia_usage
  where accounting_ref = first_request and attempt_number = 1;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence where id = evidence_id;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.settlement_budget();
  select * into stored from private.read_mia_request(owner, evidence_id, first_request);
  if outcome.usage_updated is distinct from true
    or outcome.request_state is distinct from 'reconciliation_required'
    or outcome.usage_outcome is distinct from 'reconciliation_required'
    or outcome.actual_cost is not null
    or stored.state is distinct from 'reconciliation_required'
    or stored.rendered_text is not null
    or stored.failure_category is distinct from 'unreconciled_billing'
    or token_input is distinct from 20
    or token_output is distinct from 501
    or token_cached is distinct from 0
    or token_other is not null
    or token_cost is not null
    or token_estimate is not null
    or billing is distinct from 'unknown'
    or budget.php_reserved is distinct from 0.035
    or budget.usd_reserved is distinct from 0.0035
    or budget.php_hold is distinct from 0.035
    or budget.usd_hold is distinct from 0.0035
    or budget.php_spent is distinct from 0
    or budget.usd_spent is distinct from 0
    or exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
  then
    raise exception 'output above 500 was priced or the hold was released';
  end if;

  second_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-output-next', repeat('b', 64), 'What is revenue?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, second_request);
  if claimed.authorized is distinct from false then
    raise exception 'output above 500 allowed another paid claim';
  end if;

  select * into repeated from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'completed', 'reported',
    1, 1, null, null, 0, 1,
    'replaced', '[]'::jsonb, null, 'replaced question', 'replaced answer',
    0
  );
  reset role;
  select output_tokens, actual_cost into token_output, token_cost
  from private.mia_usage where accounting_ref = first_request and attempt_number = 1;
  select latest_question into exchange from private.campaign_evidence where id = evidence_id;
  if repeated.usage_updated is distinct from false
    or repeated.usage_outcome is distinct from 'reconciliation_required'
    or token_output is distinct from 501
    or token_cost is not null
    or exchange.latest_question is distinct from 'What is spend?'
  then
    raise exception 'output-cap reconciliation was overwritten';
  end if;
  raise notice 'test A output above 500 keeps the reservation';
end;
$$;

rollback;

-- Test B. A refused attempt with reliable usage is priced and releases the hold.
-- The provider-refusal call passes no exchange text, matching the application.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '3e9b0002-0000-4000-8000-00000000000b',
  'authenticated', 'authenticated',
  'mia-settlement-b@mia-settlement-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '3e9b0002-0000-4000-8000-00000000000b';
  evidence_id uuid;
  first_request uuid;
  second_request uuid;
  claimed record;
  outcome record;
  repeated record;
  budget record;
  stored record;
  exchange record;
  token_input integer;
  token_output integer;
  token_cached integer;
  token_cost numeric;
begin
  perform pg_temp.prepare_settlement_prices();
  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  reset role;
  update private.campaign_evidence
  set latest_question = 'What is spend?', latest_answer = 'Spend is 10.00.', latest_exchange_at = pg_catalog.now()
  where id = evidence_id and owner_id = owner;
  set local role mediaiq_evidence_writer;
  first_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-refusal', repeat('c', 64), 'What is spend?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  if claimed.authorized is distinct from true then
    raise exception 'refusal case could not reserve';
  end if;

  -- 100 input, 20 cached, 10 output.
  -- PHP ((80 * 10) + (20 * 1) + (10 * 10)) / 1000000 = 0.00092
  -- USD ((80 * 1) + (20 * 0.1) + (10 * 1)) / 1000000 = 0.000092
  select * into outcome from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'refused', 'reported',
    100, 10, null, null, 0, 6,
    'MIA cannot use a provider refusal as an evidence answer.',
    null, 'provider_refusal', null, null,
    20
  );
  reset role;
  select input_tokens, output_tokens, cached_input_tokens, actual_cost
    into token_input, token_output, token_cached, token_cost
  from private.mia_usage
  where accounting_ref = first_request and attempt_number = 1;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence where id = evidence_id;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.settlement_budget();
  select * into stored from private.read_mia_request(owner, evidence_id, first_request);
  if outcome.usage_updated is distinct from true
    or outcome.request_state is distinct from 'refused'
    or outcome.usage_outcome is distinct from 'refused'
    or outcome.actual_cost is distinct from 0.000092
    or stored.state is distinct from 'refused'
    or stored.rendered_text is distinct from 'MIA cannot use a provider refusal as an evidence answer.'
    or stored.failure_category is distinct from 'provider_refusal'
    or token_input is distinct from 100
    or token_cached is distinct from 20
    or token_output is distinct from 10
    or token_cost is distinct from 0.000092
    or budget.php_reserved is distinct from 0
    or budget.usd_reserved is distinct from 0
    or budget.php_hold is distinct from 0
    or budget.usd_hold is distinct from 0
    or budget.php_spent is distinct from 0.00092
    or budget.usd_spent is distinct from 0.000092
    or exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
  then
    raise exception 'priced refusal did not settle both currencies or changed the exchange';
  end if;

  select * into repeated from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'completed', 'reported',
    1, 1, null, null, 0, 1,
    'replaced', '[]'::jsonb, null, 'replaced question', 'replaced answer',
    0
  );
  select * into budget from pg_temp.settlement_budget();
  reset role;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence where id = evidence_id;
  if repeated.usage_updated is distinct from false
    or repeated.usage_outcome is distinct from 'refused'
    or repeated.actual_cost is distinct from 0.000092
    or budget.php_spent is distinct from 0.00092
    or budget.usd_spent is distinct from 0.000092
    or exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
  then
    raise exception 'priced refusal was overwritten';
  end if;

  set local role mediaiq_evidence_writer;
  second_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-refusal-next', repeat('d', 64), 'What is revenue?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, second_request);
  select * into budget from pg_temp.settlement_budget();
  if claimed.authorized is distinct from true
    or budget.php_reserved is distinct from 0.035
    or budget.usd_reserved is distinct from 0.0035
    or budget.php_spent is distinct from 0.00092
    or budget.usd_spent is distinct from 0.000092
  then
    raise exception 'priced refusal did not release the reservation';
  end if;
  raise notice 'test B priced refusal releases the reservation';
end;
$$;

rollback;

-- Test C. The application records both an incomplete provider response and a
-- failed provider response as failed. Reliable usage is priced either way.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '3e9c0003-0000-4000-8000-00000000000c',
  'authenticated', 'authenticated',
  'mia-settlement-c@mia-settlement-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '3e9c0003-0000-4000-8000-00000000000c';
  evidence_id uuid;
  incomplete_request uuid;
  failed_request uuid;
  next_request uuid;
  claimed record;
  outcome record;
  repeated record;
  budget record;
  stored record;
  exchange record;
  token_cost numeric;
  references_present boolean;
begin
  perform pg_temp.prepare_settlement_prices();
  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  reset role;
  update private.campaign_evidence
  set latest_question = 'What is spend?', latest_answer = 'Spend is 10.00.', latest_exchange_at = pg_catalog.now()
  where id = evidence_id and owner_id = owner;
  set local role mediaiq_evidence_writer;
  incomplete_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-incomplete', repeat('e', 64), 'What is spend?'
    )
  );
  failed_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-failed', repeat('f', 64), 'What is revenue?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, incomplete_request);
  if claimed.authorized is distinct from true then
    raise exception 'incomplete case could not reserve';
  end if;

  begin
    perform private.record_mia_attempt_outcome(
      owner, incomplete_request, 1, 'incomplete', 'reported',
      40, 5, null, null, 0, 1,
      'evidence answer', '[]'::jsonb, 'incomplete_response', null, null,
      10
    );
    raise exception 'incomplete was accepted as a usage outcome';
  exception
    when invalid_parameter_value then
      null;
  end;
  select * into budget from pg_temp.settlement_budget();
  if budget.php_reserved is distinct from 0.035 or budget.php_spent is distinct from 0 then
    raise exception 'rejected incomplete outcome changed the reservation';
  end if;

  -- 40 input, 10 cached, 5 output.
  -- PHP ((30 * 10) + (10 * 1) + (5 * 10)) / 1000000 = 0.00036
  -- USD ((30 * 1) + (10 * 0.1) + (5 * 1)) / 1000000 = 0.000036
  select * into outcome from private.record_mia_attempt_outcome(
    owner, incomplete_request, 1, 'failed', 'reported',
    40, 5, null, null, 0, 4,
    null, null, 'incomplete_response', null, null,
    10
  );
  reset role;
  select actual_cost into token_cost
  from private.mia_usage where accounting_ref = incomplete_request and attempt_number = 1;
  select validated_references is not null into references_present
  from private.mia_request where id = incomplete_request;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence where id = evidence_id;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.settlement_budget();
  select * into stored from private.read_mia_request(owner, evidence_id, incomplete_request);
  if outcome.usage_updated is distinct from true
    or outcome.request_state is distinct from 'failed'
    or outcome.usage_outcome is distinct from 'failed'
    or outcome.actual_cost is distinct from 0.000036
    or stored.state is distinct from 'failed'
    or stored.rendered_text is not null
    or stored.failure_category is distinct from 'incomplete_response'
    or references_present
    or token_cost is distinct from 0.000036
    or budget.php_reserved is distinct from 0
    or budget.usd_reserved is distinct from 0
    or budget.php_hold is distinct from 0
    or budget.usd_hold is distinct from 0
    or budget.php_spent is distinct from 0.00036
    or budget.usd_spent is distinct from 0.000036
    or exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
  then
    raise exception 'incomplete response with reliable usage was not settled as failed';
  end if;

  select * into claimed from private.claim_mia_dispatch(owner, failed_request);
  if claimed.authorized is distinct from true then
    raise exception 'settled incomplete response left the reservation held';
  end if;

  -- 50 input, 0 cached, 8 output.
  -- PHP ((50 * 10) + (8 * 10)) / 1000000 = 0.00058
  -- USD ((50 * 1) + (8 * 1)) / 1000000 = 0.000058
  select * into outcome from private.record_mia_attempt_outcome(
    owner, failed_request, 1, 'failed', 'reported',
    50, 8, null, null, 0, 7,
    null, null, 'provider_failed', null, null,
    0
  );
  reset role;
  select actual_cost into token_cost
  from private.mia_usage where accounting_ref = failed_request and attempt_number = 1;
  select validated_references is not null into references_present
  from private.mia_request where id = failed_request;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence where id = evidence_id;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.settlement_budget();
  select * into stored from private.read_mia_request(owner, evidence_id, failed_request);
  if outcome.usage_updated is distinct from true
    or outcome.request_state is distinct from 'failed'
    or outcome.usage_outcome is distinct from 'failed'
    or outcome.actual_cost is distinct from 0.000058
    or stored.state is distinct from 'failed'
    or stored.rendered_text is not null
    or stored.failure_category is distinct from 'provider_failed'
    or references_present
    or token_cost is distinct from 0.000058
    or budget.php_reserved is distinct from 0
    or budget.usd_reserved is distinct from 0
    or budget.php_spent is distinct from 0.00094
    or budget.usd_spent is distinct from 0.000094
    or exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
  then
    raise exception 'failed response with reliable usage was not settled as failed';
  end if;

  select * into repeated from private.record_mia_attempt_outcome(
    owner, incomplete_request, 1, 'completed', 'reported',
    1, 1, null, null, 0, 1,
    'replaced answer', '[]'::jsonb, null, 'replaced question', 'replaced answer',
    0
  );
  select * into budget from pg_temp.settlement_budget();
  if repeated.usage_updated is distinct from false
    or repeated.usage_outcome is distinct from 'failed'
    or budget.php_spent is distinct from 0.00094
    or budget.usd_spent is distinct from 0.000094
  then
    raise exception 'settled failed usage was overwritten';
  end if;

  next_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-failed-next', repeat('0', 64), 'What is clicks?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, next_request);
  if claimed.authorized is distinct from true then
    raise exception 'settled failed responses left a reservation held';
  end if;
  raise notice 'test C incomplete and failed responses settle as failed';
end;
$$;

rollback;

-- Test D. Reported usage without cached input is unknown billing and keeps the hold.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '3e9d0004-0000-4000-8000-00000000000d',
  'authenticated', 'authenticated',
  'mia-settlement-d@mia-settlement-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '3e9d0004-0000-4000-8000-00000000000d';
  evidence_id uuid;
  first_request uuid;
  second_request uuid;
  claimed record;
  outcome record;
  repeated record;
  budget record;
  stored record;
  exchange record;
  token_input integer;
  token_output integer;
  token_cached integer;
  token_cost numeric;
  billing text;
begin
  perform pg_temp.prepare_settlement_prices();
  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  reset role;
  update private.campaign_evidence
  set latest_question = 'What is spend?', latest_answer = 'Spend is 10.00.', latest_exchange_at = pg_catalog.now()
  where id = evidence_id and owner_id = owner;
  set local role mediaiq_evidence_writer;
  first_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-missing-cached', repeat('1', 64), 'What is spend?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  if claimed.authorized is distinct from true then
    raise exception 'missing-cached case could not reserve';
  end if;

  select * into outcome from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'completed', 'reported',
    30, 4, null, null, 0, 3,
    'must not remain', '[{"metricId":"spend"}]'::jsonb, 'should be replaced', null, null,
    null
  );
  reset role;
  select input_tokens, output_tokens, cached_input_tokens, actual_cost, billing_status
    into token_input, token_output, token_cached, token_cost, billing
  from private.mia_usage
  where accounting_ref = first_request and attempt_number = 1;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence where id = evidence_id;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.settlement_budget();
  select * into stored from private.read_mia_request(owner, evidence_id, first_request);
  if outcome.usage_updated is distinct from true
    or outcome.request_state is distinct from 'reconciliation_required'
    or outcome.usage_outcome is distinct from 'reconciliation_required'
    or outcome.actual_cost is not null
    or stored.state is distinct from 'reconciliation_required'
    or stored.rendered_text is not null
    or stored.failure_category is distinct from 'unreconciled_billing'
    or token_input is distinct from 30
    or token_output is distinct from 4
    or token_cached is not null
    or token_cost is not null
    or billing is distinct from 'unknown'
    or budget.php_reserved is distinct from 0.035
    or budget.usd_reserved is distinct from 0.0035
    or budget.php_hold is distinct from 0.035
    or budget.usd_hold is distinct from 0.0035
    or budget.php_spent is distinct from 0
    or budget.usd_spent is distinct from 0
    or exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
  then
    raise exception 'missing cached input was priced or the hold was released';
  end if;

  second_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'settlement-missing-cached-next', repeat('2', 64), 'What is revenue?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, second_request);
  if claimed.authorized is distinct from false then
    raise exception 'missing cached input allowed another paid claim';
  end if;

  select * into repeated from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'completed', 'reported',
    1, 1, null, null, 0, 1,
    'replaced', '[]'::jsonb, null, 'replaced question', 'replaced answer',
    0
  );
  reset role;
  select input_tokens, cached_input_tokens, actual_cost
    into token_input, token_cached, token_cost
  from private.mia_usage where accounting_ref = first_request and attempt_number = 1;
  if repeated.usage_updated is distinct from false
    or token_input is distinct from 30
    or token_cached is not null
    or token_cost is not null
  then
    raise exception 'missing-cached reconciliation was overwritten';
  end if;
  raise notice 'test D missing cached input keeps the reservation';
end;
$$;

rollback;
