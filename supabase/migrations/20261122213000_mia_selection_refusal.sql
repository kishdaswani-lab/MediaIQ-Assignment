-- Persist a deterministic evidence-selection refusal before provider dispatch.
-- This is separate from the four intent refusals and from a provider refusal.
-- It writes no usage row, reserves no budget, and does not replace the saved exchange.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

create function private.refuse_mia_selection(
  p_owner_id uuid,
  p_evidence_id uuid,
  p_request_id uuid,
  p_refusal_code text
) returns table (
  request_id uuid,
  state text,
  result_code text,
  rendered_text text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state text;
  current_type text;
  current_rendered text;
  sentence text;
  usage_exists boolean;
begin
  if p_owner_id is null or p_evidence_id is null or p_request_id is null then
    raise exception 'owner_id, evidence id, and request id are required' using errcode = '22023';
  end if;

  sentence := case p_refusal_code
    when 'unsupported_question' then 'MIA cannot answer that question from this evidence.'
    when 'ambiguous_question' then 'MIA cannot tell which saved value that question asks for.'
    when 'incompatible_currency' then 'Those amounts are not in the same currency, so they stay separate.'
    when 'missing_source' then 'That metric was not included in the saved evidence.'
    when 'zero_denominator' then 'Omitted because the denominator is zero.'
    else null
  end;
  if sentence is null then
    raise exception 'refusal code is not a selection refusal' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  perform 1
  from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id
  for update;

  if not found then
    return query select null::uuid, null::text, 'not_found'::text, null::text;
    return;
  end if;

  select request.state, request.request_type, request.rendered_text
    into current_state, current_type, current_rendered
  from private.mia_request as request
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.evidence_id = p_evidence_id
  for update;

  if not found or current_type is distinct from 'evidence_question' then
    return query select null::uuid, null::text, 'not_found'::text, null::text;
    return;
  end if;

  if current_state = 'refused' then
    return query select p_request_id, 'refused'::text, 'unchanged'::text, current_rendered;
    return;
  end if;

  if current_state is distinct from 'validating' then
    return query select p_request_id, current_state, 'not_refusable'::text, current_rendered;
    return;
  end if;

  select exists (
    select 1
    from private.mia_usage as usage
    where usage.accounting_ref = p_request_id
      and usage.owner_id = p_owner_id
  )
    into usage_exists;

  if usage_exists then
    return query select p_request_id, current_state, 'not_refusable'::text, current_rendered;
    return;
  end if;

  update private.mia_request as request
  set
    state = 'refused',
    rendered_text = sentence,
    validated_references = pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('kind', 'selection_refusal', 'code', p_refusal_code)
    ),
    failure_category = null,
    completed_at = pg_catalog.now()
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.evidence_id = p_evidence_id
    and request.state = 'validating';

  if not found then
    return query select p_request_id, current_state, 'not_refusable'::text, current_rendered;
    return;
  end if;

  return query select p_request_id, 'refused'::text, 'refused'::text, sentence;
end;
$$;

comment on function private.refuse_mia_selection(uuid, uuid, uuid, text) is
  'Refuses one owned validating question before dispatch. The sentence comes from the selection code. It writes no usage, reserves no budget, and does not change the saved exchange.';

revoke all on function private.refuse_mia_selection(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.refuse_mia_selection(uuid, uuid, uuid, text)
  to mediaiq_evidence_writer;

alter function private.refuse_mia_selection(uuid, uuid, uuid, text)
  owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
