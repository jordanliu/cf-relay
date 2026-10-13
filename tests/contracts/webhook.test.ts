import { createHmac } from "node:crypto";
import {
  boundedResponseText,
  DeadlineError,
  type DeliveryContext,
  defineDestinations,
  defineProviders,
  dispatch,
  secret,
} from "@cf-relay/core";
import { webhookProvider } from "@cf-relay/provider-webhook";
import { createSafeLogger } from "@cf-relay/runtime-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { receiveWebhook } from "../../examples/webhook-receiver";
import { fixture, job } from "./fixtures";

const signingSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const base = {
  deliveryId: "sub_test:target",
  submissionId: "sub_test",
  formId: "events",
  createdAt: "2026-10-13T00:00:00.000Z",
  message: { title: "event", text: "Transformed notification" },
};
function context(status = 204, headers?: HeadersInit) {
  const response = new Response(
    [204, 205].includes(status) ? null : "private-upstream-response",
    { status, ...(headers ? { headers } : {}) },
  );
  const cancel = response.body ? vi.spyOn(response.body, "cancel") : undefined;
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => response,
  );
  const write = vi.fn();
  const ctx: DeliveryContext = {
    http: { fetch },
    logger: createSafeLogger(write),
    signal: new AbortController().signal,
  };
  return { ctx, fetch, write, cancel };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generic outbound webhooks", () => {
  it.each(["none", "bearer", "signing", "both"])(
    "supports %s authentication with transformed JSON and no credential payload",
    async (auth) => {
      const c = context(202);
      const config = {
        url: "https://receiver.example/events?token=private-url",
        ...(["bearer", "both"].includes(auth)
          ? { bearerToken: "private-bearer" }
          : {}),
        ...(["signing", "both"].includes(auth) ? { signingSecret } : {}),
      };
      expect(
        await webhookProvider()
          .create({})
          .deliver({ ...base, config }, c.ctx),
      ).toEqual({ status: "accepted" });
      const request = c.fetch.mock.calls[0];
      expect(request?.[1]).toMatchObject({
        method: "POST",
        redirect: "manual",
        signal: c.ctx.signal,
      });
      const body = String(request?.[1]?.body);
      expect(JSON.parse(body)).toEqual({ version: 1, ...base });
      expect(body).not.toMatch(/private|whsec_/);
      const headers = new Headers(request?.[1]?.headers);
      expect(headers.get("authorization")).toBe(
        ["bearer", "both"].includes(auth) ? "Bearer private-bearer" : null,
      );
      if (["signing", "both"].includes(auth)) {
        const expected = createHmac("sha256", Buffer.alloc(32, 7))
          .update(
            `${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${body}`,
          )
          .digest("base64");
        expect(headers.get("webhook-signature")).toBe(`v1,${expected}`);
      } else expect(headers.get("webhook-signature")).toBeNull();
      expect(c.cancel).toHaveBeenCalledOnce();
      expect(c.write).not.toHaveBeenCalled();
    },
  );
  it("keeps payload and webhook ID stable across retries while refreshing the signature timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    const executor = webhookProvider().create({});
    const input = {
      ...base,
      config: { url: "https://receiver.example", signingSecret },
    };
    const first = context(),
      second = context();
    await executor.deliver(input, first.ctx);
    vi.advanceTimersByTime(30_000);
    await executor.deliver(input, second.ctx);
    const a = first.fetch.mock.calls[0]?.[1],
      b = second.fetch.mock.calls[0]?.[1];
    expect(a?.body).toBe(b?.body);
    expect(new Headers(a?.headers).get("webhook-id")).toBe(
      new Headers(b?.headers).get("webhook-id"),
    );
    expect(new Headers(a?.headers).get("webhook-signature")).not.toBe(
      new Headers(b?.headers).get("webhook-signature"),
    );
  });
  it.each([
    [200, "accepted"],
    [201, "accepted"],
    [204, "accepted"],
    [299, "accepted"],
    [302, "failed"],
    [400, "failed"],
    [401, "failed"],
    [403, "failed"],
    [404, "failed"],
    [408, "retry"],
    [410, "failed"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ])("classifies HTTP %i as %s", async (status, outcome) => {
    const c = context(Number(status), { "retry-after": "60" });
    const result = await webhookProvider()
      .create({})
      .deliver({ ...base, config: { url: "https://receiver.example" } }, c.ctx);
    expect(result.status).toBe(outcome);
    if (status === 429) expect(result).toMatchObject({ retryAfterSeconds: 60 });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each([
    { url: "http://receiver.example" },
    { url: "https://user:password@receiver.example" },
    { url: "https://receiver.example/#fragment" },
    { url: "https://receiver.example", signingSecret: "invalid-private-key" },
    { url: "https://receiver.example", bearerToken: "private\r\nheader" },
  ])(
    "rejects invalid configured destinations before making a request",
    async (config) => {
      const c = context();
      expect(
        await webhookProvider()
          .create({})
          .deliver({ ...base, config }, c.ctx),
      ).toEqual({ status: "failed", code: "INVALID_DESTINATION" });
      expect(c.fetch).not.toHaveBeenCalled();
    },
  );
  it("does not send after cancellation", async () => {
    const c = context();
    const abort = new AbortController();
    abort.abort();
    expect(
      await webhookProvider()
        .create({})
        .deliver(
          { ...base, config: { url: "https://receiver.example" } },
          { ...c.ctx, signal: abort.signal },
        ),
    ).toEqual({ status: "retry", code: "TIMEOUT" });
    expect(c.fetch).not.toHaveBeenCalled();
  });
  it.each(["network", "timeout"])(
    "retries %s failures through the dispatcher without credential logs",
    async (failure) => {
      const f = fixture();
      const providers = defineProviders([webhookProvider()]);
      const destinations = defineDestinations(providers, {
        target: {
          provider: "webhook",
          revision: "v1",
          url: secret("WEBHOOK_URL"),
        },
      });
      const fetch = vi.fn(
        async (
          _input: RequestInfo | URL,
          _init?: RequestInit,
        ): Promise<Response> => {
          if (failure === "network") throw new Error("private-url-or-token");
          return new Promise(() => {});
        },
      );
      const result = await dispatch(
        { ...f.config, providers, destinations },
        {
          ...job(),
          destination: { id: "target", provider: "webhook", revision: "v1" },
        },
        2,
        {
          ...f,
          secretReader: {
            read: () => "https://receiver.example?private-token",
          },
          dependencies: {},
          http: { fetch },
          timeoutMs: 20,
        },
      );
      expect(result.outcome).toEqual({
        status: "retry",
        code: failure === "timeout" ? "TIMEOUT" : "UNKNOWN",
      });
      expect(fetch).toHaveBeenCalledOnce();
      if (failure === "timeout")
        expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(JSON.stringify(f.events)).not.toContain("private");
    },
  );
  it("cancels a pending body read at the deadline", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(
      boundedResponseText(response, 100, AbortSignal.timeout(10)),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  it("receiver verifies the exact body, rejects tampering and expiry, and deduplicates through its store", async () => {
    const c = context();
    await webhookProvider()
      .create({})
      .deliver(
        { ...base, config: { url: "https://receiver.example", signingSecret } },
        c.ctx,
      );
    const init = c.fetch.mock.calls[0]?.[1];
    const seen = new Set<string>();
    const acceptOnce = vi.fn(async (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const receiver = (overrides: RequestInit = {}) =>
      receiveWebhook(
        new Request("https://receiver.example", { ...init, ...overrides }),
        { signingSecret, acceptOnce },
      );
    expect((await receiver()).status).toBe(202);
    expect((await receiver()).status).toBe(204);
    expect(seen.size).toBe(1);
    expect(
      (
        await receiver({
          body: String(init?.body).replace("notification", "tampered"),
        })
      ).status,
    ).toBe(401);
    expect(
      (await receiver({ body: `\uFEFF${String(init?.body)}` })).status,
    ).toBe(401);
    const headers = new Headers(init?.headers);
    headers.set("webhook-timestamp", "1");
    expect((await receiver({ headers })).status).toBe(401);
    expect(acceptOnce).toHaveBeenCalledTimes(2);
  });
});
