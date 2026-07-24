import Type from "typebox";

export const AcknowledgementSchema = Type.Object(
  {
    status: Type.Literal("ok"),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateAcknowledgementV1",
  },
);

export const EmptyObjectSchema = Type.Object(
  {},
  {
    additionalProperties: false,
  },
);

export type Acknowledgement = Type.Static<typeof AcknowledgementSchema>;
