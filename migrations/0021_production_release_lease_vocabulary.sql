PRAGMA foreign_keys = ON;

-- Expand the Production Release lease vocabulary without invalidating Workers
-- that still use the 0014 column names during a compatible rollout.
ALTER TABLE operation_state
ADD COLUMN active_production_release_id TEXT;

ALTER TABLE operation_state
ADD COLUMN active_production_release_expires_at TEXT;

UPDATE operation_state
SET active_production_release_id = active_release_id,
    active_production_release_expires_at = active_release_expires_at
WHERE singleton = 1;

CREATE TRIGGER production_release_lease_shape_guard_v2
BEFORE UPDATE OF active_production_release_id,
  active_production_release_expires_at ON operation_state
WHEN (NEW.active_production_release_id IS NULL) <>
    (NEW.active_production_release_expires_at IS NULL)
  OR (NEW.active_production_release_expires_at IS NOT NULL AND (
    NEW.active_production_release_expires_at NOT GLOB
      '????-??-??T??:??:??.???Z'
    OR julianday(NEW.active_production_release_expires_at) IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'production_release_lease_invalid');
END;

CREATE TRIGGER production_release_lease_sync_from_legacy
AFTER UPDATE OF active_release_id, active_release_expires_at
ON operation_state
WHEN NEW.active_production_release_id IS NOT NEW.active_release_id
  OR NEW.active_production_release_expires_at IS NOT NEW.active_release_expires_at
BEGIN
  UPDATE operation_state
  SET active_production_release_id = NEW.active_release_id,
      active_production_release_expires_at = NEW.active_release_expires_at
  WHERE singleton = NEW.singleton;
END;

CREATE TRIGGER production_release_lease_sync_to_legacy
AFTER UPDATE OF active_production_release_id,
  active_production_release_expires_at ON operation_state
WHEN NEW.active_release_id IS NOT NEW.active_production_release_id
  OR NEW.active_release_expires_at IS NOT
    NEW.active_production_release_expires_at
BEGIN
  UPDATE operation_state
  SET active_release_id = NEW.active_production_release_id,
      active_release_expires_at = NEW.active_production_release_expires_at
  WHERE singleton = NEW.singleton;
END;

UPDATE catalogue_schema_state
SET migration_level = 21
WHERE singleton = 1 AND migration_level = 20;
