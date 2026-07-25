import { createServer, type Server } from "node:http";

import type { CoreHealthResponseV1, CoreHealthState } from "@opendelegate/platform-services";

import type { ServiceHostConfiguration } from "./configuration.ts";

export interface CoreHealthServerOptions {
  readonly endpoint: string;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly role: ServiceHostConfiguration["role"];
  readonly releaseVersion: string;
}

export class CoreHealthServer {
  readonly #options: CoreHealthServerOptions;
  readonly #url: URL;
  #state: CoreHealthState = "starting";
  #server: Server | undefined;

  public constructor(options: CoreHealthServerOptions) {
    this.#options = Object.freeze({ ...options });
    this.#url = new URL(options.endpoint);
  }

  public async listen(): Promise<void> {
    if (this.#server !== undefined) {
      return;
    }
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== this.#url.pathname) {
        response.writeHead(404, {
          "cache-control": "no-store",
          "content-type": "application/problem+json",
        });
        response.end('{"status":404}\n');
        return;
      }
      const healthy = this.#state === "running";
      response.writeHead(healthy ? 200 : 503, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      const body = {
        schemaVersion: 1,
        product: "OpenDelegate",
        plane: "core",
        instanceId: this.#options.instanceId,
        deviceId: this.#options.deviceId,
        role: this.#options.role,
        releaseVersion: this.#options.releaseVersion,
        status: this.#state,
        headlessWorkAvailable: healthy,
      } satisfies CoreHealthResponseV1;
      response.end(`${JSON.stringify(body)}\n`);
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once("error", fail);
      const hostname =
        this.#url.hostname === "localhost"
          ? "127.0.0.1"
          : this.#url.hostname.replace(/^\[|\]$/gu, "");
      server.listen(Number(this.#url.port), hostname, () => {
        server.off("error", fail);
        server.on("error", () => {
          this.#state = "failed";
        });
        resolve();
      });
    });
    this.#server = server;
  }

  public markRunning(): void {
    this.#state = "running";
  }

  public markStopping(): void {
    this.#state = "stopping";
  }

  public markFailed(): void {
    this.#state = "failed";
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}
