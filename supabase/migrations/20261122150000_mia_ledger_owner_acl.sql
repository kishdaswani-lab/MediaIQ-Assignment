-- Privileges held by a table owner can be removed only while that role
-- is the current user. Usage keeps select, insert, and update. The
-- approval table keeps select. Neither role receives a write privilege
-- on the approval table.

grant mediaiq_evidence_owner to current_user;
set role mediaiq_evidence_owner;

revoke all on table private.mia_usage from mediaiq_evidence_owner;
grant select, insert, update on table private.mia_usage to mediaiq_evidence_owner;

revoke all on table private.mia_approved_provider from mediaiq_evidence_owner;
grant select on table private.mia_approved_provider to mediaiq_evidence_owner;

reset role;
revoke mediaiq_evidence_owner from current_user;
