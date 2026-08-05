-- Schema level 0018: one safe request identity links a durable Ingestion Run to the structured
-- request-completion event that created it. It is deliberately distinct from
-- the owner-supplied idempotency key.
ALTER TABLE ingestion_runs
ADD COLUMN operational_request_id TEXT;
