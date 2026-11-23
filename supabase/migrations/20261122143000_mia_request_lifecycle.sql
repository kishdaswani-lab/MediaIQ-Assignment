-- MIA request lifecycle. This file does not edit an applied migration.
-- It does not insert a provider or model, and it does not create a credential.
-- The evidence owner gains UPDATE only so the lifecycle functions can lock
-- an evidence row and replace the latest exchange. A trigger still rejects
-- changes to the CSV, summary, owner, and versions.

grant mediaiq_evidence_owner to current_user;
grant create on schema private to mediaiq_evidence_owner;

create function private.campaign_evidence_source_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
    or new.created_at is distinct from old.created_at
    or new.source_text is distinct from old.source_text
    or new.summary is distinct from old.summary
    or new.parser_version is distinct from old.parser_version
    or new.calculation_version is distinct from old.calculation_version
  then
    raise exception 'campaign evidence source is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger campaign_evidence_source_immutable
  before update on private.campaign_evidence
  for each row
  execute function private.campaign_evidence_source_immutable();

grant update on table private.campaign_evidence to mediaiq_evidence_owner;

create policy campaign_evidence_owner_exchange_update
  on private.campaign_evidence
  for update
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  )
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create table private.mia_request (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  evidence_id uuid not null references private.campaign_evidence (id) on delete cascade,
  request_type text not null,
  state text not null,
  idempotency_key text not null,
  payload_fingerprint text not null,
  question_text text,
  rendered_text text,
  validated_references jsonb,
  failure_category text,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint mia_request_type_check
    check (request_type in ('performance_summary', 'evidence_question')),
  constraint mia_request_state_check
    check (state in (
      'submitted',
      'validating',
      'processing',
      'completed',
      'refused',
      'failed',
      'timed_out',
      'reconciliation_required'
    )),
  constraint mia_request_key_check
    check (pg_catalog.octet_length(idempotency_key) between 1 and 200),
  constraint mia_request_fingerprint_check
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint mia_request_question_check
    check (
      (
        request_type = 'performance_summary'
        and question_text is null
      )
      or (
        request_type = 'evidence_question'
        and question_text is not null
        and pg_catalog.octet_length(question_text) between 1 and 4000
      )
    ),
  constraint mia_request_references_check
    check (
      validated_references is null
      or pg_catalog.jsonb_typeof(validated_references) = 'array'
    ),
  constraint mia_request_owner_key_unique
    unique (owner_id, request_type, idempotency_key)
);

create unique index mia_request_one_summary_per_evidence_idx
  on private.mia_request (evidence_id)
  where request_type = 'performance_summary';

create index mia_request_owner_evidence_created_idx
  on private.mia_request (owner_id, evidence_id, created_at desc);

create index mia_request_state_created_idx
  on private.mia_request (state, created_at);

create function private.mia_request_transition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
    or new.evidence_id is distinct from old.evidence_id
    or new.request_type is distinct from old.request_type
    or new.idempotency_key is distinct from old.idempotency_key
    or new.payload_fingerprint is distinct from old.payload_fingerprint
    or new.question_text is distinct from old.question_text
    or new.created_at is distinct from old.created_at
  then
    raise exception 'mia request identity is immutable'
      using errcode = '55000';
  end if;

  if new.state = old.state then
    return new;
  end if;

  if (
    old.state = 'submitted' and new.state = 'validating'
  ) or (
    old.state = 'validating' and new.state in ('processing', 'refused', 'failed')
  ) or (
    old.state = 'processing' and new.state in (
      'completed',
      'refused',
      'failed',
      'timed_out',
      'reconciliation_required'
    )
  ) then
    return new;
  end if;

  raise exception 'illegal mia request transition from % to %', old.state, new.state
    using errcode = '23514';
end;
$$;

create trigger mia_request_transition_guard
  before update on private.mia_request
  for each row
  execute function private.mia_request_transition_guard();

create table private.mia_usage (
  accounting_ref uuid not null,
  owner_id uuid not null,
  attempt_number integer not null,
  provider text not null,
  model text not null,
  input_tokens integer,
  output_tokens integer,
  other_billable_tokens integer,
  estimated_cost numeric,
  actual_cost numeric,
  latency_ms integer,
  outcome text not null,
  billing_status text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint mia_usage_attempt_pk primary key (accounting_ref, attempt_number),
  constraint mia_usage_one_attempt_check check (attempt_number = 1),
  constraint mia_usage_names_check
    check (
      provider ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
      and model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    ),
  constraint mia_usage_outcome_check
    check (outcome in (
      'processing',
      'completed',
      'refused',
      'failed',
      'timed_out',
      'reconciliation_required'
    )),
  constraint mia_usage_billing_check
    check (billing_status in ('reported', 'non_billable', 'unknown')),
  constraint mia_usage_unknown_cost_check
    check (
      billing_status <> 'unknown'
      or (estimated_cost is null and actual_cost is null)
    ),
  constraint mia_usage_reported_cost_check
    check (billing_status <> 'reported' or actual_cost is not null),
  constraint mia_usage_nonnegative_check
    check (
      (input_tokens is null or input_tokens >= 0)
      and (output_tokens is null or output_tokens >= 0)
      and (other_billable_tokens is null or other_billable_tokens >= 0)
      and (estimated_cost is null or estimated_cost >= 0)
      and (actual_cost is null or actual_cost >= 0)
      and (latency_ms is null or latency_ms >= 0)
    )
);

create index mia_usage_owner_created_idx
  on private.mia_usage (owner_id, created_at);

create table private.mia_approved_provider (
  singleton boolean primary key default true,
  provider text not null,
  model text not null,
  approved_at timestamptz not null default pg_catalog.now(),
  constraint mia_approved_provider_singleton_check check (singleton = true),
  constraint mia_approved_provider_names_check
    check (
      provider = pg_catalog.btrim(provider)
      and model = pg_catalog.btrim(model)
      and pg_catalog.octet_length(provider) between 1 and 64
      and pg_catalog.octet_length(model) between 1 and 64
    )
);

comment on table private.mia_approved_provider is
  'At most one approved provider and model. Created empty. No row is inserted by this migration.';

alter table private.mia_request enable row level security;
alter table private.mia_request force row level security;
alter table private.mia_usage enable row level security;
alter table private.mia_usage force row level security;
alter table private.mia_approved_provider enable row level security;
alter table private.mia_approved_provider force row level security;

revoke all on table private.mia_request
  from public, anon, authenticated, service_role, mediaiq_evidence_owner, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.mia_usage
  from public, anon, authenticated, service_role, mediaiq_evidence_owner, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on table private.mia_approved_provider
  from public, anon, authenticated, service_role, mediaiq_evidence_owner, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant select, insert, update, delete on table private.mia_request to mediaiq_evidence_owner;
grant select, insert, update on table private.mia_usage to mediaiq_evidence_owner;
grant select on table private.mia_approved_provider to mediaiq_evidence_owner;

create policy mia_request_owner_select
  on private.mia_request
  for select
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_request_owner_insert
  on private.mia_request
  for insert
  to mediaiq_evidence_owner
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_request_owner_update
  on private.mia_request
  for update
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  )
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_request_owner_delete
  on private.mia_request
  for delete
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_usage_owner_select
  on private.mia_usage
  for select
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_usage_owner_insert
  on private.mia_usage
  for insert
  to mediaiq_evidence_owner
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_usage_owner_update
  on private.mia_usage
  for update
  to mediaiq_evidence_owner
  using (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  )
  with check (
    owner_id = nullif(pg_catalog.current_setting('mediaiq.evidence_owner_id', true), '')::uuid
  );

create policy mia_approved_provider_read
  on private.mia_approved_provider
  for select
  to mediaiq_evidence_owner
  using (true);

create function private.open_mia_request(
  p_owner_id uuid,
  p_evidence_id uuid,
  p_request_type text,
  p_idempotency_key text,
  p_payload_fingerprint text,
  p_question_text text
) returns table (
  request_id uuid,
  state text,
  result_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  existing_state text;
  existing_fingerprint text;
  existing_type text;
  created_id uuid;
begin
  if p_owner_id is null or p_evidence_id is null then
    raise exception 'owner_id and evidence id are required' using errcode = '22023';
  end if;
  if p_request_type not in ('performance_summary', 'evidence_question')
    or p_idempotency_key is null
    or pg_catalog.octet_length(p_idempotency_key) not between 1 and 200
    or p_payload_fingerprint is null
    or p_payload_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception 'mia request shape is invalid' using errcode = '22023';
  end if;
  if p_request_type = 'performance_summary' and p_question_text is not null then
    raise exception 'a summary request has no question' using errcode = '22023';
  end if;
  if p_request_type = 'evidence_question'
    and (
      p_question_text is null
      or pg_catalog.octet_length(p_question_text) not between 1 and 4000
    )
  then
    raise exception 'a question request requires question text' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

  perform 1
  from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id
  for update;

  if not found then
    return query select null::uuid, null::text, 'not_found'::text;
    return;
  end if;

  if p_request_type = 'performance_summary' then
    select request.id, request.state, request.payload_fingerprint, request.request_type
      into existing_id, existing_state, existing_fingerprint, existing_type
    from private.mia_request as request
    where request.evidence_id = p_evidence_id
      and request.request_type = 'performance_summary'
      and request.owner_id = p_owner_id
    for update;
  else
    select request.id, request.state, request.payload_fingerprint, request.request_type
      into existing_id, existing_state, existing_fingerprint, existing_type
    from private.mia_request as request
    where request.owner_id = p_owner_id
      and request.request_type = p_request_type
      and request.idempotency_key = p_idempotency_key
    for update;
  end if;

  if existing_id is not null then
    if existing_fingerprint is distinct from p_payload_fingerprint
      or existing_type is distinct from p_request_type
    then
      return query select existing_id, existing_state, 'fingerprint_mismatch'::text;
      return;
    end if;
    perform 1
    from private.mia_request as request
    where request.id = existing_id
      and request.evidence_id = p_evidence_id;
    if not found then
      return query select existing_id, existing_state, 'fingerprint_mismatch'::text;
      return;
    end if;
    if existing_state = 'submitted' then
      update private.mia_request as request
      set state = 'validating'
      where request.id = existing_id
        and request.state = 'submitted';
      return query select existing_id, 'validating'::text, 'progressed'::text;
      return;
    end if;
    return query select existing_id, existing_state, 'unchanged'::text;
    return;
  end if;

  begin
    insert into private.mia_request (
      owner_id,
      evidence_id,
      request_type,
      state,
      idempotency_key,
      payload_fingerprint,
      question_text
    ) values (
      p_owner_id,
      p_evidence_id,
      p_request_type,
      'submitted',
      p_idempotency_key,
      p_payload_fingerprint,
      p_question_text
    )
    returning id into created_id;
  exception
    when unique_violation then
      select request.id, request.state, request.payload_fingerprint
        into existing_id, existing_state, existing_fingerprint
      from private.mia_request as request
      where request.owner_id = p_owner_id
        and (
          (
            p_request_type = 'performance_summary'
            and request.request_type = 'performance_summary'
            and request.evidence_id = p_evidence_id
          )
          or (
            request.request_type = p_request_type
            and request.idempotency_key = p_idempotency_key
          )
        )
      for update;
      if existing_fingerprint is distinct from p_payload_fingerprint then
        return query select existing_id, existing_state, 'fingerprint_mismatch'::text;
        return;
      end if;
      return query select existing_id, existing_state, 'unchanged'::text;
      return;
  end;

  update private.mia_request as request
  set state = 'validating'
  where request.id = created_id
    and request.state = 'submitted';

  return query select created_id, 'validating'::text, 'created'::text;
end;
$$;

create function private.claim_mia_dispatch(
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
begin
  if p_owner_id is null or p_request_id is null then
    raise exception 'owner_id and request id are required' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

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

  update private.mia_request as request
  set state = 'processing'
  where request.id = p_request_id
    and request.owner_id = p_owner_id
    and request.state = 'validating';

  if not found then
    return query select false, null::uuid, null::integer, current_state, null::text, null::text;
    return;
  end if;

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
  if p_billing_status = 'reported' and p_actual_cost is null then
    raise exception 'reported billing requires an actual cost' using errcode = '22023';
  end if;
  if p_validated_references is not null
    and pg_catalog.jsonb_typeof(p_validated_references) is distinct from 'array'
  then
    raise exception 'validated references must be an array' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('mediaiq.evidence_owner_id', p_owner_id::text, true);

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

  update private.mia_usage as usage
  set
    input_tokens = p_input_tokens,
    output_tokens = p_output_tokens,
    other_billable_tokens = p_other_billable_tokens,
    estimated_cost = p_estimated_cost,
    actual_cost = p_actual_cost,
    latency_ms = p_latency_ms,
    outcome = p_outcome,
    billing_status = p_billing_status
  where usage.accounting_ref = p_accounting_ref
    and usage.attempt_number = p_attempt_number
    and usage.owner_id = p_owner_id
    and usage.outcome = 'processing';

  if request_state = 'processing' and evidence_present then
    update private.mia_request as request
    set
      state = p_outcome,
      rendered_text = p_rendered_text,
      validated_references = p_validated_references,
      failure_category = p_failure_category,
      completed_at = pg_catalog.now()
    where request.id = p_accounting_ref
      and request.owner_id = p_owner_id
      and request.state = 'processing';

    if request_type = 'evidence_question'
      and p_outcome in ('completed', 'refused')
      and p_exchange_question is not null
      and p_exchange_answer is not null
    then
      update private.campaign_evidence as evidence
      set
        latest_question = p_exchange_question,
        latest_answer = p_exchange_answer,
        latest_exchange_at = pg_catalog.now()
      where evidence.id = request_evidence
        and evidence.owner_id = p_owner_id;
    end if;

    request_state := p_outcome;
  end if;

  return query select true, request_state, p_outcome, p_actual_cost;
end;
$$;

create function private.read_mia_evidence_context(
  p_owner_id uuid,
  p_evidence_id uuid
) returns table (
  id uuid,
  summary jsonb,
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
    evidence.summary,
    evidence.latest_question,
    evidence.latest_answer,
    evidence.latest_exchange_at
  from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id;
end;
$$;

create or replace function private.delete_campaign_evidence(
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

  perform 1
  from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id
  for update;

  delete from private.campaign_evidence as evidence
  where evidence.id = p_evidence_id
    and evidence.owner_id = p_owner_id
  returning evidence.id into deleted_id;

  return deleted_id;
end;
$$;

comment on function private.delete_campaign_evidence(uuid, uuid) is
  'Locks and deletes one owner row. Request content and the latest exchange leave with it. Usage rows are not referenced and are not deleted.';

comment on function private.read_mia_evidence_context(uuid, uuid) is
  'Returns the calculated summary and latest exchange for one owner. Source text is not in the result.';

comment on function private.claim_mia_dispatch(uuid, uuid) is
  'Reserves attempt 1 and authorizes dispatch only when the single approved provider row is valid.';

revoke all on function private.open_mia_request(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on function private.claim_mia_dispatch(uuid, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text
) from public, anon, authenticated, service_role,
  mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
revoke all on function private.read_mia_evidence_context(uuid, uuid)
  from public, anon, authenticated, service_role,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

grant execute on function private.open_mia_request(uuid, uuid, text, text, text, text)
  to mediaiq_evidence_writer;
grant execute on function private.claim_mia_dispatch(uuid, uuid)
  to mediaiq_evidence_writer;
grant execute on function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text
) to mediaiq_evidence_writer;
grant execute on function private.read_mia_evidence_context(uuid, uuid)
  to mediaiq_evidence_writer;

alter function private.campaign_evidence_source_immutable() owner to mediaiq_evidence_owner;
alter function private.mia_request_transition_guard() owner to mediaiq_evidence_owner;
alter function private.open_mia_request(uuid, uuid, text, text, text, text) owner to mediaiq_evidence_owner;
alter function private.claim_mia_dispatch(uuid, uuid) owner to mediaiq_evidence_owner;
alter function private.record_mia_attempt_outcome(
  uuid, uuid, integer, text, text, integer, integer, integer, numeric, numeric, integer, text, jsonb, text, text, text
) owner to mediaiq_evidence_owner;
alter function private.read_mia_evidence_context(uuid, uuid) owner to mediaiq_evidence_owner;
alter function private.delete_campaign_evidence(uuid, uuid) owner to mediaiq_evidence_owner;
alter table private.mia_request owner to mediaiq_evidence_owner;
alter table private.mia_usage owner to mediaiq_evidence_owner;
alter table private.mia_approved_provider owner to mediaiq_evidence_owner;

revoke create on schema private from mediaiq_evidence_owner;
revoke mediaiq_evidence_owner from current_user;
