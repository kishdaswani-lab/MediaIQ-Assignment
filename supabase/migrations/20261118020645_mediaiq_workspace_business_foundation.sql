-- MediaIQ foundation: workspaces, business profiles, membership, and industry taxonomy.
-- Physical Database Schema v0.2 is the column and constraint source.
-- Later-release tables (imports, campaigns, performance, customers, recommendations)
-- are intentionally absent.
--
-- Authenticated users create workspaces and businesses only through
-- public.create_workspace and public.create_business. Those functions set
-- ownership and the creator's initial Active Admin membership. Direct inserts
-- into workspaces and businesses are not granted to authenticated.

create schema if not exists private;

revoke all on schema private from public;

grant usage on schema private to authenticated, service_role;

-- Maintains businesses.updated_at. Membership and workspace rows have no
-- updated_at column in Physical Schema v0.2.
create or replace function private.set_business_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

revoke all on function private.set_business_updated_at() from public, anon;

grant execute on function private.set_business_updated_at() to authenticated, service_role;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references auth.users (id),
  created_at timestamptz not null default pg_catalog.now()
);

comment on table public.workspaces is
  'Workspace boundary. Membership does not grant access to businesses in the workspace.';

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  user_id uuid not null references auth.users (id),
  role text not null,
  status text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint workspace_members_workspace_id_user_id_key unique (workspace_id, user_id),
  constraint workspace_members_role_check check (role in ('Admin', 'Member', 'Viewer')),
  constraint workspace_members_status_check check (status in ('Active', 'Invited', 'Suspended'))
);

comment on table public.workspace_members is
  'Workspace role and status. Only Active membership authorizes workspace access.';

comment on constraint workspace_members_workspace_id_user_id_key on public.workspace_members is
  'A user has at most one membership row in a workspace.';

create table public.industry_taxonomy (
  id uuid primary key default gen_random_uuid(),
  industry_name text not null,
  parent_industry_id uuid references public.industry_taxonomy (id),
  taxonomy_version text,
  constraint industry_taxonomy_not_self_parent check (parent_industry_id is distinct from id)
);

comment on table public.industry_taxonomy is
  'Parent and child industry classifications. taxonomy_version nullability is unspecified in v0.2.';

comment on column public.industry_taxonomy.parent_industry_id is
  'Null for a parent classification. A child references its parent row.';

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  business_name text not null,
  business_country text not null,
  business_region text,
  industry_id uuid references public.industry_taxonomy (id),
  sub_industry_id uuid references public.industry_taxonomy (id),
  business_model text,
  market_type text,
  reporting_currency text not null,
  timezone text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint businesses_reporting_currency_iso4217_check
    check (reporting_currency ~ '^[A-Z]{3}$')
);

comment on table public.businesses is
  'Business profile. Exactly one workspace and one ISO 4217 reporting currency.';

comment on column public.businesses.business_region is
  'Nullable in Physical Schema v0.2.';

comment on column public.businesses.business_model is
  'Nullable in Physical Schema v0.2.';

comment on column public.businesses.market_type is
  'Nullable in Physical Schema v0.2.';

comment on column public.businesses.reporting_currency is
  'Single reporting currency for the business. A Business Admin may change this value in this release. Once financial data has been imported, reporting currency changes must use a controlled migration process that preserves original currency, conversion rates and historical reporting consistency. That future mechanism is not implemented here.';

comment on constraint businesses_reporting_currency_iso4217_check on public.businesses is
  'Three-letter ISO 4217 shape. It does not validate the code against the ISO catalog.';

create table public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id),
  user_id uuid not null references auth.users (id),
  role text not null,
  status text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint business_members_business_id_user_id_key unique (business_id, user_id),
  constraint business_members_role_check check (role in ('Admin', 'Analyst', 'Viewer')),
  constraint business_members_status_check check (status in ('Active', 'Invited', 'Suspended'))
);

comment on table public.business_members is
  'Explicit business membership. Workspace membership never creates this row.';

comment on constraint business_members_business_id_user_id_key on public.business_members is
  'A user has at most one membership row in a business.';

-- Approved lookup indexes from Physical Schema v0.2 section 11.
create index workspace_members_user_id_workspace_id_idx
  on public.workspace_members (user_id, workspace_id);

create index businesses_workspace_id_idx
  on public.businesses (workspace_id);

create index business_members_user_id_business_id_idx
  on public.business_members (user_id, business_id);

-- Foreign-key indexes not already covered by the unique keys or section 11.
create index workspaces_owner_user_id_idx
  on public.workspaces (owner_user_id);

create index industry_taxonomy_parent_industry_id_idx
  on public.industry_taxonomy (parent_industry_id);

create index businesses_industry_id_idx
  on public.businesses (industry_id);

create index businesses_sub_industry_id_idx
  on public.businesses (sub_industry_id);

-- Authorization helpers. SECURITY DEFINER avoids recursive RLS when a policy
-- on a membership table needs to read that same table. Each function checks
-- auth.uid() and does not accept a user id from the caller.
create or replace function private.has_active_workspace_role(
  target_workspace_id uuid,
  allowed_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = (select auth.uid())
      and status = 'Active'
      and role = any (allowed_roles)
  );
$$;

create or replace function private.has_any_active_workspace_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members
    where user_id = (select auth.uid())
      and status = 'Active'
      and role = 'Admin'
  );
$$;

create or replace function private.has_any_active_workspace_membership()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members
    where user_id = (select auth.uid())
      and status = 'Active'
  );
$$;

-- Business access requires both an active workspace membership and an explicit
-- active business membership. Workspace Admin is not one of the business roles.
create or replace function private.has_active_business_access(
  target_business_id uuid,
  allowed_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.businesses as business
    join public.business_members as business_member
      on business_member.business_id = business.id
     and business_member.user_id = (select auth.uid())
     and business_member.status = 'Active'
     and business_member.role = any (allowed_roles)
    join public.workspace_members as workspace_member
      on workspace_member.workspace_id = business.workspace_id
     and workspace_member.user_id = (select auth.uid())
     and workspace_member.status = 'Active'
    where business.id = target_business_id
  );
$$;

revoke all on function private.has_active_workspace_role(uuid, text[]) from public, anon, service_role;

revoke all on function private.has_any_active_workspace_admin() from public, anon, service_role;

revoke all on function private.has_any_active_workspace_membership() from public, anon, service_role;

revoke all on function private.has_active_business_access(uuid, text[]) from public, anon, service_role;

grant execute on function private.has_active_workspace_role(uuid, text[]) to authenticated;

grant execute on function private.has_any_active_workspace_admin() to authenticated;

grant execute on function private.has_any_active_workspace_membership() to authenticated;

grant execute on function private.has_active_business_access(uuid, text[]) to authenticated;

-- True only when this statement is executing as the owner of the named
-- SECURITY DEFINER function. The helper is SECURITY INVOKER on purpose:
-- a definer helper would see its own owner and would make the check true
-- for every caller. Callers cannot satisfy this by setting a session flag.
create or replace function private.statement_runs_as_trusted_creator(
  function_name text,
  argument_count integer
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  runs_as_owner boolean;
begin
  select exists (
    select 1
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = proc.proowner
    where namespace.nspname = 'public'
      and proc.proname = function_name
      and proc.pronargs = argument_count
      and proc.prosecdef
      and owner_role.rolname = current_user
  )
  into runs_as_owner;

  return coalesce(runs_as_owner, false);
end;
$$;

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
    if tg_table_name = 'workspace_members' then
      creator_insert :=
        new.role = 'Admin'
        and new.status = 'Active'
        and (select private.statement_runs_as_trusted_creator('create_workspace', 1))
        and exists (
          select 1
          from public.workspaces as workspace
          where workspace.id = new.workspace_id
            and workspace.owner_user_id = current_user_id
        );
    elsif tg_table_name = 'business_members' then
      creator_insert :=
        new.role = 'Admin'
        and new.status = 'Active'
        and (select private.statement_runs_as_trusted_creator('create_business', 10))
        and exists (
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

create or replace function private.enforce_industry_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_parent uuid;
  depth integer := 0;
begin
  if tg_op = 'UPDATE'
    and new.parent_industry_id is distinct from old.parent_industry_id
    and exists (
      select 1
      from public.businesses as business
      where business.industry_id = new.id
        or business.sub_industry_id = new.id
    ) then
    raise exception 'referenced industry classification cannot be reparented'
      using errcode = '23514';
  end if;

  if new.parent_industry_id is null then
    return new;
  end if;

  current_parent := new.parent_industry_id;

  while current_parent is not null loop
    if current_parent = new.id then
      raise exception 'industry parent cycle is not allowed'
        using errcode = '23514';
    end if;

    depth := depth + 1;
    if depth > 20 then
      raise exception 'industry parent chain is too deep'
        using errcode = '23514';
    end if;

    select parent_industry_id
      into current_parent
    from public.industry_taxonomy
    where id = current_parent;
  end loop;

  return new;
end;
$$;

-- Keeps a business industry and sub-industry in the same parent/child pair.
create or replace function private.enforce_business_industry_pair()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.industry_id is null and new.sub_industry_id is null then
    return new;
  end if;

  if new.industry_id is null or new.sub_industry_id is null then
    raise exception 'business industry and sub-industry must be set together'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.industry_taxonomy as parent_industry
    where parent_industry.id = new.industry_id
      and parent_industry.parent_industry_id is null
  ) then
    raise exception 'business industry must be a parent classification'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.industry_taxonomy as child_industry
    where child_industry.id = new.sub_industry_id
      and child_industry.parent_industry_id = new.industry_id
  ) then
    raise exception 'business sub-industry must be a child of the selected industry'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Active business membership is valid only for an active member of that
-- business's workspace. This is the membership-level ownership safeguard.
create or replace function private.enforce_business_member_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'Active' then
    return new;
  end if;

  if not exists (
    select 1
    from public.businesses as business
    join public.workspace_members as workspace_member
      on workspace_member.workspace_id = business.workspace_id
    where business.id = new.business_id
      and workspace_member.user_id = new.user_id
      and workspace_member.status = 'Active'
  ) then
    raise exception 'active business membership requires active membership in the business workspace'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Rejects an ownership change. Workspace name updates remain allowed.
create or replace function private.prevent_workspace_owner_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'workspace owner cannot be changed'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- Rejects moving a business to another workspace through an ordinary update.
create or replace function private.prevent_business_workspace_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'business workspace cannot be changed'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function private.prevent_referenced_industry_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.businesses as business
    where business.industry_id = old.id
      or business.sub_industry_id = old.id
  ) then
    raise exception 'referenced industry classification cannot be deleted'
      using errcode = '23503';
  end if;

  return old;
end;
$$;

revoke all on function private.statement_runs_as_trusted_creator(text, integer) from public, anon;

revoke all on function private.prevent_self_membership_change() from public, anon;

revoke all on function private.enforce_industry_parent() from public, anon;

revoke all on function private.enforce_business_industry_pair() from public, anon;

revoke all on function private.enforce_business_member_workspace() from public, anon;

revoke all on function private.prevent_workspace_owner_change() from public, anon;

revoke all on function private.prevent_business_workspace_change() from public, anon;

revoke all on function private.prevent_referenced_industry_delete() from public, anon;

grant execute on function private.statement_runs_as_trusted_creator(text, integer) to authenticated, service_role;

grant execute on function private.prevent_self_membership_change() to authenticated, service_role;

grant execute on function private.enforce_industry_parent() to authenticated, service_role;

grant execute on function private.enforce_business_industry_pair() to authenticated, service_role;

grant execute on function private.enforce_business_member_workspace() to authenticated, service_role;

grant execute on function private.prevent_workspace_owner_change() to authenticated, service_role;

grant execute on function private.prevent_business_workspace_change() to authenticated, service_role;

grant execute on function private.prevent_referenced_industry_delete() to authenticated, service_role;

create trigger workspace_members_prevent_self_change
  before insert or update or delete on public.workspace_members
  for each row execute function private.prevent_self_membership_change();

create trigger business_members_prevent_self_change
  before insert or update or delete on public.business_members
  for each row execute function private.prevent_self_membership_change();

create trigger industry_taxonomy_enforce_parent
  before insert or update of parent_industry_id on public.industry_taxonomy
  for each row execute function private.enforce_industry_parent();

create trigger workspaces_prevent_owner_change
  before update of owner_user_id on public.workspaces
  for each row execute function private.prevent_workspace_owner_change();

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function private.set_business_updated_at();

create trigger businesses_prevent_workspace_change
  before update of workspace_id on public.businesses
  for each row execute function private.prevent_business_workspace_change();

create trigger industry_taxonomy_prevent_referenced_delete
  before delete on public.industry_taxonomy
  for each row execute function private.prevent_referenced_industry_delete();

create trigger businesses_enforce_industry_pair
  before insert or update of industry_id, sub_industry_id on public.businesses
  for each row execute function private.enforce_business_industry_pair();

create trigger business_members_enforce_workspace
  before insert or update of business_id, user_id, status on public.business_members
  for each row execute function private.enforce_business_member_workspace();

alter table public.workspaces enable row level security;

alter table public.workspace_members enable row level security;

alter table public.industry_taxonomy enable row level security;

alter table public.businesses enable row level security;

alter table public.business_members enable row level security;

create policy workspaces_select_active_member
  on public.workspaces
  for select
  to authenticated
  using (
    (select private.has_active_workspace_role(
      id,
      array['Admin', 'Member', 'Viewer']
    ))
  );

comment on policy workspaces_select_active_member on public.workspaces is
  'Active workspace members can read that workspace. Invited and Suspended members cannot.';

create policy workspaces_update_admin
  on public.workspaces
  for update
  to authenticated
  using (
    (select private.has_active_workspace_role(id, array['Admin']))
  )
  with check (
    (select private.has_active_workspace_role(id, array['Admin']))
  );

comment on policy workspaces_update_admin on public.workspaces is
  'Workspace Admins can update workspace settings such as the name. owner_user_id is immutable. There is no authenticated insert or delete policy.';

create policy workspace_members_select_own_or_admin
  on public.workspace_members
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_active_workspace_role(workspace_id, array['Admin']))
  );

comment on policy workspace_members_select_own_or_admin on public.workspace_members is
  'A user can read their own membership. A workspace Admin can read the workspace roster.';

create policy workspace_members_insert_admin_not_self
  on public.workspace_members
  for insert
  to authenticated
  with check (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_workspace_role(workspace_id, array['Admin']))
  );

create policy workspace_members_update_admin_not_self
  on public.workspace_members
  for update
  to authenticated
  using (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_workspace_role(workspace_id, array['Admin']))
  )
  with check (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_workspace_role(workspace_id, array['Admin']))
  );

create policy workspace_members_delete_admin_not_self
  on public.workspace_members
  for delete
  to authenticated
  using (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_workspace_role(workspace_id, array['Admin']))
  );

comment on policy workspace_members_insert_admin_not_self on public.workspace_members is
  'Workspace Admins manage other users. A user cannot insert, change, or remove their own row.';

create policy industry_taxonomy_select_workspace_member
  on public.industry_taxonomy
  for select
  to authenticated
  using ((select private.has_any_active_workspace_membership()));

comment on policy industry_taxonomy_select_workspace_member on public.industry_taxonomy is
  'Reference data is readable by active workspace members. No authenticated write policy exists.';

create policy businesses_select_explicit_member
  on public.businesses
  for select
  to authenticated
  using (
    (select private.has_active_business_access(
      id,
      array['Admin', 'Analyst', 'Viewer']
    ))
  );

comment on policy businesses_select_explicit_member on public.businesses is
  'Read requires Active workspace membership and explicit Active business membership. There is no authenticated insert or delete policy.';

create policy businesses_update_admin
  on public.businesses
  for update
  to authenticated
  using (
    (select private.has_active_business_access(id, array['Admin']))
  )
  with check (
    (select private.has_active_business_access(id, array['Admin']))
  );

comment on policy businesses_update_admin on public.businesses is
  'An Active Business Admin who is also an Active member of the parent workspace may update the profile. Analysts and Viewers cannot. workspace_id cannot change.';

create policy business_members_select_own_or_admin
  on public.business_members
  for select
  to authenticated
  using (
    (
      user_id = (select auth.uid())
      and (select private.has_active_business_access(
        business_id,
        array['Admin', 'Analyst', 'Viewer']
      ))
    )
    or (select private.has_active_business_access(business_id, array['Admin']))
  );

create policy business_members_insert_admin_not_self
  on public.business_members
  for insert
  to authenticated
  with check (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_business_access(business_id, array['Admin']))
  );

create policy business_members_update_admin_not_self
  on public.business_members
  for update
  to authenticated
  using (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_business_access(business_id, array['Admin']))
  )
  with check (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_business_access(business_id, array['Admin']))
  );

create policy business_members_delete_admin_not_self
  on public.business_members
  for delete
  to authenticated
  using (
    user_id is distinct from (select auth.uid())
    and (select private.has_active_business_access(business_id, array['Admin']))
  );

comment on policy business_members_insert_admin_not_self on public.business_members is
  'Business Admins manage other members of their business. They cannot change their own role or status.';

revoke all on table public.workspaces from public, anon, authenticated;

revoke all on table public.workspace_members from public, anon, authenticated;

revoke all on table public.industry_taxonomy from public, anon, authenticated;

revoke all on table public.businesses from public, anon, authenticated;

revoke all on table public.business_members from public, anon, authenticated;

grant select, update on table public.workspaces to authenticated;

grant select, insert, update, delete on table public.workspace_members to authenticated;

grant select on table public.industry_taxonomy to authenticated;

grant select, update on table public.businesses to authenticated;

grant select, insert, update, delete on table public.business_members to authenticated;

-- Owned by the migration role. On Supabase that role is the trusted database
-- owner, not a client role. SECURITY DEFINER makes the inserts run as that
-- owner so they can pass RLS without a direct insert grant.
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

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values (created_workspace_id, current_user_id, 'Admin', 'Active');

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

  insert into public.business_members (business_id, user_id, role, status)
  values (created_business_id, current_user_id, 'Admin', 'Active');

  business_id := created_business_id;
  workspace_id := target_workspace_id;
  role := 'Admin';
  status := 'Active';
  return next;
end;
$$;

comment on function public.create_workspace(text) is
  'Creates a workspace owned by auth.uid() and that user''s Active Admin membership. A caller who already has any membership must already be an Active Admin.';

comment on function public.create_business(uuid, text, text, text, uuid, uuid, text, text, text, text) is
  'Creates a business in a workspace the caller administers, and that caller''s Active Business Admin membership. Other workspace admins receive no business access.';

revoke all on function public.create_workspace(text) from public, anon;

revoke all on function public.create_business(uuid, text, text, text, uuid, uuid, text, text, text, text) from public, anon;

grant execute on function public.create_workspace(text) to authenticated;

grant execute on function public.create_business(uuid, text, text, text, uuid, uuid, text, text, text, text) to authenticated;
