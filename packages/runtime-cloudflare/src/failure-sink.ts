import {
  type FailureRecordV1,
  type FailureSink,
  failureRecordSchema,
  withDeadline,
} from "@cf-relay/core";
export function cloudflareFailureSink(
  queue: Pick<Queue<FailureRecordV1>, "send">,
  timeoutMs = 5000,
  retain?: (pending: Promise<unknown>) => void,
): FailureSink {
  return {
    async record(event) {
      const safe = failureRecordSchema.parse(event);
      const pending = Promise.resolve().then(() =>
        queue.send(safe, { contentType: "json" }),
      );
      retain?.(pending.catch(() => {}));
      await withDeadline(() => pending, timeoutMs);
    },
  };
}
