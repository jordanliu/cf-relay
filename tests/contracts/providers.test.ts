import {
  type DeliveryContext,
  type DeliveryInput,
  type EmailTransport,
  secret,
} from "@cf-relay/core";
import { cloudflareEmailTransport } from "@cf-relay/email-cloudflare";
import { resendEmailTransport } from "@cf-relay/email-resend";
import { discordProvider, renderDiscord } from "@cf-relay/provider-discord";
import { emailProvider, renderEmail } from "@cf-relay/provider-email";
import { renderSlack, slackProvider } from "@cf-relay/provider-slack";
import { createSafeLogger } from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";

const base = {
  deliveryId: "sub_test:target",
  submissionId: "sub_test",
  formId: "contact",
  message: {
    title: "Hello <script> @everyone",
    text: "<@123> & @here **bold**",
    fields: { "<b>Name</b>": "<img src=x>" },
    replyTo: "sender@example.com",
  },
};
function context(
  response: () => Response,
): DeliveryContext & { http: { fetch: ReturnType<typeof vi.fn> } } {
  return {
    http: { fetch: vi.fn(async () => response()) },
    logger: createSafeLogger(),
    signal: new AbortController().signal,
  };
}
describe("provider rendering and protocol acceptance", () => {
  it("Slack uses only plain-text user blocks and splits long text without data loss", () => {
    const message = {
      text: "😀".repeat(5000),
      fields: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`field${i}`, "a".repeat(1000)]),
      ),
    };
    const payload = renderSlack(message);
    expect(
      payload.blocks.every(
        (block) =>
          block.text.type === "plain_text" && block.text.text.length <= 3000,
      ),
    ).toBe(true);
    expect(
      payload.blocks
        .slice(0, 4)
        .map((block) => block.text.text)
        .join(""),
    ).toBe(message.text);
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    expect(payload.text).not.toMatch(/@/);
  });
  it("accepts only Slack's acknowledged 200 ok result", async () => {
    const input = {
      ...base,
      config: {
        webhook: "https://hooks.slack.com/services/TTEST/BTEST/FAKEONLY",
      },
    };
    const executor = slackProvider().create({});
    expect(
      await executor.deliver(
        input,
        context(() => new Response("ok")),
      ),
    ).toEqual({ status: "accepted" });
    expect(
      await executor.deliver(
        input,
        context(() => new Response("unexpected")),
      ),
    ).toEqual({ status: "retry", code: "UNKNOWN" });
    expect(
      await executor.deliver(
        input,
        context(() => new Response("secret", { status: 403 })),
      ),
    ).toEqual({ status: "failed", code: "AUTHENTICATION_FAILED" });
  });
  it("Discord suppresses mentions, neutralizes markup, splits text and rejects excessive payloads", () => {
    const payload = renderDiscord(base.message);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]?.description).not.toContain("<@123>");
    const long = renderDiscord({ text: "a".repeat(5000) });
    expect(long.embeds.map((embed) => embed.description).join("")).toHaveLength(
      5000,
    );
    expect(
      long.embeds.every((embed) => (embed.description?.length ?? 0) <= 4096),
    ).toBe(true);
    expect(() =>
      renderDiscord({
        text: "a".repeat(5000),
        fields: { big: "b".repeat(1000) },
      }),
    ).toThrow(/limit/);
  });
  it("forces wait=true and requires Discord's returned message id", async () => {
    const ctx = context(() => Response.json({ id: "12345" }));
    const executor = discordProvider().create({});
    const input = {
      ...base,
      config: { webhook: "https://discord.com/api/webhooks/123/FAKEONLY" },
    };
    expect(await executor.deliver(input, ctx)).toEqual({
      status: "accepted",
      externalId: "12345",
    });
    expect(String(ctx.http.fetch.mock.calls[0]?.[0])).toContain("wait=true");
    expect(
      await executor.deliver(
        input,
        context(() => new Response(null, { status: 204 })),
      ),
    ).toEqual({ status: "retry", code: "UNKNOWN" });
    expect(
      await executor.deliver(
        input,
        context(() => Response.json({ noId: true })),
      ),
    ).toEqual({ status: "retry", code: "UNKNOWN" });
  });
  it.each([429, 500, 503])(
    "classifies HTTP %i as retryable",
    async (status) => {
      const ctx = context(
        () =>
          new Response("sensitive details", {
            status,
            headers: { "retry-after": "60" },
          }),
      );
      const result = await slackProvider()
        .create({})
        .deliver(
          {
            ...base,
            config: {
              webhook: "https://hooks.slack.com/services/TTEST/BTEST/FAKEONLY",
            },
          },
          ctx,
        );
      expect(result.status).toBe("retry");
      expect(JSON.stringify(result)).not.toContain("sensitive");
      if (status === 429)
        expect(result).toMatchObject({
          code: "RATE_LIMITED",
          retryAfterSeconds: 60,
        });
    },
  );
  it("rejects non-provider URLs and redirects without exposing credentials", async () => {
    for (const webhook of [
      "https://attacker.example/services/T/B/C",
      "http://hooks.slack.com/services/T/B/C",
      "https://hooks.slack.com.evil.example/services/T/B/C",
      "https://user@hooks.slack.com/services/T/B/C",
    ]) {
      const ctx = context(() => new Response("ok"));
      expect(
        await slackProvider()
          .create({})
          .deliver({ ...base, config: { webhook } }, ctx),
      ).toEqual({ status: "failed", code: "INVALID_DESTINATION" });
      expect(ctx.http.fetch).not.toHaveBeenCalled();
    }
    const ctx = context(() => new Response("ok"));
    await slackProvider()
      .create({})
      .deliver(
        {
          ...base,
          config: { webhook: "https://hooks.slack.com/services/T/B/C" },
        },
        ctx,
      );
    expect(ctx.http.fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      signal: ctx.signal,
    });
  });
  it("email escapes every HTML field and validates headers", async () => {
    const config = { from: "forms@example.com", to: ["team@example.com"] };
    const email = renderEmail(base.message, config);
    expect(email.text).toContain("<img src=x>");
    expect(email.html).toContain("&lt;img src=x&gt;");
    expect(email.html).not.toContain("<script>");
    expect(email.to).toEqual(config.to);
    const send = vi.fn(async () => ({ status: "accepted" as const }));
    const executor = emailProvider().create({ transport: { send } });
    for (const message of [
      { text: "hello", replyTo: "evil\r\nBcc: victim@example.com" },
      { text: "hello", title: "subject\r\nBcc: victim" },
    ]) {
      expect(
        await executor.deliver(
          { ...base, config, message },
          context(() => new Response()),
        ),
      ).toMatchObject({ status: "failed", code: "INVALID_PAYLOAD" });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("swaps email transports without changes to config or message", async () => {
    const input: DeliveryInput<{ from: string; to: string[] }> = {
      ...base,
      config: { from: "forms@example.com", to: ["team@example.com"] },
    };
    const send = vi.fn(async () => ({ messageId: "native-test-id" }));
    const binding = { send } as Pick<SendEmail, "send">;
    const native = cloudflareEmailTransport(binding);
    const resend = resendEmailTransport("fake-resend-key");
    for (const transport of [native, resend] satisfies EmailTransport[]) {
      const ctx = context(() => Response.json({ id: "resend-test-id" }));
      expect(
        (await emailProvider().create({ transport }).deliver(input, ctx))
          .status,
      ).toBe("accepted");
      if (transport === resend) {
        const body = JSON.parse(ctx.http.fetch.mock.calls[0]?.[1]?.body);
        expect(body.reply_to).toBe("sender@example.com");
        expect(body.replyTo).toBeUndefined();
      }
    }
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.any(String),
        html: expect.any(String),
        replyTo: "sender@example.com",
      }),
    );
  });
  it.each([
    ["E_RATE_LIMIT_EXCEEDED", "retry", "RATE_LIMITED"],
    ["E_DAILY_LIMIT_EXCEEDED", "retry", "RATE_LIMITED"],
    ["E_INTERNAL_SERVER_ERROR", "retry", "UPSTREAM_UNAVAILABLE"],
    ["E_SENDER_NOT_VERIFIED", "failed", "INVALID_DESTINATION"],
    ["E_RECIPIENT_SUPPRESSED", "failed", "INVALID_DESTINATION"],
    ["E_VALIDATION_ERROR", "failed", "INVALID_PAYLOAD"],
    ["notKnown", "retry", "UNKNOWN"],
  ])(
    "classifies native email %s using safe codes",
    async (code, status, mapped) => {
      const transport = cloudflareEmailTransport({
        send: async () => {
          throw Object.assign(new Error("credentials private"), { code });
        },
      });
      expect(
        await transport.send(
          {
            from: "forms@example.com",
            to: ["team@example.com"],
            subject: "test",
            text: "test",
          },
          context(() => new Response()),
        ),
      ).toEqual({ status, code: mapped });
    },
  );
  it("validates reference config and bounded upstream responses", async () => {
    expect(
      slackProvider().configSchema.parse({ webhook: secret("WEBHOOK") }),
    ).toEqual({ webhook: secret("WEBHOOK") });
    await expect(
      slackProvider()
        .create({})
        .deliver(
          {
            ...base,
            config: { webhook: "https://hooks.slack.com/services/T/B/C" },
          },
          context(() => new Response("x".repeat(2000))),
        ),
    ).rejects.toThrow(/limit/);
  });
});
