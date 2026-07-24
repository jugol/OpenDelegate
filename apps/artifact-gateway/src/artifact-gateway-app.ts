import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

import {
  type ArtifactMutationContext,
  type ArtifactStore,
  type StoredArtifactMetadata,
} from "@opendelegate/artifact-store";

import type {
  ArtifactAuthorizationPort,
  ArtifactGatewayAppOptions,
  ArtifactGatewayPlane,
} from "./contracts.ts";

const STATIC_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
  "sandbox",
].join("; ");

const INTERACTIVE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "object-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
  "sandbox allow-scripts",
].join("; ");

const GENERIC_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'none'",
  "sandbox",
].join("; ");

const NOT_FOUND = Object.freeze({
  type: "about:blank",
  title: "Not Found",
  status: 404,
  code: "ARTIFACT_NOT_FOUND",
});
const RATE_LIMITED = Object.freeze({
  type: "about:blank",
  title: "Too Many Requests",
  status: 429,
  code: "ARTIFACT_RATE_LIMITED",
});
const ARTIFACT_REQUEST_RATE_LIMIT = Object.freeze({
  max: 120,
  timeWindow: "1 minute",
});

export const ARTIFACT_SESSION_COOKIE_NAME = "__Host-opendelegate_artifact_session";

export type ArtifactGatewayApp = FastifyInstance;

export async function createArtifactGatewayApp(
  options: ArtifactGatewayAppOptions,
): Promise<ArtifactGatewayApp> {
  const origins = validateOrigins(options);
  const expectedHost =
    options.plane === "static" ? origins.staticOrigin.host : origins.interactiveOrigin.host;
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });
  await app.register(rateLimit, ARTIFACT_REQUEST_RATE_LIMIT);

  app.addHook("onRequest", async (request) => {
    if (request.headers.host !== expectedHost) {
      throw new ArtifactGatewayHttpError(421, "ARTIFACT_HOST_REJECTED");
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    setIsolationHeaders(reply, options.plane);
    reply.header("X-OpenDelegate-Correlation-Id", `artifact-request:${request.id}`);
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ArtifactGatewayHttpError) {
      void reply.status(error.statusCode).send({
        type: "about:blank",
        title: error.statusCode === 421 ? "Misdirected Request" : "Not Found",
        status: error.statusCode,
        code: error.code,
      });
      return;
    }
    if (isRateLimitError(error)) {
      void reply.status(429).send(RATE_LIMITED);
      return;
    }
    void reply.status(404).send(NOT_FOUND);
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send(NOT_FOUND);
  });

  app.get(
    "/health/live",
    {
      config: {
        rateLimit: false,
      },
    },
    async () => ({
      status: "ok",
      service: `opendelegate-artifact-${options.plane}`,
    }),
  );

  app.get<{
    Params: { artifactId: string };
    Querystring: { token?: string | readonly string[] };
  }>("/artifacts/:artifactId", async (request, reply) => {
    const artifactId = request.params.artifactId;
    const correlationId = `artifact-request:${request.id}`;
    const context: ArtifactMutationContext = {
      actor: { type: "system", id: "artifact-gateway" },
      correlationId,
    };

    let metadata: StoredArtifactMetadata;
    try {
      metadata = await options.store.getAvailableMetadata(artifactId);
    } catch {
      return reply.status(404).send(NOT_FOUND);
    }

    if (!presentationBelongsToPlane(metadata, options.plane)) {
      await recordAccess(options.store, metadata, false, context);
      return reply.status(404).send(NOT_FOUND);
    }

    const authorized = await authorizeArtifact({
      metadata,
      request,
      token: request.query.token,
      authorization: options.authorization,
      store: options.store,
      context,
      correlationId,
    });
    if (!authorized) {
      await recordAccess(options.store, metadata, false, context);
      return reply.status(404).send(NOT_FOUND);
    }
    if (metadata.exposurePolicy.mode !== "signed-link") {
      await recordAccess(options.store, metadata, true, context);
    }

    let content;
    try {
      content = await options.store.read(metadata.artifactId);
    } catch {
      return reply.status(404).send(NOT_FOUND);
    }
    const range = parseRange(request.headers.range, content.bytes.byteLength);
    if (range === "invalid") {
      return reply.header("Content-Range", `bytes */${content.bytes.byteLength}`).status(416).send({
        type: "about:blank",
        title: "Range Not Satisfiable",
        status: 416,
        code: "ARTIFACT_RANGE_INVALID",
      });
    }

    const selected =
      range === undefined
        ? content.bytes
        : content.bytes.slice(range.start, range.endInclusive + 1);
    setArtifactHeaders(reply, content.metadata);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", selected.byteLength);
    if (range !== undefined) {
      reply.header(
        "Content-Range",
        `bytes ${range.start}-${range.endInclusive}/${content.bytes.byteLength}`,
      );
      reply.status(206);
    }
    return reply.send(Buffer.from(selected));
  });

  await app.ready();
  return app;
}

function isRateLimitError(error: unknown): error is { readonly statusCode: 429 } {
  return (
    typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 429
  );
}

async function authorizeArtifact(input: {
  readonly metadata: StoredArtifactMetadata;
  readonly request: FastifyRequest;
  readonly token: string | readonly string[] | undefined;
  readonly authorization: ArtifactAuthorizationPort;
  readonly store: ArtifactStore;
  readonly context: ArtifactMutationContext;
  readonly correlationId: string;
}): Promise<boolean> {
  const mode = input.metadata.exposurePolicy.mode;
  try {
    switch (mode) {
      case "public":
        return true;
      case "signed-link":
        if (typeof input.token !== "string" || input.token.length === 0) {
          return false;
        }
        await input.store.verifySignedToken({
          artifactId: input.metadata.artifactId,
          token: input.token,
          context: input.context,
        });
        return true;
      case "authenticated": {
        const credential = ownerCredential(input.request);
        if (credential === undefined) {
          return false;
        }
        return await input.authorization.authorizeOwner({
          artifactId: input.metadata.artifactId,
          credential: credential.value,
          credentialKind: credential.kind,
          remoteAddress: input.request.ip,
          correlationId: input.correlationId,
        });
      }
      case "private-network":
        return await input.authorization.authorizePrivateNetwork({
          artifactId: input.metadata.artifactId,
          remoteAddress: input.request.ip,
          correlationId: input.correlationId,
        });
      case "custom": {
        const bearerToken = parseBearer(input.request.headers.authorization);
        return await input.authorization.authorizeCustom({
          artifactId: input.metadata.artifactId,
          customPolicyId: input.metadata.exposurePolicy.customPolicyId,
          ...(bearerToken === undefined ? {} : { bearerToken }),
          remoteAddress: input.request.ip,
          correlationId: input.correlationId,
        });
      }
    }
  } catch {
    return false;
  }
}

async function recordAccess(
  store: ArtifactStore,
  metadata: StoredArtifactMetadata,
  granted: boolean,
  context: ArtifactMutationContext,
): Promise<void> {
  await store.recordAccess({
    artifactId: metadata.artifactId,
    granted,
    mode: metadata.exposurePolicy.mode,
    context,
  });
}

function presentationBelongsToPlane(
  metadata: StoredArtifactMetadata,
  plane: ArtifactGatewayPlane,
): boolean {
  return plane === "interactive"
    ? metadata.presentation === "interactive-html"
    : metadata.presentation !== "interactive-html";
}

function setIsolationHeaders(reply: FastifyReply, plane: ArtifactGatewayPlane): void {
  if (!reply.hasHeader("Content-Security-Policy")) {
    reply.header(
      "Content-Security-Policy",
      plane === "interactive" ? INTERACTIVE_CSP : GENERIC_CSP,
    );
  }
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Embedder-Policy", "require-corp");
  reply.header("Origin-Agent-Cluster", "?1");
  reply.header("X-Frame-Options", "DENY");
  reply.header(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
}

function setArtifactHeaders(reply: FastifyReply, metadata: StoredArtifactMetadata): void {
  reply.type(metadata.mediaType);
  reply.header(
    "Content-Security-Policy",
    metadata.presentation === "interactive-html"
      ? INTERACTIVE_CSP
      : metadata.presentation === "static-html"
        ? STATIC_CSP
        : GENERIC_CSP,
  );
  const disposition =
    metadata.presentation === "download" || metadata.mediaType === "image/svg+xml"
      ? "attachment"
      : "inline";
  reply.header("Content-Disposition", contentDisposition(disposition, metadata.originalFilename));
  reply.header("ETag", `"sha256-${metadata.checksum.value}"`);
}

function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const fallback =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 120) || "artifact";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseBearer(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 2_048 || containsControl(value)) {
    return undefined;
  }
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1];
}

function ownerCredential(request: FastifyRequest):
  | {
      readonly kind: "bearer" | "artifact-session";
      readonly value: string;
    }
  | undefined {
  const bearer = parseBearer(request.headers.authorization);
  if (bearer !== undefined) {
    return { kind: "bearer", value: bearer };
  }
  const artifactSession = parseCookie(request.headers.cookie, ARTIFACT_SESSION_COOKIE_NAME);
  return artifactSession === undefined
    ? undefined
    : { kind: "artifact-session", value: artifactSession };
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length > 8_192 || containsControl(header)) {
    return undefined;
  }
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (matches.length !== 1 || !/^[A-Za-z0-9._~-]{20,2048}$/.test(matches[0] ?? "")) {
    return undefined;
  }
  return matches[0];
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function parseRange(
  value: string | undefined,
  size: number,
):
  | {
      readonly start: number;
      readonly endInclusive: number;
    }
  | "invalid"
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.includes(",")) {
    return "invalid";
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || size === 0) {
    return "invalid";
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") {
    return "invalid";
  }
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return "invalid";
    }
    return {
      start: Math.max(0, size - suffix),
      endInclusive: size - 1,
    };
  }
  const start = Number(startText);
  const requestedEnd = endText === "" ? size - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }
  return {
    start,
    endInclusive: Math.min(requestedEnd, size - 1),
  };
}

function validateOrigins(options: ArtifactGatewayAppOptions): {
  readonly staticOrigin: URL;
  readonly interactiveOrigin: URL;
} {
  if (options.plane !== "static" && options.plane !== "interactive") {
    throw new Error("Artifact Gateway plane is invalid.");
  }
  const staticOrigin = parseOrigin(options.staticOrigin);
  const interactiveOrigin = parseOrigin(options.interactiveOrigin);
  const adminOrigins = options.adminOrigins.map(parseOrigin);
  const all = [
    staticOrigin.origin,
    interactiveOrigin.origin,
    ...adminOrigins.map((origin) => origin.origin),
  ];
  const cookieHosts = [
    staticOrigin.hostname,
    interactiveOrigin.hostname,
    ...adminOrigins.map((origin) => origin.hostname),
  ];
  if (new Set(all).size !== all.length || new Set(cookieHosts).size !== cookieHosts.length) {
    throw new Error("Artifact and Admin origins and cookie hosts must be distinct.");
  }
  return { staticOrigin, interactiveOrigin };
}

function parseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Artifact Gateway origin must be an absolute HTTP(S) origin.");
  }
  if (
    value !== url.origin ||
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
  ) {
    throw new Error(
      "Artifact Gateway origins must be exact HTTPS origins (or loopback HTTP origins).",
    );
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

class ArtifactGatewayHttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string) {
    super(code);
    this.name = "ArtifactGatewayHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
