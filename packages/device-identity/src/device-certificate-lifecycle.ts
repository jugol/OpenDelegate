import "reflect-metadata";

import { X509Certificate } from "@peculiar/x509";

import { DeviceIdentityError } from "./error.ts";

/**
 * Device certificates are deliberately short-lived, so an enrolled Device stays
 * usable only while it keeps renewing. Reading the lifecycle from the certificate
 * itself keeps the Worker, the renewal scheduler, and owner-facing diagnostics on
 * one answer instead of three independent guesses.
 */
export type DeviceCertificateLifecycleState = "not-yet-valid" | "renewable" | "expired" | "valid";

export interface DeviceCertificateLifecycle {
  readonly state: DeviceCertificateLifecycleState;
  readonly serialNumber: string;
  readonly notBefore: number;
  readonly notAfter: number;
  /** The first instant at which renewal should be attempted. */
  readonly renewAfter: number;
  /** Milliseconds until expiry, clamped at zero once the certificate has expired. */
  readonly expiresInMs: number;
}

/**
 * Renewal starts halfway through the validity window. The remaining half is the
 * budget for retries, so a Device that is briefly offline or unable to reach Main
 * still has many attempts before it locks itself out.
 */
const RENEWAL_RATIO = 0.5;

export function readDeviceCertificateLifecycle(
  certificatePem: string,
  now: number,
): DeviceCertificateLifecycle {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The certificate lifecycle clock must return a non-negative safe-integer timestamp.",
    );
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new DeviceIdentityError(
      "PEER_CERTIFICATE_INVALID",
      "The Device certificate could not be parsed.",
    );
  }

  const notBefore = certificate.notBefore.getTime();
  const notAfter = certificate.notAfter.getTime();
  if (
    !Number.isSafeInteger(notBefore) ||
    !Number.isSafeInteger(notAfter) ||
    notAfter <= notBefore
  ) {
    throw new DeviceIdentityError(
      "PEER_CERTIFICATE_INVALID",
      "The Device certificate carries an unusable validity window.",
    );
  }

  const renewAfter = notBefore + Math.floor((notAfter - notBefore) * RENEWAL_RATIO);
  const state = readState({ notAfter, notBefore, now, renewAfter });

  return Object.freeze({
    state,
    serialNumber: certificate.serialNumber.toLowerCase().padStart(32, "0"),
    notBefore,
    notAfter,
    renewAfter,
    expiresInMs: Math.max(0, notAfter - now),
  });
}

function readState(input: {
  readonly notAfter: number;
  readonly notBefore: number;
  readonly now: number;
  readonly renewAfter: number;
}): DeviceCertificateLifecycleState {
  if (input.now < input.notBefore) {
    return "not-yet-valid";
  }
  if (input.now >= input.notAfter) {
    return "expired";
  }
  return input.now >= input.renewAfter ? "renewable" : "valid";
}

/** True while the certificate can still authenticate a channel. */
export function deviceCertificateIsUsable(lifecycle: DeviceCertificateLifecycle): boolean {
  return lifecycle.state === "renewable" || lifecycle.state === "valid";
}
