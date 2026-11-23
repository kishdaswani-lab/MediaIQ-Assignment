-- Public execute on these trigger functions was granted by the evidence
-- owner. Only that role can revoke it.

grant mediaiq_evidence_owner to current_user;
set role mediaiq_evidence_owner;

revoke all on function private.campaign_evidence_source_immutable() from public;
revoke all on function private.mia_request_transition_guard() from public;

reset role;
revoke mediaiq_evidence_owner from current_user;
