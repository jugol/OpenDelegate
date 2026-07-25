import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  createNodeSessionHelperIpcTransport,
  type SessionHelperIpcConnection,
  type SessionHelperIpcEndpoint,
} from "../src/index.ts";

it("uses Node net length-prefixed local IPC on the host's native endpoint kind", async () => {
  const endpoint: SessionHelperIpcEndpoint =
    process.platform === "win32"
      ? {
          kind: "windows-named-pipe",
          path: String.raw`\\.\pipe\OpenDelegate\SessionHelper.${randomUUID()}`,
        }
      : {
          kind: "unix-domain-socket",
          path: join(tmpdir(), `od-helper-${randomUUID()}.sock`),
        };
  const transport = createNodeSessionHelperIpcTransport();
  let acceptConnection: (connection: SessionHelperIpcConnection) => void = () => {};
  const accepted = new Promise<SessionHelperIpcConnection>((resolve) => {
    acceptConnection = resolve;
  });
  const listener = await transport.listen(endpoint, (connection) => {
    acceptConnection(connection);
  });

  const client = await transport.connect(endpoint);
  const server = await accepted;
  assert.equal(client.peerIdentity.transport, endpoint.kind);
  assert.equal(server.peerIdentity.transport, endpoint.kind);

  await client.writeFrame(Buffer.from("core-frame", "utf8"));
  assert.equal((await server.readFrame(1_024))?.toString("utf8"), "core-frame");
  await server.writeFrame(Buffer.from("helper-frame", "utf8"));
  assert.equal((await client.readFrame(1_024))?.toString("utf8"), "helper-frame");

  client.close();
  server.close();
  await listener.close();
});

it("rejects remote pipes and cross-platform endpoint kinds before opening a socket", async () => {
  const windowsTransport = createNodeSessionHelperIpcTransport({ platform: "win32" });
  await assert.rejects(
    windowsTransport.connect({
      kind: "windows-named-pipe",
      path: String.raw`\\remote-host\pipe\OpenDelegate\SessionHelper`,
    }),
    /local OpenDelegate Windows named pipe/u,
  );
  await assert.rejects(
    windowsTransport.connect({
      kind: "unix-domain-socket",
      path: "C:\\OpenDelegate\\session.sock",
    }),
    /bounded absolute Unix-domain socket/u,
  );

  const unixTransport = createNodeSessionHelperIpcTransport({ platform: "linux" });
  await assert.rejects(
    unixTransport.connect({
      kind: "windows-named-pipe",
      path: String.raw`\\.\pipe\OpenDelegate\SessionHelper`,
    }),
    /local OpenDelegate Windows named pipe/u,
  );
  await assert.rejects(
    unixTransport.connect({
      kind: "unix-domain-socket",
      path: "relative/session.sock",
    }),
    /bounded absolute Unix-domain socket/u,
  );
});
