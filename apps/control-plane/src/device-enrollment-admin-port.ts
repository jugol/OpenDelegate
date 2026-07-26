import type {
  DeviceEnrollmentOverviewV1,
  IssueEnrollmentGrantResponseV1,
} from "@opendelegate/protocol";

export interface IssueDeviceEnrollmentGrantInput {
  readonly deviceId: string;
  readonly expiresInSeconds: number;
  readonly principalId: string;
  readonly idempotencyKey: string;
}

export interface DeviceEnrollmentAdminPort {
  overview(): Promise<DeviceEnrollmentOverviewV1>;
  issue(input: IssueDeviceEnrollmentGrantInput): Promise<IssueEnrollmentGrantResponseV1>;
}
