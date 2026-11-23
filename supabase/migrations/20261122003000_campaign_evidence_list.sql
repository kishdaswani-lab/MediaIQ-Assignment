-- Owner-scoped evidence listing. This file does not change the applied
-- Stage 2 migration, its roles, its policies, or the audit architecture.
-- It does not grant table privileges and does not return source text.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

create function private.list_campaign_evidence(
  p_owner_id uuid,
  p_limit integer,
  p_before_created_at timestamptz,
  p_before_id uuid
)
returns table (
  id uuid,
  created_at timestamptz,
  parser_version text,
  calculation_version text,
  period_start text,
  period_end text,
  campaign_count integer,
  channel_count integer,
  currency_codes text[]
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null then
    raise exception 'owner_id is required'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'page limit must be from 1 to 50'
      using errcode = '22023';
  end if;

  if (p_before_created_at is null) is distinct from (p_before_id is null) then
    raise exception 'page cursor requires both created_at and id'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  return query
  select
    evidence.id,
    evidence.created_at,
    evidence.parser_version,
    evidence.calculation_version,
    case
      when pg_catalog.jsonb_typeof(evidence.summary #> '{period,start}') = 'string'
        then evidence.summary #>> '{period,start}'
      else null
    end,
    case
      when pg_catalog.jsonb_typeof(evidence.summary #> '{period,end}') = 'string'
        then evidence.summary #>> '{period,end}'
      else null
    end,
    case
      when pg_catalog.jsonb_typeof(evidence.summary -> 'campaigns') = 'array'
        then pg_catalog.jsonb_array_length(evidence.summary -> 'campaigns')
      else null
    end,
    case
      when pg_catalog.jsonb_typeof(evidence.summary -> 'channels') = 'array'
        then pg_catalog.jsonb_array_length(evidence.summary -> 'channels')
      else null
    end,
    case
      when pg_catalog.jsonb_typeof(evidence.summary -> 'currencies') = 'array'
        then coalesce((
          select pg_catalog.array_agg(currency_item.code order by currency_item.ordinality)
          from (
            select
              item.ordinality,
              item.value ->> 'currency' as code
            from pg_catalog.jsonb_array_elements(evidence.summary -> 'currencies')
              with ordinality as item(value, ordinality)
            where pg_catalog.jsonb_typeof(item.value -> 'currency') = 'string'
          ) as currency_item
        ), '{}'::text[])
      else '{}'::text[]
    end
  from private.campaign_evidence as evidence
  where evidence.owner_id = p_owner_id
    and (
      p_before_created_at is null
      or (evidence.created_at, evidence.id)
        < (p_before_created_at, p_before_id)
    )
  order by evidence.created_at desc, evidence.id desc
  limit p_limit;
end;
$$;

comment on function private.list_campaign_evidence(uuid, integer, timestamptz, uuid) is
  'Lists metadata for one owner. Source text, the summary document, and the latest exchange are not returned.';

alter function private.list_campaign_evidence(uuid, integer, timestamptz, uuid)
  owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;

revoke all on function private.list_campaign_evidence(uuid, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.list_campaign_evidence(uuid, integer, timestamptz, uuid)
  to mediaiq_evidence_writer;

revoke mediaiq_evidence_owner from current_user;
