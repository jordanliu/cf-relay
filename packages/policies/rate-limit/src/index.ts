import type { Guard } from "@cf-relay/core";
export function rateLimit(options: {
  binding: string;
}): Guard & { readonly type: "rate-limit" } {
  options = Object.freeze({ ...options });
  return {
    type: "rate-limit",
    phase: "rate",
    fields: [],
    bindingNames: [options.binding],
    async check(input, capabilities) {
      if (!input.clientIp) return { allowed: false, status: 503 };
      // Only the trusted edge CF-Connecting-IP header supplies actor identity.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input.clientIp),
      );
      const actor = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      try {
        return (await capabilities.rateLimit(
          options.binding,
          `${input.formId}:${actor}`,
        ))
          ? { allowed: true }
          : { allowed: false, status: 429 };
      } catch {
        return { allowed: false, status: 503 };
      }
    },
  };
}
