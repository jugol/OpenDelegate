import Type from "typebox";

import { OpaqueIdSchema } from "./common.ts";

export const DeviceOsFamilySchema = Type.Union([
  Type.Literal("macos"),
  Type.Literal("windows"),
  Type.Literal("linux"),
]);

export const DeviceSummarySchema = Type.Object(
  {
    deviceId: OpaqueIdSchema,
    name: Type.String({ minLength: 1, maxLength: 253 }),
    osFamily: DeviceOsFamilySchema,
    platformRelease: Type.String({ minLength: 1, maxLength: 256 }),
    architecture: Type.String({ minLength: 1, maxLength: 64 }),
    role: Type.Union([Type.Literal("main"), Type.Literal("worker")]),
    connection: Type.Union([Type.Literal("online"), Type.Literal("offline")]),
    runtime: Type.Union([
      Type.Literal("healthy"),
      Type.Literal("degraded"),
      Type.Literal("unavailable"),
    ]),
    serviceMode: Type.Union([
      Type.Literal("foreground"),
      Type.Literal("system-service"),
      Type.Literal("user-service"),
    ]),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceSummaryV1",
  },
);

export type DeviceSummaryV1 = Type.Static<typeof DeviceSummarySchema>;

export const DeviceListResponseSchema = Type.Object(
  {
    devices: Type.Array(DeviceSummarySchema, {
      maxItems: 10_000,
      uniqueItems: true,
    }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceListResponseV1",
  },
);

export type DeviceListResponseV1 = Type.Static<typeof DeviceListResponseSchema>;
