/**
 * Restores the Device identity schema to its pre-0013 shape.
 *
 * Migration tests simulate an older database by deleting manifest rows, and the
 * migrator refuses to run unless the remaining executed migrations form an
 * unbroken prefix. Every test that rewinds past 0013 therefore has to undo what
 * 0013 changed, not merely forget that it ran.
 *
 * Only safe for fixtures that hold no Device identity audit rows.
 */
export const REWIND_DEVICE_RECREDENTIALING_SQL = `
  ALTER TABLE od_device_enrollment_grants DROP COLUMN intent;
  DROP TRIGGER od_device_identity_audit_no_update;
  DROP TRIGGER od_device_identity_audit_no_delete;
  DROP INDEX od_device_identity_audit_order;
  DROP TABLE od_device_identity_audit;
  CREATE TABLE od_device_identity_audit (
    audit_id TEXT PRIMARY KEY
      CHECK (length(audit_id) BETWEEN 1 AND 200 AND audit_id = trim(audit_id)),
    event_name TEXT NOT NULL CHECK (
      event_name IN (
        'device.enrolled',
        'device.enrollment-grant-issued',
        'device.enrollment-rejected',
        'device.revoked',
        'device.rotation-confirmed',
        'device.rotation-issued'
      )
    ),
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    device_id TEXT NOT NULL
      CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id = trim(device_id)),
    grant_id TEXT,
    certificate_serial TEXT,
    certificate_generation INTEGER CHECK (
      certificate_generation IS NULL OR certificate_generation > 0
    ),
    rejection_code TEXT CHECK (
      rejection_code IS NULL
      OR (
        length(rejection_code) BETWEEN 1 AND 128
        AND rejection_code = trim(rejection_code)
      )
    )
  ) STRICT;
  CREATE INDEX od_device_identity_audit_order
    ON od_device_identity_audit (occurred_at_ms, audit_id);
  CREATE TRIGGER od_device_identity_audit_no_update
    BEFORE UPDATE ON od_device_identity_audit
    BEGIN
      SELECT RAISE(ABORT, 'device identity audit is append-only');
    END;
  CREATE TRIGGER od_device_identity_audit_no_delete
    BEFORE DELETE ON od_device_identity_audit
    BEGIN
      SELECT RAISE(ABORT, 'device identity audit is append-only');
    END;
  DELETE FROM od_migration_manifest
    WHERE migration_name = '0013_device_recredentialing';
  DELETE FROM od_kysely_migration
    WHERE name = '0013_device_recredentialing';
`;
