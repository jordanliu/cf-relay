import { z } from "zod";
import { invalidMessage } from "../errors/safe-error";
import type { RelayMessage, SecretRef } from "./models";

export const LIMITS = Object.freeze({
  rawBodyBytes: 32768,
  destinations: 10,
  title: 200,
  text: 5000,
  fields: 30,
  fieldValue: 1000,
  jobBytes: 16000,
  batchBytes: 200000,
});
const length = (value: string) => Array.from(value).length;
const boundedString = (max: number) =>
  z.string().refine((value) => length(value) <= max);
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const revisionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const correlationSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_:.-]+$/);
export const emailAddressSchema = z
  .email()
  .max(254)
  .refine(
    (value) => !/[\r\n]/.test(value) && !value.includes(String.fromCharCode(0)),
  );
export const secretRefSchema: z.ZodType<SecretRef> = z
  .object({
    kind: z.literal("cf-relay.secret"),
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  })
  .strict();
export const relayMessageSchema = z
  .object({
    title: boundedString(LIMITS.title).optional(),
    text: boundedString(LIMITS.text).min(1),
    fields: z
      .record(z.string().min(1).max(200), boundedString(LIMITS.fieldValue))
      .refine((fields) => Object.keys(fields).length <= LIMITS.fields)
      .optional(),
    replyTo: emailAddressSchema.optional(),
  })
  .strict();
export const deliveryJobSchema = z
  .object({
    kind: z.literal("delivery"),
    version: z.literal(1),
    deliveryId: correlationSchema,
    submissionId: correlationSchema,
    formId: identifierSchema,
    createdAt: z.iso.datetime(),
    destination: z
      .object({
        id: identifierSchema,
        provider: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(64),
        revision: revisionSchema,
      })
      .strict(),
    message: relayMessageSchema,
  })
  .strict();
export const errorCodeSchema = z.enum([
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "INVALID_DESTINATION",
  "INVALID_PAYLOAD",
  "DESTINATION_REVISION_MISMATCH",
  "UNSUPPORTED_JOB_VERSION",
  "UNKNOWN",
]);
export const failureRecordSchema = z
  .object({
    kind: z.literal("failure.record"),
    version: z.literal(1),
    occurredAt: z.iso.datetime(),
    deliveryId: correlationSchema.optional(),
    submissionId: correlationSchema.optional(),
    destinationId: identifierSchema.optional(),
    destinationRevision: revisionSchema.optional(),
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(64)
      .optional(),
    code: errorCodeSchema,
    source: z.enum(["permanent", "invalid_job"]),
    attempt: z.number().int().positive().optional(),
  })
  .strict();
export const failureEnvelopeSchema = z.discriminatedUnion("kind", [
  deliveryJobSchema,
  failureRecordSchema,
]);
export function validateMessage(input: unknown): RelayMessage {
  const result = relayMessageSchema.safeParse(input);
  if (!result.success) throw invalidMessage();
  return result.data;
}
export function encodedBytes(input: unknown): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength;
}
export function splitText(value: string, size: number): string[] {
  const points = Array.from(value);
  const chunks: string[] = [];
  for (let start = 0; start < points.length; start += size)
    chunks.push(points.slice(start, start + size).join(""));
  return chunks;
}
