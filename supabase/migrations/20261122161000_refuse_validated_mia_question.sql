-- Provider-free validated refusals and a narrow request reader.
-- This file does not edit an applied migration, the transition trigger,
-- or the approved-provider table. It inserts no provider and no usage row.

create function private.refuse_validated_mia_question(
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
  current_question text;
  current_rendered text;
  sentence text;
  usage_exists boolean;
begin
  if p_owner_id is null or p_evidence_id is null or p_request_id is null then
    raise exception 'owner_id, evidence id, and request id are required' using errcode = '22023';
  end if;

  sentence := case p_refusal_code
    when 'recommendation' then 'MIA cannot recommend a campaign or budget change from this evidence.'
    when 'external_benchmark' then 'MIA cannot use an external benchmark. Only this saved evidence is available.'
    when 'prediction' then 'MIA cannot predict future performance from this evidence.'
    when 'causal_claim' then 'MIA cannot explain a cause from this evidence.'
    else null
  end;
  if sentence is null then
    raise exception 'refusal code is not a validated server refusal' using errcode = '22023';
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

  select request.state, request.request_type, request.question_text, request.rendered_text
    into current_state, current_type, current_question, current_rendered
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

  if current_state is distinct from 'validating' or current_question is null then
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
      pg_catalog.jsonb_build_object('kind', 'server_refusal', 'code', p_refusal_code)
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

  update private.campaign_evidence as evidence
  set
    latest_question = current_question,
    latest_answer = sentence,
    latest_exchange_at = pg_catalog.now()
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id;

  return query select p_request_id, 'refused'::text, 'refused'::text, sentence;
end;
$$;

create function private.read_mia_request(
  p_owner_id uuid,
  p_evidence_id uuid,
  p_request_id uuid
) returns table (
  request_id uuid,
  request_type text,
  state text,
  rendered_text text,
  failure_category text,
  created_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null or p_evidence_id is null or p_request_id is null then
    raise exception 'owner_id, evidence id, and request id are required' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  return query
  select
    request.id,
    request.request_type,
    request.state,
    request.rendered_text,
    request.failure_category,
    request.created_at,
    request.completed_at
  from private.mia_request as request
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.evidence_id = p_evidence_id;
end;
$$;

comment on function private.refuse_validated_mia_question(uuid, uuid, uuid, text) is
  'Refuses one owned validating question with a server sentence. It writes no usage row and accepts no caller answer.';

comment on function private.read_mia_request(uuid, uuid, uuid) is
  'Returns state and rendered text for one owned request. Question text, fingerprints, and provider data are not in the result.';

revoke all on function private.refuse_validated_mia_question(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on function private.read_mia_request(uuid, uuid, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.refuse_validated_mia_question(uuid, uuid, uuid, text)
  to mediaiq_evidence_writer;
grant execute on function private.read_mia_request(uuid, uuid, uuid)
  to mediaiq_evidence_writer;

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;
alter function private.refuse_validated_mia_question(uuid, uuid, uuid, text) owner to mediaiq_evidence_owner;
alter function private.read_mia_request(uuid, uuid, uuid) owner to mediaiq_evidence_owner;
revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
