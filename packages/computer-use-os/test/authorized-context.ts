import {
  createActionFingerprint,
  describeNativeComputerUseAction,
  type NativeComputerUseAction,
  type NativeDriverAuthorizedInputContext,
  type NativeDriverExecutionContext,
} from "../src/index.ts";

export function authorizedContext(
  context: NativeDriverExecutionContext,
  action: NativeComputerUseAction,
): NativeDriverAuthorizedInputContext {
  const descriptor = describeNativeComputerUseAction(action);
  return {
    ...context,
    authorization: {
      authorizationId: `authorization:${context.executionHandleId}:${action.kind}`,
      fingerprint: createActionFingerprint({
        action: descriptor,
      }),
      action: descriptor,
    },
  };
}
