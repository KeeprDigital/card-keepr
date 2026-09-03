-- Schema level 0018: one safe request identity links a durable Ingestion Run to the structured
-- request-completion event that created it. It is deliberately distinct from
-- the owner-supplied idempotency key.
ALTER TABLE ingestion_runs
ADD COLUMN operational_request_id TEXT;

-- Schema-level bump added retrospectively (issue #72); see 0017.
UPDATE catalogue_schema_state
SET migration_level = 18
WHERE singleton = 1 AND migration_level = 17;
