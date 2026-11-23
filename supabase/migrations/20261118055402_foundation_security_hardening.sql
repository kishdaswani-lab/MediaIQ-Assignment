-- Upgrade an already-applied foundation database to the approved hardening.
-- Tables, policies, indexes, and the existing triggers are left in place.

create or replace function private.prevent_self_membership_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  creator_insert boolean := false;
begin
  if current_user_id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' and new.user_id = current_user_id then
    -- Depth 1 is a direct insert. The initial Active Admin rows are inserted
    -- by the workspace and business creation triggers, which nest this trigger.
    if pg_catalog.pg_trigger_depth() > 1
      and new.role = 'Admin'
      and new.status = 'Active' then
      if tg_table_name = 'workspace_members' then
        creator_insert := exists (
          select 1
          from public.workspaces as workspace
          where workspace.id = new.workspace_id
            and workspace.owner_user_id = current_user_id
        );
      elsif tg_table_name = 'business_members' then
        creator_insert := exists (
          select 1
          from public.businesses as business
          join public.workspace_members as workspace_member
            on workspace_member.workspace_id = business.workspace_id
          where business.id = new.business_id
            and workspace_member.user_id = current_user_id
            and workspace_member.role = 'Admin'
            and workspace_member.status = 'Active'
        );
      end if;
    end if;

    if creator_insert then
      return new;
    end if;

    raise exception 'users cannot grant their own membership'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and (old.user_id = current_user_id or new.user_id = current_user_id) then
    raise exception 'users cannot change their own membership'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' and old.user_id = current_user_id then
    raise exception 'users cannot remove their own membership'
      using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

drop function private.statement_runs_as_trusted_creator(text, integer);

create or replace function private.grant_workspace_owner_membership()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.owner_user_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role, status)
    values (new.id, new.owner_user_id, 'Admin', 'Active');
  end if;

  return new;
end;
$$;

create or replace function private.grant_business_creator_membership()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
    and (select private.has_active_workspace_role(new.workspace_id, array['Admin'])) then
    insert into public.business_members (business_id, user_id, role, status)
    values (new.id, (select auth.uid()), 'Admin', 'Active');
  end if;

  return new;
end;
$$;

create or replace function private.protect_workspace_owner_membership()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_id uuid;
begin
  select workspace.owner_user_id
    into owner_id
  from public.workspaces as workspace
  where workspace.id = old.workspace_id;

  if owner_id is not null and old.user_id = owner_id then
    raise exception 'workspace owner membership cannot be changed'
      using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function private.grant_workspace_owner_membership() from public, anon;
revoke all on function private.grant_business_creator_membership() from public, anon;
revoke all on function private.protect_workspace_owner_membership() from public, anon;

grant execute on function private.grant_workspace_owner_membership() to authenticated, service_role;
grant execute on function private.grant_business_creator_membership() to authenticated, service_role;
grant execute on function private.protect_workspace_owner_membership() to authenticated, service_role;

create trigger workspaces_grant_owner_membership
  after insert on public.workspaces
  for each row execute function private.grant_workspace_owner_membership();

create trigger businesses_grant_creator_membership
  after insert on public.businesses
  for each row execute function private.grant_business_creator_membership();

create trigger workspace_members_protect_owner
  before update or delete on public.workspace_members
  for each row execute function private.protect_workspace_owner_membership();

create or replace function public.create_workspace(workspace_name text)
returns table (
  workspace_id uuid,
  owner_user_id uuid,
  role text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  created_workspace_id uuid;
begin
  if current_user_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if workspace_name is null or pg_catalog.btrim(workspace_name) = '' then
    raise exception 'workspace name is required'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.workspace_members as membership
    where membership.user_id = current_user_id
  ) and not (select private.has_any_active_workspace_admin()) then
    raise exception 'active workspace admin membership is required to create another workspace'
      using errcode = '42501';
  end if;

  insert into public.workspaces (name, owner_user_id)
  values (pg_catalog.btrim(workspace_name), current_user_id)
  returning id into created_workspace_id;

  workspace_id := created_workspace_id;
  owner_user_id := current_user_id;
  role := 'Admin';
  status := 'Active';
  return next;
end;
$$;

create or replace function public.create_business(
  target_workspace_id uuid,
  business_name text,
  business_country text,
  business_region text,
  industry_id uuid,
  sub_industry_id uuid,
  business_model text,
  market_type text,
  reporting_currency text,
  timezone text
)
returns table (
  business_id uuid,
  workspace_id uuid,
  role text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  created_business_id uuid;
begin
  if current_user_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if target_workspace_id is null then
    raise exception 'workspace is required'
      using errcode = '22023';
  end if;

  if business_name is null or pg_catalog.btrim(business_name) = ''
    or business_country is null or pg_catalog.btrim(business_country) = ''
    or reporting_currency is null or reporting_currency !~ '^[A-Z]{3}$'
    or timezone is null or pg_catalog.btrim(timezone) = '' then
    raise exception 'business name, country, reporting currency, and timezone are required'
      using errcode = '22023';
  end if;

  if not (select private.has_active_workspace_role(target_workspace_id, array['Admin'])) then
    raise exception 'active workspace admin membership is required to create a business'
      using errcode = '42501';
  end if;

  insert into public.businesses (
    workspace_id,
    business_name,
    business_country,
    business_region,
    industry_id,
    sub_industry_id,
    business_model,
    market_type,
    reporting_currency,
    timezone
  )
  values (
    target_workspace_id,
    pg_catalog.btrim(business_name),
    pg_catalog.btrim(business_country),
    business_region,
    industry_id,
    sub_industry_id,
    business_model,
    market_type,
    reporting_currency,
    pg_catalog.btrim(timezone)
  )
  returning id into created_business_id;

  business_id := created_business_id;
  workspace_id := target_workspace_id;
  role := 'Admin';
  status := 'Active';
  return next;
end;
$$;

revoke all on function public.create_workspace(text) from public, anon, service_role;
revoke all on function public.create_business(uuid, text, text, text, uuid, uuid, text, text, text, text) from public, anon, service_role;

grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.create_business(uuid, text, text, text, uuid, uuid, text, text, text, text) to authenticated;
