import type { AuditEventSummaryV1 } from "@opendelegate/protocol";

export interface AuditAdminPort {
  list(): Promise<readonly AuditEventSummaryV1[]>;
}
