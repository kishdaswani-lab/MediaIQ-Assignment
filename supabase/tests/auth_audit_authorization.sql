-- Rollback tests for the security-role migration.
-- The transaction rolls back. A successful run prints one completion notice.

begin;

do $$
declare
  writer_memberships integer;
  operator_admin boolean;
begin
  if to_regprocedure('public.record_security_event(text,text,text,text,jsonb,text,text)') is not null
    or to_regprocedure('public.consume_security_attempt(text,text)') is not null then
    raise exception 'public security writers are still installed';
  end if;

  if to_regprocedure('private.record_trusted_auth_event(text,uuid,jsonb,text,text,text[],text)') is not null
    or to_regprocedure('private.record_trusted_auth_event(uuid,smallint,text,uuid,timestamptz,jsonb,jsonb,text)') is null
    or to_regprocedure('private.record_auth_telemetry(text,jsonb,text)') is null
    or to_regprocedure('private.consume_auth_throttle(text,text,text[])') is null
    or to_regprocedure('private.maintain_security_retention()') is null then
    raise exception 'security functions are not installed';
  end if;

  if exists (
    select 1
    from pg_roles
    where rolname in (
      'mediaiq_security_owner',
      'mediaiq_security_writer',
      'mediaiq_security_maintainer',
      'mediaiq_security_operator'
    )
      and (rolsuper or rolbypassrls or rolcreaterole or rolinherit)
  ) then
    raise exception 'a security role is elevated';
  end if;

  if (select rolcanlogin from pg_roles where rolname = 'mediaiq_security_owner')
    or (select rolcanlogin from pg_roles where rolname = 'mediaiq_security_maintainer')
    or not (select rolcanlogin from pg_roles where rolname = 'mediaiq_security_writer')
    or not (select rolcanlogin from pg_roles where rolname = 'mediaiq_security_operator')
    or (select rolinherit from pg_roles where rolname = 'mediaiq_security_operator') then
    raise exception 'security role login or inheritance flags are wrong';
  end if;

  select count(*) into writer_memberships
  from pg_auth_members member_row
  join pg_roles member_role on member_role.oid = member_row.member
  where member_role.rolname in (
    'mediaiq_security_writer',
    'mediaiq_security_owner',
    'mediaiq_security_maintainer'
  );

  if writer_memberships <> 0 then
    raise exception 'writer, owner, or maintainer has a role membership';
  end if;

  select member_row.admin_option
    into operator_admin
  from pg_auth_members member_row
  join pg_roles granted_role on granted_role.oid = member_row.roleid
  join pg_roles member_role on member_role.oid = member_row.member
  where member_role.rolname = 'mediaiq_security_operator'
    and granted_role.rolname = 'mediaiq_security_maintainer';

  if operator_admin is distinct from false then
    raise exception 'operator is not a member of maintainer without admin option';
  end if;

  if pg_has_role('mediaiq_security_operator', 'mediaiq_security_maintainer', 'SET') is not true
    or pg_has_role('mediaiq_security_operator', 'mediaiq_security_owner', 'MEMBER')
    or pg_has_role('mediaiq_security_operator', 'mediaiq_security_writer', 'MEMBER')
    or pg_has_role('mediaiq_security_writer', 'mediaiq_security_owner', 'SET')
    or pg_has_role('mediaiq_security_writer', 'mediaiq_security_maintainer', 'SET')
    or pg_has_role('mediaiq_security_writer', 'mediaiq_security_operator', 'SET') then
    raise exception 'role assumption rights are wrong';
  end if;

  if has_table_privilege('mediaiq_security_writer', 'public.businesses', 'SELECT')
    or has_table_privilege('mediaiq_security_writer', 'public.workspaces', 'SELECT')
    or has_table_privilege('mediaiq_security_owner', 'public.businesses', 'SELECT')
    or has_table_privilege('mediaiq_security_writer', 'public.audit_events', 'SELECT')
    or has_table_privilege('mediaiq_security_writer', 'private.auth_telemetry', 'SELECT')
    or has_table_privilege('mediaiq_security_writer', 'private.security_counters', 'DELETE')
    or has_table_privilege('mediaiq_security_maintainer', 'public.audit_events', 'DELETE') then
    raise exception 'security roles can reach business or audit tables directly';
  end if;

  if has_function_privilege(
      'mediaiq_security_writer',
      'private.record_trusted_auth_event(uuid,smallint,text,uuid,timestamptz,jsonb,jsonb,text)',
      'EXECUTE'
    ) is not true
    or has_function_privilege(
      'mediaiq_security_writer',
      'private.maintain_security_retention()',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'private.record_auth_telemetry(text,jsonb,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'private.consume_auth_throttle(text,text,text[])',
      'EXECUTE'
    )
    or has_function_privilege(
      'mediaiq_security_maintainer',
      'private.maintain_security_retention()',
      'EXECUTE'
    ) is not true
    or has_function_privilege(
      'mediaiq_security_operator',
      'private.maintain_security_retention()',
      'EXECUTE'
    ) then
    raise exception 'function execution grants are wrong';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'auth_telemetry'
      and column_name = 'actor_user_id'
  ) then
    raise exception 'telemetry stores an actor';
  end if;
end $$;

grant mediaiq_security_writer to current_user with set true, inherit false;
grant mediaiq_security_owner to current_user with set true, inherit false;
grant mediaiq_security_maintainer to current_user with set true, inherit false;
grant mediaiq_security_operator to current_user with set true, inherit false;

do $$
declare
  inserted_id uuid;
  visible_count integer;
  attempt jsonb;
  attempt_number integer;
  stored_outcome text;
  account_count integer;
  account_delay integer;
  client_identity text;
  actor uuid := '88888888-8888-4888-8888-888888888888';
  sample_hash text := repeat('ab', 32);
begin
  execute 'set local role anon';

  begin
    perform private.record_auth_telemetry('login_failed', '{}'::jsonb, null);
    raise exception 'anonymous caller recorded telemetry';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'set local role authenticated';

  begin
    perform private.record_trusted_auth_event(
      '11111111-1111-4111-8111-111111111111'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      pg_catalog.clock_timestamp(),
      '{}'::jsonb,
      jsonb_build_object(
        'aal', 'aal1',
        'method', 'password',
        'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ),
      null
    );
    raise exception 'authenticated caller recorded a trusted event';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    insert into public.audit_events (event_type, outcome, metadata)
    values ('auth.logout', 'success', '{}'::jsonb);
    raise exception 'authenticated user inserted an audit event directly';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'set local role mediaiq_security_writer';

  begin
    perform private.maintain_security_retention();
    raise exception 'writer executed retention';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform set_config('mediaiq.audit_maintenance', 'on', true);
    delete from public.audit_events;
    raise exception 'writer deleted audit rows';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_auth_telemetry(
      'login_failed',
      jsonb_build_object('code', '123456'),
      null
    );
    raise exception 'metadata accepted an authentication code';
  exception
    when invalid_parameter_value then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '11111111-1111-4111-8111-111111111112'::uuid,
      1::smallint,
      'login_succeeded',
      null,
      pg_catalog.clock_timestamp(),
      '{}'::jsonb,
      jsonb_build_object(
        'aal', 'aal1',
        'method', 'password',
        'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ),
      repeat('ab', 32)
    );
    raise exception 'trusted event accepted a missing actor';
  exception
    when insufficient_privilege then
      null;
  end;

  inserted_id := private.record_auth_telemetry(
    'login_failed',
    jsonb_build_object('method', 'password'),
    'auth-audit-test'
  );

  if inserted_id is null then
    raise exception 'failed login was not recorded';
  end if;

  begin
    perform private.record_trusted_auth_event(
      '44444444-4444-4444-8444-444444444444'::uuid,
      1::smallint,
      'password_change_failed',
      actor,
      pg_catalog.clock_timestamp(),
      jsonb_build_object('method', 'recovery'),
      jsonb_build_object(
        'aal', 'aal1',
        'method', 'password',
        'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ),
      repeat('ab', 32)
    );
    raise exception 'writer forged a trusted failure without a valid signature';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'set local role mediaiq_security_owner';
  perform set_config('mediaiq.audit_insert', 'on', true);

  insert into public.audit_events (
    event_type, actor_user_id, outcome, metadata
  )
  values (
    'auth.login.succeeded',
    actor,
    'success',
    jsonb_build_object('method', 'password')
  )
  returning id into inserted_id;

  perform set_config('mediaiq.audit_insert', 'off', true);
  execute 'set local role mediaiq_security_writer';

  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  select count(*) into visible_count
  from public.audit_events
  where id = inserted_id
    and actor_user_id = actor;

  if visible_count <> 1 then
    raise exception 'actor could not read the recorded login event';
  end if;

  begin
    update public.audit_events set outcome = 'failure' where id = inserted_id;
    raise exception 'authenticated user updated an audit event';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    delete from public.audit_events where id = inserted_id;
    raise exception 'authenticated user deleted an audit event';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'set local role mediaiq_security_writer';

  for attempt_number in 1..2 loop
    attempt := private.consume_auth_throttle('login', 'local', array[sample_hash]);
    if attempt ->> 'allowed' <> 'true' then
      raise exception 'account attempt % was denied too early', attempt_number;
    end if;
  end loop;

  attempt := private.consume_auth_throttle('login', 'local', array[sample_hash]);

  if attempt ->> 'allowed' <> 'false' or attempt ->> 'account_delayed' <> 'true' then
    raise exception 'the account was not delayed';
  end if;

  execute 'set local role mediaiq_security_owner';

  select counter.attempt_count, counter.delay_seconds
    into account_count, account_delay
  from private.security_counters counter
  where counter.action = 'login'
    and counter.dimension = 'account'
    and counter.identity_hash = sample_hash;

  if account_count <> 2 or account_delay <> 1 then
    raise exception 'a too-soon retry changed the account counter';
  end if;

  execute 'set local role mediaiq_security_writer';

  for attempt_number in 1..30 loop
    attempt := private.consume_auth_throttle('signup', '203.0.113.4,198.51.100.8', array[]::text[]);
    if attempt ->> 'allowed' <> 'true' then
      raise exception 'shared local identity was hard limited';
    end if;
  end loop;

  execute 'set local role mediaiq_security_owner';

  select counter.identity_hash into client_identity
  from private.security_counters counter
  where counter.action = 'signup' and counter.dimension = 'client' and counter.identity_hash = 'local';

  if client_identity is distinct from 'local' then
    raise exception 'comma-separated identity was stored';
  end if;

  execute 'set local role mediaiq_security_writer';

  for attempt_number in 1..29 loop
    attempt := private.consume_auth_throttle('recovery', '203.0.113.10', array[]::text[]);
    if attempt ->> 'allowed' <> 'true' then
      raise exception 'distinct client was limited before the threshold';
    end if;
  end loop;

  attempt := private.consume_auth_throttle('recovery', '203.0.113.10', array[]::text[]);

  if attempt ->> 'allowed' <> 'false' then
    raise exception 'distinct client was not limited';
  end if;

  execute 'set local role mediaiq_security_owner';

  insert into private.security_counters (
    action, dimension, identity_hash, window_started, last_attempt, attempt_count, delay_seconds
  )
  values ('mfa_replace', 'global', 'global', pg_catalog.now(), pg_catalog.now(), 99, 0);

  execute 'set local role mediaiq_security_writer';

  attempt := private.consume_auth_throttle('mfa_replace', 'local', array[]::text[]);

  if attempt ->> 'allowed' <> 'true' or attempt ->> 'suspicious' <> 'true' then
    raise exception 'global counter blocked or did not become suspicious';
  end if;

  begin
    perform private.record_trusted_auth_event(
      '55555555-5555-4555-8555-555555555555'::uuid,
      1::smallint,
      'mfa_verified',
      actor,
      pg_catalog.clock_timestamp(),
      jsonb_build_object('method', 'totp', 'purpose', 'login', 'account_hashes', sample_hash),
      jsonb_build_object(
        'aal', 'aal2',
        'method', 'totp',
        'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ),
      repeat('cd', 32)
    );
    raise exception 'writer forged MFA verification without a valid signature';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'set local role mediaiq_security_owner';

  select count(*) into account_count
  from private.security_counters counter
  where counter.account_hash = sample_hash
    and counter.dimension in ('account', 'client_account');

  if account_count = 0 then
    raise exception 'unsigned MFA verification reset the account throttle';
  end if;
end $$;

reset role;

do $$
declare
  hot_id uuid;
  recent_id uuid;
  archive_id uuid := '99999999-9999-4999-8999-999999999999';
  telemetry_id uuid;
  retained jsonb;
  remaining integer;
begin
  execute 'set local role mediaiq_security_owner';
  perform set_config('mediaiq.audit_insert', 'on', true);

  insert into public.audit_events (
    event_type, actor_user_id, outcome, metadata, created_at
  )
  values (
    'auth.logout',
    '88888888-8888-4888-8888-888888888888',
    'success',
    '{}'::jsonb,
    pg_catalog.now() - interval '100 days'
  )
  returning id into hot_id;

  insert into public.audit_events (
    event_type, actor_user_id, outcome, metadata, created_at
  )
  values (
    'auth.logout',
    '88888888-8888-4888-8888-888888888888',
    'success',
    '{}'::jsonb,
    pg_catalog.now() - interval '10 days'
  )
  returning id into recent_id;

  perform set_config('mediaiq.audit_insert', 'off', true);

  insert into private.audit_events_archive (
    id, event_type, actor_user_id, outcome, metadata, created_at
  )
  values (
    archive_id,
    'auth.logout',
    '88888888-8888-4888-8888-888888888888',
    'success',
    '{}'::jsonb,
    pg_catalog.now() - interval '25 months'
  );

  insert into private.auth_telemetry (event_type, outcome, metadata, created_at)
  values (
    'auth.login.failed',
    'failure',
    '{}'::jsonb,
    pg_catalog.now() - interval '31 days'
  )
  returning id into telemetry_id;

  execute 'set local role mediaiq_security_owner';

  begin
    delete from public.audit_events where id = recent_id;
    raise exception 'owner deleted an audit row without the maintenance flag';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'set local role mediaiq_security_operator';
  execute 'set local role mediaiq_security_maintainer';
  retained := private.maintain_security_retention();

  if (retained ->> 'moved_to_archive')::integer < 1
    or (retained ->> 'expired_archive')::integer < 1
    or (retained ->> 'expired_telemetry')::integer < 1 then
    raise exception 'retention did not move and expire the aged rows';
  end if;

  execute 'set local role mediaiq_security_owner';

  select count(*) into remaining from public.audit_events where id = hot_id;
  if remaining <> 0 then
    raise exception 'aged hot audit row was not archived';
  end if;

  select count(*) into remaining from private.audit_events_archive where id = hot_id;
  if remaining <> 1 then
    raise exception 'aged hot audit row is missing from the archive';
  end if;

  select count(*) into remaining from public.audit_events where id = recent_id;
  if remaining <> 1 then
    raise exception 'recent audit row was archived too early';
  end if;

  select count(*) into remaining from private.audit_events_archive where id = archive_id;
  if remaining <> 0 then
    raise exception 'expired archive row was kept';
  end if;

  select count(*) into remaining from private.auth_telemetry where id = telemetry_id;
  if remaining <> 0 then
    raise exception 'telemetry older than 30 days was kept';
  end if;
end $$;

do $$
begin
  raise notice 'auth audit authorization tests completed; rolling back';
end $$;

rollback;
