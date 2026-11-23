-- Table ownership grants every privilege. Remove the ones the lifecycle
-- must not have: usage rows cannot be deleted, and the approval table
-- cannot be written by the evidence owner.

revoke delete, truncate, references, trigger
  on table private.mia_usage
  from mediaiq_evidence_owner;

revoke insert, update, delete, truncate, references, trigger
  on table private.mia_approved_provider
  from mediaiq_evidence_owner;
