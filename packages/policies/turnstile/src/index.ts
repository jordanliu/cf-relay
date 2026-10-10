import {
  boundedResponseText,
  type Guard,
  postJson,
  type SecretRef,
} from "@cf-relay/core";
export function turnstile(options: {
  tokenField: string;
  secret: SecretRef;
  expectedHostname: string;
  expectedAction?: string;
}): Guard {
  if (!options.expectedHostname || /[/:\s]/.test(options.expectedHostname))
    throw new Error("Turnstile requires an expected hostname");
  return {
    type: "turnstile",
    phase: "bot",
    fields: [options.tokenField],
    secretNames: [options.secret.name],
    async check(input, capabilities) {
      const token = input.security[options.tokenField];
      if (typeof token !== "string" || !token || token.length > 2048)
        return { allowed: false, status: 403 };
      try {
        const secret = await capabilities.secretReader.read(
          options.secret.name,
        );
        if (!secret) return { allowed: false, status: 503 };
        const response = await postJson(
          capabilities.http,
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          {
            secret,
            response: token,
            ...(input.clientIp ? { remoteip: input.clientIp } : {}),
          },
          capabilities.signal,
        );
        if (!response.ok) {
          await response.body?.cancel();
          return { allowed: false, status: 503 };
        }
        const result: unknown = JSON.parse(await boundedResponseText(response));
        if (!result || typeof result !== "object" || !("success" in result))
          return { allowed: false, status: 503 };
        if (result.success !== true) return { allowed: false, status: 403 };
        if (
          !("hostname" in result) ||
          result.hostname !== options.expectedHostname
        )
          return { allowed: false, status: 403 };
        if (
          options.expectedAction &&
          (!("action" in result) || result.action !== options.expectedAction)
        )
          return { allowed: false, status: 403 };
        return { allowed: true };
      } catch {
        return { allowed: false, status: 503 };
      }
    },
  };
}
