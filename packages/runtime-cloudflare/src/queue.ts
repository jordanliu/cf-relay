import {
  boundedBackoff,
  type DeliveryJob,
  deliveryFields,
  dispatch,
  encodedBytes,
  type FailureSink,
  type HttpClient,
  type JobPublisher,
  LIMITS,
  type Logger,
  type RelayConfig,
  RelayError,
  type SecretReader,
  withDeadline,
} from "@cf-relay/core";
export function cloudflarePublisher(
  queue: Pick<Queue<DeliveryJob>, "sendBatch">,
  timeoutMs = 5000,
  retain?: (pending: Promise<unknown>) => void,
): JobPublisher {
  return {
    async publish(jobs) {
      if (
        !jobs.length ||
        jobs.length > LIMITS.destinations ||
        jobs.some((job) => encodedBytes(job) > LIMITS.jobBytes) ||
        encodedBytes(jobs) > LIMITS.batchBytes
      )
        throw new RelayError(
          422,
          "INVALID_MESSAGE",
          "Queue batch exceeds supported limits.",
        );
      const pending = Promise.resolve().then(() =>
        queue.sendBatch(jobs.map((body) => ({ body, contentType: "json" }))),
      );
      retain?.(pending.catch(() => {}));
      await withDeadline(() => pending, timeoutMs);
    },
  };
}
export async function consumeQueue(
  config: RelayConfig,
  batch: Pick<MessageBatch<unknown>, "messages">,
  ports: {
    http: HttpClient;
    logger: Logger;
    secretReader: SecretReader;
    dependencies: Record<string, object>;
    failureSink: FailureSink;
    timeoutMs?: number;
  },
): Promise<void> {
  // Sequential within one bounded platform batch; other consumers run concurrently.
  for (const message of batch.messages) {
    let settlement: "ack" | "retry" = "retry";
    let delaySeconds = boundedBackoff(
      { status: "retry", code: "UNKNOWN" },
      message.attempts,
    );
    try {
      const result = await dispatch(
        config,
        message.body,
        message.attempts,
        ports,
      );
      const fields = result.job
        ? deliveryFields(result.job, message.attempts)
        : { attempt: message.attempts };
      if (result.outcome.status === "accepted") settlement = "ack";
      else if (result.outcome.status === "retry") {
        delaySeconds = boundedBackoff(result.outcome, message.attempts);
        ports.logger.warn("delivery.retry_scheduled", {
          ...fields,
          code: result.outcome.code,
          delaySeconds,
        });
      } else {
        try {
          if (!result.failure) throw new Error("Missing failure record");
          await ports.failureSink.record(result.failure);
          settlement = "ack";
          ports.logger.warn("delivery.permanently_failed", {
            ...fields,
            code: result.outcome.code,
          });
        } catch {
          ports.logger.error("failure_sink.error", {
            ...fields,
            code: "UNKNOWN",
          });
          ports.logger.warn("delivery.retry_scheduled", {
            ...fields,
            code: "UNKNOWN",
            delaySeconds,
          });
        }
      }
    } catch {
      ports.logger.error("delivery.unexpected_error", {
        attempt: message.attempts,
        code: "UNKNOWN",
      });
    }
    // A successful consumer return auto-acks unsettled messages. Always settle explicitly.
    if (settlement === "ack") message.ack();
    else message.retry({ delaySeconds });
  }
}
