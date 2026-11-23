-- The telemetry writer named a variable event_type, which PostgreSQL could not
-- distinguish from private.auth_telemetry.event_type. Replace the function body
-- while acting as its owner.

grant usage, create on schema private to mediaiq_security_owner;
grant mediaiq_security_owner to current_user with set true, inherit false;

do $migration$
begin
  execute 'set local role mediaiq_security_owner';
  execute $function$
    create or replace function private.record_auth_telemetry(
      p_operation text,
      p_metadata jsonb,
      p_user_agent text default null
    )
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    declare
      created_id uuid;
      chosen_event_type text;
      chosen_outcome text;
      recent_events integer;
    begin
      chosen_event_type := case p_operation
        when 'login_failed' then 'auth.login.failed'
        when 'signup_rejected' then 'auth.signup.rejected'
        when 'signup_requested' then 'auth.signup.requested'
        when 'password_recovery_requested' then 'auth.password_reset.requested'
        when 'rate_limited' then 'auth.rate_limited'
        when 'invalid_session' then 'auth.session.rejected'
        else null
      end;

      chosen_outcome := case p_operation
        when 'signup_requested' then 'success'
        when 'password_recovery_requested' then 'success'
        when 'rate_limited' then 'denied'
        else 'failure'
      end;

      if chosen_event_type is null then
        raise exception 'operation is not allowed'
          using errcode = '22023';
      end if;

      p_metadata := private.assert_auth_metadata(p_operation, p_metadata);

      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('telemetry:' || p_operation));

      select count(*)::integer
        into recent_events
      from private.auth_telemetry telemetry
      where telemetry.event_type = chosen_event_type
        and telemetry.created_at > pg_catalog.now() - interval '15 minutes';

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
        chosen_event_type,
        chosen_outcome,
        p_metadata,
        left(nullif(pg_catalog.btrim(p_user_agent), ''), 300)
      )
      returning id into created_id;

      return created_id;
    end;
    $body$;
  $function$;
end
$migration$;

select pg_catalog.set_config('role', 'none', false);

revoke create on schema private from mediaiq_security_owner;
revoke mediaiq_security_owner from current_user;
