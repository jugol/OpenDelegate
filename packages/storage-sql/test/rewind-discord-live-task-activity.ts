/**
 * Restores the Discord binding schema to its pre-0014 shape.
 *
 * Only migration fixtures may use this helper. Production migrations remain
 * forward-only.
 */
export const REWIND_DISCORD_LIVE_TASK_ACTIVITY_SQL = `
  ALTER TABLE od_discord_task_bindings DROP COLUMN owner_prompt_surface_json;
  ALTER TABLE od_discord_task_bindings DROP COLUMN failure_surface_json;
  ALTER TABLE od_discord_task_bindings DROP COLUMN activity_surface_json;
  DELETE FROM od_migration_manifest
    WHERE migration_name = '0016_discord_owner_prompt_surface';
  DELETE FROM od_kysely_migration
    WHERE name = '0016_discord_owner_prompt_surface';
  DELETE FROM od_migration_manifest
    WHERE migration_name = '0015_discord_failure_surface';
  DELETE FROM od_kysely_migration
    WHERE name = '0015_discord_failure_surface';
  DELETE FROM od_migration_manifest
    WHERE migration_name = '0014_discord_live_task_activity';
  DELETE FROM od_kysely_migration
    WHERE name = '0014_discord_live_task_activity';
`;
