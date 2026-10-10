import { z } from "zod";
import type { RelayConfig } from "../config/registry";
import { resolveSecrets } from "../config/secrets";
import type { DeliveryContext, SecretReader } from "../contracts/ports";
import type {
  DeliveryJob,
  DeliveryOutcome,
  FailureRecordV1,
} from "../domain/models";
import { deliveryJobSchema, encodedBytes, LIMITS } from "../domain/validation";
import { DeadlineError, withDeadline } from "./deadline";

const outcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      externalId: z.string().max(256).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("retry"),
      code: z.enum([
        "RATE_LIMITED",
        "TIMEOUT",
        "UPSTREAM_UNAVAILABLE",
        "UNKNOWN",
      ]),
      retryAfterSeconds: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.enum([
        "AUTHENTICATION_FAILED",
        "INVALID_DESTINATION",
        "INVALID_PAYLOAD",
        "DESTINATION_REVISION_MISMATCH",
        "UNSUPPORTED_JOB_VERSION",
      ]),
    })
    .strict(),
]);
export type DispatchResult = {
  outcome: DeliveryOutcome;
  job?: DeliveryJob;
  failure?: FailureRecordV1;
};
export async function dispatch(
  config: RelayConfig,
  raw: unknown,
  attempt: number,
  context: Omit<DeliveryContext, "signal"> & {
    secretReader: SecretReader;
    dependencies: Record<string, object>;
    getDependencies?: (type: string) => object;
    timeoutMs?: number;
  },
): Promise<DispatchResult> {
  const parsed = deliveryJobSchema.safeParse(raw);
  if (!parsed.success || encodedBytes(parsed.data) > LIMITS.jobBytes) {
    const version =
      raw && typeof raw === "object" && "version" in raw
        ? raw.version
        : undefined;
    const code =
      version !== undefined && version !== 1
        ? "UNSUPPORTED_JOB_VERSION"
        : "INVALID_PAYLOAD";
    return {
      outcome: { status: "failed", code },
      failure: {
        kind: "failure.record",
        version: 1,
        occurredAt: new Date().toISOString(),
        code,
        source: "invalid_job",
        attempt,
      },
    };
  }
  const job = parsed.data;
  const fields = deliveryFields(job, attempt);
  const started = Date.now();
  context.logger.info("delivery.started", fields);
  const destination = Object.hasOwn(config.destinations, job.destination.id)
    ? config.destinations[job.destination.id]
    : undefined;
  let outcome: DeliveryOutcome;
  if (
    !destination ||
    destination.provider !== job.destination.provider ||
    destination.revision !== job.destination.revision
  ) {
    outcome = { status: "failed", code: "DESTINATION_REVISION_MISMATCH" };
    context.logger.warn("delivery.revision_mismatch", fields);
  } else {
    const definition = config.providers.find(
      (provider) => provider.type === destination.provider,
    );
    if (!definition)
      outcome = { status: "failed", code: "INVALID_DESTINATION" };
    else {
      try {
        outcome = await withDeadline(async (signal) => {
          const {
            provider: _type,
            revision: _revision,
            ...declared
          } = destination;
          const resolved = await resolveSecrets(declared, context.secretReader);
          if (signal.aborted) throw new DeadlineError();
          const executor = definition.create(
            context.getDependencies?.(definition.type) ??
              context.dependencies[definition.type] ??
              {},
          );
          return outcomeSchema.parse(
            await executor.deliver(
              {
                deliveryId: job.deliveryId,
                submissionId: job.submissionId,
                formId: job.formId,
                message: job.message,
                config: resolved,
              },
              { http: context.http, logger: context.logger, signal },
            ),
          );
        }, context.timeoutMs ?? 10000);
      } catch (error) {
        outcome = {
          status: "retry",
          code: error instanceof DeadlineError ? "TIMEOUT" : "UNKNOWN",
        };
      }
    }
  }
  const failure: FailureRecordV1 | undefined =
    outcome.status === "failed"
      ? {
          kind: "failure.record",
          version: 1,
          occurredAt: new Date().toISOString(),
          deliveryId: job.deliveryId,
          submissionId: job.submissionId,
          destinationId: job.destination.id,
          destinationRevision: job.destination.revision,
          provider: job.destination.provider,
          code: outcome.code,
          source: "permanent",
          attempt,
        }
      : undefined;
  if (outcome.status === "accepted")
    context.logger.info("delivery.accepted", {
      ...fields,
      status: outcome.status,
      durationMs: Date.now() - started,
    });
  return { outcome, job, ...(failure ? { failure } : {}) };
}
export function deliveryFields(
  job: DeliveryJob,
  attempt: number,
): Record<string, unknown> {
  return {
    submissionId: job.submissionId,
    deliveryId: job.deliveryId,
    destinationId: job.destination.id,
    destinationRevision: job.destination.revision,
    provider: job.destination.provider,
    attempt,
  };
}
export function boundedBackoff(
  outcome: Extract<DeliveryOutcome, { status: "retry" }>,
  attempt: number,
  random = Math.random,
  maxDelaySeconds = 3600,
): number {
  const cap = Math.max(1, Math.min(86400, Math.floor(maxDelaySeconds)));
  const exponential = Math.min(cap, 2 ** Math.min(Math.max(0, attempt), 16));
  const delay = Math.ceil(
    exponential * (0.5 + Math.max(0, Math.min(1, random())) * 0.5),
  );
  const hint = Number.isFinite(outcome.retryAfterSeconds)
    ? Math.ceil(outcome.retryAfterSeconds ?? 0)
    : 0;
  return Math.max(1, Math.min(cap, Math.max(delay, hint)));
}
