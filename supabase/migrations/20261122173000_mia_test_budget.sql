-- Monday testing budget. This file does not edit an applied migration.
-- Prices stay null, so a claim cannot reserve a cost or authorize dispatch
-- until a separate owner decision supplies the price card.
-- PHP 500 and USD 8 are independent ceilings. No exchange rate is stored.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

create table private.mia_test_budget (
  singleton boolean primary key default true,
  php_ceiling numeric not null,
  php_reserved numeric not null default 0,
  php_spent numeric not null default 0,
  php_hold numeric not null default 0,
  usd_ceiling numeric not null,
  usd_reserved numeric not null default 0,
  usd_spent numeric not null default 0,
  usd_hold numeric not null default 0,
  max_input_tokens integer not null,
  max_output_tokens integer not null,
  php_per_million_uncached_input numeric,
  php_per_million_cached_input numeric,
  php_per_million_output numeric,
  usd_per_million_uncached_input numeric,
  usd_per_million_cached_input numeric,
  usd_per_million_output numeric,
  constraint mia_test_budget_singleton_check check (singleton = true),
  constraint mia_test_budget_ceiling_check check (
    php_ceiling = 500
    and usd_ceiling = 8
    and max_input_tokens = 3000
    and max_output_tokens = 500
  ),
  constraint mia_test_budget_nonnegative_check check (
    php_reserved >= 0 and php_spent >= 0 and php_hold >= 0
    and usd_reserved >= 0 and usd_spent >= 0 and usd_hold >= 0
    and php_hold <= php_reserved
    and usd_hold <= usd_reserved
    and php_reserved + php_spent <= php_ceiling
    and usd_reserved + usd_spent <= usd_ceiling
  ),
  constraint mia_test_budget_price_check check (
    (
      php_per_million_uncached_input is null
      and php_per_million_cached_input is null
      and php_per_million_output is null
      and usd_per_million_uncached_input is null
      and usd_per_million_cached_input is null
      and usd_per_million_output is null
    )
    or (
      php_per_million_uncached_input > 0
      and php_per_million_cached_input > 0
      and php_per_million_output > 0
      and usd_per_million_uncached_input > 0
      and usd_per_million_cached_input > 0
      and usd_per_million_output > 0
      and php_per_million_cached_input <= php_per_million_uncached_input
      and usd_per_million_cached_input <= usd_per_million_uncached_input
    )
  )
);

insert into private.mia_test_budget (
  singleton,
  php_ceiling,
  usd_ceiling,
  max_input_tokens,
  max_output_tokens
) values (true, 500, 8, 3000, 500);

alter table private.mia_usage
  add column cached_input_tokens integer;

alter table private.mia_usage
  add constraint mia_usage_cached_tokens_check
  check (cached_input_tokens is null or cached_input_tokens >= 0);

alter table private.mia_test_budget enable row level security;
alter table private.mia_test_budget force row level security;

revoke all on table private.mia_test_budget
  from public, anon, authenticated, service_role, mediaiq_evidence_owner, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant select, update on table private.mia_test_budget to mediaiq_evidence_owner;

create policy mia_test_budget_select
  on private.mia_test_budget
  for select
  to mediaiq_evidence_owner
  using (true);

create policy mia_test_budget_update
  on private.mia_test_budget
  for update
  to mediaiq_evidence_owner
  using (true)
  with check (true);

comment on table private.mia_test_budget is
  'Singleton Monday testing budget. Prices are null until the owner supplies a price card. Reserved plus spent cannot pass either ceiling.';

comment on column private.mia_usage.cached_input_tokens is
  'Cached input tokens reported by the provider. Unpriced extra categories are not stored as a cost.';

create or replace function private.claim_mia_dispatch(
  p_owner_id uuid,
  p_request_id uuid
) returns table (
  authorized boolean,
  accounting_ref uuid,
  attempt_number integer,
  state text,
  provider text,
  model text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  evidence_id uuid;
  current_state text;
  approved_count integer;
  approved_provider text;
  approved_model text;
  budget private.mia_test_budget%rowtype;
  worst_php numeric;
  worst_usd numeric;
  processing_count integer;
begin
  if p_owner_id is null or p_request_id is null then
    raise exception 'owner_id and request id are required' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  select * into budget
  from private.mia_test_budget as account
  where account.singleton
  for update;

  select request.evidence_id, request.state
    into evidence_id, current_state
  from private.mia_request as request
  where request.id = p_request_id
    and request.owner_id = p_owner_id;

  if evidence_id is null then
    return query select false, null::uuid, null::integer, 'not_found'::text, null::text, null::text;
    return;
  end if;

  perform 1
  from private.campaign_evidence as evidence
  where evidence.id = evidence_id
    and evidence.owner_id = p_owner_id
  for update;

  if not found then
    return query select false, null::uuid, null::integer, 'not_found'::text, null::text, null::text;
    return;
  end if;

  select request.state
    into current_state
  from private.mia_request as request
  where request.id = p_request_id
    and request.owner_id = p_owner_id
  for update;

  if current_state is distinct from 'validating' then
    return query select false, null::uuid, null::integer, current_state, null::text, null::text;
    return;
  end if;

  select count(*)::integer, min(approval.provider), min(approval.model)
    into approved_count, approved_provider, approved_model
  from private.mia_approved_provider as approval;

  if approved_count is distinct from 1
    or approved_provider is null
    or approved_model is null
    or approved_provider !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    or approved_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  then
    return query select false, null::uuid, null::integer, current_state, null::text, null::text;
    return;
  end if;

  if budget.singleton is distinct from true
    or budget.php_per_million_uncached_input is null
    or budget.php_per_million_cached_input is null
    or budget.php_per_million_output is null
    or budget.usd_per_million_uncached_input is null
    or budget.usd_per_million_cached_input is null
    or budget.usd_per_million_output is null
  then
    return query select false, null::uuid, null::integer, current_state, null::text, null::text;
    return;
  end if;

  worst_php := (
    budget.max_input_tokens * budget.php_per_million_uncached_input
    + budget.max_output_tokens * budget.php_per_million_output
  ) / 1000000;
  worst_usd := (
    budget.max_input_tokens * budget.usd_per_million_uncached_input
    + budget.max_output_tokens * budget.usd_per_million_output
  ) / 1000000;

  select count(*)::integer
    into processing_count
  from private.mia_usage as usage
  where usage.outcome = 'processing';

  if processing_count > 0
    or budget.php_reserved > 0
    or budget.usd_reserved > 0
    or budget.php_reserved + budget.php_spent + worst_php > budget.php_ceiling
    or budget.usd_reserved + budget.usd_spent + worst_usd > budget.usd_ceiling
  then
    return query select false, null::uuid, null::integer, current_state, null::text, null::text;
    return;
  end if;

  update private.mia_request as request
  set state = 'processing'
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.state = 'validating';

  if not found then
    return query select false, null::uuid, null::integer, current_state, null::text, null::text;
    return;
  end if;

  update private.mia_test_budget as account
  set
    php_reserved = account.php_reserved + worst_php,
    usd_reserved = account.usd_reserved + worst_usd,
    php_hold = worst_php,
    usd_hold = worst_usd
  where account.singleton;

  insert into private.mia_usage (
    accounting_ref,
    owner_id,
    attempt_number,
    provider,
    model,
    outcome,
    billing_status
  ) values (
    p_request_id,
    p_owner_id,
    1,
    approved_provider,
    approved_model,
    'processing',
    'unknown'
  );

  return query select true, p_request_id, 1, 'processing'::text, approved_provider, approved_model;
end;
$$;

create or replace function private.record_mia_attempt_outcome(
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
  p_exchange_answer text
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
  cached_tokens integer := p_other_billable_tokens;
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
    other_billable_tokens = null,
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

comment on function private.claim_mia_dispatch(uuid, uuid) is
  'Reserves the worst-case testing cost and attempt 1 only when one approved provider is valid and both ceilings can hold the reservation.';

alter table private.mia_test_budget owner to mediaiq_evidence_owner;
alter function private.claim_mia_dispatch(uuid, uuid) owner to mediaiq_evidence_owner;
alter function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text
) owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
