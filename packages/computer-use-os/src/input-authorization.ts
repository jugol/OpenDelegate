import { createHash } from "node:crypto";

import {
  NativeDriverError,
  type AuthorizedComputerUseAction,
  type ComputerUseActionFingerprint,
  type NativeComputerUseAction,
  type NativeDriverAuthorizedInputContext,
} from "./contracts.ts";

export function describeNativeComputerUseAction(
  action: NativeComputerUseAction,
): AuthorizedComputerUseAction {
  if (action.kind === "click") {
    return Object.freeze({ kind: "click", controlId: action.controlId });
  }
  return Object.freeze({
    kind: "type-text",
    controlId: action.controlId,
    textSha256: hashBytes(Buffer.from(action.text, "utf8")),
    textLength: action.text.length,
  });
}

export function createActionFingerprint(input: {
  readonly action: AuthorizedComputerUseAction;
}): ComputerUseActionFingerprint {
  return hashCanonical({
    schemaVersion: 1,
    actionCategory: "computer-use-input",
    action: input.action,
  });
}

/**
 * The final mutation guard. It deliberately reports no plaintext or caller
 * supplied identifier in errors so a malformed binding cannot become a log
 * exfiltration path.
 */
export function requireExactNativeInputAuthorization(
  context: NativeDriverAuthorizedInputContext,
  action: NativeComputerUseAction,
): void {
  const expectedAction = describeNativeComputerUseAction(action);
  const expectedFingerprint = createActionFingerprint({
    action: expectedAction,
  });
  if (
    !isIdentifier(context.authorization.authorizationId) ||
    context.authorization.fingerprint !== expectedFingerprint ||
    !sameAuthorizedAction(context.authorization.action, expectedAction)
  ) {
    throw new NativeDriverError(
      "PERMISSION_DENIED",
      "The exact native input authorization binding is invalid.",
    );
  }
}

function sameAuthorizedAction(
  left: AuthorizedComputerUseAction,
  right: AuthorizedComputerUseAction,
): boolean {
  if (
    left.kind !== right.kind ||
    left.controlId !== right.controlId ||
    Object.keys(left).length !== Object.keys(right).length
  ) {
    return false;
  }
  if (left.kind === "click" || right.kind === "click") {
    return left.kind === "click" && right.kind === "click";
  }
  return left.textSha256 === right.textSha256 && left.textLength === right.textLength;
}

function hashCanonical(value: unknown): ComputerUseActionFingerprint {
  return hashBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function hashBytes(value: Uint8Array): ComputerUseActionFingerprint {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= 256 && value === value.trim() && !/\p{Cc}/u.test(value)
  );
}
