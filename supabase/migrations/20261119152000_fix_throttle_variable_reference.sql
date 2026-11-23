-- Rename the throttle variable that collided with private.security_counters.account_hash.

grant usage, create on schema private to mediaiq_security_owner;
grant mediaiq_security_owner to current_user with set true, inherit false;

do $migration$
begin
  execute 'set local role mediaiq_security_owner';
  execute $function$
create or replace function private.consume_auth_throttle(
  p_action text,
  p_client_identity text,
  p_account_hashes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
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
  subject_hash text;
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

  foreach subject_hash in array hashes loop
    if subject_hash is null or subject_hash !~ '^[0-9a-f]{64}$' then
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

  foreach subject_hash in array hashes loop
    select * into counter
    from private.security_counters
    where action = p_action
      and dimension = 'account'
      and identity_hash = subject_hash
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

  foreach subject_hash in array hashes loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_action || ':account:' || subject_hash)
    );

    select * into counter
    from private.security_counters
    where action = p_action and dimension = 'account' and identity_hash = subject_hash
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
        p_action, 'account', subject_hash, subject_hash,
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
          account_hash = subject_hash
      where action = p_action and dimension = 'account' and identity_hash = subject_hash;
    end if;

    pair_hash := encode(
      extensions.digest(client_identity || ':' || subject_hash, 'sha256'),
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
        p_action, 'client_account', pair_hash, subject_hash,
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
          account_hash = subject_hash
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
$body$;
  $function$;
end
$migration$;

select pg_catalog.set_config('role', 'none', false);

revoke create on schema private from mediaiq_security_owner;
revoke mediaiq_security_owner from current_user;
