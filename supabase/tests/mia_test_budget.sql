-- Monday testing-budget authorization.
-- Rolls back. Does not leave a price card or a provider row.
--   docker exec -i supabase_db_MediaIQ psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/mia_test_budget.sql

begin;

create function pg_temp.budget_state() returns table (
  php_reserved numeric,
  php_spent numeric,
  php_hold numeric,
  usd_reserved numeric,
  usd_spent numeric,
  usd_hold numeric
)
language sql security definer set search_path = ''
as $$
  select php_reserved, php_spent, php_hold, usd_reserved, usd_spent, usd_hold
  from private.mia_test_budget
  where singleton
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '12121212-1212-4121-8121-121212121212',
  'authenticated', 'authenticated',
  'mia-budget@mia-budget-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '12121212-1212-4121-8121-121212121212';
  evidence_id uuid;
  first_request uuid;
  second_request uuid;
  third_request uuid;
  fourth_request uuid;
  fifth_request uuid;
  sixth_request uuid;
  claimed record;
  outcome record;
  budget record;
  usage_rows integer;
  token_input integer;
  token_output integer;
  token_cached integer;
  token_other integer;
  token_cost numeric;
  repeated record;
begin
  if has_table_privilege('mediaiq_evidence_writer', 'private.mia_test_budget', 'select, insert, update, delete') then
    raise exception 'writer can modify the testing budget directly';
  end if;
  if (select php_ceiling from private.mia_test_budget) is distinct from 500
    or (select usd_ceiling from private.mia_test_budget) is distinct from 8
    or (select max_input_tokens from private.mia_test_budget) is distinct from 3000
    or (select max_output_tokens from private.mia_test_budget) is distinct from 500
  then
    raise exception 'approved ceilings or token caps changed';
  end if;

  set local role mediaiq_evidence_writer;
  evidence_id := private.insert_campaign_evidence(
    owner,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  first_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'budget-one', repeat('a', 64), 'What is spend?'
    )
  );
  second_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'budget-two', repeat('b', 64), 'What is revenue?'
    )
  );

  reset role;
  insert into private.mia_approved_provider (provider, model)
  values ('openai', 'gpt-6-luna');
  set local role mediaiq_evidence_writer;
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  reset role;
  if claimed.authorized is distinct from false
    or (select count(*) from private.mia_usage where owner_id = owner) <> 0
  then
    raise exception 'missing price card authorized a paid request';
  end if;
  set local role mediaiq_evidence_writer;
  raise notice 'missing price card denies dispatch';

  reset role;
  update private.mia_test_budget
  set
    php_per_million_uncached_input = 200000,
    php_per_million_cached_input = 1,
    php_per_million_output = 1,
    usd_per_million_uncached_input = 1,
    usd_per_million_cached_input = 0.1,
    usd_per_million_output = 1;
  set local role mediaiq_evidence_writer;
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  if claimed.authorized is distinct from false then
    raise exception 'PHP ceiling allowed a reservation the USD ceiling could hold';
  end if;
  raise notice 'PHP ceiling denies independently';

  reset role;
  update private.mia_test_budget
  set
    php_per_million_uncached_input = 10,
    php_per_million_cached_input = 1,
    php_per_million_output = 10,
    usd_per_million_uncached_input = 3000,
    usd_per_million_cached_input = 1,
    usd_per_million_output = 1;
  set local role mediaiq_evidence_writer;
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  if claimed.authorized is distinct from false then
    raise exception 'USD ceiling allowed a reservation the PHP ceiling could hold';
  end if;
  raise notice 'USD ceiling denies independently';

  reset role;
  update private.mia_test_budget
  set
    php_per_million_uncached_input = 10,
    php_per_million_cached_input = 1,
    php_per_million_output = 10,
    usd_per_million_uncached_input = 1,
    usd_per_million_cached_input = 0.1,
    usd_per_million_output = 1;
  set local role mediaiq_evidence_writer;
  select * into claimed from private.claim_mia_dispatch(owner, first_request);
  if claimed.authorized is distinct from true or claimed.model is distinct from 'gpt-6-luna' then
    raise exception 'affordable reservation was not atomic with the usage attempt';
  end if;
  reset role;
  select count(*) into usage_rows from private.mia_usage as usage where usage.owner_id = owner and usage.outcome = 'processing';
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.budget_state();
  if usage_rows is distinct from 1 or budget.php_reserved <= 0 or budget.usd_reserved <= 0 or budget.php_hold <= 0 then
    raise exception 'claim did not reserve both currencies';
  end if;
  select * into claimed from private.claim_mia_dispatch(owner, second_request);
  if claimed.authorized is distinct from false then
    raise exception 'second paid request was authorized while one reservation is open';
  end if;
  raise notice 'one concurrent reservation blocks the next claim';

  select * into outcome from private.record_mia_attempt_outcome(
    owner, first_request, 1, 'timed_out', 'unknown',
    null, null, null, null, null, null,
    null, null, 'timeout', null, null
  );
  select * into budget from pg_temp.budget_state();
  if outcome.usage_updated is distinct from true or budget.php_reserved <= 0 or budget.php_spent <> 0 then
    raise exception 'ambiguous timeout released the reservation';
  end if;
  select * into claimed from private.claim_mia_dispatch(owner, second_request);
  if claimed.authorized is distinct from false then
    raise exception 'ambiguous billing allowed another paid request';
  end if;
  raise notice 'ambiguous billing keeps the reservation';

  reset role;
  update private.mia_test_budget
  set php_reserved = 0, php_hold = 0, usd_reserved = 0, usd_hold = 0
  where singleton;
  update private.mia_usage
  set outcome = 'failed', billing_status = 'non_billable'
  where accounting_ref = first_request;
  set local role mediaiq_evidence_writer;
  select * into claimed from private.claim_mia_dispatch(owner, second_request);
  if claimed.authorized is distinct from true then
    raise exception 'cleared reservation did not allow the next request';
  end if;
  select * into outcome from private.record_mia_attempt_outcome(
    owner, second_request, 1, 'completed', 'reported',
    100, 10, null, null, 0, 5,
    'server sentence', '[]'::jsonb, null, null, null,
    0
  );
  select * into budget from pg_temp.budget_state();
  if outcome.usage_updated is distinct from true
    or outcome.actual_cost is null
    or outcome.actual_cost <= 0
    or budget.php_reserved <> 0
    or budget.usd_reserved <> 0
    or budget.php_spent <= 0
    or budget.usd_spent <= 0
    or budget.php_reserved + budget.php_spent > 500
    or budget.usd_reserved + budget.usd_spent > 8
  then
    raise exception 'reconciled cost did not release the reservation inside both ceilings';
  end if;
  raise notice 'verified billing releases the reservation';

  third_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'budget-over-input', repeat('c', 64), 'What is spend?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, third_request);
  if claimed.authorized is distinct from true then
    raise exception 'input-cap case could not reserve';
  end if;
  select * into outcome from private.record_mia_attempt_outcome(
    owner, third_request, 1, 'completed', 'reported',
    3001, 10, null, null, 0, 5,
    'server sentence', '[]'::jsonb, null, null, null,
    0
  );
  reset role;
  select input_tokens, output_tokens, cached_input_tokens, other_billable_tokens, actual_cost
    into token_input, token_output, token_cached, token_other, token_cost
  from private.mia_usage
  where accounting_ref = third_request
    and attempt_number = 1;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.budget_state();
  if outcome.usage_updated is distinct from true
    or outcome.usage_outcome is distinct from 'reconciliation_required'
    or outcome.actual_cost is not null
    or token_input is distinct from 3001
    or token_output is distinct from 10
    or token_cached is distinct from 0
    or token_other is not null
    or token_cost is not null
    or budget.php_reserved <= 0
    or budget.usd_reserved <= 0
    or budget.php_hold <= 0
    or budget.usd_hold <= 0
  then
    raise exception 'input usage above 3000 was accepted';
  end if;
  fourth_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'budget-over-next', repeat('d', 64), 'What is revenue?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, fourth_request);
  if claimed.authorized is distinct from false then
    raise exception 'input above 3000 released the reservation';
  end if;
  raise notice 'input above 3000 keeps the reservation';

  reset role;
  update private.mia_test_budget
  set php_reserved = 0, php_hold = 0, usd_reserved = 0, usd_hold = 0
  where singleton;
  update private.mia_usage
  set outcome = 'failed', billing_status = 'non_billable'
  where accounting_ref = third_request;
  set local role mediaiq_evidence_writer;
  fifth_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'budget-unpriced', repeat('e', 64), 'What is clicks?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, fifth_request);
  if claimed.authorized is distinct from true then
    raise exception 'unpriced-token case could not reserve';
  end if;
  select * into outcome from private.record_mia_attempt_outcome(
    owner, fifth_request, 1, 'completed', 'reported',
    20, 5, 7, null, 0, 5,
    'server sentence', '[]'::jsonb, null, null, null,
    1
  );
  reset role;
  select input_tokens, output_tokens, cached_input_tokens, other_billable_tokens, actual_cost
    into token_input, token_output, token_cached, token_other, token_cost
  from private.mia_usage
  where accounting_ref = fifth_request
    and attempt_number = 1;
  set local role mediaiq_evidence_writer;
  select * into budget from pg_temp.budget_state();
  if outcome.usage_updated is distinct from true
    or outcome.usage_outcome is distinct from 'reconciliation_required'
    or outcome.actual_cost is not null
    or token_input is distinct from 20
    or token_output is distinct from 5
    or token_cached is distinct from 1
    or token_other is distinct from 7
    or token_cost is not null
    or budget.php_reserved <= 0
    or budget.usd_reserved <= 0
    or budget.php_hold <= 0
    or budget.usd_hold <= 0
  then
    raise exception 'unpriced additional tokens were dropped or priced';
  end if;
  select * into repeated from private.record_mia_attempt_outcome(
    owner, fifth_request, 1, 'completed', 'reported',
    1, 1, 0, null, 0, 1,
    'replaced', '[]'::jsonb, null, null, null,
    0
  );
  reset role;
  select other_billable_tokens into token_other
  from private.mia_usage
  where accounting_ref = fifth_request
    and attempt_number = 1;
  set local role mediaiq_evidence_writer;
  if repeated.usage_updated is distinct from false or token_other is distinct from 7 then
    raise exception 'a terminal usage row was overwritten';
  end if;
  sixth_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'budget-unpriced-next', repeat('f', 64), 'What is conversions?'
    )
  );
  select * into claimed from private.claim_mia_dispatch(owner, sixth_request);
  if claimed.authorized is distinct from false then
    raise exception 'unknown cost allowed another paid request';
  end if;
  raise notice 'unpriced tokens keep the reservation';

  reset role;
  delete from private.mia_approved_provider where provider = 'openai' and model = 'gpt-6-luna';
end;
$$;

rollback;
