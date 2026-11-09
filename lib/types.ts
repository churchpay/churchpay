import { z } from "zod";

export const memberFieldSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.null()]),
});
export const memberSchema = z.object({
  personId: z.number().int().positive(),
  person: z.object({
    domainAttributes: z.object({
      firstName: z.string().trim(),
      lastName: z.string().trim(),
    }),
  }),
  group: z.object({ title: z.string().min(1) }),
  groupMemberStatus: z.string(),
  fields: z.array(memberFieldSchema),
});
export const groupMemberFieldSchema = z.object({
  type: z.enum(["group", "person"]),
  field: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    fieldTypeCode: z.string(),
    options: z
      .array(
        z.object({ id: z.union([z.string(), z.number()]), name: z.string() }),
      )
      .nullish(),
  }),
});
export type MemberField = z.infer<typeof memberFieldSchema>;
export type GroupMemberField = z.infer<typeof groupMemberFieldSchema>;
export type Quote = {
  groupName: string;
  personName: string;
  amountCents: number;
  paidFieldId: number;
  paid: boolean;
};
export type PaymentStatus =
  | "creating"
  | "created"
  | "capturing"
  | "pending"
  | "completed"
  | "refunded"
  | "reversed"
  | "review";
export type PaymentResult = {
  type: "status";
  status: PaymentStatus;
  synced: boolean;
};
export type PaymentInfo =
  | { type: "error"; message: string }
  | PaymentResult
  | { type: "data"; groupName: string; amountCents: number; clientId: string };
