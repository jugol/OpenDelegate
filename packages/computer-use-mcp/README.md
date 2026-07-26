# `@opendelegate/computer-use-mcp`

Run-scoped Model Context Protocol (MCP) stdio server for OpenDelegate Computer Use.
The package has no external runtime dependency and implements only the JSON-RPC
surface needed by the Worker Agent bridge.

This module is a protocol adapter, not an authority service. It cannot acquire or
renew a desktop lease, create a Policy grant, consume an Approval, select a Run, or
start a desktop controller.

## Public seam

```ts
await runComputerUseMcpStdioServer({
  authority,
  port,
});
```

`authority` is the exact immutable authority issued to one Worker Run:

- Task, Work Order, Run, Device, and execution-handle identities;
- the capacity-one `desktop-session` lease ID, fencing token, and expiry; and
- the authenticated helper identity, service epoch, and persistence generation.

It is never accepted from MCP tool arguments. The server validates and freezes a
copy, then passes the same value to every `ComputerUseToolPort` call.

The Worker-owned port is the executable enforcement boundary. Every port method
MUST verify that the complete authority is still current. Immediately before
`click`, `typeText`, `key`, or `scroll` mutates the desktop, the port MUST:

1. match current executable Policy or an exact Task-scoped Approval;
2. atomically consume a once Approval when applicable;
3. revalidate the exact lease ID and fencing token;
4. revalidate helper identity, service epoch, and persistence generation; and
5. fail closed when any proof is missing, expired, replaced, or unverifiable.

The MCP server does not duplicate those checks because doing so would create an
independent and stale authority plane.

## Tools

The server exposes:

| Tool | Behavior |
| --- | --- |
| `computer_use_readiness` | Read-only readiness and permission checks |
| `computer_use_observe` | Bounded accessibility-oriented observation |
| `computer_use_capture` | Bounded PNG content plus checksum metadata |
| `computer_use_click` | Click one previously observed `controlId` |
| `computer_use_type_text` | Type sensitive plaintext into one `controlId` |
| `computer_use_key` | Send one key chord |
| `computer_use_scroll` | Send bounded integer scroll deltas |
| `computer_use_stop` | Cancel or emergency-stop this Run's execution handle |

Every tool publishes an object JSON Schema with `additionalProperties: false`.
Unknown tools, missing fields, extra fields, invalid ranges, invalid enum members,
and unsupported pagination fail before the port is called. `key` and `scroll` remain
in the portable contract even when a platform port returns the fixed
`UNSUPPORTED` tool error.

`computer_use_capture` accepts only PNG bytes with the PNG signature and applies
configured byte, dimension, timestamp, and metadata bounds. It returns MCP image
content with `mimeType: image/png` and a separate bounded JSON text item containing
width, height, SHA-256, capture time, and display fingerprint.

## MCP lifecycle

The server supports exact negotiation for:

- `2024-11-05`
- `2025-03-26`
- `2025-06-18`

Supported requests and notifications are deliberately limited to:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`
- `notifications/cancelled`

`ping` is the only request accepted before initialization completes. Unsupported
versions fail with the supported-version list. Batches are rejected uniformly,
including under the 2025-03-26 revision, to preserve one bounded request and
cancellation identity per JSONL frame.

## Framing, bounds, and redaction

The stdio runner accepts one UTF-8 JSON-RPC object per line. It bounds bytes before
decoding, discards an oversized frame through its newline, and can process the next
valid frame. Request envelopes, lifecycle parameters, and tool arguments use
allowlisted keys.

Only JSON-RPC responses are written to stdout. Structured diagnostics are written to
stderr and contain fixed event codes plus a validated tool name. They never contain
raw input, port error messages, cancellation reasons, screen content, or
`type_text` plaintext.

The plaintext `text` value is passed only to `ComputerUseToolPort.typeText`.
Implementations MUST NOT log, persist, include it in an exception, or retain it
after the call. Even when a faulty port repeats plaintext in its thrown error, this
server returns and logs only a fixed redacted failure.

Client `notifications/cancelled` abort an in-flight port signal and suppress the
response, as required by MCP cancellation semantics. Calls also have bounded
concurrency and a hard timeout. Port failures are returned as MCP tool errors
(`isError: true`); malformed protocol or arguments use JSON-RPC errors.
