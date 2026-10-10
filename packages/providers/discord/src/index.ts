import {
  boundedResponseText,
  classifyHttp,
  type ProviderDefinition,
  postJson,
  type RelayMessage,
  type SecretRef,
  secretRefSchema,
  splitText,
  validateMessage,
} from "@cf-relay/core";
import { z } from "zod";

interface DiscordConfig {
  webhook: SecretRef;
}
const neutralize = (value: string) =>
  value
    .replace(/@/g, "@\u200b")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/[\\*_`~|]/g, "\\$&");
interface Embed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline: false }[];
}
export function renderDiscord(message: RelayMessage) {
  const title = message.title ? neutralize(message.title) : undefined;
  const embeds: Embed[] = splitText(neutralize(message.text), 2000).map(
    (description, index) => ({
      description,
      ...(index === 0 && title ? { title } : {}),
    }),
  );
  const fields = Object.entries(message.fields ?? {}).map(([name, value]) => ({
    name: neutralize(name),
    value: neutralize(value) || "\u200b",
    inline: false as const,
  }));
  for (let index = 0; index < fields.length; index += 25)
    embeds.push({ fields: fields.slice(index, index + 25) });
  const total = embeds.reduce(
    (size, embed) =>
      size +
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.fields?.reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0,
      ) ?? 0),
    0,
  );
  if (
    embeds.length > 10 ||
    total > 6000 ||
    (title?.length ?? 0) > 256 ||
    fields.some((field) => field.name.length > 256 || field.value.length > 1024)
  )
    throw new Error("Discord payload limit exceeded");
  return { allowed_mentions: { parse: [] }, embeds };
}
export function discordProvider(): ProviderDefinition<
  "discord",
  DiscordConfig
> {
  return {
    type: "discord",
    configSchema: z.object({ webhook: secretRefSchema }).strict(),
    create() {
      return {
        async deliver(input, context) {
          let url: URL;
          try {
            url = new URL(input.config.webhook);
          } catch {
            return { status: "failed", code: "INVALID_DESTINATION" };
          }
          if (
            url.protocol !== "https:" ||
            url.hostname !== "discord.com" ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(
              url.pathname,
            )
          )
            return { status: "failed", code: "INVALID_DESTINATION" };
          url.searchParams.set("wait", "true");
          let body: ReturnType<typeof renderDiscord>;
          try {
            body = renderDiscord(validateMessage(input.message));
          } catch {
            return { status: "failed", code: "INVALID_PAYLOAD" };
          }
          const response = await postJson(
            context.http,
            url.href,
            body,
            context.signal,
          );
          const outcome = classifyHttp(response);
          if (outcome) {
            await response.body?.cancel();
            return outcome;
          }
          try {
            const result: unknown = JSON.parse(
              await boundedResponseText(response),
            );
            return response.status === 200 &&
              result &&
              typeof result === "object" &&
              "id" in result &&
              typeof result.id === "string" &&
              /^\d+$/.test(result.id)
              ? { status: "accepted", externalId: result.id }
              : { status: "retry", code: "UNKNOWN" };
          } catch {
            return { status: "retry", code: "UNKNOWN" };
          }
        },
      };
    },
  };
}
