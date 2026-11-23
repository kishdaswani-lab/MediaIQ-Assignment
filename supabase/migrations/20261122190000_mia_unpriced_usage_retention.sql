-- Preserve provider-reported token counts when a cost cannot be reconciled.
-- The previous function stored cached input in the other-billable argument and
-- then wrote other_billable_tokens as null. This replacement keeps that column.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

drop function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text
);

create function private.record_mia_attempt_outcome(
  p_owner_id uuid,
  p_accounting_ref uuid,
  p_attempt_number integer,
  p_outcome text,
  p_billing_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_other_billable_tokens integer,
  p_estimated_cost numeric,
  p_actual_cost numeric,
  p_latency_ms integer,
  p_rendered_text text,
  p_validated_references jsonb,
  p_failure_category text,
  p_exchange_question text,
  p_exchange_answer text,
  p_cached_input_tokens integer default null
) returns table (
  usage_updated boolean,
  request_state text,
  usage_outcome text,
  actual_cost numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_outcome text;
  current_cost numeric;
  request_evidence uuid;
  request_type text;
  request_state text;
  evidence_present boolean;
  budget private.mia_test_budget%rowtype;
  local_outcome text := p_outcome;
  local_billing text := p_billing_status;
  local_rendered text := p_rendered_text;
  local_failure text := p_failure_category;
  local_exchange_question text := p_exchange_question;
  local_exchange_answer text := p_exchange_answer;
  cached_tokens integer := p_cached_input_tokens;
  actual_php numeric := null;
  actual_usd numeric := null;
  estimated_usd numeric := null;
begin
  if p_owner_id is null or p_accounting_ref is null or p_attempt_number is distinct from 1 then
    raise exception 'usage identity is invalid' using errcode = '22023';
  end if;
  if p_outcome not in ('completed', 'refused', 'failed', 'timed_out', 'reconciliation_required')
    or p_billing_status not in ('reported', 'non_billable', 'unknown')
  then
    raise exception 'usage outcome is invalid' using errcode = '22023';
  end if;
  if p_billing_status = 'unknown' and (p_estimated_cost is not null or p_actual_cost is not null) then
    raise exception 'unknown billing cannot store a cost' using errcode = '22023';
  end if;
  if p_billing_status = 'reported' and p_actual_cost is null and p_input_tokens is null then
    raise exception 'reported billing requires an actual cost' using errcode = '22023';
  end if;
  if p_validated_references is not null
    and pg_catalog.jsonb_typeof(p_validated_references) is distinct from 'array'
  then
    raise exception 'validated references must be an array' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  select * into budget
  from private.mia_test_budget as account
  where account.singleton
  for update;

  select request.evidence_id, request.request_type, request.state
    into request_evidence, request_type, request_state
  from private.mia_request as request
  where request.id = p_accounting_ref
    and request.owner_id = p_owner_id;

  evidence_present := false;
  if request_evidence is not null then
    perform 1
    from private.campaign_evidence as evidence
    where evidence.id = request_evidence
      and evidence.owner_id = p_owner_id
    for update;

    if found then
      select request.state
        into request_state
      from private.mia_request as request
      where request.id = p_accounting_ref
        and request.owner_id = p_owner_id
      for update;
      evidence_present := found;
    end if;
  end if;

  if not evidence_present then
    request_state := null;
  end if;

  select usage.outcome, usage.actual_cost
    into current_outcome, current_cost
  from private.mia_usage as usage
  where usage.accounting_ref = p_accounting_ref
    and usage.attempt_number = p_attempt_number
    and usage.owner_id = p_owner_id
  for update;

  if current_outcome is null then
    raise exception 'usage attempt was not found' using errcode = 'P0002';
  end if;

  if current_outcome <> 'processing' then
    return query
    select false, request_state, current_outcome, current_cost;
    return;
  end if;

  if local_billing = 'reported' then
    estimated_usd := budget.usd_hold;
    if p_input_tokens is null
      or p_output_tokens is null
      or cached_tokens is null
      or cached_tokens > p_input_tokens
      or p_other_billable_tokens is not null
      or p_input_tokens > budget.max_input_tokens
      or p_output_tokens > budget.max_output_tokens
      or budget.usd_per_million_uncached_input is null
    then
      local_outcome := 'reconciliation_required';
      local_billing := 'unknown';
      local_rendered := null;
      local_failure := 'unreconciled_billing';
      local_exchange_question := null;
      local_exchange_answer := null;
      actual_php := null;
      actual_usd := null;
      estimated_usd := null;
    else
      actual_php := (
        (p_input_tokens - cached_tokens) * budget.php_per_million_uncached_input
        + cached_tokens * budget.php_per_million_cached_input
        + p_output_tokens * budget.php_per_million_output
      ) / 1000000;
      actual_usd := (
        (p_input_tokens - cached_tokens) * budget.usd_per_million_uncached_input
        + cached_tokens * budget.usd_per_million_cached_input
        + p_output_tokens * budget.usd_per_million_output
      ) / 1000000;
      if actual_php > budget.php_hold
        or actual_usd > budget.usd_hold
        or budget.php_spent + actual_php > budget.php_ceiling
        or budget.usd_spent + actual_usd > budget.usd_ceiling
      then
        local_outcome := 'reconciliation_required';
        local_billing := 'unknown';
        local_rendered := null;
        local_failure := 'unreconciled_billing';
        local_exchange_question := null;
        local_exchange_answer := null;
        actual_php := null;
        actual_usd := null;
        estimated_usd := null;
      end if;
    end if;
  elsif local_billing = 'unknown' then
    actual_php := null;
    actual_usd := null;
    estimated_usd := null;
  else
    actual_php := 0;
    actual_usd := null;
    estimated_usd := null;
  end if;

  update private.mia_usage as usage
  set
    input_tokens = p_input_tokens,
    cached_input_tokens = cached_tokens,
    output_tokens = p_output_tokens,
    other_billable_tokens = p_other_billable_tokens,
    estimated_cost = estimated_usd,
    actual_cost = actual_usd,
    latency_ms = p_latency_ms,
    outcome = local_outcome,
    billing_status = local_billing
  where usage.accounting_ref = p_accounting_ref
    and usage.attempt_number = p_attempt_number
    and usage.owner_id = p_owner_id
    and usage.outcome = 'processing';

  if local_billing = 'unknown' then
    null;
  else
    update private.mia_test_budget as account
    set
      php_reserved = account.php_reserved - account.php_hold,
      usd_reserved = account.usd_reserved - account.usd_hold,
      php_spent = account.php_spent + coalesce(actual_php, 0),
      usd_spent = account.usd_spent + coalesce(actual_usd, 0),
      php_hold = 0,
      usd_hold = 0
    where account.singleton
      and account.php_hold > 0;
  end if;

  if request_state = 'processing' and evidence_present then
    update private.mia_request as request
    set
      state = local_outcome,
      rendered_text = local_rendered,
      validated_references = case
        when local_outcome = 'reconciliation_required' then null
        else p_validated_references
      end,
      failure_category = local_failure,
      completed_at = pg_catalog.now()
    where request.id = p_accounting_ref
      and request.owner_id = p_owner_id
      and request.state = 'processing';

    if request_type = 'evidence_question'
      and local_outcome in ('completed', 'refused')
      and local_exchange_question is not null
      and local_exchange_answer is not null
    then
      update private.campaign_evidence as evidence
      set
        latest_question = local_exchange_question,
        latest_answer = local_exchange_answer,
        latest_exchange_at = pg_catalog.now()
      where evidence.id = request_evidence
        and evidence.owner_id = p_owner_id;
    end if;

    request_state := local_outcome;
  end if;

  return query select true, request_state, local_outcome, actual_usd;
end;
$$;

comment on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer
) is
  'Stores provider token counts as reported. Null stays null. A cost is stored only when cached input is known, no additional billable tokens were reported, and both counts are within the approved caps. Otherwise the reservation stays and a later paid claim is denied. A terminal usage row is not overwritten.';

revoke all on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer
) from public, anon, authenticated, service_role,
  mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer
) to mediaiq_evidence_writer;

alter function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer
) owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
