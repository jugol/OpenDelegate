# ADR-0036: Socket closure releases in-flight Worker requests

Status: **Accepted**

Date: **2026-08-08**

## Context

The Worker renews its short-lived Device certificate over its authenticated channel.
Renewal sends a durable rotation request and waits for Main's correlated response
before the next heartbeat. A production socket closed in that interval. The request
waiter was only rejected by an explicit client `close()`, so the daemon remained
alive but never reached heartbeat failure or its reconnect loop. Twelve hours later
the certificate expired and the Device required owner-authorized re-credentialing.

Identity rotation is not unique here. Artifact preparation, action authorization,
Run lease renewal, and ordinary event acknowledgments also wait on responses tied to
one socket and must not survive that socket.

## Decision

The Worker Device-channel client rejects and clears every pending response waiter
when the underlying WebSocket closes unexpectedly. Explicit close uses the same
cleanup operation before closing the socket. Durable outbound frames are unchanged,
so a new client can replay them through the existing acknowledgment boundary.

## Consequences

An interrupted certificate renewal returns an unavailable outcome to the daemon,
the next maintenance step observes the dead connection, and the ordinary reconnect
loop creates a fresh client. Other request/response operations gain the same bounded
failure behavior. No cumulative state or credential limit is reset.

## Verification

- A real mutually authenticated channel begins certificate rotation while Main
  deliberately holds its response.
- Closing that socket rejects the Worker's rotation Promise within one second with
  a channel-disconnected error.
- Existing successful rotation, pending-rotation refusal, and reconnect tests remain
  authoritative.

## References

- [`../PRODUCT_SPEC.md`](../PRODUCT_SPEC.md), FR-21
- [`../DECISIONS.md`](../DECISIONS.md), D-084
- [`0033-owner-input-idle-budget-resumption.md`](0033-owner-input-idle-budget-resumption.md)
