import type { ArtifactStore } from "@opendelegate/artifact-store";

export type ArtifactGatewayPlane = "static" | "interactive";

export interface OwnerArtifactAuthorization {
  readonly artifactId: string;
  readonly credential: string;
  readonly credentialKind: "bearer" | "artifact-session";
  readonly remoteAddress: string;
  readonly correlationId: string;
}

export interface PrivateNetworkArtifactAuthorization {
  readonly artifactId: string;
  readonly remoteAddress: string;
  readonly correlationId: string;
}

export interface CustomArtifactAuthorization {
  readonly artifactId: string;
  readonly customPolicyId: string;
  readonly bearerToken?: string;
  readonly remoteAddress: string;
  readonly correlationId: string;
}

export interface ArtifactAuthorizationPort {
  authorizeOwner(input: OwnerArtifactAuthorization): Promise<boolean>;
  authorizePrivateNetwork(input: PrivateNetworkArtifactAuthorization): Promise<boolean>;
  authorizeCustom(input: CustomArtifactAuthorization): Promise<boolean>;
}

export interface ArtifactGatewayAppOptions {
  readonly plane: ArtifactGatewayPlane;
  readonly store: ArtifactStore;
  readonly authorization: ArtifactAuthorizationPort;
  readonly staticOrigin: string;
  readonly interactiveOrigin: string;
  readonly adminOrigins: readonly string[];
}
