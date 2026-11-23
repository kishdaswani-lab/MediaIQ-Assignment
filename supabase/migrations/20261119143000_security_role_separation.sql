-- Phase 1 database security foundation.
-- Hosting does not expose a trustworthy client peer to Next.js Proxy.
-- Client-supplied forwarded headers are not a rate-limit or audit identity.
-- The shared client identity is "local" until a hosting-specific source exists.
-- Passwords for the login roles are generated here and are not written in this file.

create role mediaiq_security_owner
  nologin
  noinherit
  nobypassrls
  nocreaterole
  nocreatedb;

create role mediaiq_security_maintainer
  nologin
  noinherit
  nobypassrls
  nocreaterole
  nocreatedb;

create role mediaiq_security_operator
  login
  noinherit
  nobypassrls
  nocreaterole
  nocreatedb
  connection limit 2;

create role mediaiq_security_writer
  login
  noinherit
  nobypassrls
  nocreaterole
  nocreatedb
  connection limit 8;

alter role mediaiq_security_writer set statement_timeout = '5s';
alter role mediaiq_security_writer set idle_in_transaction_session_timeout = '10s';
alter role mediaiq_security_owner set search_path = '';

grant mediaiq_security_maintainer to mediaiq_security_operator;

create table private.security_secrets (
  name text primary key,
  value text not null
);

alter table private.security_secrets enable row level security;
alter table private.security_secrets force row level security;
revoke all on table private.security_secrets from public, anon, authenticated, service_role;

do $$
declare
  writer_password text := encode(extensions.gen_random_bytes(24), 'hex');
  operator_password text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  execute format(
    'alter role mediaiq_security_writer password %L',
    writer_password
  );
  execute format(
    'alter role mediaiq_security_operator password %L',
    operator_password
  );
  insert into private.security_secrets (name, value)
  values
    ('writer_password', writer_password),
    ('operator_password', operator_password);
end $$;

grant mediaiq_security_owner to current_user;
grant usage, create on schema private, public, extensions to mediaiq_security_owner;

alter table private.security_secrets owner to mediaiq_security_owner;

insert into private.audit_event_types (event_type, module)
values
  ('auth.mfa.enroll.failed', 'auth'),
  ('auth.password_change.failed', 'auth')
on conflict (event_type) do nothing;

create table private.auth_telemetry (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  outcome text not null,
  metadata jsonb not null default '{}'::jsonb,
  user_agent text,
  created_at timestamptz not null default pg_catalog.now(),
  constraint auth_telemetry_event_type_fk
    foreign key (event_type) references private.audit_event_types (event_type),
  constraint auth_telemetry_outcome_check
    check (outcome in ('success', 'failure', 'denied')),
  constraint auth_telemetry_no_actor_check
    check (true),
  constraint auth_telemetry_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 2000),
  constraint auth_telemetry_user_agent_check
    check (user_agent is null or char_length(user_agent) <= 300)
);

create table private.audit_events_archive (
  id uuid primary key,
  event_type text not null,
  actor_user_id uuid,
  workspace_id uuid,
  business_id uuid,
  target_type text,
  target_id text,
  outcome text not null,
  ip_address inet,
  user_agent text,
  metadata jsonb not null,
  created_at timestamptz not null,
  archived_at timestamptz not null default pg_catalog.now(),
  constraint audit_events_archive_outcome_check
    check (outcome in ('success', 'failure', 'denied')),
  constraint audit_events_archive_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4000)
);

create table private.security_counters (
  action text not null,
  dimension text not null,
  identity_hash text not null,
  account_hash text,
  window_started timestamptz not null default pg_catalog.now(),
  last_attempt timestamptz not null default pg_catalog.now(),
  attempt_count integer not null,
  delay_seconds integer not null default 0,
  primary key (action, dimension, identity_hash),
  constraint security_counters_dimension_check
    check (dimension in ('client', 'account', 'client_account', 'global')),
  constraint security_counters_action_check
    check (action in (
      'login', 'signup', 'recovery', 'mfa_verify', 'mfa_enroll', 'mfa_replace', 'password_update'
    ))
);

alter table private.auth_telemetry enable row level security;
alter table private.auth_telemetry force row level security;
alter table private.audit_events_archive enable row level security;
alter table private.audit_events_archive force row level security;
alter table private.security_counters enable row level security;
alter table private.security_counters force row level security;

revoke all on table private.auth_telemetry from public, anon, authenticated, service_role;
revoke all on table private.audit_events_archive from public, anon, authenticated, service_role;
revoke all on table private.security_counters from public, anon, authenticated, service_role;

create policy auth_telemetry_owner_select
  on private.auth_telemetry
  for select
  to mediaiq_security_owner
  using (true);

create policy auth_telemetry_owner_insert
  on private.auth_telemetry
  for insert
  to mediaiq_security_owner
  with check (true);

create policy auth_telemetry_owner_delete
  on private.auth_telemetry
  for delete
  to mediaiq_security_owner
  using (true);

create policy audit_events_archive_owner_select
  on private.audit_events_archive
  for select
  to mediaiq_security_owner
  using (true);

create policy audit_events_archive_owner_insert
  on private.audit_events_archive
  for insert
  to mediaiq_security_owner
  with check (true);

create policy audit_events_archive_owner_delete
  on private.audit_events_archive
  for delete
  to mediaiq_security_owner
  using (true);

create policy security_counters_owner_select
  on private.security_counters
  for select
  to mediaiq_security_owner
  using (true);

create policy security_counters_owner_insert
  on private.security_counters
  for insert
  to mediaiq_security_owner
  with check (true);

create policy security_counters_owner_update
  on private.security_counters
  for update
  to mediaiq_security_owner
  using (true)
  with check (true);

create policy security_counters_owner_delete
  on private.security_counters
  for delete
  to mediaiq_security_owner
  using (true);

create policy audit_events_owner_select
  on public.audit_events
  for select
  to mediaiq_security_owner
  using (true);

create policy audit_events_owner_insert
  on public.audit_events
  for insert
  to mediaiq_security_owner
  with check (true);

create policy audit_events_owner_delete
  on public.audit_events
  for delete
  to mediaiq_security_owner
  using (true);

create or replace function private.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user = 'mediaiq_security_owner'
    and pg_catalog.current_setting('mediaiq.audit_maintenance', true) = 'on' then
    return old;
  end if;

  raise exception 'audit events are immutable'
    using errcode = '42501';
end;
$$;

create trigger auth_telemetry_immutable
  before update or delete on private.auth_telemetry
  for each row
  execute function private.prevent_audit_mutation();

create trigger audit_events_archive_immutable
  before update or delete on private.audit_events_archive
  for each row
  execute function private.prevent_audit_mutation();

create or replace function private.assert_auth_metadata(
  p_operation text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  metadata_key text;
  metadata_value text;
  allowed text[];
begin
  if p_metadata is null then
    p_metadata := '{}'::jsonb;
  end if;

  if jsonb_typeof(p_metadata) <> 'object' or octet_length(p_metadata::text) > 2000 then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  allowed := case p_operation
    when 'login_succeeded' then array['method']
    when 'login_failed' then array['method']
    when 'logout' then array['scope']
    when 'signup_succeeded' then array['method','confirmation']
    when 'signup_rejected' then array['method']
    when 'signup_requested' then array['method','confirmation']
    when 'password_recovery_requested' then array['method']
    when 'password_changed' then array['method','mfa_bypassed']
    when 'password_change_failed' then array['method']
    when 'mfa_enroll_started' then array['method']
    when 'mfa_enroll_failed' then array['method']
    when 'mfa_enroll_verified' then array['method']
    when 'mfa_verified' then array['method','purpose']
    when 'mfa_challenge_failed' then array['method','purpose']
    when 'mfa_factor_removed' then array['method','purpose']
    when 'mfa_factor_remove_failed' then array['method','purpose']
    when 'mfa_factor_replace_started' then array['method']
    when 'session_revoked' then array['scope','reason']
    when 'authorization_denied' then array['action']
    when 'rate_limited' then array['action']
    when 'invalid_session' then array['reason']
    else null
  end;

  if allowed is null then
    raise exception 'operation is not allowed'
      using errcode = '22023';
  end if;

  for metadata_key in
    select jsonb_object_keys(p_metadata)
  loop
    if metadata_key !~ '(password|secret|token|totp|otp|qr|uri|code)'
      and not (metadata_key = any (allowed)) then
      raise exception 'metadata is not allowed'
        using errcode = '22023';
    end if;

    if metadata_key ~* '(password|secret|token|totp|otp|qr|uri|code)' then
      raise exception 'metadata is not allowed'
        using errcode = '22023';
    end if;

    if jsonb_typeof(p_metadata -> metadata_key) = 'string' then
      metadata_value := p_metadata ->> metadata_key;
      if char_length(metadata_value) > 80
        or metadata_value ~ '^[0-9]{6}$'
        or metadata_value ilike '%eyJ%'
        or metadata_value ilike '%otpauth://%'
        or metadata_value ilike '%bearer %' then
        raise exception 'metadata is not allowed'
          using errcode = '22023';
      end if;
    elsif jsonb_typeof(p_metadata -> metadata_key) <> 'boolean'
      and jsonb_typeof(p_metadata -> metadata_key) <> 'number' then
      raise exception 'metadata is not allowed'
        using errcode = '22023';
    end if;
  end loop;

  if p_metadata ? 'method'
    and (p_metadata ->> 'method') not in ('password', 'totp', 'email', 'recovery') then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  if p_metadata ? 'purpose'
    and (p_metadata ->> 'purpose') not in ('enrollment', 'login', 'replace', 'remove') then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  if p_metadata ? 'scope'
    and (p_metadata ->> 'scope') not in ('global', 'local', 'others') then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  if p_metadata ? 'confirmation'
    and (p_metadata ->> 'confirmation') not in ('required', 'disabled') then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  if p_metadata ? 'action'
    and (p_metadata ->> 'action') not in (
      'login', 'signup', 'recovery', 'mfa_verify', 'mfa_enroll', 'mfa_replace',
      'password_update', 'remove_last_mfa_factor'
    ) then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  if p_metadata ? 'reason'
    and (p_metadata ->> 'reason') not in ('password_reset', 'invalid_session') then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  if p_metadata ? 'mfa_bypassed' and (p_metadata -> 'mfa_bypassed') <> 'false'::jsonb then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  return p_metadata;
end;
$$;

create or replace function private.record_trusted_auth_event(
  p_operation text,
  p_actor uuid,
  p_metadata jsonb,
  p_target_type text default null,
  p_target_id text default null,
  p_reset_account_hashes text[] default null,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_id uuid;
  event_type text;
  event_outcome text;
  reset_hash text;
begin
  if p_actor is null then
    raise exception 'verified actor is required'
      using errcode = '42501';
  end if;

  event_type := case p_operation
    when 'login_succeeded' then 'auth.login.succeeded'
    when 'logout' then 'auth.logout'
    when 'signup_succeeded' then 'auth.signup.succeeded'
    when 'password_changed' then 'auth.password_reset.completed'
    when 'password_change_failed' then 'auth.password_change.failed'
    when 'mfa_enroll_started' then 'auth.mfa.enroll.started'
    when 'mfa_enroll_failed' then 'auth.mfa.enroll.failed'
    when 'mfa_enroll_verified' then 'auth.mfa.enroll.verified'
    when 'mfa_verified' then 'auth.mfa.challenge.verified'
    when 'mfa_challenge_failed' then 'auth.mfa.challenge.failed'
    when 'mfa_factor_removed' then 'auth.mfa.factor.removed'
    when 'mfa_factor_remove_failed' then 'auth.mfa.factor.removed'
    when 'mfa_factor_replace_started' then 'auth.mfa.factor.replace_started'
    when 'session_revoked' then 'auth.session.revoked'
    when 'authorization_denied' then 'auth.permission.denied'
    else null
  end;

  event_outcome := case p_operation
    when 'password_change_failed' then 'failure'
    when 'mfa_enroll_failed' then 'failure'
    when 'mfa_challenge_failed' then 'failure'
    when 'mfa_factor_remove_failed' then 'failure'
    when 'authorization_denied' then 'denied'
    else 'success'
  end;

  if event_type is null then
    raise exception 'operation is not allowed'
      using errcode = '22023';
  end if;

  p_metadata := private.assert_auth_metadata(p_operation, p_metadata);

  insert into public.audit_events (
    event_type,
    actor_user_id,
    target_type,
    target_id,
    outcome,
    ip_address,
    user_agent,
    metadata
  )
  values (
    event_type,
    p_actor,
    nullif(pg_catalog.btrim(p_target_type), ''),
    nullif(pg_catalog.btrim(p_target_id), ''),
    event_outcome,
    null,
    left(nullif(pg_catalog.btrim(p_user_agent), ''), 300),
    p_metadata
  )
  returning id into created_id;

  if p_operation in (
    'mfa_enroll_verified',
    'mfa_verified',
    'mfa_factor_removed',
    'mfa_factor_replace_started'
  ) and p_reset_account_hashes is not null then
    foreach reset_hash in array p_reset_account_hashes loop
      delete from private.security_counters
      where account_hash = reset_hash
        and dimension in ('account', 'client_account');
    end loop;
  end if;

  return created_id;
end;
$$;

create or replace function private.record_auth_telemetry(
  p_operation text,
  p_metadata jsonb,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_id uuid;
  event_type text;
  event_outcome text;
  recent_events integer;
begin
  event_type := case p_operation
    when 'login_failed' then 'auth.login.failed'
    when 'signup_rejected' then 'auth.signup.rejected'
    when 'signup_requested' then 'auth.signup.requested'
    when 'password_recovery_requested' then 'auth.password_reset.requested'
    when 'rate_limited' then 'auth.rate_limited'
    when 'invalid_session' then 'auth.session.rejected'
    else null
  end;

  event_outcome := case p_operation
    when 'signup_requested' then 'success'
    when 'password_recovery_requested' then 'success'
    when 'rate_limited' then 'denied'
    else 'failure'
  end;

  if event_type is null then
    raise exception 'operation is not allowed'
      using errcode = '22023';
  end if;

  p_metadata := private.assert_auth_metadata(p_operation, p_metadata);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('telemetry:' || p_operation));

  select count(*)::integer
    into recent_events
  from private.auth_telemetry
  where private.auth_telemetry.event_type = event_type
    and created_at > pg_catalog.now() - interval '15 minutes';

  if recent_events >= 300 then
    raise exception 'too many telemetry events'
      using errcode = '54000';
  end if;

  insert into private.auth_telemetry (
    event_type,
    outcome,
    metadata,
    user_agent
  )
  values (
    event_type,
    event_outcome,
    p_metadata,
    left(nullif(pg_catalog.btrim(p_user_agent), ''), 300)
  )
  returning id into created_id;

  return created_id;
end;
$$;

create or replace function private.consume_auth_throttle(
  p_action text,
  p_client_identity text,
  p_account_hashes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  client_identity text := coalesce(nullif(pg_catalog.btrim(p_client_identity), ''), 'local');
  trusted_client boolean;
  suspicious boolean := false;
  account_delayed boolean := false;
  retry_after integer := 0;
  allowed boolean := true;
  counter private.security_counters%rowtype;
  elapsed integer;
  next_count integer;
  next_delay integer;
  account_hash text;
  pair_hash text;
  hashes text[] := coalesce(p_account_hashes, array[]::text[]);
begin
  if p_action not in (
    'login', 'signup', 'recovery', 'mfa_verify', 'mfa_enroll', 'mfa_replace', 'password_update'
  ) then
    return jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', 60,
      'suspicious', false,
      'account_delayed', false
    );
  end if;

  if client_identity <> 'local' and client_identity !~ '^[0-9a-fA-F:.]+$' then
    client_identity := 'local';
  end if;

  trusted_client := client_identity <> 'local';

  foreach account_hash in array hashes loop
    if account_hash is null or account_hash !~ '^[0-9a-f]{64}$' then
      return jsonb_build_object(
        'allowed', false,
        'retry_after_seconds', 60,
        'suspicious', false,
        'account_delayed', false
      );
    end if;
  end loop;

  delete from private.security_counters
  where window_started < pg_catalog.now() - interval '1 hour';

  foreach account_hash in array hashes loop
    select * into counter
    from private.security_counters
    where action = p_action
      and dimension = 'account'
      and identity_hash = account_hash
    for update;

    if found
      and counter.window_started >= pg_catalog.now() - interval '15 minutes'
      and counter.delay_seconds > 0 then
      elapsed := floor(extract(epoch from (pg_catalog.now() - counter.last_attempt)))::integer;
      if elapsed < counter.delay_seconds then
        account_delayed := true;
        allowed := false;
        retry_after := greatest(retry_after, counter.delay_seconds - elapsed);
      end if;
    end if;
  end loop;

  if account_delayed then
    return jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', retry_after,
      'suspicious', suspicious,
      'account_delayed', true
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_action || ':global'));

  select * into counter
  from private.security_counters
  where action = p_action and dimension = 'global' and identity_hash = 'global'
  for update;

  if not found then
    insert into private.security_counters (
      action, dimension, identity_hash, account_hash, window_started, last_attempt, attempt_count, delay_seconds
    )
    values (p_action, 'global', 'global', null, pg_catalog.now(), pg_catalog.now(), 1, 0);
    next_count := 1;
  else
    if counter.window_started < pg_catalog.now() - interval '5 minutes' then
      next_count := 1;
    else
      next_count := counter.attempt_count + 1;
    end if;

    update private.security_counters
    set attempt_count = next_count,
        window_started = case
          when counter.window_started < pg_catalog.now() - interval '5 minutes' then pg_catalog.now()
          else window_started
        end,
        last_attempt = pg_catalog.now()
    where action = p_action and dimension = 'global' and identity_hash = 'global';
  end if;

  if next_count >= 100 then
    suspicious := true;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_action || ':client:' || client_identity)
  );

  select * into counter
  from private.security_counters
  where action = p_action and dimension = 'client' and identity_hash = client_identity
  for update;

  if not found then
    insert into private.security_counters (
      action, dimension, identity_hash, account_hash, window_started, last_attempt, attempt_count, delay_seconds
    )
    values (p_action, 'client', client_identity, null, pg_catalog.now(), pg_catalog.now(), 1, 0);
    next_count := 1;
  else
    if counter.window_started < pg_catalog.now() - interval '15 minutes' then
      next_count := 1;
    else
      next_count := counter.attempt_count + 1;
    end if;

    update private.security_counters
    set attempt_count = next_count,
        window_started = case
          when counter.window_started < pg_catalog.now() - interval '15 minutes' then pg_catalog.now()
          else window_started
        end,
        last_attempt = pg_catalog.now()
    where action = p_action and dimension = 'client' and identity_hash = client_identity;
  end if;

  if not trusted_client and next_count >= 100 then
    suspicious := true;
  elsif trusted_client and next_count >= 30 then
    allowed := false;
    retry_after := greatest(retry_after, 900);
  end if;

  foreach account_hash in array hashes loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_action || ':account:' || account_hash)
    );

    select * into counter
    from private.security_counters
    where action = p_action and dimension = 'account' and identity_hash = account_hash
    for update;

    if not found or counter.window_started < pg_catalog.now() - interval '15 minutes' then
      next_count := 1;
      next_delay := 0;
    else
      next_count := counter.attempt_count + 1;
      next_delay := least(60, power(2, least(greatest(next_count - 2, 0), 6))::integer);
    end if;

    if not found then
      insert into private.security_counters (
        action, dimension, identity_hash, account_hash, window_started, last_attempt, attempt_count, delay_seconds
      )
      values (
        p_action, 'account', account_hash, account_hash,
        pg_catalog.now(), pg_catalog.now(), next_count, next_delay
      );
    else
      update private.security_counters
      set attempt_count = next_count,
          delay_seconds = next_delay,
          window_started = case
            when counter.window_started < pg_catalog.now() - interval '15 minutes' then pg_catalog.now()
            else window_started
          end,
          last_attempt = pg_catalog.now(),
          account_hash = account_hash
      where action = p_action and dimension = 'account' and identity_hash = account_hash;
    end if;

    pair_hash := encode(
      extensions.digest(client_identity || ':' || account_hash, 'sha256'),
      'hex'
    );

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_action || ':pair:' || pair_hash)
    );

    select * into counter
    from private.security_counters
    where action = p_action and dimension = 'client_account' and identity_hash = pair_hash
    for update;

    if not found or counter.window_started < pg_catalog.now() - interval '15 minutes' then
      next_count := 1;
    else
      next_count := counter.attempt_count + 1;
    end if;

    if not found then
      insert into private.security_counters (
        action, dimension, identity_hash, account_hash, window_started, last_attempt, attempt_count, delay_seconds
      )
      values (
        p_action, 'client_account', pair_hash, account_hash,
        pg_catalog.now(), pg_catalog.now(), next_count, 0
      );
    else
      update private.security_counters
      set attempt_count = next_count,
          window_started = case
            when counter.window_started < pg_catalog.now() - interval '15 minutes' then pg_catalog.now()
            else window_started
          end,
          last_attempt = pg_catalog.now(),
          account_hash = account_hash
      where action = p_action and dimension = 'client_account' and identity_hash = pair_hash;
    end if;

    if trusted_client and next_count >= 10 then
      allowed := false;
      retry_after := greatest(retry_after, 900);
    end if;
  end loop;

  return jsonb_build_object(
    'allowed', allowed,
    'retry_after_seconds', retry_after,
    'suspicious', suspicious,
    'account_delayed', account_delayed
  );
end;
$$;

create or replace function private.maintain_security_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved_count integer := 0;
  expired_archive integer := 0;
  expired_telemetry integer := 0;
begin
  perform set_config('mediaiq.audit_maintenance', 'on', true);

  with doomed as (
    select id
    from public.audit_events
    where created_at < pg_catalog.now() - interval '90 days'
    order by created_at
    limit 1000
  ),
  removed as (
    delete from public.audit_events event
    using doomed
    where event.id = doomed.id
    returning event.*
  )
  insert into private.audit_events_archive (
    id, event_type, actor_user_id, workspace_id, business_id, target_type, target_id,
    outcome, ip_address, user_agent, metadata, created_at, archived_at
  )
  select
    id, event_type, actor_user_id, workspace_id, business_id, target_type, target_id,
    outcome, ip_address, user_agent, metadata, created_at, pg_catalog.now()
  from removed;

  get diagnostics moved_count = row_count;

  delete from private.audit_events_archive
  where id in (
    select id
    from private.audit_events_archive
    where created_at < pg_catalog.now() - interval '24 months'
    order by created_at
    limit 1000
  );

  get diagnostics expired_archive = row_count;

  delete from private.auth_telemetry
  where id in (
    select id
    from private.auth_telemetry
    where created_at < pg_catalog.now() - interval '30 days'
    order by created_at
    limit 1000
  );

  get diagnostics expired_telemetry = row_count;

  return jsonb_build_object(
    'moved_to_archive', moved_count,
    'expired_archive', expired_archive,
    'expired_telemetry', expired_telemetry
  );
end;
$$;

drop function if exists public.record_security_event(text, text, text, text, jsonb, text, text);
drop function if exists public.consume_security_attempt(text, text);
drop table if exists private.security_attempts;

alter table private.auth_telemetry owner to mediaiq_security_owner;
alter table private.audit_events_archive owner to mediaiq_security_owner;
alter table private.security_counters owner to mediaiq_security_owner;

alter function private.prevent_audit_mutation() owner to mediaiq_security_owner;
alter function private.assert_auth_metadata(text, jsonb) owner to mediaiq_security_owner;
alter function private.record_trusted_auth_event(text, uuid, jsonb, text, text, text[], text) owner to mediaiq_security_owner;
alter function private.record_auth_telemetry(text, jsonb, text) owner to mediaiq_security_owner;
alter function private.consume_auth_throttle(text, text, text[]) owner to mediaiq_security_owner;
alter function private.maintain_security_retention() owner to mediaiq_security_owner;

revoke all on function private.prevent_audit_mutation() from public, anon, authenticated, service_role;
revoke all on function private.assert_auth_metadata(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.record_trusted_auth_event(text, uuid, jsonb, text, text, text[], text)
  from public, anon, authenticated, service_role;
revoke all on function private.record_auth_telemetry(text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.consume_auth_throttle(text, text, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.maintain_security_retention()
  from public, anon, authenticated, service_role;

grant usage on schema private to mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer;
grant connect on database postgres to mediaiq_security_writer, mediaiq_security_operator;

grant execute on function private.record_trusted_auth_event(text, uuid, jsonb, text, text, text[], text)
  to mediaiq_security_writer;
grant execute on function private.record_auth_telemetry(text, jsonb, text)
  to mediaiq_security_writer;
grant execute on function private.consume_auth_throttle(text, text, text[])
  to mediaiq_security_writer;
grant execute on function private.maintain_security_retention()
  to mediaiq_security_maintainer;

alter table public.audit_events owner to mediaiq_security_owner;
alter table private.audit_event_types owner to mediaiq_security_owner;

grant usage on schema public to mediaiq_security_owner;
grant usage on schema extensions to mediaiq_security_owner;
grant execute on function extensions.digest(text, text) to mediaiq_security_owner;
grant execute on function extensions.gen_random_bytes(integer) to mediaiq_security_owner;

revoke all on table public.workspaces
  from mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table public.workspace_members
  from mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table public.businesses
  from mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table public.business_members
  from mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table public.industry_taxonomy
  from mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

revoke all on table public.audit_events
  from mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.auth_telemetry
  from mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.audit_events_archive
  from mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.security_counters
  from mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.security_secrets
  from mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.audit_event_types
  from mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

revoke create on schema public, extensions, private from mediaiq_security_owner;
revoke mediaiq_security_owner from current_user;
