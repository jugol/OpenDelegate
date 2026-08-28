# Device Agent: DEVICE_ID

- Device ID: `DEVICE_ID`
- Host label: `DEVICE_HOST_LABEL`
- Preferred private route: `DEVICE_PRIVATE_ROUTE`
- Peer API: `DEVICE_PRIVATE_URL`
- Hermes home: `DEVICE_LOCAL_HERMES_HOME`
- Role: `DEVICE_ROLE`
- Computer Use: `enabled|disabled|unavailable`

## Federation peers

- `coordinator`: `COORDINATOR_PRIVATE_URL`
- `worker-a`: `WORKER_A_PRIVATE_URL`

## Availability

Before delegation, probe the candidate health endpoint. Dispatch only after an authenticated healthy
response. Health proves service readiness, not authority to perform the requested action.

## Local-only data

Do not commit a populated copy of this file when it contains private routes, owner paths, or local
identifiers. Never include credentials or peer keys here.
