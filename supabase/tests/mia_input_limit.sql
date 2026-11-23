-- Pre-dispatch input-limit failure. Rolls back. Does not reserve budget or insert usage.
--   docker exec -i supabase_db_MediaIQ psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/mia_input_limit.sql

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '13131313-1313-4131-8131-131313131313',
  'authenticated', 'authenticated',
  'mia-input-limit@mia-input-limit-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '13131313-1313-4131-8131-131313131313';
  evidence_id uuid;
  question_request uuid;
  summary_request uuid;
  other_request uuid;
  failed record;
  replay record;
  stored record;
  exchange record;
  refused record;
  reserved_before numeric;
  reserved_after numeric;
  usage_rows integer;
  limit_message text := 'This evidence is too large to send within the 3,000-token input limit.';
begin
  select php_reserved + usd_reserved into reserved_before
  from private.mia_test_budget
  where singleton;

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
  set
    latest_question = 'What is spend?',
    latest_answer = 'Spend is 10.00.',
    latest_exchange_at = pg_catalog.now()
  where id = evidence_id
    and owner_id = owner;
  set local role mediaiq_evidence_writer;

  question_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'input-limit-question', repeat('a', 64), 'What is revenue?'
    )
  );
  select * into failed
  from private.fail_mia_request_before_dispatch(owner, evidence_id, question_request);
  if failed.result_code is distinct from 'failed'
    or failed.state is distinct from 'failed'
    or failed.failure_category is distinct from limit_message
  then
    raise exception 'oversized request was not stored as a terminal failure';
  end if;

  select * into replay from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'input-limit-question', repeat('a', 64), 'What is revenue?'
  );
  if replay.request_id is distinct from question_request
    or replay.state is distinct from 'failed'
    or replay.result_code is distinct from 'unchanged'
  then
    raise exception 'same key did not return the stored input-limit failure';
  end if;

  select * into stored
  from private.read_mia_request(owner, evidence_id, question_request);
  if stored.state is distinct from 'failed'
    or stored.rendered_text is not null
    or stored.failure_category is distinct from limit_message
  then
    raise exception 'refresh did not return the same terminal result';
  end if;

  select * into failed
  from private.fail_mia_request_before_dispatch(owner, evidence_id, question_request);
  if failed.result_code is distinct from 'unchanged' or failed.state is distinct from 'failed' then
    raise exception 'replaying the pre-dispatch failure changed the terminal row';
  end if;

  reset role;
  select latest_question, latest_answer into exchange
  from private.campaign_evidence
  where id = evidence_id;
  select count(*) into usage_rows
  from private.mia_usage
  where accounting_ref = question_request;
  select php_reserved + usd_reserved into reserved_after
  from private.mia_test_budget
  where singleton;
  if exchange.latest_question is distinct from 'What is spend?'
    or exchange.latest_answer is distinct from 'Spend is 10.00.'
    or usage_rows <> 0
    or reserved_after is distinct from reserved_before
  then
    raise exception 'pre-dispatch failure changed the exchange, usage, or reservation';
  end if;
  set local role mediaiq_evidence_writer;

  summary_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'performance_summary', 'input-limit-summary', repeat('b', 64), null
    )
  );
  select * into failed
  from private.fail_mia_request_before_dispatch(owner, evidence_id, summary_request);
  select * into replay from private.open_mia_request(
    owner, evidence_id, 'performance_summary', 'another-summary-key', repeat('c', 64), null
  );
  if failed.state is distinct from 'failed'
    or replay.request_id is distinct from summary_request
    or replay.state is distinct from 'failed'
  then
    raise exception 'summary refresh did not keep the same terminal failure';
  end if;

  other_request := (
    select request_id from private.open_mia_request(
      owner, evidence_id, 'evidence_question', 'input-limit-refused', repeat('d', 64), 'What should we change?'
    )
  );
  select * into refused
  from private.refuse_validated_mia_question(owner, evidence_id, other_request, 'recommendation');
  select * into failed
  from private.fail_mia_request_before_dispatch(owner, evidence_id, other_request);
  if refused.state is distinct from 'refused'
    or failed.result_code is distinct from 'not_pre_dispatch'
    or failed.state is distinct from 'refused'
  then
    raise exception 'pre-dispatch failure overwrote a terminal refusal';
  end if;

  raise notice 'input-limit failure is terminal, idempotent, and does not reserve usage';
end;
$$;

rollback;
