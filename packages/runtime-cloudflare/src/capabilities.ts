import type { HttpClient, Logger, SecretReader } from "@cf-relay/core";
export const runtimeHttp: HttpClient = {
  fetch: (input, init) => fetch(input, init),
};
export function binding(env: object, name: string): unknown {
  return Object.hasOwn(env, name)
    ? (env as Record<string, unknown>)[name]
    : undefined;
}
export function cloudflareSecrets(env: object): SecretReader {
  return {
    read(name) {
      const value = binding(env, name);
      if (typeof value !== "string" || !value)
        throw new Error("Required secret unavailable");
      return value;
    },
  };
}
const allowedFields = new Set([
  "submissionId",
  "deliveryId",
  "destinationId",
  "destinationRevision",
  "provider",
  "formId",
  "status",
  "attempt",
  "durationMs",
  "code",
  "destinations",
  "delaySeconds",
]);
const allowedEvents = new Set([
  "submission.rejected",
  "submission.queued",
  "submission.publish_uncertain",
  "delivery.started",
  "delivery.accepted",
  "delivery.retry_scheduled",
  "delivery.permanently_failed",
  "delivery.revision_mismatch",
  "failure_sink.error",
  "delivery.unexpected_error",
]);
export function createSafeLogger(
  write: (level: string, event: Record<string, unknown>) => void = (
    level,
    fields,
  ) => console.log(JSON.stringify({ level, ...fields })),
): Logger {
  const emit = (
    level: string,
    event: string,
    fields: Record<string, unknown>,
  ) => {
    if (!allowedEvents.has(event)) return;
    const safe: Record<string, unknown> = { event };
    for (const [key, value] of Object.entries(fields))
      if (
        allowedFields.has(key) &&
        ((typeof value === "string" &&
          /^[a-zA-Z0-9_:.-]{1,256}$/.test(value)) ||
          (typeof value === "number" && Number.isFinite(value)))
      )
        safe[key] = value;
    // Diagnostics must never change Queue settlement or public acceptance semantics.
    try {
      write(level, safe);
    } catch {
      /* Log sinks are best effort. */
    }
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
