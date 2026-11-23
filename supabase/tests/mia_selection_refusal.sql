-- Selection-refusal persistence. Rolls back. Does not change prices, approval, or budget balances.
-- Run as supabase_admin:
--   docker exec -i supabase_db_MediaIQ psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/mia_selection_refusal.sql

begin;

create function pg_temp.request_state(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select request.state from private.mia_request as request where request.id = p_id $$;

create function pg_temp.request_rendered(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select request.rendered_text from private.mia_request as request where request.id = p_id $$;

create function pg_temp.request_references(p_id uuid) returns jsonb
language sql security definer set search_path = ''
as $$ select request.validated_references from private.mia_request as request where request.id = p_id $$;

create function pg_temp.usage_count(p_ref uuid) returns integer
language sql security definer set search_path = ''
as $$ select count(*)::integer from private.mia_usage where accounting_ref = p_ref $$;

create function pg_temp.exchange_question(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select evidence.latest_question from private.campaign_evidence as evidence where evidence.id = p_id $$;

create function pg_temp.exchange_answer(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select evidence.latest_answer from private.campaign_evidence as evidence where evidence.id = p_id $$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '3e10f001-0000-4000-8000-00000000000f',
  'authenticated', 'authenticated',
  'mia-selection-refusal@mia-selection-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
), (
  '00000000-0000-0000-0000-000000000000',
  '3e10f002-0000-4000-8000-00000000000f',
  'authenticated', 'authenticated',
  'mia-selection-other@mia-selection-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner uuid := '3e10f001-0000-4000-8000-00000000000f';
  other_owner uuid := '3e10f002-0000-4000-8000-00000000000f';
  evidence_id uuid;
  summary_id uuid;
  question_id uuid;
  usage_question uuid;
  processing_question uuid;
  opened record;
  refused record;
  php_reserved numeric;
  usd_reserved numeric;
  php_spent numeric;
  usd_spent numeric;
  php_reserved_after numeric;
  usd_reserved_after numeric;
  php_spent_after numeric;
  usd_spent_after numeric;
begin
  if has_function_privilege('public', 'private.refuse_mia_selection(uuid, uuid, uuid, text)', 'execute')
    or has_function_privilege('anon', 'private.refuse_mia_selection(uuid, uuid, uuid, text)', 'execute')
    or has_function_privilege('authenticated', 'private.refuse_mia_selection(uuid, uuid, uuid, text)', 'execute')
    or not has_function_privilege('mediaiq_evidence_writer', 'private.refuse_mia_selection(uuid, uuid, uuid, text)', 'execute')
  then
    raise exception 'selection refusal execute privilege is not limited to the evidence writer';
  end if;

  select account.php_reserved, account.usd_reserved, account.php_spent, account.usd_spent
    into php_reserved, usd_reserved, php_spent, usd_spent
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
    owner, evidence_id, 'evidence_question', 'selection-ambiguous', repeat('a', 64), 'What is the spend for Meta?'
  );
  question_id := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'performance_summary', 'selection-summary', repeat('b', 64), null
  );
  summary_id := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'selection-usage', repeat('c', 64), 'What is the spend for Meta?'
  );
  usage_question := opened.request_id;
  select * into opened
  from private.open_mia_request(
    owner, evidence_id, 'evidence_question', 'selection-processing', repeat('d', 64), 'What is the spend for Meta?'
  );
  processing_question := opened.request_id;
  reset role;

  update private.campaign_evidence as evidence
  set
    latest_question = 'Earlier question?',
    latest_answer = 'Spend for the file in USD was $25.30 USD.',
    latest_exchange_at = pg_catalog.now()
  where evidence.id = evidence_id
    and evidence.owner_id = owner;

  insert into private.mia_usage (
    accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
  ) values (
    usage_question, owner, 1, 'openai', 'gpt-6-luna', 'processing', 'unknown'
  );

  update private.mia_request as request
  set state = 'processing'
  where request.id = processing_question
    and request.owner_id = owner
    and request.state = 'validating';

  set local role mediaiq_evidence_writer;

  begin
    perform private.refuse_mia_selection(owner, evidence_id, question_id, 'recommendation');
    raise exception 'an intent refusal code was accepted as a selection refusal';
  exception
    when sqlstate '22023' then
      null;
  end;
  if pg_temp.request_state(question_id) is distinct from 'validating' then
    raise exception 'rejected selection code changed the request';
  end if;

  select * into refused
  from private.refuse_mia_selection(other_owner, evidence_id, question_id, 'ambiguous_question');
  if refused.result_code is distinct from 'not_found'
    or pg_temp.request_state(question_id) is distinct from 'validating'
  then
    raise exception 'foreign owner selection refusal was not denied';
  end if;

  select * into refused
  from private.refuse_mia_selection(owner, evidence_id, summary_id, 'unsupported_question');
  if refused.result_code is distinct from 'not_found'
    or pg_temp.request_state(summary_id) is distinct from 'validating'
  then
    raise exception 'summary request accepted a selection refusal';
  end if;

  select * into refused
  from private.refuse_mia_selection(owner, evidence_id, usage_question, 'ambiguous_question');
  if refused.result_code is distinct from 'not_refusable'
    or pg_temp.request_state(usage_question) is distinct from 'validating'
    or pg_temp.usage_count(usage_question) is distinct from 1
  then
    raise exception 'selection refusal changed a request that already has usage';
  end if;

  select * into refused
  from private.refuse_mia_selection(owner, evidence_id, processing_question, 'ambiguous_question');
  if refused.result_code is distinct from 'not_refusable'
    or pg_temp.request_state(processing_question) is distinct from 'processing'
  then
    raise exception 'selection refusal changed a processing request';
  end if;

  select * into refused
  from private.refuse_mia_selection(owner, evidence_id, question_id, 'ambiguous_question');
  if refused.result_code is distinct from 'refused'
    or refused.state is distinct from 'refused'
    or refused.rendered_text is distinct from 'MIA cannot tell which saved value that question asks for.'
    or pg_temp.usage_count(question_id) is distinct from 0
  then
    raise exception 'ambiguous selection refusal was not stored without usage';
  end if;
  if pg_temp.request_references(question_id)
    is distinct from pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('kind', 'selection_refusal', 'code', 'ambiguous_question')
    )
  then
    raise exception 'selection refusal marker was %', pg_temp.request_references(question_id);
  end if;

  select * into refused
  from private.refuse_mia_selection(owner, evidence_id, question_id, 'unsupported_question');
  if refused.result_code is distinct from 'unchanged'
    or refused.state is distinct from 'refused'
    or refused.rendered_text is distinct from 'MIA cannot tell which saved value that question asks for.'
    or pg_temp.request_state(question_id) is distinct from 'refused'
  then
    raise exception 'replayed selection refusal was not terminal';
  end if;

  reset role;

  if pg_temp.exchange_question(evidence_id) is distinct from 'Earlier question?'
    or pg_temp.exchange_answer(evidence_id) is distinct from 'Spend for the file in USD was $25.30 USD.'
  then
    raise exception 'selection refusal replaced the saved exchange';
  end if;

  select account.php_reserved, account.usd_reserved, account.php_spent, account.usd_spent
    into php_reserved_after, usd_reserved_after, php_spent_after, usd_spent_after
  from private.mia_test_budget as account
  where account.singleton;
  if php_reserved_after is distinct from php_reserved
    or usd_reserved_after is distinct from usd_reserved
    or php_spent_after is distinct from php_spent
    or usd_spent_after is distinct from usd_spent
  then
    raise exception 'selection refusal changed the budget balances';
  end if;

  raise notice 'selection refusal persisted without usage, budget, or exchange changes';
end $$;

rollback;
