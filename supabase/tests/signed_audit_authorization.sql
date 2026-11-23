-- Signed trusted-audit checks. Successful rows in the rollback sections are discarded.
-- The committed duplicate uses one fixed event id and deletes only that row.
-- A captured request that has not committed can still be inserted once until it expires.
-- Event-id uniqueness does not prevent that first insert.

begin;

do $$
declare
  issued timestamptz := timestamptz 'epoch'
    + 1763510400 * interval '1 second'
    + 123000 * interval '1 microsecond';
  payload text;
  escaped text;
begin
  payload := private.trusted_audit_payload(
    1::smallint,
    '11111111-1111-4111-8111-111111111111'::uuid,
    'login_succeeded',
    '88888888-8888-4888-8888-888888888888'::uuid,
    issued,
    '{"method":"password"}'::jsonb,
    jsonb_build_object(
      'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aal', 'aal1',
      'method', 'password'
    )
  );

  if octet_length(pg_catalog.convert_to(payload, 'UTF8')) <> 234
    or payload <> E'mediaiq-audit-v1\n1\n11111111-1111-4111-8111-111111111111\nlogin_succeeded\n88888888-8888-4888-8888-888888888888\n1763510400123000\n{"method":"password"}\n{"aal":"aal1","method":"password","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}' then
    raise exception 'canonical payload vector did not match';
  end if;

  if pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(payload, 'UTF8'),
      pg_catalog.decode('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
      'sha256'
    ),
    'hex'
  ) <> '60774719ade831f4b25c9c8ad24f3f737248f678b19ff3e26b805c13b4cc9e2f' then
    raise exception 'postgres hmac vector did not match';
  end if;

  escaped := private.canonical_json_object('{"b":"é","a":"x\"y"}'::jsonb);

  if pg_catalog.encode(pg_catalog.convert_to(escaped, 'UTF8'), 'hex')
    <> '7b2261223a22785c2279222c2262223a22c3a9227d' then
    raise exception 'json escaping vector did not match';
  end if;
end $$;

do $$
declare
  leaking_function text;
begin
  if (select rolcanlogin from pg_roles where rolname = 'mediaiq_security_owner') then
    raise exception 'security owner can log in';
  end if;

  if has_table_privilege('mediaiq_security_writer', 'private.audit_signing_key', 'SELECT')
    or has_table_privilege('mediaiq_security_maintainer', 'private.audit_signing_key', 'SELECT')
    or has_table_privilege('mediaiq_security_operator', 'private.audit_signing_key', 'SELECT')
    or has_table_privilege('anon', 'private.audit_signing_key', 'SELECT')
    or has_table_privilege('authenticated', 'private.audit_signing_key', 'SELECT')
    or has_table_privilege('public', 'private.audit_signing_key', 'SELECT')
    or pg_has_role('postgres', 'mediaiq_security_owner', 'USAGE')
    or pg_has_role('postgres', 'mediaiq_security_owner', 'SET') then
    raise exception 'a denied role can read the signing key';
  end if;

  if has_function_privilege(
      'mediaiq_security_writer',
      'private.record_trusted_auth_event(uuid,smallint,text,uuid,timestamptz,jsonb,jsonb,text)',
      'EXECUTE'
    ) is not true
    or has_function_privilege(
      'mediaiq_security_writer',
      'private.rotate_audit_signing_key()',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'private.record_trusted_auth_event(uuid,smallint,text,uuid,timestamptz,jsonb,jsonb,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'mediaiq_security_maintainer',
      'private.rotate_audit_signing_key()',
      'EXECUTE'
    ) is not true then
    raise exception 'signing function grants are wrong';
  end if;

  select function.proname
    into leaking_function
  from pg_proc function
  join pg_namespace namespace on namespace.oid = function.pronamespace
  where namespace.nspname = 'private'
    and function.prosrc like '%audit_signing_key%'
    and pg_catalog.pg_get_function_result(function.oid) like '%bytea%';

  if leaking_function is not null then
    raise exception 'a function returns signing key material';
  end if;
end $$;

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'mediaiq_security_writer',
    'mediaiq_security_maintainer',
    'mediaiq_security_operator',
    'anon',
    'authenticated'
  ] loop
    execute format('set local role %I', role_name);

    begin
      perform count(*) from private.audit_signing_key;
      raise exception '% read the signing key', role_name;
    exception
      when insufficient_privilege then
        null;
    end;
  end loop;

  execute 'reset role';
end $$;

do $$
declare
  signing_key bytea;
  actor uuid := '88888888-8888-4888-8888-888888888888';
  event_id uuid := '12121212-1212-4212-8212-121212121212';
  issued timestamptz := pg_catalog.clock_timestamp();
  metadata jsonb := '{"method":"password"}'::jsonb;
  context jsonb := jsonb_build_object(
    'aal', 'aal1',
    'method', 'password',
    'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  payload text;
  signature text;
  stored_actor uuid;
  stored_outcome text;
  account_count integer;
  sample_hash text := repeat('ab', 32);
  rotated_id smallint;
  key_count integer;
begin
  select secret
    into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'active';

  if signing_key is null or octet_length(signing_key) <> 32 then
    raise exception 'active signing key is missing';
  end if;

  payload := private.trusted_audit_payload(
    1::smallint, event_id, 'login_succeeded', actor, issued, metadata, context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );
  signing_key := null;

  execute 'set local role mediaiq_security_writer';

  begin
    perform private.record_trusted_auth_event(
      event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, null
    );
    raise exception 'writer created a trusted login without a signature';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '13131313-1313-4313-8313-131313131313'::uuid,
      1::smallint,
      'mfa_verified',
      actor,
      issued,
      jsonb_build_object('method', 'totp', 'purpose', 'login'),
      jsonb_build_object(
        'aal', 'aal2',
        'method', 'totp',
        'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ),
      repeat('ab', 32)
    );
    raise exception 'writer forged MFA verification';
  exception
    when insufficient_privilege then
      null;
  end;

  perform private.record_trusted_auth_event(
    event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
  );

  begin
    perform private.record_trusted_auth_event(
      event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
    );
    raise exception 'duplicate event id was accepted before commit';
  exception
    when unique_violation then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '14141414-1414-4414-8414-141414141414'::uuid,
      1::smallint,
      'login_succeeded',
      '99999999-9999-4999-8999-999999999999'::uuid,
      issued,
      metadata,
      context,
      signature
    );
    raise exception 'changed actor was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '15151515-1515-4515-8515-151515151515'::uuid,
      1::smallint,
      'password_change_failed',
      actor,
      issued,
      metadata,
      context,
      signature
    );
    raise exception 'changed operation was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '16161616-1616-4616-8616-161616161616'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      issued,
      '{"method":"totp"}'::jsonb,
      context,
      signature
    );
    raise exception 'changed metadata was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '17171717-1717-4717-8717-171717171717'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      issued,
      metadata,
      jsonb_build_object(
        'aal', 'aal2',
        'method', 'password',
        'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ),
      signature
    );
    raise exception 'changed context was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '18181818-1818-4818-8818-181818181818'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      issued + interval '1 second',
      metadata,
      context,
      signature
    );
    raise exception 'changed timestamp was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '19191919-1919-4919-8919-191919191919'::uuid,
      1::smallint,
      'not_an_operation',
      actor,
      issued,
      metadata,
      context,
      signature
    );
    raise exception 'unknown operation was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  foreach signature in array array[null, '', repeat('ab', 10), pg_catalog.upper(signature), repeat('zz', 32)] loop
    begin
      perform private.record_trusted_auth_event(
        '20202020-2020-4202-8202-202020202020'::uuid,
        1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
      );
      raise exception 'malformed signature was accepted';
    exception
      when insufficient_privilege then
        null;
    end;
  end loop;

  execute 'reset role';

  select actor_user_id, outcome
    into stored_actor, stored_outcome
  from public.audit_events
  where id = event_id;

  if stored_actor <> actor or stored_outcome <> 'success' then
    raise exception 'signed login did not record the actor';
  end if;

  execute 'set local role mediaiq_security_owner';

  begin
    insert into public.audit_events (event_type, actor_user_id, outcome, metadata)
    values ('auth.logout', actor, 'success', '{}'::jsonb);
    raise exception 'owner inserted an audit row without the signing flag';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    delete from public.audit_events where id = event_id;
    raise exception 'owner deleted an audit row without the maintenance flag';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
  execute 'set local role postgres';

  begin
    insert into public.audit_events (event_type, actor_user_id, outcome, metadata)
    values ('auth.logout', actor, 'success', '{}'::jsonb);
    raise exception 'postgres inserted an audit row directly';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
  execute 'set local role mediaiq_security_writer';

  begin
    perform set_config('mediaiq.audit_insert', 'on', true);
    insert into public.audit_events (event_type, actor_user_id, outcome, metadata)
    values ('auth.logout', actor, 'success', '{}'::jsonb);
    raise exception 'writer inserted an audit row directly';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform set_config('mediaiq.audit_maintenance', 'on', true);
    delete from public.audit_events where id = event_id;
    raise exception 'writer deleted an audit row';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';

  select secret into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'active';

  payload := private.trusted_audit_payload(
    1::smallint,
    '21212121-2121-4212-8212-212121212121'::uuid,
    'login_succeeded',
    actor,
    pg_catalog.clock_timestamp() - interval '61 seconds',
    metadata,
    context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );

  begin
    perform private.record_trusted_auth_event(
      '21212121-2121-4212-8212-212121212121'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      pg_catalog.clock_timestamp() - interval '61 seconds',
      metadata,
      context,
      signature
    );
    raise exception 'expired audit request was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  payload := private.trusted_audit_payload(
    1::smallint,
    '23232323-2323-4232-8232-232323232323'::uuid,
    'login_succeeded',
    actor,
    pg_catalog.clock_timestamp() + interval '6 seconds',
    metadata,
    context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );

  begin
    perform private.record_trusted_auth_event(
      '23232323-2323-4232-8232-232323232323'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      pg_catalog.clock_timestamp() + interval '6 seconds',
      metadata,
      context,
      signature
    );
    raise exception 'future audit request was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  payload := private.trusted_audit_payload(
    1::smallint,
    '24242424-2424-4242-8242-242424242424'::uuid,
    'login_succeeded',
    actor,
    issued,
    metadata,
    context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );

  insert into private.audit_signing_key (key_id, secret, status, not_valid_after)
  values (
    9,
    extensions.gen_random_bytes(32),
    'retiring',
    pg_catalog.clock_timestamp() + interval '60 seconds'
  );

  begin
    perform private.record_trusted_auth_event(
      '24242424-2424-4242-8242-242424242424'::uuid,
      9::smallint,
      'login_succeeded',
      actor,
      issued,
      metadata,
      context,
      signature
    );
    raise exception 'changed key id was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  delete from private.audit_signing_key where key_id = 9;

  insert into private.security_counters (
    action, dimension, identity_hash, account_hash, attempt_count, delay_seconds
  )
  values ('login', 'account', sample_hash, sample_hash, 2, 1);

  payload := private.trusted_audit_payload(
    1::smallint,
    '25252525-2525-4252-8252-252525252525'::uuid,
    'mfa_verified',
    actor,
    issued,
    jsonb_build_object('method', 'totp', 'purpose', 'login', 'account_hashes', sample_hash),
    jsonb_build_object(
      'aal', 'aal2',
      'method', 'totp',
      'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );
  signing_key := null;

  perform private.record_trusted_auth_event(
    '25252525-2525-4252-8252-252525252525'::uuid,
    1::smallint,
    'mfa_verified',
    actor,
    issued,
    jsonb_build_object('method', 'totp', 'purpose', 'login', 'account_hashes', sample_hash),
    jsonb_build_object(
      'aal', 'aal2',
      'method', 'totp',
      'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ),
    signature
  );

  select count(*)
    into account_count
  from private.security_counters
  where account_hash = sample_hash
    and dimension in ('account', 'client_account');

  if account_count <> 0 then
    raise exception 'signed verification did not reset the account throttle';
  end if;

  select outcome
    into stored_outcome
  from public.audit_events
  where id = '26262626-2626-4262-8262-262626262626'::uuid;

  select secret into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'active';

  payload := private.trusted_audit_payload(
    1::smallint,
    '26262626-2626-4262-8262-262626262626'::uuid,
    'password_change_failed',
    actor,
    issued,
    metadata,
    context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );

  perform private.record_trusted_auth_event(
    '26262626-2626-4262-8262-262626262626'::uuid,
    1::smallint,
    'password_change_failed',
    actor,
    issued,
    metadata,
    context,
    signature
  );

  select outcome
    into stored_outcome
  from public.audit_events
  where id = '26262626-2626-4262-8262-262626262626'::uuid;

  if stored_outcome <> 'failure' then
    raise exception 'database did not choose the trusted outcome';
  end if;

  execute 'set local role mediaiq_security_maintainer';
  rotated_id := private.rotate_audit_signing_key();
  execute 'reset role';

  if rotated_id <> 2 then
    raise exception 'rotation did not return the new key id';
  end if;

  select count(*)
    into key_count
  from private.audit_signing_key
  where status = 'retiring'
    and not_valid_after > pg_catalog.clock_timestamp()
    and not_valid_after <= pg_catalog.clock_timestamp() + interval '121 seconds';

  if key_count <> 1 then
    raise exception 'previous key overlap was not 120 seconds';
  end if;

  begin
    perform private.rotate_audit_signing_key();
    raise exception 'a second rotation was accepted during the overlap';
  exception
    when invalid_parameter_value then
      null;
  end;

  select secret into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'retiring';

  payload := private.trusted_audit_payload(
    1::smallint,
    '27272727-2727-4272-8272-272727272727'::uuid,
    'logout',
    actor,
    issued,
    '{"scope":"global"}'::jsonb,
    context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );

  perform private.record_trusted_auth_event(
    '27272727-2727-4272-8272-272727272727'::uuid,
    1::smallint,
    'logout',
    actor,
    issued,
    '{"scope":"global"}'::jsonb,
    context,
    signature
  );

  update private.audit_signing_key
  set not_valid_after = pg_catalog.clock_timestamp() - interval '1 second'
  where key_id = 1;

  select secret into signing_key
  from private.audit_signing_key
  where key_id = 2 and status = 'active';

  payload := private.trusted_audit_payload(
    2::smallint,
    '28282828-2828-4282-8282-282828282828'::uuid,
    'logout',
    actor,
    issued,
    '{"scope":"global"}'::jsonb,
    context
  );
  signature := pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(payload, 'UTF8'), signing_key, 'sha256'),
    'hex'
  );
  signing_key := null;

  perform private.record_trusted_auth_event(
    '28282828-2828-4282-8282-282828282828'::uuid,
    2::smallint,
    'logout',
    actor,
    issued,
    '{"scope":"global"}'::jsonb,
    context,
    signature
  );

  select count(*)
    into key_count
  from private.audit_signing_key
  where key_id = 1;

  if key_count <> 0 then
    raise exception 'expired signing key material was kept';
  end if;
end $$;

rollback;

begin;

do $$
declare
  signing_key bytea;
  actor uuid := '88888888-8888-4888-8888-888888888888';
  event_id uuid := '32323232-3232-4232-8232-323232323232';
  issued timestamptz := pg_catalog.clock_timestamp();
  metadata jsonb := '{"method":"password"}'::jsonb;
  context jsonb := jsonb_build_object(
    'aal', 'aal1',
    'method', 'password',
    'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  signature text;
begin
  select secret into signing_key
  from private.audit_signing_key
  where status = 'active';

  signature := pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        private.trusted_audit_payload(1::smallint, event_id, 'login_succeeded', actor, issued, metadata, context),
        'UTF8'
      ),
      signing_key,
      'sha256'
    ),
    'hex'
  );

  perform private.record_trusted_auth_event(
    event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
  );
end $$;

rollback;

begin;

do $$
declare
  signing_key bytea;
  actor uuid := '88888888-8888-4888-8888-888888888888';
  event_id uuid := '32323232-3232-4232-8232-323232323232';
  issued timestamptz := pg_catalog.clock_timestamp();
  metadata jsonb := '{"method":"password"}'::jsonb;
  context jsonb := jsonb_build_object(
    'aal', 'aal1',
    'method', 'password',
    'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  signature text;
begin
  select secret into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'active';

  if signing_key is null then
    raise exception 'rolled-back rotation changed the active key';
  end if;

  signature := pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        private.trusted_audit_payload(1::smallint, event_id, 'login_succeeded', actor, issued, metadata, context),
        'UTF8'
      ),
      signing_key,
      'sha256'
    ),
    'hex'
  );

  perform private.record_trusted_auth_event(
    event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
  );
end $$;

rollback;

begin;

select set_config('role', 'mediaiq_security_owner', true);
select set_config('mediaiq.audit_maintenance', 'on', true);
delete from public.audit_events
where id = '22222222-2222-4222-8222-222222222222'::uuid;

commit;

create temp table signed_probe (
  issued_at timestamptz,
  signature text
);

do $$
declare
  signing_key bytea;
  actor uuid := '88888888-8888-4888-8888-888888888888';
  event_id uuid := '22222222-2222-4222-8222-222222222222';
  issued timestamptz := pg_catalog.clock_timestamp();
  metadata jsonb := '{"method":"password"}'::jsonb;
  context jsonb := jsonb_build_object(
    'aal', 'aal1',
    'method', 'password',
    'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  signature text;
begin
  select secret into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'active';

  signature := pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        private.trusted_audit_payload(1::smallint, event_id, 'login_succeeded', actor, issued, metadata, context),
        'UTF8'
      ),
      signing_key,
      'sha256'
    ),
    'hex'
  );

  insert into signed_probe (issued_at, signature) values (issued, signature);

  perform private.record_trusted_auth_event(
    event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
  );
end $$;

do $$
declare
  actor uuid := '88888888-8888-4888-8888-888888888888';
  event_id uuid := '22222222-2222-4222-8222-222222222222';
  issued timestamptz;
  metadata jsonb := '{"method":"password"}'::jsonb;
  context jsonb := jsonb_build_object(
    'aal', 'aal1',
    'method', 'password',
    'session_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  signature text;
begin
  select probe.issued_at, probe.signature
    into issued, signature
  from signed_probe probe;

  begin
    perform private.record_trusted_auth_event(
      event_id, 1::smallint, 'login_succeeded', actor, issued, metadata, context, signature
    );
    raise exception 'duplicate committed event was accepted';
  exception
    when unique_violation then
      null;
  end;
end $$;

begin;

select set_config('role', 'mediaiq_security_owner', true);
select set_config('mediaiq.audit_maintenance', 'on', true);
delete from public.audit_events
where id = '22222222-2222-4222-8222-222222222222'::uuid;

commit;

do $$
begin
  if exists (
    select 1
    from public.audit_events
    where id = '22222222-2222-4222-8222-222222222222'::uuid
  ) then
    raise exception 'committed duplicate test row was not removed';
  end if;

  if (
    select count(*)
    from private.audit_signing_key
    where status = 'active' and key_id = 1
  ) <> 1 then
    raise exception 'rotation test changed the active signing key';
  end if;
end $$;

begin;

do $$
declare
  signing_key bytea;
  actor uuid := '88888888-8888-4888-8888-888888888888';
  issued timestamptz := pg_catalog.clock_timestamp();
  session_id text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  signature text;
  stored_method text;
  stored_aal text;
  stored_metadata text;
begin
  select secret
    into signing_key
  from private.audit_signing_key
  where key_id = 1 and status = 'active';

  signature := pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        private.trusted_audit_payload(
          1::smallint,
          '41414141-4141-4141-8141-414141414141'::uuid,
          'mfa_enroll_started',
          actor,
          issued,
          '{"method":"totp"}'::jsonb,
          jsonb_build_object('aal', 'aal1', 'method', 'email/signup', 'session_id', session_id)
        ),
        'UTF8'
      ),
      signing_key,
      'sha256'
    ),
    'hex'
  );

  execute 'set local role mediaiq_security_writer';
  perform private.record_trusted_auth_event(
    '41414141-4141-4141-8141-414141414141'::uuid,
    1::smallint,
    'mfa_enroll_started',
    actor,
    issued,
    '{"method":"totp"}'::jsonb,
    jsonb_build_object('aal', 'aal1', 'method', 'email/signup', 'session_id', session_id),
    signature
  );
  perform pg_catalog.set_config('role', 'none', true);

  select auth_context ->> 'method', auth_context ->> 'aal', metadata ->> 'method'
    into stored_method, stored_aal, stored_metadata
  from public.audit_events
  where id = '41414141-4141-4141-8141-414141414141'::uuid;

  if stored_method <> 'email/signup' or stored_aal <> 'aal1' or stored_metadata <> 'totp' then
    raise exception 'email confirmation did not record enrollment start';
  end if;

  signature := pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        private.trusted_audit_payload(
          1::smallint,
          '42424242-4242-4242-8242-424242424242'::uuid,
          'mfa_enroll_verified',
          actor,
          issued,
          '{"method":"totp"}'::jsonb,
          jsonb_build_object('aal', 'aal2', 'method', 'totp', 'session_id', session_id)
        ),
        'UTF8'
      ),
      signing_key,
      'sha256'
    ),
    'hex'
  );

  execute 'set local role mediaiq_security_writer';
  perform private.record_trusted_auth_event(
    '42424242-4242-4242-8242-424242424242'::uuid,
    1::smallint,
    'mfa_enroll_verified',
    actor,
    issued,
    '{"method":"totp"}'::jsonb,
    jsonb_build_object('aal', 'aal2', 'method', 'totp', 'session_id', session_id),
    signature
  );
  perform pg_catalog.set_config('role', 'none', true);

  select auth_context ->> 'method', auth_context ->> 'aal'
    into stored_method, stored_aal
  from public.audit_events
  where id = '42424242-4242-4242-8242-424242424242'::uuid;

  if stored_method <> 'totp' or stored_aal <> 'aal2' then
    raise exception 'verified enrollment did not record totp at AAL2';
  end if;

  signature := pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(
        private.trusted_audit_payload(
          1::smallint,
          '43434343-4343-4343-8343-434343434343'::uuid,
          'login_succeeded',
          actor,
          issued,
          '{"method":"password"}'::jsonb,
          jsonb_build_object('aal', 'aal1', 'method', 'password', 'session_id', session_id)
        ),
        'UTF8'
      ),
      signing_key,
      'sha256'
    ),
    'hex'
  );
  execute 'set local role mediaiq_security_writer';
  perform private.record_trusted_auth_event(
    '43434343-4343-4343-8343-434343434343'::uuid,
    1::smallint,
    'login_succeeded',
    actor,
    issued,
    '{"method":"password"}'::jsonb,
    jsonb_build_object('aal', 'aal1', 'method', 'password', 'session_id', session_id),
    signature
  );
  perform pg_catalog.set_config('role', 'none', true);

  execute 'set local role mediaiq_security_writer';

  begin
    perform private.record_trusted_auth_event(
      '44444444-4444-4444-8444-444444444444'::uuid,
      1::smallint,
      'mfa_enroll_started',
      actor,
      issued,
      '{"method":"totp"}'::jsonb,
      jsonb_build_object('aal', 'aal2', 'method', 'email/signup', 'session_id', session_id),
      signature
    );
    raise exception 'email confirmation was accepted at AAL2';
  exception
    when invalid_parameter_value then
      null;
  end;

  begin
    perform private.record_trusted_auth_event(
      '45454545-4545-4545-8545-454545454545'::uuid,
      1::smallint,
      'login_succeeded',
      actor,
      issued,
      '{"method":"password"}'::jsonb,
      jsonb_build_object('aal', 'aal1', 'method', 'oauth', 'session_id', session_id),
      signature
    );
    raise exception 'oauth context was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  perform pg_catalog.set_config('role', 'none', true);

  signing_key := null;
end $$;

rollback;

-- postgres and supabase_admin are trusted infrastructure administrators.
-- postgres inherits pg_read_all_data and has BYPASSRLS, so forced row-level
-- security does not hide private.audit_signing_key from it. supabase_admin is
-- a superuser. This test does not claim the signing key is protected from
-- database administrators. Application roles are checked earlier.

do $$
declare
  visible integer;
begin
  if not has_table_privilege('postgres', 'private.audit_signing_key', 'SELECT')
    or not has_table_privilege('supabase_admin', 'private.audit_signing_key', 'SELECT') then
    raise exception 'trusted infrastructure administrator lacks effective select on the signing key';
  end if;

  execute 'set local role postgres';
  select count(*) into visible from private.audit_signing_key;

  if visible = 0 then
    raise exception 'postgres could not read the signing key as a trusted administrator';
  end if;
end $$;

do $$
begin
  raise notice 'signed audit authorization tests completed';
end $$;
