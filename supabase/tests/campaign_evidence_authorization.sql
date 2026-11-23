-- Authorization tests for private.campaign_evidence.
-- This file is not a migration and must not be placed in supabase/migrations.
--
-- Run it manually, after 20261121231500_campaign_evidence_private.sql and
-- 20261122003000_campaign_evidence_list.sql, against
-- a local Supabase database, as a role that can insert into auth.users and
-- SET ROLE to authenticated, anon, service_role, and the evidence roles:
--
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/campaign_evidence_authorization.sql
--
-- The script begins a transaction and rolls it back. A successful run prints
-- one completion notice and leaves no rows behind. These tests were not
-- executed in the environment that authored this file.
--
-- This script does not set the evidence writer password and does not read
-- MEDIAIQ_EVIDENCE_DATABASE_URL. It does not make an HTTP PostgREST call.
-- Direct Data API denial depends on the revoked table privileges and on
-- private remaining outside the exposed API schemas. The privilege checks
-- below are the database half of that denial.

begin;

do $$
begin
  if to_regclass('auth.users') is null
    or to_regclass('private.campaign_evidence') is null
    or to_regclass('public.audit_events') is null then
    raise exception 'campaign evidence dependencies are not installed';
  end if;

  if to_regprocedure('private.insert_campaign_evidence(uuid,text,jsonb,text,text)') is null
    or to_regprocedure('private.read_campaign_evidence(uuid,uuid)') is null
    or to_regprocedure('private.delete_campaign_evidence(uuid,uuid)') is null then
    raise exception 'campaign evidence functions are not installed';
  end if;
end $$;

do $$
declare
  policy_count integer;
  select_policy integer;
  insert_policy integer;
  delete_policy integer;
  other_policy integer;
  executable_functions text;
  public_functions text;
  list_columns text;
begin
  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname in ('mediaiq_evidence_owner', 'mediaiq_evidence_writer')
      and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit)
  ) then
    raise exception 'an evidence role is elevated';
  end if;

  if (select rolcanlogin from pg_catalog.pg_roles where rolname = 'mediaiq_evidence_owner')
    or not (select rolcanlogin from pg_catalog.pg_roles where rolname = 'mediaiq_evidence_writer') then
    raise exception 'evidence role login flags are wrong';
  end if;

  if pg_catalog.pg_has_role('mediaiq_evidence_writer', 'mediaiq_evidence_owner', 'member')
    or pg_catalog.pg_has_role('mediaiq_evidence_owner', 'mediaiq_evidence_writer', 'member')
    or pg_catalog.pg_has_role('mediaiq_evidence_writer', 'mediaiq_security_owner', 'member')
    or pg_catalog.pg_has_role('mediaiq_evidence_writer', 'mediaiq_security_writer', 'member')
    or pg_catalog.pg_has_role('mediaiq_security_writer', 'mediaiq_evidence_owner', 'member')
    or pg_catalog.pg_has_role('mediaiq_security_writer', 'mediaiq_evidence_writer', 'member') then
    raise exception 'evidence and audit roles are members of each other';
  end if;

  if not pg_catalog.has_table_privilege('mediaiq_evidence_owner', 'private.campaign_evidence', 'select')
    or not pg_catalog.has_table_privilege('mediaiq_evidence_owner', 'private.campaign_evidence', 'insert')
    or not pg_catalog.has_table_privilege('mediaiq_evidence_owner', 'private.campaign_evidence', 'delete') then
    raise exception 'evidence owner lost the privileges its policies require';
  end if;

  if pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.campaign_evidence', 'select')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.campaign_evidence', 'insert')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.campaign_evidence', 'update')
    or pg_catalog.has_table_privilege('mediaiq_evidence_writer', 'private.campaign_evidence', 'delete')
    or pg_catalog.has_table_privilege('authenticated', 'private.campaign_evidence', 'select')
    or pg_catalog.has_table_privilege('authenticated', 'private.campaign_evidence', 'insert')
    or pg_catalog.has_table_privilege('authenticated', 'private.campaign_evidence', 'update')
    or pg_catalog.has_table_privilege('authenticated', 'private.campaign_evidence', 'delete')
    or pg_catalog.has_table_privilege('anon', 'private.campaign_evidence', 'select')
    or pg_catalog.has_table_privilege('anon', 'private.campaign_evidence', 'insert')
    or pg_catalog.has_table_privilege('anon', 'private.campaign_evidence', 'update')
    or pg_catalog.has_table_privilege('anon', 'private.campaign_evidence', 'delete')
    or pg_catalog.has_table_privilege('service_role', 'private.campaign_evidence', 'select')
    or pg_catalog.has_table_privilege('service_role', 'private.campaign_evidence', 'insert')
    or pg_catalog.has_table_privilege('service_role', 'private.campaign_evidence', 'update')
    or pg_catalog.has_table_privilege('service_role', 'private.campaign_evidence', 'delete')
    or pg_catalog.has_table_privilege('public', 'private.campaign_evidence', 'select') then
    raise exception 'a forbidden role can access campaign evidence directly';
  end if;

  if pg_catalog.has_function_privilege('public', 'private.insert_campaign_evidence(uuid,text,jsonb,text,text)', 'execute')
    or pg_catalog.has_function_privilege('public', 'private.read_campaign_evidence(uuid,uuid)', 'execute')
    or pg_catalog.has_function_privilege('public', 'private.delete_campaign_evidence(uuid,uuid)', 'execute')
    or pg_catalog.has_function_privilege('authenticated', 'private.insert_campaign_evidence(uuid,text,jsonb,text,text)', 'execute')
    or pg_catalog.has_function_privilege('anon', 'private.read_campaign_evidence(uuid,uuid)', 'execute')
    or pg_catalog.has_function_privilege('service_role', 'private.delete_campaign_evidence(uuid,uuid)', 'execute')
    or pg_catalog.has_function_privilege('mediaiq_security_writer', 'private.insert_campaign_evidence(uuid,text,jsonb,text,text)', 'execute') then
    raise exception 'a forbidden role can execute an evidence function';
  end if;

  if not pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.insert_campaign_evidence(uuid,text,jsonb,text,text)', 'execute')
    or not pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.read_campaign_evidence(uuid,uuid)', 'execute')
    or not pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.delete_campaign_evidence(uuid,uuid)', 'execute')
    or not pg_catalog.has_function_privilege('mediaiq_evidence_writer', 'private.list_campaign_evidence(uuid,integer,timestamptz,uuid)', 'execute') then
    raise exception 'evidence writer cannot execute the approved functions';
  end if;

  select coalesce(pg_catalog.string_agg(
      pg_catalog.format(
        '%s(%s)',
        proc.proname,
        pg_catalog.pg_get_function_identity_arguments(proc.oid)
      ),
      ', ' order by proc.proname, pg_catalog.pg_get_function_identity_arguments(proc.oid)
    ), '')
    into public_functions
  from pg_catalog.pg_proc as proc
  join pg_catalog.pg_namespace as namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'private'
    and pg_catalog.has_function_privilege('public', proc.oid, 'execute');

  if public_functions <> '' then
    raise exception 'private functions remain executable by public: %', public_functions;
  end if;

  if exists (
    select writer_executable.oid
    from (
      select proc.oid
      from pg_catalog.pg_proc as proc
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = proc.pronamespace
      where namespace.nspname = 'private'
        and pg_catalog.has_function_privilege('mediaiq_evidence_writer', proc.oid, 'execute')
    ) as writer_executable
    full outer join (
      values
        (pg_catalog.to_regprocedure('private.insert_campaign_evidence(uuid,text,jsonb,text,text)')),
        (pg_catalog.to_regprocedure('private.read_campaign_evidence(uuid,uuid)')),
        (pg_catalog.to_regprocedure('private.delete_campaign_evidence(uuid,uuid)')),
        (pg_catalog.to_regprocedure('private.list_campaign_evidence(uuid,integer,timestamptz,uuid)')),
        (pg_catalog.to_regprocedure('private.open_mia_request(uuid,uuid,text,text,text,text)')),
        (pg_catalog.to_regprocedure('private.claim_mia_dispatch(uuid,uuid)')),
        (pg_catalog.to_regprocedure('private.record_mia_attempt_outcome(uuid,uuid,integer,text,text,integer,integer,integer,numeric,numeric,integer,text,jsonb,text,text,text,integer,text,boolean,integer,text,boolean)')),
        (pg_catalog.to_regprocedure('private.read_mia_evidence_context(uuid,uuid)')),
        (pg_catalog.to_regprocedure('private.refuse_validated_mia_question(uuid,uuid,uuid,text)')),
        (pg_catalog.to_regprocedure('private.refuse_mia_selection(uuid,uuid,uuid,text)')),
        (pg_catalog.to_regprocedure('private.read_mia_request(uuid,uuid,uuid)')),
        (pg_catalog.to_regprocedure('private.fail_mia_request_before_dispatch(uuid,uuid,uuid)')),
        (pg_catalog.to_regprocedure('private.reconcile_unknown_reservation(uuid,uuid,numeric,numeric,text)')),
        (pg_catalog.to_regprocedure('private.list_eligible_mia_reservations(uuid)'))
    ) as expected (oid) on expected.oid = writer_executable.oid
    where writer_executable.oid is null
      or expected.oid is null
  ) then
    raise exception 'evidence writer private execute set is not the approved evidence and MIA functions';
  end if;

  select pg_catalog.pg_get_userbyid(relation.relowner)
    into executable_functions
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'private'
    and relation.relname = 'campaign_evidence';

  if executable_functions is distinct from 'mediaiq_evidence_owner' then
    raise exception 'campaign evidence table owner is %', executable_functions;
  end if;

  if pg_catalog.to_regprocedure('private.insert_campaign_evidence(uuid,text,jsonb,text,text)') is null
    or not exists (
      select 1
      from pg_catalog.pg_proc as proc
      where proc.oid = pg_catalog.to_regprocedure('private.insert_campaign_evidence(uuid,text,jsonb,text,text)')
        and pg_catalog.pg_get_userbyid(proc.proowner) = 'mediaiq_evidence_owner'
        and proc.prosecdef
        and proc.proconfig @> array['search_path=""']::text[]
    ) then
    raise exception 'insert_campaign_evidence is missing owner, security definer, or an empty search_path';
  end if;

  if pg_catalog.to_regprocedure('private.read_campaign_evidence(uuid,uuid)') is null
    or not exists (
      select 1
      from pg_catalog.pg_proc as proc
      where proc.oid = pg_catalog.to_regprocedure('private.read_campaign_evidence(uuid,uuid)')
        and pg_catalog.pg_get_userbyid(proc.proowner) = 'mediaiq_evidence_owner'
        and proc.prosecdef
        and proc.proconfig @> array['search_path=""']::text[]
    ) then
    raise exception 'read_campaign_evidence is missing owner, security definer, or an empty search_path';
  end if;

  if pg_catalog.to_regprocedure('private.delete_campaign_evidence(uuid,uuid)') is null
    or not exists (
      select 1
      from pg_catalog.pg_proc as proc
      where proc.oid = pg_catalog.to_regprocedure('private.delete_campaign_evidence(uuid,uuid)')
        and pg_catalog.pg_get_userbyid(proc.proowner) = 'mediaiq_evidence_owner'
        and proc.prosecdef
        and proc.proconfig @> array['search_path=""']::text[]
    ) then
    raise exception 'delete_campaign_evidence is missing owner, security definer, or an empty search_path';
  end if;

  if pg_catalog.to_regprocedure('private.list_campaign_evidence(uuid,integer,timestamptz,uuid)') is null
    or not exists (
      select 1
      from pg_catalog.pg_proc as proc
      where proc.oid = pg_catalog.to_regprocedure('private.list_campaign_evidence(uuid,integer,timestamptz,uuid)')
        and pg_catalog.pg_get_userbyid(proc.proowner) = 'mediaiq_evidence_owner'
        and proc.prosecdef
        and proc.proconfig @> array['search_path=""']::text[]
    ) then
    raise exception 'list_campaign_evidence is missing owner, security definer, or an empty search_path';
  end if;

  select pg_catalog.string_agg(
      pg_catalog.format('%s %s', names.name, pg_catalog.format_type(types.typ, null)),
      ', ' order by names.ordinality
    )
    into list_columns
  from pg_catalog.pg_proc as proc
  cross join lateral pg_catalog.unnest(proc.proargmodes) with ordinality as modes(mode, ordinality)
  cross join lateral pg_catalog.unnest(proc.proargnames) with ordinality as names(name, ordinality)
  cross join lateral pg_catalog.unnest(proc.proallargtypes) with ordinality as types(typ, ordinality)
  where proc.oid = pg_catalog.to_regprocedure('private.list_campaign_evidence(uuid,integer,timestamptz,uuid)')
    and modes.ordinality = names.ordinality
    and names.ordinality = types.ordinality
    and modes.mode = 't';

  if list_columns is distinct from
    'id uuid, created_at timestamp with time zone, parser_version text, calculation_version text, period_start text, period_end text, campaign_count integer, channel_count integer, currency_codes text[]'
    or list_columns like '%source_text%'
    or list_columns like '%summary%'
    or list_columns like '%latest_question%'
    or list_columns like '%latest_answer%'
    or list_columns like '%latest_exchange_at%' then
    raise exception 'list result columns are %', list_columns;
  end if;

  if pg_catalog.has_schema_privilege('mediaiq_evidence_owner', 'private', 'create')
    or pg_catalog.has_schema_privilege('mediaiq_evidence_writer', 'private', 'create')
    or not pg_catalog.has_schema_privilege('mediaiq_evidence_owner', 'private', 'usage')
    or not pg_catalog.has_schema_privilege('mediaiq_evidence_writer', 'private', 'usage') then
    raise exception 'evidence schema privileges are not usage without create';
  end if;

  select count(*)
    into policy_count
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'private'
    and relation.relname = 'campaign_evidence';

  if policy_count <> 4 then
    raise exception 'campaign evidence does not have exactly four policies';
  end if;

  select count(*)
    into select_policy
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_roles as role on role.oid = any (policy.polroles)
  where namespace.nspname = 'private'
    and relation.relname = 'campaign_evidence'
    and policy.polname = 'campaign_evidence_owner_select'
    and policy.polcmd = 'r'
    and role.rolname = 'mediaiq_evidence_owner';

  select count(*)
    into insert_policy
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_roles as role on role.oid = any (policy.polroles)
  where namespace.nspname = 'private'
    and relation.relname = 'campaign_evidence'
    and policy.polname = 'campaign_evidence_owner_insert'
    and policy.polcmd = 'a'
    and role.rolname = 'mediaiq_evidence_owner';

  select count(*)
    into delete_policy
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_roles as role on role.oid = any (policy.polroles)
  where namespace.nspname = 'private'
    and relation.relname = 'campaign_evidence'
    and policy.polname = 'campaign_evidence_owner_delete'
    and policy.polcmd = 'd'
    and role.rolname = 'mediaiq_evidence_owner';

  select count(*)
    into other_policy
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'private'
    and relation.relname = 'campaign_evidence'
    and (
      policy.polcmd = '*'
      or (
        policy.polcmd = 'w'
        and policy.polname is distinct from 'campaign_evidence_owner_exchange_update'
      )
      or policy.polname not in (
        'campaign_evidence_owner_select',
        'campaign_evidence_owner_insert',
        'campaign_evidence_owner_delete',
        'campaign_evidence_owner_exchange_update'
      )
      or cardinality(policy.polroles) <> 1
    );

  if select_policy <> 1 or insert_policy <> 1 or delete_policy <> 1 or other_policy <> 0 then
    raise exception 'evidence policies are not limited to owner select, insert, delete, and the exchange update';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_policy as policy
    join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_roles as role on role.oid = any (policy.polroles)
    where namespace.nspname = 'private'
      and relation.relname = 'campaign_evidence'
      and policy.polname = 'campaign_evidence_owner_exchange_update'
      and policy.polcmd = 'w'
      and role.rolname = 'mediaiq_evidence_owner'
  ) <> 1 then
    raise exception 'evidence exchange update policy is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'campaign_evidence'
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    raise exception 'campaign evidence does not force row level security';
  end if;
end $$;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'authenticated',
    'authenticated',
    'evidence-owner-a@campaign-evidence-test.mediaiq.invalid',
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    pg_catalog.now(),
    pg_catalog.now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    'authenticated',
    'authenticated',
    'evidence-owner-b@campaign-evidence-test.mediaiq.invalid',
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    pg_catalog.now(),
    pg_catalog.now(),
    '',
    '',
    '',
    ''
  );

do $$
declare
  owner_a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  owner_b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  evidence_id uuid;
  second_id uuid;
  owner_b_evidence_id uuid;
  audit_before bigint;
  audit_after bigint;
  visible_count integer;
  updated_count integer;
  deleted_count integer;
  stored_text text;
  stored_summary jsonb;
  stored_question text;
  stored_answer text;
  stored_exchange_at timestamptz;
  deleted_id uuid;
  list_ids uuid[];
  list_again uuid[];
  page_id uuid;
  page_created timestamptz;
  next_page_id uuid;
  next_page_created timestamptz;
  listed_campaigns integer;
  listed_channels integer;
  listed_currencies text[];
  listed_period text;
  listed_period_end text;
  rich_id uuid;
  expected_summary jsonb := jsonb_build_object(
    'parserVersion', 'monday-csv-1',
    'calculationVersion', 'campaign-descriptive-1',
    'impressions', '1',
    'clicks', '1'
  );
begin
  select count(*) into audit_before from public.audit_events;

  begin
    execute 'set local role authenticated';
    perform 1 from private.campaign_evidence;
    raise exception 'authenticated selected campaign evidence';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;

  begin
    execute 'set local role anon';
    insert into private.campaign_evidence (
      owner_id, source_text, summary, parser_version, calculation_version
    ) values (
      owner_a, 'date,campaign', expected_summary, 'monday-csv-1', 'campaign-descriptive-1'
    );
    raise exception 'anon inserted campaign evidence';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;

  begin
    execute 'set local role service_role';
    delete from private.campaign_evidence;
    raise exception 'service_role deleted campaign evidence';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;

  begin
    execute 'set local role mediaiq_evidence_writer';
    update private.campaign_evidence set source_text = 'tamper';
    raise exception 'evidence writer updated campaign evidence';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;

  execute 'set local role mediaiq_evidence_writer';
  evidence_id := private.insert_campaign_evidence(
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    expected_summary,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  execute 'reset role';

  select
    evidence.latest_question,
    evidence.latest_answer,
    evidence.latest_exchange_at
  into stored_question, stored_answer, stored_exchange_at
  from private.campaign_evidence as evidence
  where evidence.id = evidence_id;

  if stored_question is not null
    or stored_answer is not null
    or stored_exchange_at is not null then
    raise exception 'insert stored a latest exchange';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', '', true);
  execute 'set local role mediaiq_evidence_owner';
  select count(*) into visible_count from private.campaign_evidence;
  execute 'reset role';

  if visible_count <> 0 then
    raise exception 'missing owner GUC exposed evidence rows under forced RLS';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', owner_b::text, true);
  execute 'set local role mediaiq_evidence_owner';
  select count(*) into visible_count from private.campaign_evidence;
  execute 'reset role';

  if visible_count <> 0 then
    raise exception 'select policy returned another owner row';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', owner_a::text, true);
  execute 'set local role mediaiq_evidence_owner';
  select count(*) into visible_count from private.campaign_evidence;
  execute 'reset role';

  if visible_count <> 1 then
    raise exception 'select policy hid the matching owner row';
  end if;

  begin
    perform pg_catalog.set_config('mediaiq.evidence_owner_id', owner_a::text, true);
    execute 'set local role mediaiq_evidence_owner';
    insert into private.campaign_evidence (
      owner_id, source_text, summary, parser_version, calculation_version
    ) values (
      owner_b,
      'date,campaign,channel,spend,impressions,clicks',
      expected_summary,
      'monday-csv-1',
      'campaign-descriptive-1'
    );
    raise exception 'insert policy accepted a mismatched owner';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;

  execute 'set local role mediaiq_evidence_writer';
  owner_b_evidence_id := private.insert_campaign_evidence(
    owner_b,
    'owner-b-source',
    expected_summary,
    'monday-csv-1',
    'campaign-descriptive-1'
  );
  execute 'reset role';

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', owner_a::text, true);
  execute 'set local role mediaiq_evidence_owner';
  delete from private.campaign_evidence as evidence
  where evidence.id = owner_b_evidence_id;
  get diagnostics deleted_count = row_count;
  execute 'reset role';

  if deleted_count <> 0 then
    raise exception 'owner A deleted owner B evidence through the delete policy';
  end if;

  select evidence.source_text
    into stored_text
  from private.campaign_evidence as evidence
  where evidence.id = owner_b_evidence_id
    and evidence.owner_id = owner_b;

  if stored_text is distinct from 'owner-b-source' then
    raise exception 'owner A direct delete changed owner B evidence';
  end if;

  execute 'set local role mediaiq_evidence_writer';
  if not exists (
    select 1
    from private.read_campaign_evidence(owner_b, owner_b_evidence_id) as evidence
    where evidence.source_text = 'owner-b-source'
      and evidence.summary = expected_summary
  ) then
    raise exception 'owner B could not read the preserved evidence row';
  end if;

  deleted_id := private.delete_campaign_evidence(owner_b, owner_b_evidence_id);
  execute 'reset role';

  if deleted_id is distinct from owner_b_evidence_id
    or exists (
      select 1
      from private.read_campaign_evidence(owner_b, owner_b_evidence_id)
    ) then
    raise exception 'owner B could not delete the preserved evidence row';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', owner_a::text, true);
  execute 'set local role mediaiq_evidence_owner';
  insert into private.campaign_evidence (
    owner_id, source_text, summary, parser_version, calculation_version
  ) values (
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    expected_summary,
    'monday-csv-1',
    'campaign-descriptive-1'
  )
  returning id into second_id;

  delete from private.campaign_evidence as evidence
  where evidence.id = second_id
    and evidence.owner_id = owner_a;

  if not found then
    raise exception 'delete policy refused the matching owner row';
  end if;

  begin
    update private.campaign_evidence as evidence
    set source_text = 'tampered'
    where evidence.id = evidence_id;
    raise exception 'evidence source update was accepted';
  exception
    when object_not_in_prerequisite_state then
      null;
  end;
  execute 'reset role';

  select evidence.source_text, evidence.summary
    into stored_text, stored_summary
  from private.campaign_evidence as evidence
  where evidence.id = evidence_id;

  if stored_text is distinct from 'date,campaign,channel,spend,impressions,clicks'
    or stored_summary is distinct from expected_summary then
    raise exception 'evidence update changed the stored source text or summary';
  end if;

  execute 'set local role mediaiq_evidence_writer';
  if exists (
    select 1
    from private.read_campaign_evidence(owner_b, evidence_id)
  ) then
    raise exception 'cross-owner read returned a row';
  end if;

  deleted_id := private.delete_campaign_evidence(owner_b, evidence_id);
  execute 'reset role';

  if deleted_id is not null then
    raise exception 'cross-owner delete returned an id';
  end if;

  if not exists (
    select 1
    from private.campaign_evidence as evidence
    where evidence.id = evidence_id
      and evidence.owner_id = owner_a
  ) then
    raise exception 'cross-owner delete removed the row';
  end if;

  begin
    perform private.delete_campaign_evidence(owner_a, evidence_id);
    raise exception 'force rollback of delete';
  exception
    when raise_exception then
      if sqlerrm is distinct from 'force rollback of delete' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from private.read_campaign_evidence(owner_a, evidence_id) as evidence
    where evidence.source_text = 'date,campaign,channel,spend,impressions,clicks'
      and evidence.latest_question is null
      and evidence.latest_answer is null
      and evidence.latest_exchange_at is null
  ) then
    raise exception 'rolled back delete did not preserve the evidence row';
  end if;

  deleted_id := private.delete_campaign_evidence(owner_a, evidence_id);

  if deleted_id is distinct from evidence_id
    or exists (
      select 1
      from private.read_campaign_evidence(owner_a, evidence_id)
    ) then
    raise exception 'atomic delete did not remove the evidence row';
  end if;

  execute 'set local role mediaiq_evidence_writer';
  begin
    perform 1 from private.campaign_evidence;
    raise exception 'writer select succeeded';
  exception
    when insufficient_privilege then
      if sqlstate is distinct from '42501' then
        raise exception 'writer select returned %', sqlstate;
      end if;
  end;

  list_ids := array[
    private.insert_campaign_evidence(
      owner_a,
      'date,campaign,channel,spend,impressions,clicks',
      expected_summary,
      'monday-csv-1',
      'campaign-descriptive-1'
    ),
    private.insert_campaign_evidence(
      owner_a,
      'date,campaign,channel,spend,impressions,clicks',
      expected_summary,
      'monday-csv-1',
      'campaign-descriptive-1'
    )
  ];
  owner_b_evidence_id := private.insert_campaign_evidence(
    owner_b,
    'owner-b-source',
    expected_summary,
    'monday-csv-1',
    'campaign-descriptive-1'
  );

  select pg_catalog.array_agg(listed.id order by listed.created_at desc, listed.id desc)
    into list_again
  from private.list_campaign_evidence(owner_a, 50, null, null) as listed;

  select pg_catalog.array_agg(listed.id order by listed.created_at desc, listed.id desc)
    into list_ids
  from private.list_campaign_evidence(owner_a, 50, null, null) as listed;

  if list_ids is distinct from list_again
    or pg_catalog.cardinality(list_ids) is distinct from 2
    or list_again[1] is not distinct from list_again[2]
    or owner_b_evidence_id = any (list_ids) then
    raise exception 'owner list order or isolation failed';
  end if;

  if exists (
    select 1
    from private.list_campaign_evidence(
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
      20,
      null,
      null
    )
  ) then
    raise exception 'empty owner list returned a row';
  end if;

  if not exists (
    select 1
    from private.list_campaign_evidence(owner_b, 20, null, null) as listed
    where listed.id = owner_b_evidence_id
  ) or exists (
    select 1
    from private.list_campaign_evidence(owner_b, 20, null, null) as listed
    where listed.id = any (list_ids)
  ) then
    raise exception 'owner B list did not stay inside owner B';
  end if;

  select listed.id, listed.created_at
    into page_id, page_created
  from private.list_campaign_evidence(owner_a, 1, null, null) as listed;

  select listed.id, listed.created_at
    into next_page_id, next_page_created
  from private.list_campaign_evidence(owner_a, 1, page_created, page_id) as listed;

  if page_id is null
    or next_page_id is null
    or page_id = next_page_id
    or not (page_id = any (list_ids) and next_page_id = any (list_ids))
    or exists (
      select 1
      from private.list_campaign_evidence(owner_a, 1, next_page_created, next_page_id)
    ) then
    raise exception 'keyset pages repeated or skipped a stable row';
  end if;

  select listed.period_start, listed.campaign_count, listed.currency_codes
    into listed_period, listed_campaigns, listed_currencies
  from private.list_campaign_evidence(owner_a, 50, null, null) as listed
  where listed.id = page_id;

  if listed_period is not null
    or listed_campaigns is not null
    or listed_currencies is distinct from '{}'::text[] then
    raise exception 'missing summary fields were converted instead of preserved';
  end if;

  rich_id := private.insert_campaign_evidence(
    owner_a,
    'date,campaign,channel,spend,impressions,clicks',
    jsonb_build_object(
      'parserVersion', 'monday-csv-1',
      'calculationVersion', 'campaign-descriptive-1',
      'period', jsonb_build_object('start', '2024-02-01', 'end', '2024-03-01'),
      'campaigns', jsonb_build_array(
        jsonb_build_object('name', 'Spring'),
        jsonb_build_object('name', 'Fall')
      ),
      'channels', jsonb_build_array(
        jsonb_build_object('name', 'Search'),
        jsonb_build_object('name', 'Social'),
        jsonb_build_object('name', 'Display')
      ),
      'currencies', jsonb_build_array(
        jsonb_build_object('currency', 'USD'),
        jsonb_build_object('currency', 'EUR')
      )
    ),
    'monday-csv-1',
    'campaign-descriptive-1'
  );

  select
    listed.period_start,
    listed.period_end,
    listed.campaign_count,
    listed.channel_count,
    listed.currency_codes
  into listed_period, listed_period_end, listed_campaigns, listed_channels, listed_currencies
  from private.list_campaign_evidence(owner_a, 50, null, null) as listed
  where listed.id = rich_id;

  if listed_period is distinct from '2024-02-01'
    or listed_period_end is distinct from '2024-03-01'
    or listed_campaigns is distinct from 2
    or listed_channels is distinct from 3
    or listed_currencies is distinct from array['USD', 'EUR']::text[] then
    raise exception 'listed metadata did not match the stored summary';
  end if;

  begin
    perform 1 from private.list_campaign_evidence(null, 20, null, null);
    raise exception 'null owner was accepted';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform 1 from private.list_campaign_evidence(owner_a, 51, null, null);
    raise exception 'limit 51 was accepted';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform 1 from private.list_campaign_evidence(owner_a, 0, null, null);
    raise exception 'limit 0 was accepted';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform 1 from private.list_campaign_evidence(owner_a, 20, pg_catalog.now(), null);
    raise exception 'partial cursor was accepted';
  exception
    when sqlstate '22023' then
      null;
  end;

  execute 'reset role';

  select count(*) into audit_after from public.audit_events;

  if audit_before <> audit_after then
    raise exception 'evidence operations changed authentication audit records';
  end if;
end $$;

do $$
begin
  raise notice 'campaign evidence authorization tests completed; rolling back';
end $$;

rollback;
