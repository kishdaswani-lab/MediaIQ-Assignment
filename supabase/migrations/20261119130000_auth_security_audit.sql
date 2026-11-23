-- Authentication and account-security audit events.
-- Business activity events are not written here. Later migrations can add event types.
--
-- Guaranteed by the application: successful login, signup when a session is created,
-- password change, MFA enrollment, MFA verification, and factor replacement fail closed
-- when the audit write does not succeed.
-- Best effort: failed login, rejected signup, logout, rate-limit denial, and session
-- rejection. Those actions still stop access when the audit write fails.
-- IP address and user agent are stored for security review. This migration does not
-- add a retention or deletion job.

create table private.audit_event_types (
  event_type text primary key,
  module text not null
);

insert into private.audit_event_types (event_type, module)
values
  ('auth.login.succeeded', 'auth'),
  ('auth.login.failed', 'auth'),
  ('auth.logout', 'auth'),
  ('auth.signup.requested', 'auth'),
  ('auth.signup.succeeded', 'auth'),
  ('auth.signup.rejected', 'auth'),
  ('auth.password_reset.requested', 'auth'),
  ('auth.password_reset.completed', 'auth'),
  ('auth.mfa.enroll.started', 'auth'),
  ('auth.mfa.enroll.verified', 'auth'),
  ('auth.mfa.challenge.failed', 'auth'),
  ('auth.mfa.challenge.verified', 'auth'),
  ('auth.mfa.factor.removed', 'auth'),
  ('auth.mfa.factor.replace_started', 'auth'),
  ('auth.rate_limited', 'auth'),
  ('auth.permission.denied', 'auth'),
  ('auth.session.rejected', 'auth'),
  ('auth.session.revoked', 'auth');

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor_user_id uuid,
  workspace_id uuid,
  business_id uuid,
  target_type text,
  target_id text,
  outcome text not null,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  constraint audit_events_event_type_fk
    foreign key (event_type) references private.audit_event_types (event_type),
  constraint audit_events_workspace_fk
    foreign key (workspace_id) references public.workspaces (id),
  constraint audit_events_business_fk
    foreign key (business_id) references public.businesses (id),
  constraint audit_events_outcome_check
    check (outcome in ('success', 'failure', 'denied')),
  constraint audit_events_target_type_check
    check (target_type is null or char_length(target_type) between 1 and 80),
  constraint audit_events_target_id_check
    check (target_id is null or char_length(target_id) between 1 and 200),
  constraint audit_events_user_agent_check
    check (user_agent is null or char_length(user_agent) <= 300),
  constraint audit_events_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4000)
);

create index audit_events_created_at_idx
  on public.audit_events (created_at desc);

create index audit_events_actor_created_idx
  on public.audit_events (actor_user_id, created_at desc);

create index audit_events_event_created_idx
  on public.audit_events (event_type, created_at desc);

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy audit_events_select_own
  on public.audit_events
  for select
  to authenticated
  using (actor_user_id = (select auth.uid()));

revoke all on table public.audit_events from public, anon, authenticated, service_role;
grant select on table public.audit_events to authenticated;

create or replace function private.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit events are immutable'
    using errcode = '42501';
end;
$$;

create trigger audit_events_immutable
  before update or delete on public.audit_events
  for each row
  execute function private.prevent_audit_mutation();

create table private.security_attempts (
  id bigint generated always as identity primary key,
  action text not null,
  subject_hash text not null,
  created_at timestamptz not null default pg_catalog.now()
);

create index security_attempts_lookup_idx
  on private.security_attempts (action, subject_hash, created_at desc);

revoke all on table private.security_attempts from public, anon, authenticated, service_role;
revoke all on table private.audit_event_types from public, anon, authenticated, service_role;

create or replace function public.record_security_event(
  p_event_type text,
  p_outcome text,
  p_ip text,
  p_user_agent text,
  p_metadata jsonb,
  p_target_type text default null,
  p_target_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  created_id uuid;
  stored_ip inet;
  forbidden_key text;
begin
  if p_event_type is null
    or not exists (
      select 1
      from private.audit_event_types
      where event_type = p_event_type
        and module = 'auth'
    ) then
    raise exception 'event type is not allowed'
      using errcode = '22023';
  end if;

  if p_outcome not in ('success', 'failure', 'denied') then
    raise exception 'outcome is not allowed'
      using errcode = '22023';
  end if;

  if actor is null then
    if p_event_type not in (
      'auth.login.failed',
      'auth.signup.requested',
      'auth.signup.rejected',
      'auth.password_reset.requested',
      'auth.rate_limited',
      'auth.session.rejected'
    ) then
      raise exception 'authentication required'
        using errcode = '42501';
    end if;

    if p_outcome = 'success'
      and p_event_type not in ('auth.signup.requested', 'auth.password_reset.requested') then
      raise exception 'authentication required'
        using errcode = '42501';
    end if;
  end if;

  if p_metadata is null then
    p_metadata := '{}'::jsonb;
  end if;

  if jsonb_typeof(p_metadata) <> 'object' or octet_length(p_metadata::text) > 2000 then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  select key
    into forbidden_key
  from jsonb_object_keys(p_metadata) as key
  where key ~* '(password|secret|token|totp|otp|qr|uri|code)'
  limit 1;

  if forbidden_key is not null then
    raise exception 'metadata is not allowed'
      using errcode = '22023';
  end if;

  begin
    stored_ip := nullif(pg_catalog.btrim(p_ip), '')::inet;
  exception
    when others then
      stored_ip := null;
  end;

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
    p_event_type,
    actor,
    nullif(pg_catalog.btrim(p_target_type), ''),
    nullif(pg_catalog.btrim(p_target_id), ''),
    p_outcome,
    stored_ip,
    left(nullif(pg_catalog.btrim(p_user_agent), ''), 300),
    p_metadata
  )
  returning id into created_id;

  return created_id;
end;
$$;

create or replace function public.consume_security_attempt(
  p_action text,
  p_subject text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  hashed_subject text;
  attempt_window interval;
  attempt_count integer;
  latest_attempt timestamptz;
  required_gap integer := 0;
  elapsed_seconds integer;
  attempt_max integer;
begin
  if p_action not in ('login', 'signup', 'recovery', 'mfa_verify', 'mfa_enroll', 'mfa_replace') then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', 900);
  end if;

  hashed_subject := encode(
    sha256(
      convert_to(
        p_action || ':' || coalesce(nullif(pg_catalog.btrim(p_subject), ''), 'unknown'),
        'utf8'
      )
    ),
    'hex'
  );

  if p_action in ('signup', 'recovery', 'mfa_enroll', 'mfa_replace') then
    attempt_window := interval '1 hour';
    attempt_max := case
      when p_action in ('recovery', 'mfa_replace') then 3
      else 5
    end;
  else
    attempt_window := interval '15 minutes';
    attempt_max := case when p_action = 'login' then 8 else 10 end;
  end if;

  select count(*)::integer, max(created_at)
    into attempt_count, latest_attempt
  from private.security_attempts
  where action = p_action
    and subject_hash = hashed_subject
    and created_at > pg_catalog.now() - attempt_window;

  if p_action = 'login' then
    if attempt_count >= 8 then
      required_gap := 900;
    elsif attempt_count >= 5 then
      required_gap := 30;
    end if;
  elsif p_action = 'mfa_verify' then
    if attempt_count >= 10 then
      required_gap := 900;
    elsif attempt_count >= 5 then
      required_gap := 60;
    elsif attempt_count >= 3 then
      required_gap := 15;
    end if;
  elsif attempt_count >= attempt_max then
    required_gap := 3600;
  end if;

  if required_gap > 0 and latest_attempt is not null then
    elapsed_seconds := floor(extract(epoch from (pg_catalog.now() - latest_attempt)))::integer;

    if elapsed_seconds < required_gap then
      return jsonb_build_object(
        'allowed', false,
        'retry_after_seconds', required_gap - elapsed_seconds
      );
    end if;
  end if;

  insert into private.security_attempts (action, subject_hash)
  values (p_action, hashed_subject);

  return jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
end;
$$;

revoke all on function public.record_security_event(text, text, text, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.consume_security_attempt(text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.record_security_event(text, text, text, text, jsonb, text, text)
  to anon, authenticated;
grant execute on function public.consume_security_attempt(text, text)
  to anon, authenticated;
