-- Signed trusted audit events.
-- The signing key is generated here with extensions.gen_random_bytes and is not
-- written into this file. PostgreSQL does not provide a formal constant-time
-- guarantee for the byte-comparison loop below.

grant usage, create on schema private to mediaiq_security_owner;
grant usage, create on schema public to mediaiq_security_owner;
grant mediaiq_security_owner to current_user with set true, inherit false;

create table private.audit_signing_key (
  key_id smallint primary key,
  secret bytea not null,
  status text not null,
  not_valid_after timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint audit_signing_key_secret_length check (octet_length(secret) = 32),
  constraint audit_signing_key_status check (status in ('active', 'retiring')),
  constraint audit_signing_key_window check (
    (status = 'active' and not_valid_after is null)
    or (status = 'retiring' and not_valid_after is not null)
  )
);

create unique index audit_signing_key_one_active
  on private.audit_signing_key (status)
  where status = 'active';

insert into private.audit_signing_key (key_id, secret, status)
values (1, extensions.gen_random_bytes(32), 'active');

alter table private.audit_signing_key enable row level security;
alter table private.audit_signing_key force row level security;

create policy audit_signing_key_owner_access
  on private.audit_signing_key
  for all
  to mediaiq_security_owner
  using (true)
  with check (true);

revoke all on table private.audit_signing_key from
  public,
  postgres,
  anon,
  authenticated,
  service_role,
  mediaiq_security_writer,
  mediaiq_security_maintainer,
  mediaiq_security_operator;

grant select, insert, update, delete on table private.audit_signing_key
  to mediaiq_security_owner;

alter table private.audit_signing_key owner to mediaiq_security_owner;

grant execute on function extensions.hmac(bytea, bytea, text) to mediaiq_security_owner;
grant execute on function extensions.hmac(text, text, text) to mediaiq_security_owner;

do $migration$
begin
  execute 'set local role mediaiq_security_owner';

  execute 'alter table public.audit_events add column auth_context jsonb';
  execute $function$
    alter table public.audit_events
      add constraint audit_events_auth_context_check
      check (
        auth_context is null
        or (
          jsonb_typeof(auth_context) = 'object'
          and octet_length(auth_context::text) <= 2000
        )
      )
  $function$;
  execute 'alter table private.audit_events_archive add column auth_context jsonb';

  execute $function$
    create or replace function private.json_string(p_value text)
    returns text
    language plpgsql
    immutable
    set search_path = ''
    as $body$
    declare
      normalized text := pg_catalog.normalize(p_value, 'NFC');
      encoded text := '"';
      index integer;
      current_character text;
      code integer;
    begin
      if normalized is null then
        raise exception 'metadata is not allowed'
          using errcode = '22023';
      end if;

      for index in 1..pg_catalog.char_length(normalized) loop
        current_character := pg_catalog.substr(normalized, index, 1);
        code := pg_catalog.ascii(current_character);

        if code = 34 then
          encoded := encoded || '\"';
        elsif code = 92 then
          encoded := encoded || '\\';
        elsif code < 32 then
          encoded := encoded || '\u00' || pg_catalog.lpad(pg_catalog.to_hex(code), 2, '0');
        else
          encoded := encoded || current_character;
        end if;
      end loop;

      return encoded || '"';
    end;
    $body$;
  $function$;

  execute $function$
    create or replace function private.canonical_json_object(p_value jsonb)
    returns text
    language plpgsql
    immutable
    set search_path = ''
    as $body$
    declare
      object_key text;
      object_value jsonb;
      encoded text := '{';
      first_key boolean := true;
    begin
      if p_value is null or jsonb_typeof(p_value) <> 'object' then
        raise exception 'metadata is not allowed'
          using errcode = '22023';
      end if;

      for object_key, object_value in
        select entry.key, entry.value
        from jsonb_each(p_value) as entry(key, value)
        order by entry.key collate "C"
      loop
        if object_key !~ '^[a-z0-9_]+$' then
          raise exception 'metadata is not allowed'
            using errcode = '22023';
        end if;

        if first_key then
          first_key := false;
        else
          encoded := encoded || ',';
        end if;

        encoded := encoded || '"' || object_key || '":';

        if jsonb_typeof(object_value) = 'string' then
          encoded := encoded || private.json_string(object_value #>> '{}');
        elsif jsonb_typeof(object_value) = 'boolean' then
          encoded := encoded || case when object_value = 'true'::jsonb then 'true' else 'false' end;
        else
          raise exception 'metadata is not allowed'
            using errcode = '22023';
        end if;
      end loop;

      return encoded || '}';
    end;
    $body$;
  $function$;

  execute $function$
    create or replace function private.audit_issued_micros(p_issued_at timestamptz)
    returns bigint
    language sql
    immutable
    set search_path = ''
    as $body$
      select
        pg_catalog.date_part(
          'epoch', pg_catalog.date_trunc('second', p_issued_at)
        )::bigint * 1000000
        + (pg_catalog.date_part('microseconds', p_issued_at)::bigint % 1000000);
    $body$;
  $function$;

  execute $function$
    create or replace function private.trusted_audit_payload(
      p_key_id smallint,
      p_event_id uuid,
      p_operation text,
      p_actor uuid,
      p_issued_at timestamptz,
      p_metadata jsonb,
      p_context jsonb
    )
    returns text
    language plpgsql
    immutable
    set search_path = ''
    as $body$
    begin
      if p_key_id is null
        or p_event_id is null
        or p_operation is null
        or p_actor is null
        or p_issued_at is null
        or p_metadata is null
        or p_context is null then
        raise exception 'audit payload is incomplete'
          using errcode = '22023';
      end if;

      return 'mediaiq-audit-v1'
        || E'\n' || p_key_id::text
        || E'\n' || pg_catalog.lower(p_event_id::text)
        || E'\n' || p_operation
        || E'\n' || pg_catalog.lower(p_actor::text)
        || E'\n' || private.audit_issued_micros(p_issued_at)::text
        || E'\n' || private.canonical_json_object(p_metadata)
        || E'\n' || private.canonical_json_object(p_context);
    end;
    $body$;
  $function$;

  execute $function$
    create or replace function private.audit_signatures_match(
      p_expected bytea,
      p_actual bytea
    )
    returns boolean
    language plpgsql
    immutable
    set search_path = ''
    as $body$
    declare
      index integer;
      difference integer := 0;
    begin
      -- This loop does not return early. It is not a formal constant-time
      -- comparison, and PostgreSQL does not guarantee constant-time execution.
      if p_expected is null
        or p_actual is null
        or octet_length(p_expected) <> 32
        or octet_length(p_actual) <> 32 then
        return false;
      end if;

      for index in 0..31 loop
        difference := difference
          | (pg_catalog.get_byte(p_expected, index) # pg_catalog.get_byte(p_actual, index));
      end loop;

      return difference = 0;
    end;
    $body$;
  $function$;

  execute $function$
    create or replace function private.guard_trusted_audit_insert()
    returns trigger
    language plpgsql
    set search_path = ''
    as $body$
    begin
      if current_user = 'mediaiq_security_owner'
        and pg_catalog.current_setting('mediaiq.audit_insert', true) = 'on' then
        return new;
      end if;

      raise exception 'direct audit inserts are blocked'
        using errcode = '42501';
    end;
    $body$;
  $function$;

  execute $function$
    create trigger audit_events_require_signed_insert
      before insert on public.audit_events
      for each row
      execute function private.guard_trusted_audit_insert();
  $function$;

  execute $function$
    create or replace function private.assert_auth_metadata(
      p_operation text,
      p_metadata jsonb
    )
    returns jsonb
    language plpgsql
    set search_path = ''
    as $body$
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
        when 'mfa_enroll_verified' then array['method','account_hashes']
        when 'mfa_verified' then array['method','purpose','account_hashes']
        when 'mfa_challenge_failed' then array['method','purpose']
        when 'mfa_factor_removed' then array['method','purpose','account_hashes']
        when 'mfa_factor_remove_failed' then array['method','purpose']
        when 'mfa_factor_replace_started' then array['method','account_hashes']
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

          if metadata_key = 'account_hashes' then
            if p_operation not in (
                'mfa_enroll_verified',
                'mfa_verified',
                'mfa_factor_removed',
                'mfa_factor_replace_started'
              )
              or metadata_value !~ '^[0-9a-f]{64}(,[0-9a-f]{64})?$' then
              raise exception 'metadata is not allowed'
                using errcode = '22023';
            end if;
          elsif char_length(metadata_value) > 80
            or metadata_value ~ '^[0-9]{6}$'
            or metadata_value ilike '%eyJ%'
            or metadata_value ilike '%otpauth://%'
            or metadata_value ilike '%bearer %' then
            raise exception 'metadata is not allowed'
              using errcode = '22023';
          end if;
        elsif jsonb_typeof(p_metadata -> metadata_key) <> 'boolean' then
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
    $body$;
  $function$;

  execute $function$
    create or replace function private.record_trusted_auth_event(
      p_event_id uuid,
      p_key_id smallint,
      p_operation text,
      p_actor uuid,
      p_issued_at timestamptz,
      p_metadata jsonb,
      p_context jsonb,
      p_signature text
    )
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    declare
      event_type text;
      event_outcome text;
      signing_key bytea;
      payload text;
      expected bytea;
      supplied bytea;
      reset_hash text;
      reset_list text;
    begin
      if p_actor is null or p_event_id is null or p_issued_at is null then
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

      if p_issued_at < pg_catalog.clock_timestamp() - interval '60 seconds'
        or p_issued_at > pg_catalog.clock_timestamp() + interval '5 seconds' then
        raise exception 'audit request has expired'
          using errcode = '22023';
      end if;

      p_metadata := private.assert_auth_metadata(p_operation, p_metadata);

      if p_context is null
        or jsonb_typeof(p_context) <> 'object'
        or (
          select count(*)
          from jsonb_object_keys(p_context)
        ) <> 3
        or not (
          p_context ? 'aal'
          and p_context ? 'method'
          and p_context ? 'session_id'
        )
        or (p_context ->> 'aal') not in ('aal1', 'aal2')
        or (p_context ->> 'method') not in ('password', 'totp', 'recovery', 'otp')
        or (p_context ->> 'session_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'authentication context is not valid'
          using errcode = '22023';
      end if;

      if p_signature is null or p_signature !~ '^[0-9a-f]{64}$' then
        raise exception 'signature is not valid'
          using errcode = '42501';
      end if;

      delete from private.audit_signing_key
      where status = 'retiring'
        and not_valid_after <= pg_catalog.clock_timestamp();

      select secret
        into signing_key
      from private.audit_signing_key
      where key_id = p_key_id
        and (
          status = 'active'
          or (
            status = 'retiring'
            and not_valid_after > pg_catalog.clock_timestamp()
          )
        );

      if signing_key is null then
        raise exception 'signature is not valid'
          using errcode = '42501';
      end if;

      payload := private.trusted_audit_payload(
        p_key_id,
        p_event_id,
        p_operation,
        p_actor,
        p_issued_at,
        p_metadata,
        p_context
      );
      expected := extensions.hmac(
        pg_catalog.convert_to(payload, 'UTF8'),
        signing_key,
        'sha256'
      );
      supplied := pg_catalog.decode(p_signature, 'hex');
      signing_key := null;

      if not private.audit_signatures_match(expected, supplied) then
        raise exception 'signature is not valid'
          using errcode = '42501';
      end if;

      perform pg_catalog.set_config('mediaiq.audit_insert', 'on', true);

      insert into public.audit_events (
        id,
        event_type,
        actor_user_id,
        target_type,
        target_id,
        outcome,
        ip_address,
        user_agent,
        metadata,
        auth_context
      )
      values (
        p_event_id,
        event_type,
        p_actor,
        null,
        null,
        event_outcome,
        null,
        null,
        p_metadata,
        p_context
      );

      perform pg_catalog.set_config('mediaiq.audit_insert', 'off', true);

      if p_operation in (
        'mfa_enroll_verified',
        'mfa_verified',
        'mfa_factor_removed',
        'mfa_factor_replace_started'
      ) and p_metadata ? 'account_hashes' then
        reset_list := p_metadata ->> 'account_hashes';

        foreach reset_hash in array pg_catalog.string_to_array(reset_list, ',') loop
          delete from private.security_counters
          where account_hash = reset_hash
            and dimension in ('account', 'client_account');
        end loop;
      end if;

      return p_event_id;
    end;
    $body$;
  $function$;

  execute $function$
    create or replace function private.rotate_audit_signing_key()
    returns smallint
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    declare
      new_id smallint;
      retiring_open integer;
    begin
      delete from private.audit_signing_key
      where status = 'retiring'
        and not_valid_after <= pg_catalog.clock_timestamp();

      select count(*)
        into retiring_open
      from private.audit_signing_key
      where status = 'retiring';

      if retiring_open > 0 then
        raise exception 'previous signing key is still inside its overlap'
          using errcode = '22023';
      end if;

      update private.audit_signing_key
      set status = 'retiring',
          not_valid_after = pg_catalog.clock_timestamp() + interval '120 seconds'
      where status = 'active';

      if not found then
        raise exception 'active signing key is missing'
          using errcode = '22023';
      end if;

      select coalesce(max(key_id), 0) + 1
        into new_id
      from private.audit_signing_key;

      insert into private.audit_signing_key (key_id, secret, status, not_valid_after)
      values (new_id, extensions.gen_random_bytes(32), 'active', null);

      return new_id;
    end;
    $body$;
  $function$;

  execute $function$
    create or replace function private.maintain_security_retention()
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $body$
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
        outcome, ip_address, user_agent, metadata, created_at, archived_at, auth_context
      )
      select
        id, event_type, actor_user_id, workspace_id, business_id, target_type, target_id,
        outcome, ip_address, user_agent, metadata, created_at, pg_catalog.now(), auth_context
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
    $body$;
  $function$;

  execute 'drop function private.record_trusted_auth_event(text, uuid, jsonb, text, text, text[], text)';

  execute 'revoke all on function private.json_string(text) from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.canonical_json_object(jsonb) from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.audit_issued_micros(timestamptz) from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.trusted_audit_payload(smallint, uuid, text, uuid, timestamptz, jsonb, jsonb) from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.audit_signatures_match(bytea, bytea) from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.guard_trusted_audit_insert() from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.record_trusted_auth_event(uuid, smallint, text, uuid, timestamptz, jsonb, jsonb, text) from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'revoke all on function private.rotate_audit_signing_key() from public, anon, authenticated, service_role, postgres, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator';
  execute 'grant execute on function private.json_string(text) to mediaiq_security_owner';
  execute 'grant execute on function private.canonical_json_object(jsonb) to mediaiq_security_owner';
  execute 'grant execute on function private.audit_issued_micros(timestamptz) to mediaiq_security_owner';
  execute 'grant execute on function private.trusted_audit_payload(smallint, uuid, text, uuid, timestamptz, jsonb, jsonb) to mediaiq_security_owner';
  execute 'grant execute on function private.audit_signatures_match(bytea, bytea) to mediaiq_security_owner';
  execute 'grant execute on function private.guard_trusted_audit_insert() to mediaiq_security_owner';
  execute 'grant execute on function private.record_trusted_auth_event(uuid, smallint, text, uuid, timestamptz, jsonb, jsonb, text) to mediaiq_security_owner, mediaiq_security_writer';
  execute 'grant execute on function private.rotate_audit_signing_key() to mediaiq_security_owner, mediaiq_security_maintainer';
  execute 'grant execute on function private.assert_auth_metadata(text, jsonb) to mediaiq_security_owner';
  execute 'grant execute on function private.maintain_security_retention() to mediaiq_security_owner, mediaiq_security_maintainer';
end
$migration$;

select pg_catalog.set_config('role', 'none', false);

revoke create on schema private from mediaiq_security_owner;
revoke create on schema public from mediaiq_security_owner;
revoke mediaiq_security_owner from current_user;
