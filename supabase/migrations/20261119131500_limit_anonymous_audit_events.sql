-- Cap anonymous audit writes so the public record function cannot be used to fill the table.
-- Authenticated events are not counted here. Successful authenticated events remain fail-closed
-- in the application if this insert is rejected.

create or replace function private.limit_anonymous_audit_events()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  recent_events integer;
begin
  if new.actor_user_id is not null then
    return new;
  end if;

  select count(*)::integer
    into recent_events
  from public.audit_events
  where actor_user_id is null
    and ip_address is not distinct from new.ip_address
    and created_at > pg_catalog.now() - interval '15 minutes';

  if recent_events >= 30 then
    raise exception 'too many audit events'
      using errcode = '54000';
  end if;

  return new;
end;
$$;

create trigger audit_events_limit_anonymous
  before insert on public.audit_events
  for each row
  execute function private.limit_anonymous_audit_events();

revoke all on function private.limit_anonymous_audit_events()
  from public, anon, authenticated, service_role;
