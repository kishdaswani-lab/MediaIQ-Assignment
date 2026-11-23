-- Validated refusal and narrow request-reader tests.
-- Run as supabase_admin:
--   docker exec -i supabase_db_MediaIQ psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/mia_refusal_retrieval.sql
-- The first section rolls back. The race section commits a fixture only
-- long enough to overlap a refusal and a claim, then deletes that fixture.

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

create function pg_temp.request_state(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select request.state from private.mia_request as request where request.id = p_id $$;

create function pg_temp.request_rendered(p_id uuid) returns text
language sql security definer set search_path = ''
as $$ select request.rendered_text from private.mia_request as request where request.id = p_id $$;

create function pg_temp.request_exists(p_id uuid) returns boolean
language sql security definer set search_path = ''
as $$ select exists (select 1 from private.mia_request where id = p_id) $$;

create function pg_temp.usage_count(p_ref uuid) returns integer
language sql security definer set search_path = ''
as $$ select count(*)::integer from private.mia_usage where accounting_ref = p_ref $$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '12121212-1212-4121-8121-121212121212',
  'authenticated', 'authenticated',
  'mia-refusal-a@mia-refusal-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
), (
  '00000000-0000-0000-0000-000000000000',
  '13131313-1313-4131-8131-131313131313',
  'authenticated', 'authenticated',
  'mia-refusal-b@mia-refusal-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

do $$
declare
  owner_a uuid := '12121212-1212-4121-8121-121212121212';
  owner_b uuid := '13131313-1313-4131-8131-131313131313';
  evidence_a uuid;
  evidence_summary uuid;
  evidence_usage uuid;
  evidence_processing uuid;
  question_id uuid;
  summary_id uuid;
  usage_question uuid;
  processing_question uuid;
  opened record;
  refused record;
  reread record;
  request_question text;
  stored_question text;
  stored_answer text;
  stored_references jsonb;
  stored_failure text;
  exchange_ctid tid;
  request_ctid tid;
  exchange_ctid_after tid;
  request_ctid_after tid;
  reader_result text;
  approval_count integer;
begin
  if (select count(*) from private.mia_approved_provider) <> 0 then
    raise exception 'approved provider table was not empty at the start of the refusal test';
  end if;
  if has_table_privilege('mediaiq_evidence_writer', 'private.mia_request', 'select, insert, update, delete')
    or has_table_privilege('mediaiq_evidence_writer', 'private.mia_usage', 'select, insert, update, delete')
  then
    raise exception 'writer has a direct ledger privilege';
  end if;
  if has_function_privilege('public', 'private.refuse_validated_mia_question(uuid, uuid, uuid, text)', 'execute')
    or has_function_privilege('public', 'private.read_mia_request(uuid, uuid, uuid)', 'execute')
    or has_function_privilege('anon', 'private.refuse_validated_mia_question(uuid, uuid, uuid, text)', 'execute')
    or has_function_privilege('authenticated', 'private.read_mia_request(uuid, uuid, uuid)', 'execute')
    or not has_function_privilege('mediaiq_evidence_writer', 'private.refuse_validated_mia_question(uuid, uuid, uuid, text)', 'execute')
    or not has_function_privilege('mediaiq_evidence_writer', 'private.read_mia_request(uuid, uuid, uuid)', 'execute')
  then
    raise exception 'refusal functions are not limited to the evidence writer';
  end if;

  reader_result := pg_catalog.pg_get_function_result('private.read_mia_request(uuid, uuid, uuid)'::regprocedure);
  if reader_result is distinct from 'TABLE(request_id uuid, request_type text, state text, rendered_text text, failure_category text, created_at timestamp with time zone, completed_at timestamp with time zone)' then
    raise exception 'request reader result is %', reader_result;
  end if;
  if reader_result ilike '%question_text%'
    or reader_result ilike '%owner_id%'
    or reader_result ilike '%payload_fingerprint%'
    or reader_result ilike '%idempotency_key%'
    or reader_result ilike '%validated_references%'
    or reader_result ilike '%source_text%'
    or reader_result ilike '%provider%'
  then
    raise exception 'request reader exposes a forbidden column: %', reader_result;
  end if;

  set local role mediaiq_evidence_writer;
  evidence_a := private.insert_campaign_evidence(
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"10.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  evidence_summary := private.insert_campaign_evidence(
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"11.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  evidence_usage := private.insert_campaign_evidence(
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"12.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  evidence_processing := private.insert_campaign_evidence(
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1","spend":"13.00"}'::jsonb,
    'monday-csv-1',
    'campaign-descriptive-1'
  );

  select * into opened
  from private.open_mia_request(
    owner_a, evidence_a, 'evidence_question', 'refusal-question', repeat('a', 64), 'Should we increase the budget?'
  );
  question_id := opened.request_id;
  if opened.result_code is distinct from 'created' or opened.state is distinct from 'validating' then
    raise exception 'question request was not created in validating';
  end if;

  begin
    perform private.refuse_validated_mia_question(owner_a, evidence_a, question_id, 'not-a-code');
    raise exception 'invalid refusal code was accepted';
  exception
    when sqlstate '22023' then
      null;
  end;
  if pg_temp.request_state(question_id) is distinct from 'validating' then
    raise exception 'invalid refusal code changed the request';
  end if;

  select * into refused
  from private.refuse_validated_mia_question(owner_b, evidence_a, question_id, 'recommendation');
  if refused.result_code is distinct from 'not_found' or pg_temp.request_state(question_id) is distinct from 'validating' then
    raise exception 'foreign owner refusal was not denied';
  end if;

  select * into opened
  from private.open_mia_request(
    owner_a, evidence_summary, 'performance_summary', 'refusal-summary', repeat('b', 64), null
  );
  summary_id := opened.request_id;
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_summary, summary_id, 'recommendation');
  if refused.result_code is distinct from 'not_found'
    or pg_temp.request_state(summary_id) is distinct from 'validating'
  then
    raise exception 'summary request was refused';
  end if;

  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_a, question_id, 'recommendation');
  if refused.result_code is distinct from 'refused'
    or refused.state is distinct from 'refused'
    or refused.rendered_text is distinct from 'MIA cannot recommend a campaign or budget change from this evidence.'
    or pg_temp.usage_count(question_id) is distinct from 0
  then
    raise exception 'canonical recommendation refusal was not stored without usage';
  end if;

  reset role;
  select request.question_text, request.validated_references, request.failure_category
    into request_question, stored_references, stored_failure
  from private.mia_request as request
  where request.id = question_id;
  select evidence.latest_question, evidence.latest_answer, evidence.ctid
    into stored_question, stored_answer, exchange_ctid
  from private.campaign_evidence as evidence
  where evidence.id = evidence_a;
  select request.ctid
    into request_ctid
  from private.mia_request as request
  where request.id = question_id;
  if request_question is distinct from stored_question
    or stored_question is distinct from 'Should we increase the budget?'
    or stored_answer is distinct from 'MIA cannot recommend a campaign or budget change from this evidence.'
    or stored_references is distinct from '[{"kind":"server_refusal","code":"recommendation"}]'::jsonb
    or stored_failure is not null
  then
    raise exception 'exchange was not taken from the stored question and canonical sentence';
  end if;

  set local role mediaiq_evidence_writer;
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_a, question_id, 'recommendation');
  select * into reread
  from private.refuse_validated_mia_question(owner_a, evidence_a, question_id, 'prediction');
  reset role;
  select evidence.ctid, request.ctid
    into exchange_ctid_after, request_ctid_after
  from private.campaign_evidence as evidence
  join private.mia_request as request on request.evidence_id = evidence.id
  where evidence.id = evidence_a
    and request.id = question_id;
  if refused.result_code is distinct from 'unchanged'
    or reread.result_code is distinct from 'unchanged'
    or reread.rendered_text is distinct from 'MIA cannot recommend a campaign or budget change from this evidence.'
    or exchange_ctid_after is distinct from exchange_ctid
    or request_ctid_after is distinct from request_ctid
  then
    raise exception 'repeated refusal overwrote the stored answer or exchange';
  end if;

  set local role mediaiq_evidence_writer;
  if exists (
    select 1 from private.read_mia_request(owner_b, evidence_a, question_id)
  ) or exists (
    select 1 from private.read_mia_request(owner_a, evidence_summary, question_id)
  ) then
    raise exception 'request reader returned a foreign or mismatched row';
  end if;
  select * into reread
  from private.read_mia_request(owner_a, evidence_a, question_id);
  if reread.request_id is distinct from question_id
    or reread.request_type is distinct from 'evidence_question'
    or reread.state is distinct from 'refused'
    or reread.rendered_text is distinct from 'MIA cannot recommend a campaign or budget change from this evidence.'
    or reread.failure_category is not null
    or reread.created_at is null
    or reread.completed_at is null
  then
    raise exception 'request reader did not return the refused question';
  end if;

  select * into opened
  from private.open_mia_request(
    owner_a, evidence_a, 'evidence_question', 'benchmark-question', repeat('c', 64), 'What is the industry average?'
  );
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_a, opened.request_id, 'external_benchmark');
  if refused.rendered_text is distinct from 'MIA cannot use an external benchmark. Only this saved evidence is available.' then
    raise exception 'external benchmark sentence drifted';
  end if;
  select * into opened
  from private.open_mia_request(
    owner_a, evidence_a, 'evidence_question', 'prediction-question', repeat('d', 64), 'Will this campaign perform next quarter?'
  );
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_a, opened.request_id, 'prediction');
  if refused.rendered_text is distinct from 'MIA cannot predict future performance from this evidence.' then
    raise exception 'prediction sentence drifted';
  end if;
  select * into opened
  from private.open_mia_request(
    owner_a, evidence_a, 'evidence_question', 'causal-question', repeat('e', 64), 'Why did spend change?'
  );
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_a, opened.request_id, 'causal_claim');
  if refused.rendered_text is distinct from 'MIA cannot explain a cause from this evidence.' then
    raise exception 'causal sentence drifted';
  end if;

  perform private.delete_campaign_evidence(owner_a, evidence_a);
  if pg_temp.request_exists(question_id) then
    raise exception 'evidence deletion left the refused request';
  end if;

  select * into opened
  from private.open_mia_request(
    owner_a, evidence_usage, 'evidence_question', 'usage-question', repeat('f', 64), 'Should we reallocate spend?'
  );
  usage_question := opened.request_id;
  reset role;
  insert into private.mia_usage (
    accounting_ref, owner_id, attempt_number, provider, model, outcome, billing_status
  ) values (
    usage_question, owner_a, 1, 'existingprovider', 'existingmodel', 'processing', 'unknown'
  );
  set local role mediaiq_evidence_writer;
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_usage, usage_question, 'recommendation');
  if refused.result_code is distinct from 'not_refusable'
    or pg_temp.request_state(usage_question) is distinct from 'validating'
    or pg_temp.usage_count(usage_question) is distinct from 1
  then
    raise exception 'existing usage row did not prevent refusal';
  end if;

  select * into opened
  from private.open_mia_request(
    owner_a, evidence_processing, 'evidence_question', 'processing-question', repeat('9', 64), 'Should we optimize spend?'
  );
  processing_question := opened.request_id;
  reset role;
  insert into private.mia_approved_provider (provider, model)
  values ('refusalprovider', 'refusalmodel');
  delete from private.mia_usage where accounting_ref = usage_question;
  perform pg_temp.fund_mia_budget();
  set local role mediaiq_evidence_writer;
  perform private.claim_mia_dispatch(owner_a, processing_question);
  select * into refused
  from private.refuse_validated_mia_question(owner_a, evidence_processing, processing_question, 'recommendation');
  if refused.result_code is distinct from 'not_refusable'
    or pg_temp.request_state(processing_question) is distinct from 'processing'
  then
    raise exception 'processing request was refused';
  end if;
  reset role;
  delete from private.mia_usage where accounting_ref in (usage_question, processing_question);
  delete from private.mia_approved_provider
  where provider = 'refusalprovider' and model = 'refusalmodel';
  select count(*) into approval_count from private.mia_approved_provider;
  if approval_count <> 0 then
    raise exception 'refusal test left an approved provider row';
  end if;
  raise notice 'validated refusal and request reader checks passed';
end;
$$;

rollback;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '14141414-1414-4141-8141-141414141414',
  'authenticated', 'authenticated',
  'mia-refusal-race@mia-refusal-test.mediaiq.invalid',
  '', pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  pg_catalog.now(), pg_catalog.now(), '', '', '', ''
);

insert into private.campaign_evidence (
  id, owner_id, source_text, summary, parser_version, calculation_version
) values (
  '15151515-1515-4151-8151-151515151515',
  '14141414-1414-4141-8141-141414141414',
  'date,campaign,channel,spend,impressions,clicks',
  '{"parserVersion":"monday-csv-1","calculationVersion":"campaign-descriptive-1"}'::jsonb,
  'monday-csv-1',
  'campaign-descriptive-1'
);

insert into private.mia_request (
  id, owner_id, evidence_id, request_type, state, idempotency_key, payload_fingerprint, question_text
) values (
  '16161616-1616-4161-8161-161616161616',
  '14141414-1414-4141-8141-141414141414',
  '15151515-1515-4151-8151-151515151515',
  'evidence_question',
  'validating',
  'refusal-race',
  repeat('a', 64),
  'Should we increase the budget?'
);

select pg_temp.fund_mia_budget();

insert into private.mia_approved_provider (provider, model)
values ('racerefusalprovider', 'racerefusalmodel');

select (not exists (select 1 from pg_catalog.pg_extension where extname = 'dblink')) as created_dblink_refusal \gset

\if :created_dblink_refusal
create extension dblink;
\endif

do $$
declare
  connection text := 'host=/var/run/postgresql dbname=' || current_database() || ' user=' || current_user;
  refuse_sql text := format(
    'select request_id, state, result_code, rendered_text from private.refuse_validated_mia_question(%L, %L, %L, %L)',
    '14141414-1414-4141-8141-141414141414',
    '15151515-1515-4151-8151-151515151515',
    '16161616-1616-4161-8161-161616161616',
    'recommendation'
  );
  claim_sql text := format(
    'select authorized, accounting_ref, attempt_number, state, provider, model from private.claim_mia_dispatch(%L, %L)',
    '14141414-1414-4141-8141-141414141414',
    '16161616-1616-4161-8161-161616161616'
  );
  winner_state text;
  winner_code text;
  winner_text text;
  loser_authorized boolean;
  overlapped boolean := false;
  polls integer;
  usage_rows integer;
begin
  perform dblink_connect('refuse_a', connection);
  perform dblink_connect('refuse_b', connection);
  perform dblink_exec('refuse_a', 'begin');
  perform dblink_exec('refuse_b', 'set lock_timeout = ''5s''');

  if dblink_send_query('refuse_a', refuse_sql) <> 1 then
    raise exception 'could not send the refusal';
  end if;
  select remote_refusal.state, remote_refusal.result_code, remote_refusal.rendered_text
    into winner_state, winner_code, winner_text
  from dblink_get_result('refuse_a') as remote_refusal(
    request_id uuid,
    state text,
    result_code text,
    rendered_text text
  );
  if not found then
    raise exception 'refusal returned no result';
  end if;
  perform 1
  from dblink_get_result('refuse_a') as extra(
    request_id uuid,
    state text,
    result_code text,
    rendered_text text
  );
  if winner_state is distinct from 'refused'
    or winner_code is distinct from 'refused'
    or winner_text is distinct from 'MIA cannot recommend a campaign or budget change from this evidence.'
  then
    raise exception 'refusal did not win the open transaction';
  end if;

  if dblink_send_query('refuse_b', claim_sql) <> 1 then
    raise exception 'could not send the overlapping claim';
  end if;
  for polls in 1..40 loop
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
    raise exception 'claim did not wait on the refusal lock';
  end if;

  perform dblink_exec('refuse_a', 'commit');
  select remote_claim.authorized
    into loser_authorized
  from dblink_get_result('refuse_b') as remote_claim(
    authorized boolean,
    accounting_ref uuid,
    attempt_number integer,
    state text,
    provider text,
    model text
  );
  if not found then
    raise exception 'overlapping claim returned no result';
  end if;
  perform 1
  from dblink_get_result('refuse_b') as extra(
    authorized boolean,
    accounting_ref uuid,
    attempt_number integer,
    state text,
    provider text,
    model text
  );
  select count(*)
    into usage_rows
  from private.mia_usage
  where accounting_ref = '16161616-1616-4161-8161-161616161616';
  if loser_authorized is distinct from false or usage_rows is distinct from 0 then
    raise exception 'claim and refusal both changed the request';
  end if;

  perform dblink_disconnect('refuse_a');
  perform dblink_disconnect('refuse_b');
  raise notice 'claim and refusal overlapped: the refusal succeeded and no usage row was created';
exception
  when others then
    begin
      perform dblink_exec('refuse_a', 'rollback');
    exception
      when others then null;
    end;
    begin
      perform dblink_disconnect('refuse_a');
    exception
      when others then null;
    end;
    begin
      perform dblink_disconnect('refuse_b');
    exception
      when others then null;
    end;
    begin
      perform dblink_connect('refuse_cleanup', connection);
      perform dblink_exec('refuse_cleanup', 'delete from private.mia_usage where accounting_ref = ''16161616-1616-4161-8161-161616161616''');
      perform dblink_exec('refuse_cleanup', 'delete from private.mia_approved_provider where provider = ''racerefusalprovider'' and model = ''racerefusalmodel''');
      perform dblink_exec('refuse_cleanup', 'update private.mia_test_budget set php_reserved = 0, php_spent = 0, php_hold = 0, usd_reserved = 0, usd_spent = 0, usd_hold = 0, php_per_million_uncached_input = null, php_per_million_cached_input = null, php_per_million_output = null, usd_per_million_uncached_input = null, usd_per_million_cached_input = null, usd_per_million_output = null where singleton');
      perform dblink_exec('refuse_cleanup', 'delete from private.campaign_evidence where id = ''15151515-1515-4151-8151-151515151515''');
      perform dblink_exec('refuse_cleanup', 'delete from auth.users where id = ''14141414-1414-4141-8141-141414141414''');
      perform dblink_disconnect('refuse_cleanup');
    exception
      when others then null;
    end;
    raise;
end;
$$;

do $$
declare
  first_exchange timestamptz;
  second_exchange timestamptz;
  repeated record;
begin
  select evidence.latest_exchange_at
    into first_exchange
  from private.campaign_evidence as evidence
  where evidence.id = '15151515-1515-4151-8151-151515151515';
  perform pg_catalog.pg_sleep(0.05);
  select *
    into repeated
  from private.refuse_validated_mia_question(
    '14141414-1414-4141-8141-141414141414',
    '15151515-1515-4151-8151-151515151515',
    '16161616-1616-4161-8161-161616161616',
    'causal_claim'
  );
  select evidence.latest_exchange_at
    into second_exchange
  from private.campaign_evidence as evidence
  where evidence.id = '15151515-1515-4151-8151-151515151515';
  if repeated.result_code is distinct from 'unchanged'
    or repeated.rendered_text is distinct from 'MIA cannot recommend a campaign or budget change from this evidence.'
    or second_exchange is distinct from first_exchange
  then
    raise exception 'a later refusal code changed the exchange';
  end if;
end;
$$;

select pg_temp.clear_mia_budget();

delete from private.mia_usage
where accounting_ref = '16161616-1616-4161-8161-161616161616';
delete from private.mia_approved_provider
where provider = 'racerefusalprovider'
  and model = 'racerefusalmodel';
delete from private.campaign_evidence
where id = '15151515-1515-4151-8151-151515151515';
delete from auth.users
where id = '14141414-1414-4141-8141-141414141414';

\if :created_dblink_refusal
drop extension dblink;
\endif

do $$
begin
  if exists (select 1 from private.mia_approved_provider) then
    raise exception 'approved provider table was left populated';
  end if;
  if exists (
    select 1 from auth.users
    where email like '%@mia-refusal-test.mediaiq.invalid'
  ) then
    raise exception 'refusal test users remain';
  end if;
  if exists (
    select 1 from private.mia_usage
    where accounting_ref = '16161616-1616-4161-8161-161616161616'
  ) or exists (
    select 1 from private.mia_request
    where id = '16161616-1616-4161-8161-161616161616'
  ) then
    raise exception 'refusal race fixture remains';
  end if;
  raise notice 'refusal fixtures removed and approval table empty';
end;
$$;
