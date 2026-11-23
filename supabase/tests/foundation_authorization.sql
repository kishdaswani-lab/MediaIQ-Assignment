-- Repeatable authorization tests for the MediaIQ foundation migration.
-- This file is not a migration and must not be placed in supabase/migrations.
--
-- Run it manually, after the foundation migration, against a local Supabase
-- database, as a role that can insert into auth.users and SET ROLE to
-- authenticated and anon:
--
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/foundation_authorization.sql
--
-- The script begins a transaction and rolls it back. A successful run prints
-- one completion notice and leaves no rows behind. These tests were not
-- executed in the environment that authored this file.

begin;

do $$
begin
  if to_regclass('auth.users') is null then
    raise exception 'auth.users is not available. Apply the foundation migration to a local Supabase database before running this script.';
  end if;

  if to_regprocedure('public.create_workspace(text)') is null
    or to_regprocedure('public.create_business(uuid,text,text,text,uuid,uuid,text,text,text,text)') is null then
    raise exception 'creation functions are not installed. Apply supabase/migrations/20261118020645_mediaiq_workspace_business_foundation.sql first.';
  end if;
end $$;

create temp table test_user (
  label text primary key,
  id uuid not null unique
);

insert into test_user (label, id)
values
  ('founder', '11111111-1111-4111-8111-111111111111'),
  ('second_admin', '22222222-2222-4222-8222-222222222222'),
  ('member', '33333333-3333-4333-8333-333333333333'),
  ('viewer', '44444444-4444-4444-8444-444444444444'),
  ('suspended', '55555555-5555-4555-8555-555555555555'),
  ('analyst', '66666666-6666-4666-8666-666666666666'),
  ('outsider', '77777777-7777-4777-8777-777777777777');

-- auth.users column requirements vary slightly between Supabase Auth versions.
-- If this insert fails, align only these fixture columns with the local auth schema.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
select
  '00000000-0000-0000-0000-000000000000',
  test_user.id,
  'authenticated',
  'authenticated',
  test_user.label || '@foundation-test.mediaiq.invalid',
  '',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  pg_catalog.now(),
  pg_catalog.now(),
  '',
  '',
  '',
  ''
from test_user;

create temp table test_result (
  label text primary key,
  id uuid
);

-- authenticated reads these fixtures after SET LOCAL ROLE. The session owner
-- still owns the tables. USAGE is limited to this session's temporary schema,
-- which is the schema that holds the two fixture tables.
do $$
declare
  temp_schema_name text;
begin
  select namespace.nspname
    into temp_schema_name
  from pg_catalog.pg_namespace as namespace
  where namespace.oid = pg_catalog.pg_my_temp_schema();

  if temp_schema_name is null then
    raise exception 'temporary schema does not exist for this session';
  end if;

  execute format('grant usage on schema %I to authenticated', temp_schema_name);
end $$;

grant select on table test_user to authenticated;
grant select on table test_result to authenticated;

do $$
declare
  user_count integer;
  result_count integer;
begin
  execute 'set local role authenticated';
  select count(*) into user_count from test_user;
  select count(*) into result_count from test_result;
  execute 'reset role';

  if user_count <> 7 or result_count <> 0 then
    raise exception 'authenticated role cannot read the fixture tables';
  end if;
end $$;

-- Fixture setup is explicit. Actions under test switch to authenticated or anon.
-- 3. anon cannot execute workspace creation.
do $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';

  begin
    perform public.create_workspace('Anon workspace');
    raise exception 'test 3 failed: anon created a workspace';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end $$;

-- 1 and 2. A new user creates the first workspace and becomes Active Admin.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  created record;
  stored_role text;
  stored_status text;
  stored_owner uuid;
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';

  select * into created from public.create_workspace('Founder workspace');

  if created.owner_user_id is distinct from founder_id
    or created.role is distinct from 'Admin'
    or created.status is distinct from 'Active' then
    raise exception 'test 2 failed: creator was not returned as Active Admin owner';
  end if;

  execute 'reset role';

  select membership.role, membership.status, workspace.owner_user_id
    into stored_role, stored_status, stored_owner
  from public.workspace_members as membership
  join public.workspaces as workspace on workspace.id = membership.workspace_id
  where membership.workspace_id = created.workspace_id
    and membership.user_id = founder_id;

  if stored_role is distinct from 'Admin'
    or stored_status is distinct from 'Active'
    or stored_owner is distinct from founder_id then
    raise exception 'test 1 or 2 failed: stored workspace ownership or admin membership is wrong';
  end if;

  insert into test_result (label, id) values ('workspace', created.workspace_id);
end $$;

-- 4. An existing Active Admin can create another workspace.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  created record;
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
  select * into created from public.create_workspace('Second workspace');
  execute 'reset role';

  if created.owner_user_id is distinct from founder_id or created.role is distinct from 'Admin' then
    raise exception 'test 4 failed: Active Admin could not create a second owned workspace';
  end if;

  insert into test_result (label, id) values ('second_workspace', created.workspace_id);
end $$;

-- Fixtures for Member, Viewer, and Suspended identities. Inserted without a user JWT.
do $$
declare
  fixture_workspace uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into public.workspaces (name, owner_user_id)
  values ('Fixture workspace', (select id from test_user where label = 'founder'))
  returning id into fixture_workspace;

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values
    (fixture_workspace, (select id from test_user where label = 'member'), 'Member', 'Active'),
    (fixture_workspace, (select id from test_user where label = 'viewer'), 'Viewer', 'Active'),
    (fixture_workspace, (select id from test_user where label = 'suspended'), 'Admin', 'Suspended');

  insert into test_result (label, id) values ('fixture_workspace', fixture_workspace);
end $$;

-- 5. Member and Viewer cannot create another workspace.
do $$
declare
  actor uuid;
begin
  for actor in
    select id
    from test_user
    where label in ('member', 'viewer')
  loop
    perform set_config('request.jwt.claim.sub', actor::text, true);
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', actor::text, 'role', 'authenticated')::text,
      true
    );
    execute 'set local role authenticated';

    begin
      perform public.create_workspace('Should not exist');
      raise exception 'test 5 failed: non-admin created a workspace';
    exception
      when insufficient_privilege then
        null;
    end;

    execute 'reset role';
  end loop;
end $$;

-- 6. A Suspended membership does not qualify for the first-workspace exception.
do $$
declare
  suspended_id uuid := (select id from test_user where label = 'suspended');
begin
  perform set_config('request.jwt.claim.sub', suspended_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', suspended_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    perform public.create_workspace('Suspended user workspace');
    raise exception 'test 6 failed: suspended user created a workspace';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end $$;

-- 7. The initial admin cannot insert another membership for themselves.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    insert into public.workspace_members (workspace_id, user_id, role, status)
    values ((select id from test_result where label = 'second_workspace'), founder_id, 'Admin', 'Active');
    raise exception 'test 7 failed: direct self-membership insert succeeded';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end $$;

-- 8. A workspace Member cannot create a business.
do $$
declare
  member_id uuid := (select id from test_user where label = 'member');
begin
  perform set_config('request.jwt.claim.sub', member_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', member_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    perform public.create_business(
      (select id from test_result where label = 'fixture_workspace'),
      'Member business',
      'Singapore',
      null,
      null,
      null,
      null,
      null,
      'SGD',
      'Asia/Singapore'
    );
    raise exception 'test 8 failed: workspace member created a business';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end $$;

-- Taxonomy fixtures used by business creation and later integrity tests.
do $$
declare
  parent_id uuid;
  child_id uuid;
  other_parent_id uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into public.industry_taxonomy (industry_name, parent_industry_id, taxonomy_version)
  values ('Proposed parent', null, 'test')
  returning id into parent_id;

  insert into public.industry_taxonomy (industry_name, parent_industry_id, taxonomy_version)
  values ('Proposed child', parent_id, 'test')
  returning id into child_id;

  insert into public.industry_taxonomy (industry_name, parent_industry_id, taxonomy_version)
  values ('Other parent', null, 'test')
  returning id into other_parent_id;

  insert into test_result (label, id)
  values
    ('industry', parent_id),
    ('sub_industry', child_id),
    ('other_industry', other_parent_id);
end $$;

-- 9. Workspace Admin creates a business and becomes its Active Business Admin.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  created record;
  stored_role text;
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  select * into created from public.create_business(
    (select id from test_result where label = 'workspace'),
    'Founder business',
    'Singapore',
    'Central',
    (select id from test_result where label = 'industry'),
    (select id from test_result where label = 'sub_industry'),
    'Services',
    'B2B',
    'SGD',
    'Asia/Singapore'
  );

  execute 'reset role';

  if created.role is distinct from 'Admin' or created.status is distinct from 'Active' then
    raise exception 'test 9 failed: creator was not returned as Active Business Admin';
  end if;

  select role into stored_role
  from public.business_members
  where business_id = created.business_id
    and user_id = founder_id;

  if stored_role is distinct from 'Admin' then
    raise exception 'test 9 failed: stored business membership is not Admin';
  end if;

  insert into test_result (label, id) values ('business', created.business_id);
end $$;

-- 10. Another Workspace Admin without business membership cannot read the business.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  second_id uuid := (select id from test_user where label = 'second_admin');
  visible_count integer;
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values ((select id from test_result where label = 'workspace'), second_id, 'Admin', 'Active');

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', second_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', second_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  select count(*) into visible_count
  from public.businesses
  where id = (select id from test_result where label = 'business');

  execute 'reset role';

  if visible_count <> 0 then
    raise exception 'test 10 failed: workspace admin without business membership read the business';
  end if;
end $$;

-- 11. Business Admin can update the profile, including the single reporting currency.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  updated_name text;
  updated_currency text;
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  update public.businesses
  set business_name = 'Renamed business',
      reporting_currency = 'USD'
  where id = (select id from test_result where label = 'business');

  execute 'reset role';

  select business_name, reporting_currency
    into updated_name, updated_currency
  from public.businesses
  where id = (select id from test_result where label = 'business');

  if updated_name is distinct from 'Renamed business' or updated_currency is distinct from 'USD' then
    raise exception 'test 11 failed: business admin profile update did not persist';
  end if;
end $$;

-- Analyst and Viewer fixtures, both Active in the workspace and the business.
insert into public.workspace_members (workspace_id, user_id, role, status)
values
  ((select id from test_result where label = 'workspace'), (select id from test_user where label = 'analyst'), 'Member', 'Active'),
  ((select id from test_result where label = 'workspace'), (select id from test_user where label = 'viewer'), 'Viewer', 'Active');

insert into public.business_members (business_id, user_id, role, status)
values
  ((select id from test_result where label = 'business'), (select id from test_user where label = 'analyst'), 'Analyst', 'Active'),
  ((select id from test_result where label = 'business'), (select id from test_user where label = 'viewer'), 'Viewer', 'Active');

-- 12 and 13. Analyst and Viewer updates do not change the profile.
do $$
declare
  actor uuid;
  actor_label text;
  visible_name text;
begin
  foreach actor_label in array array['analyst', 'viewer']
  loop
    actor := (select id from test_user where label = actor_label);
    perform set_config('request.jwt.claim.sub', actor::text, true);
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', actor::text, 'role', 'authenticated')::text,
      true
    );
    execute 'set local role authenticated';

    update public.businesses
    set business_name = actor_label || ' changed the name'
    where id = (select id from test_result where label = 'business');

    execute 'reset role';
  end loop;

  select business_name into visible_name
  from public.businesses
  where id = (select id from test_result where label = 'business');

  if visible_name is distinct from 'Renamed business' then
    raise exception 'test 12 or 13 failed: non-admin changed the business profile';
  end if;
end $$;

-- 14. Workspace ownership cannot be changed.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  update public.workspaces
  set name = 'Renamed workspace'
  where id = (select id from test_result where label = 'workspace');

  begin
    update public.workspaces
    set owner_user_id = (select id from test_user where label = 'second_admin')
    where id = (select id from test_result where label = 'workspace');
    raise exception 'test 14 failed: owner_user_id changed';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';

  if (select name from public.workspaces where id = (select id from test_result where label = 'workspace'))
    is distinct from 'Renamed workspace' then
    raise exception 'test 14 failed: workspace name update was blocked';
  end if;
end $$;

-- 15. business.workspace_id cannot be changed.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    update public.businesses
    set workspace_id = (select id from test_result where label = 'second_workspace')
    where id = (select id from test_result where label = 'business');
    raise exception 'test 15 failed: business workspace_id changed';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end $$;

-- 16. Users cannot grant themselves a membership or elevate their own role.
-- A self-update matches no RLS policy, so PostgreSQL changes zero rows and
-- does not raise. The assertions check the stored roles.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  member_id uuid := (select id from test_user where label = 'member');
  changed_rows integer;
begin
  perform set_config('request.jwt.claim.sub', member_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', member_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  update public.workspace_members
  set role = 'Admin'
  where user_id = member_id;
  get diagnostics changed_rows = row_count;

  if changed_rows <> 0 then
    raise exception 'test 16 failed: member updated their own workspace role';
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  update public.business_members
  set role = 'Viewer'
  where business_id = (select id from test_result where label = 'business')
    and user_id = founder_id;
  get diagnostics changed_rows = row_count;

  if changed_rows <> 0 then
    raise exception 'test 16 failed: business admin updated their own role';
  end if;

  execute 'reset role';

  if (select role from public.workspace_members where user_id = member_id and role = 'Member') is null then
    raise exception 'test 16 failed: member role was not preserved';
  end if;

  if (
    select role
    from public.business_members
    where user_id = founder_id
      and business_id = (select id from test_result where label = 'business')
  ) is distinct from 'Admin' then
    raise exception 'test 16 failed: founder business role was not preserved';
  end if;
end $$;

-- 17. Active business membership requires Active membership in the parent workspace.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    insert into public.business_members (business_id, user_id, role, status)
    values (
      (select id from test_result where label = 'business'),
      (select id from test_user where label = 'outsider'),
      'Analyst',
      'Active'
    );
    raise exception 'test 17 failed: business membership was created without workspace membership';
  exception
    when check_violation then
      null;
  end;

  execute 'reset role';
end $$;

-- 18 and 19. Referenced taxonomy cannot be reparented or deleted.
-- Authenticated has no taxonomy write grant. These mutations run as the
-- migration role, which is the role that could otherwise bypass RLS.
do $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'reset role';

  begin
    update public.industry_taxonomy
    set parent_industry_id = (select id from test_result where label = 'other_industry')
    where id = (select id from test_result where label = 'sub_industry');
    raise exception 'test 18 failed: referenced sub-industry was reparented';
  exception
    when check_violation then
      null;
  end;

  begin
    delete from public.industry_taxonomy
    where id = (select id from test_result where label = 'sub_industry');
    raise exception 'test 19 failed: referenced industry classification was deleted';
  exception
    when foreign_key_violation then
      null;
  end;
end $$;

-- 20. Suspending business membership revokes business access and leaves workspace access.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  analyst_id uuid := (select id from test_user where label = 'analyst');
  business_count integer;
  workspace_count integer;
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  update public.business_members
  set status = 'Suspended'
  where business_id = (select id from test_result where label = 'business')
    and user_id = analyst_id;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', analyst_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', analyst_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  select count(*) into business_count
  from public.businesses
  where id = (select id from test_result where label = 'business');

  select count(*) into workspace_count
  from public.workspaces
  where id = (select id from test_result where label = 'workspace');

  execute 'reset role';

  if business_count <> 0 or workspace_count <> 1 then
    raise exception 'test 20 failed: suspension did not revoke business access while preserving workspace access';
  end if;
end $$;

-- 21, 22, and 23. Another Workspace Admin cannot change or remove the owner's membership.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  second_id uuid := (select id from test_user where label = 'second_admin');
  target_workspace_id uuid := (select id from test_result where label = 'workspace');
  stored_role text;
  stored_status text;
begin
  perform set_config('request.jwt.claim.sub', second_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', second_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  begin
    update public.workspace_members as membership
    set role = 'Member'
    where membership.workspace_id = target_workspace_id
      and membership.user_id = founder_id;
    raise exception 'test 21 failed: second admin changed the owner role';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    update public.workspace_members as membership
    set status = 'Suspended'
    where membership.workspace_id = target_workspace_id
      and membership.user_id = founder_id;
    raise exception 'test 22 failed: second admin suspended the owner';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    delete from public.workspace_members as membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = founder_id;
    raise exception 'test 23 failed: second admin deleted the owner membership';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';

  select membership.role, membership.status
    into stored_role, stored_status
  from public.workspace_members as membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = founder_id;

  if stored_role is distinct from 'Admin' or stored_status is distinct from 'Active' then
    raise exception 'test 21, 22, or 23 failed: owner membership was not preserved';
  end if;
end $$;

-- 24. A Workspace Admin can still update and delete a non-owner member.
-- The member fixture belongs to the fixture workspace and has no business membership.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  member_id uuid := (select id from test_user where label = 'member');
  target_workspace_id uuid := (select id from test_result where label = 'fixture_workspace');
  stored_role text;
begin
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  update public.workspace_members as membership
  set role = 'Viewer'
  where membership.workspace_id = target_workspace_id
    and membership.user_id = member_id;

  select membership.role
    into stored_role
  from public.workspace_members as membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = member_id;

  if stored_role is distinct from 'Viewer' then
    raise exception 'test 24 failed: admin could not update a non-owner member';
  end if;

  delete from public.workspace_members as membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = member_id;

  execute 'reset role';

  if exists (
    select 1
    from public.workspace_members as membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = member_id
  ) then
    raise exception 'test 24 failed: admin could not delete a non-owner member';
  end if;
end $$;

-- 25. Direct self-membership inserts fail as postgres when a founder JWT is present.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', founder_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', founder_id::text, 'role', 'authenticated')::text,
    true
  );

  begin
    insert into public.workspace_members (workspace_id, user_id, role, status)
    values (
      (select id from test_result where label = 'workspace'),
      founder_id,
      'Admin',
      'Active'
    );
    raise exception 'test 25 failed: postgres inserted a workspace self-membership';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    insert into public.business_members (business_id, user_id, role, status)
    values (
      (select id from test_result where label = 'business'),
      founder_id,
      'Admin',
      'Active'
    );
    raise exception 'test 25 failed: postgres inserted a business self-membership';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

-- 26. A business created without a user JWT does not receive a business membership.
do $$
declare
  created_business uuid;
  membership_count integer;
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);

  insert into public.businesses (
    workspace_id,
    business_name,
    business_country,
    reporting_currency,
    timezone
  )
  values (
    (select id from test_result where label = 'workspace'),
    'Unsigned business',
    'Singapore',
    'SGD',
    'Asia/Singapore'
  )
  returning id into created_business;

  select count(*)
    into membership_count
  from public.business_members
  where business_id = created_business;

  if membership_count <> 0 then
    raise exception 'test 26 failed: business created without a user JWT received a membership';
  end if;
end $$;

-- 27. Owner protection applies without a user JWT.
do $$
declare
  founder_id uuid := (select id from test_user where label = 'founder');
  target_workspace_id uuid := (select id from test_result where label = 'workspace');
  stored_role text;
  stored_status text;
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);

  begin
    delete from public.workspace_members as membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = founder_id;
    raise exception 'test 27 failed: postgres deleted the owner membership without a user JWT';
  exception
    when sqlstate '42501' then
      null;
  end;

  select membership.role, membership.status
    into stored_role, stored_status
  from public.workspace_members as membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = founder_id;

  if stored_role is distinct from 'Admin' or stored_status is distinct from 'Active' then
    raise exception 'test 27 failed: owner membership was not preserved';
  end if;
end $$;

do $$
begin
  raise notice 'foundation authorization tests completed; rolling back';
end $$;

rollback;
