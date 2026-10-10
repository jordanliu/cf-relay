export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface Submission<T = Record<string, JsonValue>> {
  id: string;
  formId: string;
  createdAt: string;
  data: T;
  metadata: { origin?: string | undefined };
}
export interface RelayMessage {
  title?: string | undefined;
  text: string;
  fields?: Record<string, string> | undefined;
  replyTo?: string | undefined;
}
export interface DeliveryJobV1 {
  kind: "delivery";
  version: 1;
  deliveryId: string;
  submissionId: string;
  formId: string;
  createdAt: string;
  destination: { id: string; provider: string; revision: string };
  message: RelayMessage;
}
export type DeliveryJob = DeliveryJobV1;
export type DeliveryErrorCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "INVALID_DESTINATION"
  | "INVALID_PAYLOAD"
  | "DESTINATION_REVISION_MISMATCH"
  | "UNSUPPORTED_JOB_VERSION"
  | "UNKNOWN";
export type RetryCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UNKNOWN";
export type DeliveryOutcome =
  | { status: "accepted"; externalId?: string | undefined }
  | { status: "retry"; code: RetryCode; retryAfterSeconds?: number | undefined }
  | { status: "failed"; code: Exclude<DeliveryErrorCode, RetryCode> };
export interface FailureRecordV1 {
  kind: "failure.record";
  version: 1;
  occurredAt: string;
  deliveryId?: string | undefined;
  submissionId?: string | undefined;
  destinationId?: string | undefined;
  destinationRevision?: string | undefined;
  provider?: string | undefined;
  code: DeliveryErrorCode;
  source: "permanent" | "invalid_job";
  attempt?: number | undefined;
}
export type FailureEnvelope = DeliveryJobV1 | FailureRecordV1;
export interface SecretRef<Name extends string = string> {
  readonly kind: "cf-relay.secret";
  readonly name: Name;
}
export type ResolveSecrets<T> = T extends SecretRef
  ? string
  : T extends readonly (infer U)[]
    ? readonly ResolveSecrets<U>[]
    : T extends object
      ? { [K in keyof T]: ResolveSecrets<T[K]> }
      : T;
export function secret<const Name extends string>(name: Name): SecretRef<Name> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    throw new Error("Invalid secret binding name");
  return Object.freeze({ kind: "cf-relay.secret", name });
}
