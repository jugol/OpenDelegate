export type SessionHelperIpcErrorCode =
  | "AUTHENTICATION_FAILED"
  | "BINDING_MISMATCH"
  | "CONNECTION_CLOSED"
  | "FRAME_TOO_LARGE"
  | "KEY_ROTATION_REJECTED"
  | "KEY_UNAVAILABLE"
  | "MALFORMED_MESSAGE"
  | "NONCE_REPLAY"
  | "PEER_REJECTED"
  | "PROTOCOL_ERROR"
  | "SEQUENCE_VIOLATION"
  | "TRANSPORT_FAILURE";

const SAFE_MESSAGES: Readonly<Record<SessionHelperIpcErrorCode, string>> = Object.freeze({
  AUTHENTICATION_FAILED: "The local IPC peer could not be authenticated.",
  BINDING_MISMATCH: "The local IPC session binding is stale or mismatched.",
  CONNECTION_CLOSED: "The authenticated local IPC connection is closed.",
  FRAME_TOO_LARGE: "The local IPC frame exceeds its configured bound.",
  KEY_ROTATION_REJECTED: "The one-time local IPC key migration allowance is unavailable.",
  KEY_UNAVAILABLE: "The local IPC authentication key is unavailable.",
  MALFORMED_MESSAGE: "The local IPC message does not match the capability protocol.",
  NONCE_REPLAY: "The local IPC handshake nonce was already used.",
  PEER_REJECTED: "The transport peer did not pass local identity authorization.",
  PROTOCOL_ERROR: "The authenticated local IPC protocol failed closed.",
  SEQUENCE_VIOLATION: "The authenticated local IPC frame sequence is invalid.",
  TRANSPORT_FAILURE: "The local IPC transport failed.",
});

export class SessionHelperIpcError extends Error {
  public readonly code: SessionHelperIpcErrorCode;

  public constructor(code: SessionHelperIpcErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "SessionHelperIpcError";
    this.code = code;
  }
}
