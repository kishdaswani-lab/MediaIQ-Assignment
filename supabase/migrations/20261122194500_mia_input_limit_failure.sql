-- Terminal pre-dispatch failure when a request cannot fit the input ceiling.
-- No usage row and no budget reservation.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

create function private.fail_mia_request_before_dispatch(
  p_owner_id uuid,
  p_evidence_id uuid,
  p_request_id uuid
) returns table (
  request_id uuid,
  state text,
  result_code text,
  failure_category text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state text;
  current_failure text;
  current_rendered text;
  limit_message text := 'This evidence is too large to send within the 3,000-token input limit.';
begin
  if p_owner_id is null or p_evidence_id is null or p_request_id is null then
    raise exception 'owner_id, evidence id, and request id are required' using errcode = '22023';
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

  select request.state, request.failure_category, request.rendered_text
    into current_state, current_failure, current_rendered
  from private.mia_request as request
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.evidence_id = p_evidence_id
  for update;

  if not found then
    return query select null::uuid, null::text, 'not_found'::text, null::text;
    return;
  end if;

  if current_state = 'failed' and current_failure = limit_message and current_rendered is null then
    return query select p_request_id, 'failed'::text, 'unchanged'::text, current_failure;
    return;
  end if;

  if current_state is distinct from 'validating' then
    return query select p_request_id, current_state, 'not_pre_dispatch'::text, current_failure;
    return;
  end if;

  if exists (
    select 1
    from private.mia_usage as usage
    where usage.accounting_ref = p_request_id
      and usage.owner_id = p_owner_id
  ) then
    return query select p_request_id, current_state, 'not_pre_dispatch'::text, current_failure;
    return;
  end if;

  update private.mia_request as request
  set
    state = 'failed',
    rendered_text = null,
    validated_references = null,
    failure_category = limit_message,
    completed_at = pg_catalog.now()
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.evidence_id = p_evidence_id
    and request.state = 'validating';

  return query select p_request_id, 'failed'::text, 'failed'::text, limit_message;
end;
$$;

comment on function private.fail_mia_request_before_dispatch(uuid, uuid, uuid) is
  'Marks one validating request failed when it cannot be sent. It does not create usage, reserve budget, write an answer, or change the saved exchange.';

revoke all on function private.fail_mia_request_before_dispatch(uuid, uuid, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.fail_mia_request_before_dispatch(uuid, uuid, uuid)
  to mediaiq_evidence_writer;

alter function private.fail_mia_request_before_dispatch(uuid, uuid, uuid)
  owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
