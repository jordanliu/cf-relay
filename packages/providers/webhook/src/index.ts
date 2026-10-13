import {
  classifyHttp,
  correlationSchema,
  type DeliveryInput,
  identifierSchema,
  type ProviderDefinition,
  relayMessageSchema,
  type SecretRef,
  secretRefSchema,
} from "@cf-relay/core";
import { z } from "zod";

export interface WebhookConfig {
  url: SecretRef;
  bearerToken?: SecretRef | undefined;
  signingSecret?: SecretRef | undefined;
}

export const webhookPayloadSchema = z
  .object({
    version: z.literal(1),
    deliveryId: correlationSchema,
    submissionId: correlationSchema,
    formId: identifierSchema,
    createdAt: z.iso.datetime(),
    message: relayMessageSchema,
  })
  .strict();
export type WebhookPayloadV1 = z.infer<typeof webhookPayloadSchema>;

export function renderWebhook(
  input: Omit<DeliveryInput<unknown>, "config">,
): WebhookPayloadV1 {
  return webhookPayloadSchema.parse({
    version: 1,
    deliveryId: input.deliveryId,
    submissionId: input.submissionId,
    formId: input.formId,
    createdAt: input.createdAt,
    message: input.message,
  });
}

export function decodeSigningSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new Error("Invalid signing key");
  const decoded = atob(secret.slice(6));
  if (decoded.length < 24 || decoded.length > 64)
    throw new Error("Invalid signing key");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function webhookProvider(): ProviderDefinition<
  "webhook",
  WebhookConfig
> {
  return {
    type: "webhook",
    configSchema: z
      .object({
        url: secretRefSchema,
        bearerToken: secretRefSchema.optional(),
        signingSecret: secretRefSchema.optional(),
      })
      .strict(),
    create() {
      return {
        async deliver(input, context) {
          if (context.signal.aborted)
            return { status: "retry", code: "TIMEOUT" };
          let url: URL;
          let signingKey: Uint8Array<ArrayBuffer> | undefined;
          try {
            url = new URL(input.config.url);
            if (
              url.protocol !== "https:" ||
              url.username ||
              url.password ||
              url.hash
            )
              throw new Error("Invalid endpoint");
            if (
              input.config.bearerToken !== undefined &&
              (!input.config.bearerToken ||
                input.config.bearerToken.length > 4096 ||
                /[\r\n\0]/.test(input.config.bearerToken))
            )
              throw new Error("Invalid bearer token");
            if (input.config.signingSecret !== undefined)
              signingKey = decodeSigningSecret(input.config.signingSecret);
          } catch {
            return { status: "failed", code: "INVALID_DESTINATION" };
          }
          let body: string;
          try {
            body = JSON.stringify(renderWebhook(input));
          } catch {
            return { status: "failed", code: "INVALID_PAYLOAD" };
          }
          // Encode IDs to keep the signed identifier unambiguous even for imported jobs.
          const id = btoa(input.deliveryId)
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");
          const timestamp = String(Math.floor(Date.now() / 1000));
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "webhook-id": id,
            "webhook-timestamp": timestamp,
          };
          if (input.config.bearerToken)
            headers.authorization = `Bearer ${input.config.bearerToken}`;
          if (signingKey) {
            const key = await crypto.subtle.importKey(
              "raw",
              signingKey,
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            );
            const signature = await crypto.subtle.sign(
              "HMAC",
              key,
              new TextEncoder().encode(`${id}.${timestamp}.${body}`),
            );
            headers["webhook-signature"] =
              `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
          }
          if (context.signal.aborted)
            return { status: "retry", code: "TIMEOUT" };
          const response = await context.http.fetch(url.href, {
            method: "POST",
            headers,
            body,
            signal: context.signal,
            redirect: "manual",
          });
          await response.body?.cancel().catch(() => {});
          if (response.status >= 200 && response.status < 300)
            return { status: "accepted" };
          if (response.status === 408)
            return { status: "retry", code: "UPSTREAM_UNAVAILABLE" };
          if (response.status >= 300 && response.status < 400)
            return { status: "failed", code: "INVALID_DESTINATION" };
          return (
            classifyHttp(response) ?? {
              status: "failed",
              code: "INVALID_DESTINATION",
            }
          );
        },
      };
    },
  };
}
