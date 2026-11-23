-- Private campaign evidence for the Monday Campaign Evidence Explainer.
-- The Next.js server is the evidence-validation boundary. It must call
-- parseCampaignCsv and calculateEvidence before insert_campaign_evidence,
-- and it must pass the user id from requireProtectedSession().
--
-- This file does not set a password and does not create
-- MEDIAIQ_EVIDENCE_DATABASE_URL. mediaiq_evidence_writer requires a
-- separately provisioned credential and a database authentication
-- configuration that accepts that credential. A LOGIN role without a
-- password is not universally unable to connect. The authentication
-- audit roles, tables, and functions are not changed.
--
-- owner_id references auth.users. PostgreSQL runs that referential
-- lookup as the owner of auth.users, not as mediaiq_evidence_owner or
-- mediaiq_evidence_writer. Neither evidence role is granted a privilege
-- on auth.users. This ownership behavior was not executed against this
-- database. The authorization test's insert remains the confirmation
-- required before the migration is applied.

create role mediaiq_evidence_owner
  nologin
  noinherit
  nobypassrls
  nocreaterole
  nocreatedb;

create role mediaiq_evidence_writer
  login
  noinherit
  nobypassrls
  nocreaterole
  nocreatedb
  connection limit 8;

alter role mediaiq_evidence_owner set search_path = '';
alter role mediaiq_evidence_writer set search_path = '';
alter role mediaiq_evidence_writer set statement_timeout = '5s';
alter role mediaiq_evidence_writer set idle_in_transaction_session_timeout = '10s';

grant usage on schema private to mediaiq_evidence_owner, mediaiq_evidence_writer;
grant connect on database postgres to mediaiq_evidence_writer;

grant mediaiq_evidence_owner to current_user;

create table private.campaign_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  created_at timestamptz not null default pg_catalog.now(),
  source_text text not null,
  summary jsonb not null,
  parser_version text not null,
  calculation_version text not null,
  latest_question text,
  latest_answer text,
  latest_exchange_at timestamptz,
  constraint campaign_evidence_source_size_check
    check (pg_catalog.octet_length(source_text) between 1 and 1048576),
  constraint campaign_evidence_summary_shape_check
    check (
      pg_catalog.jsonb_typeof(summary) = 'object'
      and not (summary ? 'rows')
    ),
  constraint campaign_evidence_versions_match_check
    check (
      parser_version <> ''
      and calculation_version <> ''
      and summary->>'parserVersion' = parser_version
      and summary->>'calculationVersion' = calculation_version
    ),
  constraint campaign_evidence_exchange_all_or_nothing_check
    check (
      (
        latest_question is null
        and latest_answer is null
        and latest_exchange_at is null
      )
      or (
        latest_question is not null
        and latest_answer is not null
        and latest_exchange_at is not null
      )
    )
);

comment on table private.campaign_evidence is
  'One campaign CSV and its calculated summary. Owned by the authenticated user. Parsed rows are not stored.';

comment on column private.campaign_evidence.source_text is
  'Decoded UTF-8 CSV text after one leading BOM is removed. The upload currency is not written back into this text.';

comment on column private.campaign_evidence.summary is
  'EvidenceSummary produced by the application calculator. Database checks do not prove that origin.';

create index campaign_evidence_owner_created_at_idx
  on private.campaign_evidence (owner_id, created_at);

alter table private.campaign_evidence enable row level security;
alter table private.campaign_evidence force row level security;

revoke all on table private.campaign_evidence
  from public, anon, authenticated, service_role, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

create policy campaign_evidence_owner_select
  on private.campaign_evidence
  for select
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy campaign_evidence_owner_insert
  on private.campaign_evidence
  for insert
  to mediaiq_evidence_owner
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy campaign_evidence_owner_delete
  on private.campaign_evidence
  for delete
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

comment on policy campaign_evidence_owner_select on private.campaign_evidence is
  'The evidence owner role can read a row only while the transaction-local owner GUC matches owner_id.';

comment on policy campaign_evidence_owner_insert on private.campaign_evidence is
  'The evidence owner role can insert a row only when owner_id matches the transaction-local owner GUC.';

comment on policy campaign_evidence_owner_delete on private.campaign_evidence is
  'The evidence owner role can delete a row only while the transaction-local owner GUC matches owner_id.';

create function private.insert_campaign_evidence(
  p_owner_id uuid,
  p_source_text text,
  p_summary jsonb,
  p_parser_version text,
  p_calculation_version text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if p_owner_id is null then
    raise exception 'owner_id is required' using errcode = '22023';
  end if;

  if p_source_text is null
    or pg_catalog.octet_length(p_source_text) < 1
    or pg_catalog.octet_length(p_source_text) > 1048576 then
    raise exception 'source_text is outside the approved size' using errcode = '22023';
  end if;

  if p_summary is null
    or pg_catalog.jsonb_typeof(p_summary) <> 'object'
    or p_summary ? 'rows' then
    raise exception 'summary is not an evidence summary' using errcode = '22023';
  end if;

  if p_parser_version is null
    or pg_catalog.btrim(p_parser_version) = ''
    or p_calculation_version is null
    or pg_catalog.btrim(p_calculation_version) = ''
    or p_summary->>'parserVersion' is distinct from p_parser_version
    or p_summary->>'calculationVersion' is distinct from p_calculation_version then
    raise exception 'summary versions do not match' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  insert into private.campaign_evidence (
    owner_id,
    source_text,
    summary,
    parser_version,
    calculation_version,
    latest_question,
    latest_answer,
    latest_exchange_at
  ) values (
    p_owner_id,
    p_source_text,
    p_summary,
    p_parser_version,
    p_calculation_version,
    null,
    null,
    null
  )
  returning id into new_id;

  return new_id;
end;
$$;

create function private.read_campaign_evidence(
  p_owner_id uuid,
  p_evidence_id uuid
) returns table (
  id uuid,
  owner_id uuid,
  created_at timestamptz,
  source_text text,
  summary jsonb,
  parser_version text,
  calculation_version text,
  latest_question text,
  latest_answer text,
  latest_exchange_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null or p_evidence_id is null then
    raise exception 'owner_id and evidence id are required' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  return query
  select
    evidence.id,
    evidence.owner_id,
    evidence.created_at,
    evidence.source_text,
    evidence.summary,
    evidence.parser_version,
    evidence.calculation_version,
    evidence.latest_question,
    evidence.latest_answer,
    evidence.latest_exchange_at
  from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id;
end;
$$;

create function private.delete_campaign_evidence(
  p_owner_id uuid,
  p_evidence_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_id uuid;
begin
  if p_owner_id is null or p_evidence_id is null then
    raise exception 'owner_id and evidence id are required' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  delete from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id
  returning evidence.id into deleted_id;

  return deleted_id;
end;
$$;

comment on function private.insert_campaign_evidence(uuid, text, jsonb, text, text) is
  'Stores decoded CSV text and a calculated summary. The latest exchange is always inserted as null.';

comment on function private.read_campaign_evidence(uuid, uuid) is
  'Returns one evidence row for the supplied owner, or no row when the id is missing or belongs to someone else.';

comment on function private.delete_campaign_evidence(uuid, uuid) is
  'Deletes one owner row. Text, summary, versions, and the exchange leave together. Returns null when no row matches.';

-- PostgreSQL requires the new owner to have CREATE on the schema unless
-- the session is a superuser. The grant is temporary and is revoked
-- after every ownership transfer. Schema private keeps its current owner.
grant create on schema private to mediaiq_evidence_owner;

alter table private.campaign_evidence owner to mediaiq_evidence_owner;
alter function private.insert_campaign_evidence(uuid, text, jsonb, text, text) owner to mediaiq_evidence_owner;
alter function private.read_campaign_evidence(uuid, uuid) owner to mediaiq_evidence_owner;
alter function private.delete_campaign_evidence(uuid, uuid) owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;

revoke all on function private.insert_campaign_evidence(uuid, text, jsonb, text, text)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on function private.read_campaign_evidence(uuid, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on function private.delete_campaign_evidence(uuid, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.insert_campaign_evidence(uuid, text, jsonb, text, text)
  to mediaiq_evidence_writer;
grant execute on function private.read_campaign_evidence(uuid, uuid)
  to mediaiq_evidence_writer;
grant execute on function private.delete_campaign_evidence(uuid, uuid)
  to mediaiq_evidence_writer;

revoke mediaiq_evidence_owner from current_user;
