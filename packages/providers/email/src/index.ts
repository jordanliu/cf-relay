import {
  type EmailProviderDependencies,
  emailAddressSchema,
  type OutgoingEmail,
  type ProviderDefinition,
  type RelayMessage,
  validateMessage,
} from "@cf-relay/core";
import { z } from "zod";

interface EmailConfig {
  from: string;
  to: string[];
}
export const emailConfigSchema = z
  .object({
    from: emailAddressSchema,
    to: z.array(emailAddressSchema).min(1).max(50),
  })
  .strict();
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
export function renderEmail(
  message: RelayMessage,
  config: EmailConfig,
): OutgoingEmail {
  const subject = message.title ?? "New form submission";
  if (/[\r\n]/.test(subject) || subject.includes(String.fromCharCode(0)))
    throw new Error("Invalid subject");
  const fields = Object.entries(message.fields ?? {});
  const text = [
    message.text,
    ...fields.map(([key, value]) => `${key}: ${value}`),
  ].join("\n\n");
  const html = `<h1>${escapeHtml(subject)}</h1><p>${escapeHtml(message.text).replace(/\n/g, "<br>")}</p>${fields.map(([key, value]) => `<p><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value).replace(/\n/g, "<br>")}</p>`).join("")}`;
  return {
    ...config,
    to: [...config.to],
    subject,
    text,
    html,
    ...(message.replyTo
      ? { replyTo: emailAddressSchema.parse(message.replyTo) }
      : {}),
  };
}
export function emailProvider(): ProviderDefinition<
  "email",
  EmailConfig,
  EmailProviderDependencies
> {
  return {
    type: "email",
    configSchema: emailConfigSchema,
    create({ transport }) {
      if (!transport || typeof transport.send !== "function")
        throw new Error("Email transport unavailable");
      return {
        async deliver(input, context) {
          let email: OutgoingEmail;
          try {
            email = renderEmail(
              validateMessage(input.message),
              emailConfigSchema.parse(input.config),
            );
          } catch {
            return { status: "failed", code: "INVALID_PAYLOAD" };
          }
          return transport.send(email, context);
        },
      };
    },
  };
}
