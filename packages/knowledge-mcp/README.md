# `@opendelegate/knowledge-mcp`

Strict, Device-local Model Context Protocol (MCP) stdio adapter for OpenDelegate
Knowledge.

This package is a protocol adapter, not a memory service or authority plane. It
does not know a Knowledge root, open files, persist an index, contact Main, or
mint a Run lease. `apps/worker` injects a `KnowledgeToolPort` backed by the current
Device's `LocalKnowledgeService` only after consuming a one-time Run capability.

## Public seam

```ts
await runKnowledgeMcpStdioServer({
  authority,
  port,
  limits: {
    maxCumulativeSearchCandidates: 20,
    maxCumulativeOpenCharacters: 24_000,
    maxCumulativeContextCharacters: 48_000,
  },
});
```

`authority` is an immutable Task, Work Order, Run, Device, lease, fencing-token,
and lease-expiry binding. It comes from `@opendelegate/run-capability-broker`, not
from an Agent or tool argument. Every port call receives the same binding and an
abort signal. The Worker-owned port revalidates the complete binding before every
read, immediately before an upsert, and again before returning a result.

The capability descriptor is a one-time, owner-only local file. It contains only
an opaque token, local endpoint, capability name, expiry, and framing bound. It
never contains the Knowledge root, a note identifier, query, title, preview,
relationship, or Markdown content.

## Tools

| Tool | Behavior |
| --- | --- |
| `knowledge_search` | Return a bounded candidate list from the local disposable index |
| `knowledge_open` | Open selected note IDs under an explicit character budget |
| `knowledge_relationships` | Return bounded outgoing references and backlinks |
| `knowledge_upsert` | Submit one note to the existing durable-Knowledge admission path |

All tool schemas reject undeclared keys. Note IDs must be relative, forward-slash
Markdown paths and cannot contain traversal components, backslashes, Windows
reserved path characters, or empty components. The underlying Knowledge service
also enforces real-path containment, ordinary-file and symlink rules, Secret and
transcript rejection, durable-value qualification, atomic replacement, and a
deterministic index rebuild after an accepted upsert.

## One connection and cumulative budgets

The MCP process may call tools repeatedly, but only over the single authenticated
connection created by consuming its capability file. Candidate, opened-character,
and serialized context budgets are cumulative for that connection. The Worker
capability handler independently enforces the same limits, so bypassing MCP
argument validation cannot widen the Run.

Input bytes, output bytes, concurrency, and tool duration are also bounded.
Cancellation aborts the local port. Capability disposal, lease/fence replacement,
Worker cancellation, expiry, or broker restart closes the connection and later
operations fail closed.

## Privacy boundary

Only JSON-RPC responses are written to stdout. stderr diagnostics contain stable
codes and validated tool names only. Raw port exceptions, tool inputs, results,
filenames, queries, Markdown, graph data, and local paths are never logged.

Knowledge tool inputs and results may enter only the native Agent process attached
to the same Worker Run. Provider adapters remove those values from normalized
tool events; Worker reports, Device-channel frames, Main storage, Admin Web,
Artifacts, and operational diagnostics receive no Knowledge data. Main may observe
only the coarse Knowledge health projection defined by the Worker inventory.

The server negotiates MCP revisions `2024-11-05`, `2025-03-26`, and `2025-06-18`.
Its supported surface is limited to `initialize`, `notifications/initialized`,
`ping`, `tools/list`, `tools/call`, and `notifications/cancelled`.
