import type { Guard, SecretRef } from "@cf-relay/core";
export function apiKey(options: {
  secret: SecretRef;
}): Guard & { readonly type: "api-key" } {
  options = Object.freeze({
    ...options,
    secret: Object.freeze({ ...options.secret }),
  });
  return {
    type: "api-key",
    phase: "auth",
    fields: [],
    secretNames: [options.secret.name],
    async check(input, capabilities) {
      const header = input.headers.authorization ?? "";
      if (
        !header.startsWith("Bearer ") ||
        header.length > 4096 ||
        header.length <= 7
      )
        return { allowed: false, status: 401 };
      try {
        const expected = await capabilities.secretReader.read(
          options.secret.name,
        );
        if (!expected) return { allowed: false, status: 503 };
        // Verify a fixed message with HMAC: Web Crypto performs the MAC comparison.
        const encoder = new TextEncoder();
        const data = encoder.encode("cf-relay.api-key.v1");
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(expected),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const signature = await crypto.subtle.sign("HMAC", key, data);
        const presented = await crypto.subtle.importKey(
          "raw",
          encoder.encode(header.slice(7)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        );
        return (await crypto.subtle.verify("HMAC", presented, signature, data))
          ? { allowed: true }
          : { allowed: false, status: 401 };
      } catch {
        return { allowed: false, status: 503 };
      }
    },
  };
}
