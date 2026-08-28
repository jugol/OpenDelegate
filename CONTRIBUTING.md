# Contributing

OpenDelegate is a lightweight Hermes Device Federation setup kit.

Contributions should improve one of these areas:

- setup clarity;
- cross-platform connection guidance;
- safe templates;
- verified troubleshooting and recovery notes;
- security boundaries;
- generic examples that contain no private infrastructure data.

## Guidelines

- Keep changes small and readable.
- Prefer Markdown and simple text templates.
- Do not commit tokens, peer keys, credentials, private IP addresses, owner-specific paths, sessions,
  databases, logs, or `HERMES_HOME` contents.
- State whether a behavior belongs to official Hermes or requires an external durable orchestrator.
- Do not claim support from a local smoke test alone.
- Preserve English and Korean README parity for material workflow changes.

A prose change does not need a dedicated automated test. Before submitting, check links, review the
diff, and scan added text for secrets and private identifiers.
