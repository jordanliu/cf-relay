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

interface SlackConfig {
  webhook: SecretRef;
}
export function renderSlack(message: RelayMessage) {
  const sections = [
    ...(message.title ? [message.title] : []),
    message.text,
    ...Object.entries(message.fields ?? {}).map(
      ([key, value]) => `${key}: ${value}`,
    ),
  ];
  const blocks = sections.flatMap((text) =>
    splitText(text, 1500).map((chunk) => ({
      type: "section",
      text: { type: "plain_text", text: chunk, emoji: false },
    })),
  );
  if (blocks.length > 50) throw new Error("Slack block limit exceeded");
  return {
    text: "New form submission",
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}
export function slackProvider(): ProviderDefinition<"slack", SlackConfig> {
  return {
    type: "slack",
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
            !["hooks.slack.com", "hooks.slack-gov.com"].includes(
              url.hostname,
            ) ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(
              url.pathname,
            )
          )
            return { status: "failed", code: "INVALID_DESTINATION" };
          let body: ReturnType<typeof renderSlack>;
          try {
            body = renderSlack(validateMessage(input.message));
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
          const text = (await boundedResponseText(response, 1024)).trim();
          return response.status === 200 && text === "ok"
            ? { status: "accepted" }
            : { status: "retry", code: "UNKNOWN" };
        },
      };
    },
  };
}
