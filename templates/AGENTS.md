# Hermes Device Agent rules

This Device is part of an owner-controlled Hermes fleet.

## Routing

- The Agent that receives the owner request remains responsible for the final answer.
- Delegate only when another Device is genuinely useful.
- Honor explicit Device names.
- Probe health before dispatch.

## Security

- Keep credentials, sessions, databases, auth files, peer keys, and `HERMES_HOME` local.
- Never disable SSH host-key verification.
- Reachability is not identity or authority.
- Confirm protected external or destructive actions.

## Completion

- Require observable completion criteria.
- Treat timeout as unknown observation, not automatic Worker failure.
- Do not promise later completion without a durable collector.
- Return results to the original owner conversation.
