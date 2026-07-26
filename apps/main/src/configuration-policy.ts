import type {
  ConfigurationMutationAuthorization,
  ConfigurationMutationAuthorizationInput,
} from "@opendelegate/configuration";

const AUTOMATIC_DEVICE_PROFILE_CONFIGURATION_KEYS = new Set([
  "device.display-name",
  "device.instructions",
  "device.roles",
]);

/**
 * Main-owned Device profile maintenance is the one accepted automatic
 * Configuration Agent mutation class. Every other setting remains behind an
 * explicit owner approval surface; authenticated chat alone is not an approval.
 */
export function authorizeMainConfigurationMutation(
  input: ConfigurationMutationAuthorizationInput,
): ConfigurationMutationAuthorization {
  if (
    input.diff.length > 0 &&
    input.diff.every((entry) => AUTOMATIC_DEVICE_PROFILE_CONFIGURATION_KEYS.has(entry.key))
  ) {
    return Object.freeze({
      decision: "allow",
      authority: "policy",
      decisionId: "device-profile-auto-apply-v1",
    });
  }
  return Object.freeze({
    decision: "require-approval",
    code: "PROTECTED_CONFIGURATION_REQUIRES_OWNER_APPROVAL",
  });
}
