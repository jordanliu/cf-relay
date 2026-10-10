import type { DeliveryOutcome, EmailTransport } from "@cf-relay/core";
export function cloudflareEmailTransport(
  binding: Pick<SendEmail, "send">,
): EmailTransport {
  if (!binding || typeof binding.send !== "function")
    throw new Error("Email binding unavailable");
  return {
    async send(email, context): Promise<DeliveryOutcome> {
      if (context.signal.aborted) return { status: "retry", code: "TIMEOUT" };
      try {
        // Native send currently has no cancellation signal. Dispatcher bounds the wait,
        // but an expired attempt may still be accepted and a retry may duplicate it.
        const result = await binding.send(email);
        return result &&
          typeof result.messageId === "string" &&
          result.messageId
          ? { status: "accepted", externalId: result.messageId }
          : { status: "retry", code: "UNKNOWN" };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (
          code === "E_RATE_LIMIT_EXCEEDED" ||
          code === "E_DAILY_LIMIT_EXCEEDED"
        )
          return { status: "retry", code: "RATE_LIMITED" };
        if (code === "E_INTERNAL_SERVER_ERROR" || code === "E_DELIVERY_FAILED")
          return { status: "retry", code: "UPSTREAM_UNAVAILABLE" };
        if (
          [
            "E_SENDER_NOT_VERIFIED",
            "E_RECIPIENT_NOT_ALLOWED",
            "E_RECIPIENT_SUPPRESSED",
            "E_SENDER_DOMAIN_NOT_AVAILABLE",
          ].includes(String(code))
        )
          return { status: "failed", code: "INVALID_DESTINATION" };
        if (
          [
            "E_VALIDATION_ERROR",
            "E_FIELD_MISSING",
            "E_TOO_MANY_RECIPIENTS",
            "E_CONTENT_TOO_LARGE",
            "E_HEADER_NOT_ALLOWED",
            "E_HEADER_USE_API_FIELD",
            "E_HEADER_VALUE_INVALID",
            "E_HEADER_VALUE_TOO_LONG",
            "E_HEADER_NAME_INVALID",
          ].includes(String(code))
        )
          return { status: "failed", code: "INVALID_PAYLOAD" };
        return { status: "retry", code: "UNKNOWN" };
      }
    },
  };
}
