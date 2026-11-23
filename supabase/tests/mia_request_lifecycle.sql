-- MIA request lifecycle authorization tests.
-- Run as supabase_admin, which can insert auth.users and set role.
-- The postgres role is a member of the evidence writer but cannot set that role.
--   docker exec -i supabase_db_MediaIQ psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/mia_request_lifecycle.sql
-- Do not set a writer password. Do not read MEDIAIQ_EVIDENCE_DATABASE_URL.
-- The first section rolls back. The concurrency section commits a fixture
-- only long enough to lock it, then deletes that fixture.

create function pg_temp.fund_mia_budget() returns void
language sql
security definer
set search_path = ''
as $$
  update private.mia_test_budget
  set
    php_reserved = 0,
    php_spent = 0,
    php_hold = 0,
    usd_reserved = 0,
    usd_spent = 0,
    usd_hold = 0,
    php_per_million_uncached_input = 10,
    php_per_million_cached_input = 1,
    php_per_million_output = 10,
    usd_per_million_uncached_input = 1,
    usd_per_million_cached_input = 0.1,
    usd_per_million_output = 1
  where singleton
$$;

create function pg_temp.clear_mia_budget() returns void
language sql
security definer
set search_path = ''
as $$
  update private.mia_test_budget
  set
    php_reserved = 0,
    php_spent = 0,
    php_hold = 0,
    usd_reserved = 0,
    usd_spent = 0,
    usd_hold = 0,
    php_per_million_uncached_input = null,
    php_per_million_cached_input = null,
    php_per_million_output = null,
    usd_per_million_uncached_input = null,
    usd_per_million_cached_input = null,
    usd_per_million_output = null
  where singleton
$$;

begin;

create function pg_temp.usage_count(p_owner uuid) returns integer
language sql security definer set search_path = ''
as $$ select count(*)::integer from private.mia_usage where owner_id = p_owner $$;

create function pg_temp.usage_field(p_ref uuid) returns table (
  provider text, model text, outcome text, actual_cost numeric, input_tokens integer
)
language sql security definer set search_path = ''
as $$
  select usage.provider, usage.model, usage.outcome, usage.actual_cost, usage.input_tokens
  from private.mia_usage as usage
  where usage.accounting_ref = p_ref
$$;

create function pg_temp.request_state(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select request.state from private.mia_request as request where request.id = p_id $$;

create function pg_temp.request_rendered(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select request.rendered_text from private.mia_request as request where request.id = p_id $$;

create function pg_temp.summary_count(p_evidence uuid) returns integer
language sql security definer set search_path = ''
as $$
  select count(*)::integer
  from private.mia_request
  where evidence_id = p_evidence and request_type = 'performance_summary'
$$;

create function pg_temp.exchange_question(p_evidence uuid) returns text
language sql security definer set search_path = ''
as $$ select evidence.latest_question from private.campaign_evidence as evidence where evidence.id = p_evidence $$;

create function pg_temp.evidence_exists(p_evidence uuid) returns boolean
language sql security definer set search_path = ''
as $$ select exists (select 1 from private.campaign_evidence where id = p_evidence) $$;

create function pg_temp.request_exists(p_id uuid) returns boolean
language sql security definer set search_path = ''
as $$ select exists (select 1 from private.mia_request where id = p_id) $$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated',
  'mia-owner-a@mia-lifecycle-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
), (
  '00000000-0000-0000-0000-000000000000',
  '22222222-2222-4222-8222-222222222222',
  'authenticated', 'authenticated',
  'mia-owner-b@mia-lifecycle-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  evidence_a uuid;
  evidence_b uuid;
  summary_request uuid;
  question_request uuid;
  submitted_request uuid;
  opened record;
  claimed record;
  outcome record;
  context record;
  usage_count integer;
  request_count integer;
  stored_cost numeric;
  stored_outcome text;
  exchange_question text;
  exchange_at timestamptz;
  source_count integer;
  evidence_before integer;
  stored_parser text;
  stored_calculation text;
begin
  if has_table_privilege('mediaiq_evidence_writer', 'private.mia_request', 'select, insert, update, delete')
    or has_table_privilege('mediaiq_evidence_writer', 'private.mia_usage', 'select, insert, update, delete')
    or has_table_privilege('mediaiq_evidence_writer', 'private.mia_approved_provider', 'select, insert, update, delete')
    or has_table_privilege('mediaiq_evidence_writer', 'private.mia_test_budget', 'select, insert, update, delete')
  then
    raise exception 'writer has a direct ledger privilege';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(relation.relacl) as acl
    where namespace.nspname = 'private'
      and relation.relname = 'mia_usage'
      and acl.privilege_type in ('DELETE', 'TRUNCATE')
  ) or exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(relation.relacl) as acl
    where namespace.nspname = 'private'
      and relation.relname = 'mia_approved_provider'
      and acl.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    raise exception 'ledger owner privileges are broader than the lifecycle allows';
  end if;
  if has_function_privilege('anon', 'private.claim_mia_dispatch(uuid, uuid)', 'execute')
    or has_function_privilege('authenticated', 'private.claim_mia_dispatch(uuid, uuid)', 'execute')
    or has_function_privilege('public', 'private.open_mia_request(uuid, uuid, text, text, text, text)', 'execute')
  then
    raise exception 'ledger functions are executable outside the writer role';
  end if;
  if pg_catalog.pg_get_function_result('private.read_mia_evidence_context(uuid, uuid)'::regprocedure)
    ilike '%source_text%'
  then
    raise exception 'context read exposes source text';
  end if;
  if (select count(*) from private.mia_approved_provider) <> 0 then
    raise exception 'approved provider table was not empty at the start of the test';
  end if;

  set local role mediaiq_evidence_writer;
  evidence_a := private.insert_campaign_evidence(
    '11111111-1111-4111-8111-111111111111',
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  evidence_b := private.insert_campaign_evidence(
    '22222222-2222-4222-8222-222222222222',
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"3.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );

  reset role;
  select count(*)
    into evidence_before
  from private.campaign_evidence
  where owner_id = '11111111-1111-4111-8111-111111111111';
  set local role mediaiq_evidence_writer;
  begin
    perform private.insert_campaign_evidence(
      '11111111-1111-4111-8111-111111111111',
      'date,campaign,channel,spend,impressions,clicks',
      '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
      'other-parser',
      'campaign-descriptive-1'
    );
    raise exception 'mismatched parser version was inserted';
  exception
    when sqlstate '22023' then
      null;
  end;
  reset role;
  if (
    select count(*)
    from private.campaign_evidence
    where owner_id = '11111111-1111-4111-8111-111111111111'
  ) is distinct from evidence_before then
    raise exception 'mismatched parser version inserted an evidence row';
  end if;
  set local role mediaiq_evidence_writer;
  raise notice 'test summary version mismatch rejected';

  select * into opened
  from private.open_mia_request(
    '22222222-2222-4222-8222-222222222222',
    evidence_a,
    'performance_summary',
    'owner-b-summary',
    repeat('a', 64),
    null
  );
  if opened.result_code is distinct from 'not_found' then
    raise exception 'owner isolation failed: %', opened.result_code;
  end if;
  if exists (
    select 1 from private.read_mia_evidence_context(
      '22222222-2222-4222-8222-222222222222', evidence_a
    )
  ) then
    raise exception 'owner isolation failed on context read';
  end if;
  raise notice 'test 1 owner isolation';

  begin
    perform 1 from private.mia_request;
    raise exception 'writer read the request ledger';
  exception
    when insufficient_privilege then
      null;
  end;
  begin
    insert into private.mia_usage (
      accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
    ) values (
      gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 1,
      'fixtureprovider', 'fixturemodel', 'processing', 'unknown'
    );
    raise exception 'writer inserted usage';
  exception
    when insufficient_privilege then
      null;
  end;
  raise notice 'test 2 writer cannot read or modify ledger tables';

  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'performance_summary',
    'summary-key',
    repeat('a', 64),
    null
  );
  if opened.result_code is distinct from 'created' or opened.state is distinct from 'validating' then
    raise exception 'summary was not created: % %', opened.result_code, opened.state;
  end if;
  summary_request := opened.request_id;

  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'performance_summary',
    'summary-key',
    repeat('a', 64),
    null
  );
  if opened.result_code is distinct from 'unchanged'
    or opened.request_id is distinct from summary_request
    or opened.state is distinct from 'validating'
  then
    raise exception 'matching fingerprint was not idempotent: %', opened.result_code;
  end if;
  if pg_temp.summary_count(evidence_a) <> 1 then
    raise exception 'summary idempotency created a second request';
  end if;
  raise notice 'test 3 matching fingerprint idempotency';

  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'performance_summary',
    'summary-key-other',
    repeat('b', 64),
    null
  );
  if opened.result_code is distinct from 'fingerprint_mismatch'
    or opened.request_id is distinct from summary_request
    or opened.state is distinct from 'validating'
  then
    raise exception 'mismatched fingerprint was not rejected: %', opened.result_code;
  end if;
  raise notice 'test 4 mismatched fingerprint';

  reset role;
  insert into private.mia_request (
    id, owner_id, evidence_id, request_type, state, idempotency_key, payload_fingerprint, question_text
  ) values (
    '33333333-3333-4333-8333-333333333331',
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'evidence_question',
    'submitted',
    'submitted-key',
    repeat('c', 64),
    'What is spend?'
  );
  set local role mediaiq_evidence_writer;
  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'evidence_question',
    'submitted-key',
    repeat('c', 64),
    'What is spend?'
  );
  if opened.result_code is distinct from 'progressed' or opened.state is distinct from 'validating' then
    raise exception 'submitted request did not progress: % %', opened.result_code, opened.state;
  end if;
  submitted_request := opened.request_id;
  raise notice 'test 5 submitted request progresses';

  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'evidence_question',
    'submitted-key',
    repeat('c', 64),
    'What is spend?'
  );
  if opened.result_code is distinct from 'unchanged' or opened.state is distinct from 'validating' then
    raise exception 'validating replay changed the request: % %', opened.result_code, opened.state;
  end if;
  if pg_temp.usage_count('11111111-1111-4111-8111-111111111111') <> 0 then
    raise exception 'validating replay reserved usage';
  end if;
  raise notice 'test 6 validating replay does not claim';

  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    summary_request
  );
  if claimed.authorized is distinct from false or claimed.state is distinct from 'validating' then
    raise exception 'claim succeeded without an approval row: %', claimed.authorized;
  end if;
  if pg_temp.usage_count('11111111-1111-4111-8111-111111111111') <> 0 then
    raise exception 'absent approval reserved usage';
  end if;
  raise notice 'test 8 claim fails when approval is absent';

  reset role;
  insert into private.mia_approved_provider (provider, model)
  values ('not approved', 'not approved');
  set local role mediaiq_evidence_writer;
  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    summary_request
  );
  if claimed.authorized is distinct from false or claimed.state is distinct from 'validating' then
    raise exception 'invalid provider configuration authorized dispatch';
  end if;
  if pg_temp.usage_count('11111111-1111-4111-8111-111111111111') <> 0 then
    raise exception 'invalid provider configuration reserved usage';
  end if;
  raise notice 'test 9 invalid provider configuration';

  reset role;
  delete from private.mia_approved_provider;
  insert into private.mia_approved_provider (provider, model)
  values ('fixtureprovider', 'fixturemodel');
  perform pg_temp.fund_mia_budget();
  set local role mediaiq_evidence_writer;

  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    summary_request
  );
  if claimed.authorized is distinct from true
    or claimed.accounting_ref is distinct from summary_request
    or claimed.attempt_number is distinct from 1
    or claimed.state is distinct from 'processing'
    or claimed.provider is distinct from 'fixtureprovider'
    or claimed.model is distinct from 'fixturemodel'
  then
    raise exception 'approved claim did not record the provider before authorization';
  end if;
  select usage.provider, usage.model, usage.actual_cost, usage.input_tokens
    into stored_outcome, exchange_question, stored_cost, request_count
  from pg_temp.usage_field(summary_request) as usage;
  if pg_temp.usage_count('11111111-1111-4111-8111-111111111111') <> 1
    or stored_outcome is distinct from 'fixtureprovider'
    or exchange_question is distinct from 'fixturemodel'
    or stored_cost is not null
    or request_count is not null
  then
    raise exception 'initial usage reservation is not exactly one unknown-cost row';
  end if;
  raise notice 'test 10 provider and model recorded before authorization';
  raise notice 'test 11 exactly one initial usage reservation';

  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    summary_request
  );
  if claimed.authorized is distinct from false then
    raise exception 'duplicate claim was authorized';
  end if;
  if pg_temp.usage_count('11111111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'duplicate claim created another usage row';
  end if;
  raise notice 'test 7 only one claim succeeds';

  reset role;
  begin
    update private.mia_request
    set state = 'completed'
    where id = submitted_request;
    raise exception 'illegal transition was accepted';
  exception
    when check_violation then
      null;
  end;
  if pg_temp.request_state(submitted_request) is distinct from 'validating' then
    raise exception 'illegal transition changed the request';
  end if;
  raise notice 'test 12 illegal transition rejected';

  set local role mediaiq_evidence_writer;
  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'evidence_question',
    'conversation-key',
    repeat('d', 64),
    'Which channel has more spend?'
  );
  question_request := opened.request_id;
  select * into outcome
  from private.record_mia_attempt_outcome(
    '11111111-1111-4111-8111-111111111111',
    summary_request,
    1,
    'completed',
    'non_billable',
    null, null, null, null, null, null,
    'Spend is 10.00.',
    '[]'::jsonb,
    null,
    null,
    null
  );
  if outcome.usage_updated is distinct from true or outcome.request_state is distinct from 'completed' then
    raise exception 'summary reservation was not released before the next claim';
  end if;
  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    question_request
  );
  if claimed.authorized is distinct from true then
    raise exception 'question claim was not authorized';
  end if;

  select * into outcome
  from private.record_mia_attempt_outcome(
    '11111111-1111-4111-8111-111111111111',
    question_request,
    1,
    'refused',
    'non_billable',
    null, null, null, null, null, null,
    'That comparison is not in the evidence.',
    '[]'::jsonb,
    null,
    'Which channel has more spend?',
    'That comparison is not in the evidence.'
  );
  if outcome.usage_updated is distinct from true
    or outcome.request_state is distinct from 'refused'
    or outcome.usage_outcome is distinct from 'refused'
    or outcome.actual_cost is not null
  then
    raise exception 'refused outcome was not atomic';
  end if;
  select usage.outcome, usage.actual_cost
    into stored_outcome, stored_cost
  from pg_temp.usage_field(question_request) as usage;
  if pg_temp.request_state(question_request) is distinct from 'refused'
    or stored_outcome is distinct from 'refused'
    or stored_cost is not null
  then
    raise exception 'request and usage were not updated together';
  end if;
  exchange_question := pg_temp.exchange_question(evidence_a);
  if exchange_question is distinct from 'Which channel has more spend?' then
    raise exception 'validated refusal did not update the conversation';
  end if;
  raise notice 'test 13 outcome and request state update atomically';
  raise notice 'test 16 validated refusal updates conversation';
  raise notice 'test 24 null cost stays null';

  select * into outcome
  from private.record_mia_attempt_outcome(
    '11111111-1111-4111-8111-111111111111',
    question_request,
    1,
    'completed',
    'reported',
    10, 10, 0, 1, 0, 5,
    'replaced',
    '[]'::jsonb,
    null,
    'replaced question',
    'replaced answer'
  );
  if outcome.usage_updated is distinct from false
    or outcome.usage_outcome is distinct from 'refused'
    or outcome.actual_cost is not null
  then
    raise exception 'duplicate outcome overwrote a terminal outcome';
  end if;
  if pg_temp.exchange_question(evidence_a) is distinct from 'Which channel has more spend?' then
    raise exception 'duplicate outcome overwrote the conversation';
  end if;
  raise notice 'test 14 duplicate outcome does not overwrite a terminal outcome';

  select * into outcome
  from private.record_mia_attempt_outcome(
    '11111111-1111-4111-8111-111111111111',
    summary_request,
    1,
    'completed',
    'unknown',
    null, null, null, null, null, null,
    'Spend is 10.00.',
    '[]'::jsonb,
    null,
    'should not become the question',
    'should not become the answer'
  );
  if outcome.request_state is distinct from 'completed' then
    raise exception 'summary did not complete';
  end if;
  if pg_temp.exchange_question(evidence_a) is distinct from 'Which channel has more spend?'
    or pg_temp.request_rendered(summary_request) is distinct from 'Spend is 10.00.'
  then
    raise exception 'summary completion changed the conversation';
  end if;
  raise notice 'test 15 summary completion does not overwrite conversation';

  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'evidence_question',
    'failed-key',
    repeat('e', 64),
    'Why did spend change?'
  );
  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    opened.request_id
  );
  select * into outcome
  from private.record_mia_attempt_outcome(
    '11111111-1111-4111-8111-111111111111',
    opened.request_id,
    1,
    'failed',
    'non_billable',
    null, null, null, null, null, null,
    null,
    null,
    'provider_error',
    'Why did spend change?',
    'This answer must not be stored.'
  );
  if pg_temp.exchange_question(evidence_a) is distinct from 'Which channel has more spend?' then
    raise exception 'failed question overwrote the conversation';
  end if;
  raise notice 'test 17 failed question does not overwrite conversation';

  select * into context
  from private.read_mia_evidence_context(
    '11111111-1111-4111-8111-111111111111',
    evidence_a
  );
  if context.summary->>'spend' is distinct from '10.00'
    or context.latest_question is distinct from 'Which channel has more spend?'
    or context.latest_answer is distinct from 'That comparison is not in the evidence.'
  then
    raise exception 'context read did not return the summary and latest exchange';
  end if;
  if to_jsonb(context) ? 'source_text'
    or context::text like '%date,campaign,channel,spend,impressions,clicks%'
  then
    raise exception 'context read returned source CSV text';
  end if;
  reset role;
  select evidence.parser_version, evidence.calculation_version
    into stored_parser, stored_calculation
  from private.campaign_evidence as evidence
  where evidence.id = evidence_a;
  if context.summary->>'parserVersion' is distinct from stored_parser
    or context.summary->>'calculationVersion' is distinct from stored_calculation
    or stored_parser is distinct from 'monday-csv-1'
    or stored_calculation is distinct from 'campaign-descriptive-1'
  then
    raise exception 'context versions do not match the stored evidence row';
  end if;
  set local role mediaiq_evidence_writer;
  raise notice 'test context read';
  raise notice 'test summary versions match the stored row';

  if private.delete_campaign_evidence(
    '11111111-1111-4111-8111-111111111111',
    evidence_a
  ) is distinct from evidence_a then
    raise exception 'delete did not return the evidence id';
  end if;
  if pg_temp.evidence_exists(evidence_a)
    or pg_temp.summary_count(evidence_a) <> 0
    or pg_temp.request_exists(question_request)
  then
    raise exception 'delete left evidence or request content';
  end if;
  if pg_temp.usage_count('11111111-1111-4111-8111-111111111111') <> 3 then
    raise exception 'delete removed or changed usage rows';
  end if;
  raise notice 'test 18 deletion removes request content';
  raise notice 'test 19 deletion preserves usage';

  select * into opened
  from private.open_mia_request(
    '11111111-1111-4111-8111-111111111111',
    evidence_a,
    'evidence_question',
    'after-delete',
    repeat('f', 64),
    'Is the file still there?'
  );
  if opened.result_code is distinct from 'not_found' then
    raise exception 'create after deletion did not return not_found';
  end if;
  raise notice 'test 20 create after deletion';

  select * into claimed
  from private.claim_mia_dispatch(
    '11111111-1111-4111-8111-111111111111',
    summary_request
  );
  if claimed.authorized is distinct from false or claimed.state is distinct from 'not_found' then
    raise exception 'claim after deletion was authorized';
  end if;
  raise notice 'test 21 claim after deletion';

  select * into outcome
  from private.record_mia_attempt_outcome(
    '11111111-1111-4111-8111-111111111111',
    summary_request,
    1,
    'completed',
    'reported',
    null, null, null, null, 0, null,
    'recreated summary',
    '[]'::jsonb,
    null,
    null,
    null
  );
  if outcome.usage_updated is distinct from false
    or outcome.request_state is not null
    or outcome.usage_outcome is distinct from 'completed'
  then
    raise exception 'outcome after completion was not a stored no-op';
  end if;
  if pg_temp.request_exists(summary_request) or pg_temp.evidence_exists(evidence_a) then
    raise exception 'outcome after deletion recreated customer content';
  end if;
  raise notice 'test 22 and 23 terminal outcome after deletion does not recreate content';

  select * into opened
  from private.open_mia_request(
    '22222222-2222-4222-8222-222222222222',
    evidence_b,
    'evidence_question',
    'usage-only',
    repeat('a', 64),
    'What is spend?'
  );
  select * into claimed
  from private.claim_mia_dispatch(
    '22222222-2222-4222-8222-222222222222',
    opened.request_id
  );
  perform private.delete_campaign_evidence(
    '22222222-2222-4222-8222-222222222222',
    evidence_b
  );
  select * into outcome
  from private.record_mia_attempt_outcome(
    '22222222-2222-4222-8222-222222222222',
    opened.request_id,
    1,
    'timed_out',
    'unknown',
    null, null, null, null, null, null,
    null, null, 'lost_response', null, null
  );
  if outcome.usage_updated is distinct from true
    or outcome.request_state is not null
    or outcome.actual_cost is not null
  then
    raise exception 'outcome after deletion did not update usage only';
  end if;
  if pg_temp.request_exists(opened.request_id) then
    raise exception 'outcome after deletion recreated the request';
  end if;
  select usage.outcome, usage.actual_cost
    into stored_outcome, stored_cost
  from pg_temp.usage_field(opened.request_id) as usage;
  if stored_outcome is distinct from 'timed_out' or stored_cost is not null then
    raise exception 'deleted-evidence outcome did not keep a null cost';
  end if;
  raise notice 'test 23 outcome after deletion updates usage only';

  begin
    perform private.record_mia_attempt_outcome(
      '22222222-2222-4222-8222-222222222222',
      opened.request_id,
      1,
      'failed',
      'unknown',
      null, null, null, 0, 0, null,
      null, null, null, null, null
    );
    raise exception 'unknown billing accepted a zero cost';
  exception
    when invalid_parameter_value then
      null;
  end;
  select usage.actual_cost into stored_cost from pg_temp.usage_field(opened.request_id) as usage;
  if stored_cost is not null then
    raise exception 'rejected zero cost was stored';
  end if;
  raise notice 'test 24 unknown billing rejects zero';
end;
$$;

rollback;

-- Cross-session lock proofs. The fixture is committed, then removed.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '44444444-4444-4444-8444-444444444444',
  'authenticated', 'authenticated',
  'mia-lock@mia-lifecycle-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

insert into private.campaign_evidence (
  id, owner_id, source_text, summary, parser_version, calculation_version
) values (
  '55555555-5555-4555-8555-555555555551',
  '44444444-4444-4444-8444-444444444444',
  'date,campaign,channel,spend,impressions,clicks',
  '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1"}'::jsonb,
  'monday-csv-1',
  'campaign-descriptive-1'
);

insert into private.mia_request (
  id, owner_id, evidence_id, request_type, state, idempotency_key, payload_fingerprint, question_text
) values (
  '66666666-6666-4666-8666-666666666661',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555551',
  'evidence_question',
  'validating',
  'lock-key',
  repeat('a', 64),
  'What is spend?'
);

insert into private.mia_usage (
  accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
) values (
  '66666666-6666-4666-8666-666666666661',
  '44444444-4444-4444-8444-444444444444',
  1,
  'fixtureprovider',
  'fixturemodel',
  'processing',
  'unknown'
);

select (not exists (select 1 from pg_catalog.pg_extension where extname = 'dblink')) as created_dblink \gset

\if :created_dblink
create extension dblink;
\endif

do $$
declare
  connection text := 'host=/var/run/postgresql dbname=' || current_database() || ' user=' || current_user;
  remote_error text;
begin
  perform dblink_connect('mia_lock', connection);
  perform 1
  from private.campaign_evidence
  where id = '55555555-5555-4555-8555-555555555551'
  for update;

  perform dblink_exec('mia_lock', 'set lock_timeout = ''300ms''');

  begin
    perform *
    from dblink(
      'mia_lock',
      'select request_id, state, result_code from private.open_mia_request('
      || '''44444444-4444-4444-8444-444444444444'', '
      || '''55555555-5555-4555-8555-555555555551'', '
      || '''evidence_question'', ''other-lock-key'', '''
      || repeat('b', 64)
      || ''', ''What is spend?'')'
    ) as remote_open(request_id uuid, state text, result_code text);
    raise exception 'request creation did not wait for the evidence lock';
  exception
    when others then
      remote_error := sqlerrm;
      if remote_error not ilike '%lock timeout%'
        and remote_error not ilike '%lock_not_available%'
      then
        raise;
      end if;
  end;

  begin
    perform *
    from dblink(
      'mia_lock',
      'select authorized, accounting_ref, attempt_number, state, provider, model from private.claim_mia_dispatch('
      || '''44444444-4444-4444-8444-444444444444'', '
      || '''66666666-6666-4666-8666-666666666661'')'
    ) as remote_claim(
      authorized boolean, accounting_ref uuid, attempt_number integer,
      state text, provider text, model text
    );
    raise exception 'dispatch claim did not wait for the evidence lock';
  exception
    when others then
      remote_error := sqlerrm;
      if remote_error not ilike '%lock timeout%'
        and remote_error not ilike '%lock_not_available%'
      then
        raise;
      end if;
  end;

  begin
    perform *
    from dblink(
      'mia_lock',
      'select usage_updated, request_state, usage_outcome, actual_cost from private.record_mia_attempt_outcome('
      || '''44444444-4444-4444-8444-444444444444'', '
      || '''66666666-6666-4666-8666-666666666661'', '
      || '1, ''failed'', ''unknown'', null, null, null, null, null, null, null, null, null, null, null)'
    ) as remote_outcome(
      usage_updated boolean, request_state text, usage_outcome text, actual_cost numeric
    );
    raise exception 'outcome recording did not wait for the evidence lock';
  exception
    when others then
      remote_error := sqlerrm;
      if remote_error not ilike '%lock timeout%'
        and remote_error not ilike '%lock_not_available%'
      then
        raise;
      end if;
  end;

  if (select count(*) from private.mia_request where evidence_id = '55555555-5555-4555-8555-555555555551') <> 1
    or (select outcome from private.mia_usage where accounting_ref = '66666666-6666-4666-8666-666666666661')
      is distinct from 'processing'
    or (select actual_cost from private.mia_usage where accounting_ref = '66666666-6666-4666-8666-666666666661')
      is not null
  then
    raise exception 'a blocked session changed request content or usage';
  end if;
  perform dblink_disconnect('mia_lock');
  raise notice 'tests 20-22 blocked sessions wait on the evidence row';
end;
$$;

delete from private.mia_usage
where accounting_ref = '66666666-6666-4666-8666-666666666661';
delete from private.campaign_evidence
where id = '55555555-5555-4555-8555-555555555551';
delete from auth.users
where id = '44444444-4444-4444-8444-444444444444';

\if :created_dblink
drop extension dblink;
\endif

-- Two overlapping claim calls. The first session keeps its transaction open
-- after a successful claim. The second session waits on that lock, then
-- finishes after the first session commits.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '88888888-8888-4888-8888-888888888888',
  'authenticated', 'authenticated',
  'mia-claim@mia-lifecycle-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

insert into private.campaign_evidence (
  id, owner_id, source_text, summary, parser_version, calculation_version
) values (
  '99999999-9999-4999-8999-999999999999',
  '88888888-8888-4888-8888-888888888888',
  'date,campaign,channel,spend,impressions,clicks',
  '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1"}'::jsonb,
  'monday-csv-1',
  'campaign-descriptive-1'
);

insert into private.mia_request (
  id, owner_id, evidence_id, request_type, state, idempotency_key, payload_fingerprint, question_text
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
  'evidence_question',
  'validating',
  'concurrent-claim',
  repeat('a', 64),
  'What is spend?'
);

select pg_temp.fund_mia_budget();

insert into private.mia_approved_provider (provider, model)
values ('concurrentprovider', 'concurrentmodel');

select (not exists (select 1 from pg_catalog.pg_extension where extname = 'dblink')) as created_dblink_claim \gset

\if :created_dblink_claim
create extension dblink;
\endif

do $$
declare
  connection text := 'host=/var/run/postgresql dbname=' || current_database() || ' user=' || current_user;
  claim_sql text := format(
    'select authorized, accounting_ref, attempt_number, state, provider, model from private.claim_mia_dispatch(%L, %L)',
    '88888888-8888-4888-8888-888888888888',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  );
  winner_authorized boolean;
  winner_ref uuid;
  winner_attempt integer;
  winner_state text;
  winner_provider text;
  winner_model text;
  loser_authorized boolean;
  overlapped boolean := false;
  usage_rows integer;
  attempt_rows integer;
  request_state text;
  stored_provider text;
  stored_model text;
  stored_cost numeric;
begin
  perform dblink_connect('claim_a', connection);
  perform dblink_connect('claim_b', connection);
  perform dblink_exec('claim_a', 'begin');
  perform dblink_exec('claim_b', 'set lock_timeout = ''5s''');

  if dblink_send_query('claim_a', claim_sql) <> 1 then
    raise exception 'could not send the first claim';
  end if;
  select
    remote_claim.authorized,
    remote_claim.accounting_ref,
    remote_claim.attempt_number,
    remote_claim.state,
    remote_claim.provider,
    remote_claim.model
    into winner_authorized, winner_ref, winner_attempt, winner_state, winner_provider, winner_model
  from dblink_get_result('claim_a') as remote_claim(
    authorized boolean,
    accounting_ref uuid,
    attempt_number integer,
    state text,
    provider text,
    model text
  );
  if not found then
    raise exception 'first claim returned no result';
  end if;
  if exists (
    select 1
    from dblink_get_result('claim_a') as extra(
      authorized boolean,
      accounting_ref uuid,
      attempt_number integer,
      state text,
      provider text,
      model text
    )
  ) then
    raise exception 'first claim returned an extra row';
  end if;
  if winner_authorized is distinct from true
    or winner_ref is distinct from 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
    or winner_attempt is distinct from 1
    or winner_state is distinct from 'processing'
    or winner_provider is distinct from 'concurrentprovider'
    or winner_model is distinct from 'concurrentmodel'
  then
    raise exception 'first claim did not authorize the approved attempt';
  end if;

  if dblink_send_query('claim_b', claim_sql) <> 1 then
    raise exception 'could not send the second claim';
  end if;
  for attempt_rows in 1..40 loop
    if exists (
      select 1
      from pg_catalog.pg_stat_activity
      where pid <> pg_backend_pid()
        and query ilike '%claim_mia_dispatch%'
        and wait_event_type = 'Lock'
    ) then
      overlapped := true;
      exit;
    end if;
    perform pg_catalog.pg_sleep(0.05);
  end loop;
  if not overlapped then
    raise exception 'second claim did not wait on the first claim lock';
  end if;

  perform dblink_exec('claim_a', 'commit');
  select remote_claim.authorized
    into loser_authorized
  from dblink_get_result('claim_b') as remote_claim(
    authorized boolean,
    accounting_ref uuid,
    attempt_number integer,
    state text,
    provider text,
    model text
  );
  if not found then
    raise exception 'second claim returned no result';
  end if;
  perform 1
  from dblink_get_result('claim_b') as extra(
    authorized boolean,
    accounting_ref uuid,
    attempt_number integer,
    state text,
    provider text,
    model text
  );
  if loser_authorized is distinct from false then
    raise exception 'second claim was authorized';
  end if;

  select count(*), count(*) filter (where usage.attempt_number = 1), min(usage.provider), min(usage.model), min(usage.actual_cost)
    into usage_rows, attempt_rows, stored_provider, stored_model, stored_cost
  from private.mia_usage as usage
  where usage.accounting_ref = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  select request.state
    into request_state
  from private.mia_request as request
  where request.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  if usage_rows is distinct from 1
    or attempt_rows is distinct from 1
    or stored_provider is distinct from 'concurrentprovider'
    or stored_model is distinct from 'concurrentmodel'
    or stored_cost is not null
    or request_state is distinct from 'processing'
  then
    raise exception 'concurrent claims did not leave one processing reservation';
  end if;

  perform dblink_disconnect('claim_a');
  perform dblink_disconnect('claim_b');
  raise notice 'concurrent claims: one authorized result and one usage reservation';
exception
  when others then
    begin
      perform dblink_exec('claim_a', 'rollback');
    exception
      when others then
        null;
    end;
    begin
      perform dblink_disconnect('claim_a');
    exception
      when others then
        null;
    end;
    begin
      perform dblink_disconnect('claim_b');
    exception
      when others then
        null;
    end;
    begin
      perform dblink_connect('claim_cleanup', connection);
      perform dblink_exec('claim_cleanup', 'delete from private.mia_usage where accounting_ref = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1''');
      perform dblink_exec('claim_cleanup', 'delete from private.mia_approved_provider where provider = ''concurrentprovider'' and model = ''concurrentmodel''');
      perform dblink_exec('claim_cleanup', 'update private.mia_test_budget set php_reserved = 0, php_spent = 0, php_hold = 0, usd_reserved = 0, usd_spent = 0, usd_hold = 0, php_per_million_uncached_input = null, php_per_million_cached_input = null, php_per_million_output = null, usd_per_million_uncached_input = null, usd_per_million_cached_input = null, usd_per_million_output = null where singleton');
      perform dblink_exec('claim_cleanup', 'delete from private.campaign_evidence where id = ''99999999-9999-4999-8999-999999999999''');
      perform dblink_exec('claim_cleanup', 'delete from auth.users where id = ''88888888-8888-4888-8888-888888888888''');
      perform dblink_disconnect('claim_cleanup');
    exception
      when others then
        null;
    end;
    raise;
end;
$$;

select pg_temp.clear_mia_budget();

delete from private.mia_usage
where accounting_ref = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
delete from private.mia_approved_provider
where provider = 'concurrentprovider'
  and model = 'concurrentmodel';
delete from private.campaign_evidence
where id = '99999999-9999-4999-8999-999999999999';
delete from auth.users
where id = '88888888-8888-4888-8888-888888888888';

\if :created_dblink_claim
drop extension dblink;
\endif

do $$
begin
  if exists (select 1 from private.mia_approved_provider) then
    raise exception 'approved provider table was left populated';
  end if;
  if exists (
    select 1 from auth.users
    where email like '%@mia-lifecycle-test.mediaiq.invalid'
  ) then
    raise exception 'lifecycle test users remain';
  end if;
  if exists (
    select 1
    from private.mia_test_budget
    where php_reserved <> 0
      or php_spent <> 0
      or php_hold <> 0
      or usd_reserved <> 0
      or usd_spent <> 0
      or usd_hold <> 0
      or php_per_million_uncached_input is not null
      or usd_per_million_uncached_input is not null
  ) then
    raise exception 'testing budget was left reserved or priced';
  end if;
  if exists (
    select 1 from private.mia_usage
    where owner_id in (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '44444444-4444-4444-8444-444444444444',
      '88888888-8888-4888-8888-888888888888'
    )
  ) then
    raise exception 'lifecycle usage fixture remains';
  end if;
  raise notice 'lifecycle fixtures removed and approval table empty';
end;
$$;
