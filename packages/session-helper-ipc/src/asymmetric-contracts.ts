import type {
  SessionHelperCapabilityRequest,
  SessionHelperCapabilityResponse,
  SessionHelperIpcConnection,
  SessionHelperIpcDialer,
  SessionHelperIpcEndpoint,
  SessionHelperIpcPeerIdentity,
} from "./contracts.ts";

export const SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION = 2 as const;

/**
 * Version 2 deliberately uses distinct signing identities for the boot service
 * and the logged-in owner. No private key or shared Secret crosses that OS
 * identity boundary.
 */
export interface SignedSessionHelperBinding {
  readonly protocolVersion: typeof SIGNED_SESSION_HELPER_IPC_PROTOCOL_VERSION;
  readonly deviceId: string;
  readonly helperId: string;
  readonly sessionId: string;
  readonly serviceEpoch: number;
  readonly releaseVersion: string;
}

export interface SessionHelperSigningKeyProvider {
  /**
   * Signs one domain-separated, bounded byte string while the private key remains
   * inside the plane-local ManagedSecretStore callback.
   */
  sign(privateKeyReference: string, keyId: string, message: Buffer): Promise<Buffer>;
}

export interface SessionHelperPeerPublicKey {
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
  readonly usage: "active" | "migration";
  /**
   * A migration pin is accepted for one successful handshake only.
   */
  readonly consumeMigration?: () => Promise<boolean>;
}

export interface SignedSessionHelperPeerAuthorizationRequest {
  readonly localRole: "core" | "helper";
  readonly binding: SignedSessionHelperBinding;
  readonly peerIdentity: SessionHelperIpcPeerIdentity;
}

export interface SignedSessionHelperPeerAuthorizer {
  authorize(request: SignedSessionHelperPeerAuthorizationRequest): boolean | Promise<boolean>;
}

export interface SignedSessionHelperNonceReplayGuard {
  claim(
    role: "core" | "helper",
    binding: SignedSessionHelperBinding,
    nonce: Buffer,
  ): boolean | Promise<boolean>;
}

export interface SignedSessionHelperIpcFactoryOptions {
  readonly localPrivateKeyReference: string;
  readonly localKeyId: `sha256:${string}`;
  readonly signingKeyProvider: SessionHelperSigningKeyProvider;
  readonly acceptedPeerKeys: readonly SessionHelperPeerPublicKey[];
  readonly peerAuthorizer: SignedSessionHelperPeerAuthorizer;
  readonly nonceGuard?: SignedSessionHelperNonceReplayGuard;
  readonly nonceSource?: () => Buffer;
  readonly handshakeTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

export interface ConnectSignedCoreSessionHelperOptions {
  readonly binding: SignedSessionHelperBinding;
  readonly endpoint: SessionHelperIpcEndpoint;
  readonly dialer: SessionHelperIpcDialer;
  readonly signal?: AbortSignal;
}

export interface AcceptSignedHelperSessionOptions {
  readonly binding: SignedSessionHelperBinding;
  readonly connection: SessionHelperIpcConnection;
  readonly signal?: AbortSignal;
}

export interface SignedCoreSessionHelperChannel {
  readonly binding: SignedSessionHelperBinding;
  readonly isClosed: boolean;
  send(request: SessionHelperCapabilityRequest, signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): Promise<SessionHelperCapabilityResponse>;
  close(): void;
}

export interface SignedHelperSessionHelperChannel {
  readonly binding: SignedSessionHelperBinding;
  readonly isClosed: boolean;
  send(response: SessionHelperCapabilityResponse, signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): Promise<SessionHelperCapabilityRequest>;
  close(): void;
}

export interface SignedCoreSessionHelperIpc {
  connect(options: ConnectSignedCoreSessionHelperOptions): Promise<SignedCoreSessionHelperChannel>;
}

export interface SignedHelperSessionHelperIpc {
  accept(options: AcceptSignedHelperSessionOptions): Promise<SignedHelperSessionHelperChannel>;
}
