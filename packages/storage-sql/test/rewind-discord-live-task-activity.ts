/**
 * Restores the Discord binding schema to its pre-0014 shape.
 *
 * Only migration fixtures may use this helper. Production migrations remain
 * forward-only.
 */
export const REWIND_DISCORD_LIVE_TASK_ACTIVITY_SQL = `
  ALTER TABLE od_discord_task_bindings DROP COLUMN activity_surface_json;
  DELETE FROM od_migration_manifest
    WHERE migration_name = '0014_discord_live_task_activity';
  DELETE FROM od_kysely_migration
    WHERE name = '0014_discord_live_task_activity';
`;
