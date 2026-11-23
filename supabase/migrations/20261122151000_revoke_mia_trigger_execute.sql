-- Trigger functions are invoked by the evidence owner. They are not
-- part of the writer API.

revoke all on function private.campaign_evidence_source_immutable()
  from public, anon, authenticated, service_role, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;

revoke all on function private.mia_request_transition_guard()
  from public, anon, authenticated, service_role, mediaiq_evidence_writer,
    mediaiq_security_owner, mediaiq_security_writer, mediaiq_security_maintainer, mediaiq_security_operator;
