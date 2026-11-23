-- Allow an email-confirmation session to record trusted audit context.
-- email/signup remains an AAL1 context method. It does not satisfy TOTP or AAL2.
-- Metadata method names are unchanged.

grant usage, create on schema private to mediaiq_security_owner;
grant mediaiq_security_owner to current_user with set true, inherit false;

do $migration$
begin
  execute 'set local role mediaiq_security_owner';

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
        or (p_context ->> 'method') not in (
          'password', 'totp', 'recovery', 'otp', 'email/signup'
        )
        or (
          (p_context ->> 'method') = 'email/signup'
          and (p_context ->> 'aal') <> 'aal1'
        )
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
end
$migration$;

select pg_catalog.set_config('role', 'none', false);

revoke create on schema private from mediaiq_security_owner;
revoke mediaiq_security_owner from current_user;
