import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;.*)?$/i;

export class PublicHttpError extends Error {
  public readonly code: string;
  public readonly diagnosticCode: string | undefined;
  public readonly statusCode: number;

  public constructor(statusCode: number, code: string, diagnosticCode?: string) {
    super(code);
    this.name = "PublicHttpError";
    this.code = code;
    this.diagnosticCode = diagnosticCode;
    this.statusCode = statusCode;
  }
}

export interface IngressSecurity {
  readonly correlationIdFor: (request: FastifyRequest) => string;
  readonly install: () => void;
  readonly validatePublicMutation: (request: FastifyRequest) => void;
}

export function createIngressSecurity(input: {
  readonly app: {
    addHook(
      name: "onRequest",
      hook: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
    ): void;
  };
  readonly allowedOrigins: readonly string[];
}): IngressSecurity {
  const origins = normalizeOrigins(input.allowedOrigins);
  const hosts = new Set(origins.map((origin) => new URL(origin).host.toLowerCase()));
  const correlationIds = new WeakMap<FastifyRequest, string>();

  const correlationIdFor = (request: FastifyRequest): string =>
    correlationIds.get(request) ?? createCorrelationId();

  return {
    correlationIdFor,
    install: () => {
      input.app.addHook("onRequest", async (request, reply) => {
        const suppliedCorrelationId = oneHeader(request.headers["x-correlation-id"]);
        const correlationId =
          suppliedCorrelationId === undefined || !CORRELATION_ID_PATTERN.test(suppliedCorrelationId)
            ? createCorrelationId()
            : suppliedCorrelationId;

        correlationIds.set(request, correlationId);
        void reply.header("x-correlation-id", correlationId);
        if (request.url.startsWith("/api/v1/")) {
          void reply.header("cache-control", "no-store");
        }

        if (
          suppliedCorrelationId !== undefined &&
          !CORRELATION_ID_PATTERN.test(suppliedCorrelationId)
        ) {
          throw new PublicHttpError(400, "CORRELATION_ID_INVALID");
        }

        const host = oneHeader(request.headers.host)?.toLowerCase();
        if (host === undefined || !hosts.has(host)) {
          throw new PublicHttpError(421, "HOST_NOT_ALLOWED");
        }
      });
    },
    validatePublicMutation: (request) => {
      const origin = oneHeader(request.headers.origin);
      const contentType = oneHeader(request.headers["content-type"]);
      const secFetchSite = oneHeader(request.headers["sec-fetch-site"]);

      if (
        origin === undefined ||
        !origins.includes(origin) ||
        contentType === undefined ||
        !JSON_CONTENT_TYPE_PATTERN.test(contentType.trim()) ||
        secFetchSite?.trim().toLowerCase() === "cross-site"
      ) {
        throw new PublicHttpError(403, "CSRF_INVALID");
      }
    },
  };
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }

  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const octets = ipv4.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function normalizeOrigins(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("At least one owner origin is required.");
  }

  const origins = values.map((value) => {
    if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
      throw new Error("Owner origins must be absolute HTTP(S) origins.");
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Owner origins must be absolute HTTP(S) origins.");
    }

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      value !== url.origin ||
      (url.protocol === "http:" && !isLoopbackHostname(url.hostname))
    ) {
      throw new Error("Non-loopback owner origins must use HTTPS.");
    }

    return url.origin;
  });

  if (new Set(origins).size !== origins.length) {
    throw new Error("Owner origins must be unique.");
  }

  return Object.freeze(origins);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function oneHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function createCorrelationId(): string {
  return `correlation_${randomUUID()}`;
}
