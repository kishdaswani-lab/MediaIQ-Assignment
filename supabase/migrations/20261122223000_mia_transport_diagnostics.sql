-- Safe transport diagnostics for one MIA usage attempt.
-- These columns are not returned by the customer request reader.
-- Unknown billing still keeps the worst-case reservation.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

alter table private.mia_usage
  add column transport_outcome text,
  add column http_response_received boolean,
  add column http_status integer,
  add column provider_request_id text,
  add column usage_validated boolean;

alter table private.mia_usage
  add constraint mia_usage_http_status_check
  check (http_status is null or http_status between 100 and 599);

alter table private.mia_usage
  add constraint mia_usage_provider_request_id_check
  check (
    provider_request_id is null
    or provider_request_id ~ '^[A-Za-z0-9._:-]{1,200}$'
  );

alter table private.mia_usage
  add constraint mia_usage_transport_outcome_check
  check (
    transport_outcome is null
    or transport_outcome in (
      'network',
      'http_rejected',
      'malformed_response',
      'timeout',
      'accepted'
    )
  );

alter table private.mia_usage
  add constraint mia_usage_transport_relationship_check
  check (
    (
      transport_outcome is null
      and http_response_received is null
      and http_status is null
      and provider_request_id is null
    )
    or (
      transport_outcome in ('network', 'timeout')
      and http_response_received = false
      and http_status is null
      and provider_request_id is null
    )
    or (
      transport_outcome = 'http_rejected'
      and http_response_received = true
      and http_status is not null
      and (http_status < 200 or http_status > 299)
    )
    or (
      transport_outcome in ('malformed_response', 'accepted')
      and http_response_received = true
      and http_status between 200 and 299
    )
  );

comment on column private.mia_usage.transport_outcome is
  'Controlled transport classification. It is not a billing receipt.';
comment on column private.mia_usage.http_response_received is
  'Whether an HTTP response was received. A request id is not proof of billing.';
comment on column private.mia_usage.http_status is
  'HTTP status when a response was received. The response body is not stored.';
comment on column private.mia_usage.provider_request_id is
  'Sanitized provider request id from the response header, when it matched the allowed pattern.';
comment on column private.mia_usage.usage_validated is
  'Whether the reported token fields passed the usage rules. It does not by itself settle a cost.';

drop function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer
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
  p_cached_input_tokens integer default null,
  p_transport_outcome text default null,
  p_http_response_received boolean default null,
  p_http_status integer default null,
  p_provider_request_id text default null,
  p_usage_validated boolean default null
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
  diag_outcome text := p_transport_outcome;
  diag_received boolean := p_http_response_received;
  diag_status integer := p_http_status;
  diag_request_id text := p_provider_request_id;
  diag_usage_validated boolean;
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
  if diag_request_id is not null and diag_request_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    diag_request_id := null;
  end if;
  if diag_outcome is not null
    and diag_outcome not in ('network', 'http_rejected', 'malformed_response', 'timeout', 'accepted')
  then
    raise exception 'transport outcome is invalid' using errcode = '22023';
  end if;
  if diag_status is not null and (diag_status < 100 or diag_status > 599) then
    raise exception 'http status is invalid' using errcode = '22023';
  end if;
  if diag_outcome is null then
    if diag_received is not null or diag_status is not null or diag_request_id is not null then
      raise exception 'transport diagnostics are incomplete' using errcode = '22023';
    end if;
  elsif diag_outcome in ('network', 'timeout') then
    if diag_received is distinct from false or diag_status is not null or diag_request_id is not null then
      raise exception 'transport diagnostics are inconsistent' using errcode = '22023';
    end if;
  elsif diag_outcome = 'http_rejected' then
    if diag_received is distinct from true
      or diag_status is null
      or diag_status between 200 and 299
    then
      raise exception 'transport diagnostics are inconsistent' using errcode = '22023';
    end if;
  elsif diag_received is distinct from true
    or diag_status is null
    or diag_status < 200
    or diag_status > 299
  then
    raise exception 'transport diagnostics are inconsistent' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  select * into budget
  from private.mia_test_budget as account
  where account.singleton
  for update;

  diag_usage_validated :=
    p_input_tokens is not null
    and p_output_tokens is not null
    and cached_tokens is not null
    and p_other_billable_tokens is null
    and p_input_tokens >= 0
    and p_output_tokens >= 0
    and cached_tokens >= 0
    and cached_tokens <= p_input_tokens
    and p_input_tokens <= budget.max_input_tokens
    and p_output_tokens <= budget.max_output_tokens;
  if p_usage_validated is not null and p_usage_validated is distinct from diag_usage_validated then
    raise exception 'usage_validated does not match the usage fields' using errcode = '22023';
  end if;

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
    billing_status = local_billing,
    transport_outcome = diag_outcome,
    http_response_received = diag_received,
    http_status = diag_status,
    provider_request_id = diag_request_id,
    usage_validated = diag_usage_validated
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
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer, text, boolean, integer, text, boolean
) is
  'Stores provider token counts as reported. Null stays null. A cost is stored only when cached input is known, no additional billable tokens were reported, and both counts are within the approved caps. Otherwise the reservation stays and a later paid claim is denied. Transport diagnostics do not release that reservation. A terminal usage row is not overwritten.';

revoke all on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer, text, boolean, integer, text, boolean
) from public, anon, authenticated, service_role,
  mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer, text, boolean, integer, text, boolean
) to mediaiq_evidence_writer;

alter function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text, integer, text, boolean, integer, text, boolean
) owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
