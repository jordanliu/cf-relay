import type {
  DeliveryJob,
  DeliveryOutcome,
  FailureRecordV1,
  RelayMessage,
  ResolveSecrets,
} from "../domain/models";
export interface Schema<T> {
  parse(input: unknown): T;
}
export interface HttpClient {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
export interface Logger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}
export interface DeliveryContext {
  http: HttpClient;
  logger: Logger;
  signal: AbortSignal;
}
export interface DeliveryInput<T> {
  deliveryId: string;
  submissionId: string;
  formId: string;
  message: RelayMessage;
  config: T;
}
export interface ProviderExecutor<T> {
  deliver(
    input: DeliveryInput<T>,
    context: DeliveryContext,
  ): Promise<DeliveryOutcome>;
}
export interface ProviderDefinition<
  Type extends string,
  Config extends object,
  Dependencies extends object = Record<string, never>,
> {
  readonly type: Type;
  readonly configSchema: Schema<Config>;
  create(dependencies: Dependencies): ProviderExecutor<ResolveSecrets<Config>>;
}
export interface OutgoingEmail {
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}
export interface EmailTransport {
  send(
    email: OutgoingEmail,
    context: DeliveryContext,
  ): Promise<DeliveryOutcome>;
}
export interface EmailProviderDependencies {
  transport: EmailTransport;
}
export interface SecretReader {
  read(name: string): string | Promise<string>;
}
export interface JobPublisher {
  publish(jobs: readonly DeliveryJob[]): Promise<void>;
}
export interface FailureSink {
  record(event: FailureRecordV1): Promise<void>;
}
export interface RuntimeCapabilities {
  http: HttpClient;
  logger: Logger;
  secretReader: SecretReader;
  publisher: JobPublisher;
  failureSink: FailureSink;
}
export interface GuardInput {
  formId: string;
  security: Readonly<Record<string, unknown>>;
  headers: Readonly<Record<string, string>>;
  clientIp?: string;
}
export interface GuardCapabilities {
  http: HttpClient;
  secretReader: SecretReader;
  signal: AbortSignal;
  rateLimit(binding: string, key: string): Promise<boolean>;
}
export type GuardResult =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 429 | 503 };
export interface Guard {
  readonly type: string;
  readonly phase: "rate" | "auth" | "bot";
  readonly fields: readonly string[];
  readonly secretNames?: readonly string[];
  readonly bindingNames?: readonly string[];
  check(
    input: GuardInput,
    capabilities: GuardCapabilities,
  ): Promise<GuardResult>;
}
