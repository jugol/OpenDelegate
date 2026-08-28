# Security policy

OpenDelegate documents how to connect powerful local Agents. Treat every Device Agent as code with the
same authority as the OS user running it.

## Do not report secrets publicly

Never include bot tokens, API keys, peer keys, private IP addresses, SSH private keys, authentication
files, owner paths, session transcripts, or databases in an issue or pull request.

For a suspected security issue, contact the repository owner privately before publishing details.

## Baseline rules

- Use authenticated peer APIs and SSH host-key verification.
- Keep `HERMES_HOME` and credentials Device-local.
- Restrict API listeners to trusted networks and require strong keys.
- Prefer a sandbox for untrusted or remotely initiated tool execution.
- Use least-privilege platform and Discord permissions.
- Confirm authority-expanding and externally visible actions.
- Preserve rollback before changing services or connection policy.

See [Security boundaries](docs/SECURITY_BOUNDARIES.md).
