import {
  defineRelay,
  type Guard,
  ingest,
  LIMITS,
  secret,
} from "@cf-relay/core";
import { honeypot, turnstile } from "@cf-relay/policies";
import { cloudflarePublisher, parseBody } from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "./fixtures";

describe("bounded parse-once ingress", () => {
  it.each(["application/json", "application/x-www-form-urlencoded"])(
    "separates security fields and minimizes jobs: %s",
    async (type) => {
      const f = fixture();
      const guards = [
        honeypot({ field: "website" }),
        turnstile({
          secret: secret("TURNSTILE"),
          tokenField: "token",
          expectedHostname: "example.com",
        }),
      ];
      const config = defineRelay({
        ...f.config,
        forms: { contact: { ...f.config.forms.contact, guards } },
      });
      f.http.fetch.mockImplementation(async () =>
        Response.json({ success: true, hostname: "example.com" }),
      );
      const raw = {
        message: "Hello",
        hiddenBusiness: "do not queue",
        website: "",
        token: "sensitive-token",
      };
      const request = new Request("https://relay.example/v1/forms/contact", {
        method: "POST",
        headers: { "content-type": type },
        body:
          type === "application/json"
            ? JSON.stringify(raw)
            : new URLSearchParams(raw).toString(),
      });
      const body = await parseBody(request);
      expect(request.bodyUsed).toBe(true);
      const publish = vi.fn(async () => {});
      await ingest(
        config,
        { formId: "contact", body, headers: {} },
        {
          ...f,
          signal: new AbortController().signal,
          publisher: { publish },
          rateLimit: async () => true,
        },
      );
      expect(publish).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(publish.mock.calls[0]);
      expect(serialized).toContain(
        '"message":{"title":"Contact","text":"Hello"}',
      );
      for (const forbidden of [
        "sensitive-token",
        "hiddenBusiness",
        "do not queue",
        "cf-relay.secret",
        "test-secret-only",
      ])
        expect(serialized).not.toContain(forbidden);
    },
  );
  it("rejects stream bytes over limit even without Content-Length", async () => {
    const request = new Request("https://relay.example", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(LIMITS.rawBodyBytes + 1),
    });
    await expect(parseBody(request)).rejects.toMatchObject({ status: 413 });
  });
  it.each([
    ["multipart/form-data", "", 415],
    ["application/json", "[]", 400],
    ["application/json", "{broken", 400],
    ["application/json", '{"__proto__":{"evil":true}}', 400],
    ["application/x-www-form-urlencoded", "a=%ZZ", 400],
    ["application/x-www-form-urlencoded", "a=1&a=2", 400],
    ["application/x-www-form-urlencoded", "a[]=1", 400],
  ])("rejects malformed or unsupported format", async (type, body, status) => {
    await expect(
      parseBody(
        new Request("https://relay.example", {
          method: "POST",
          headers: { "content-type": type },
          body: String(body),
        }),
      ),
    ).rejects.toMatchObject({ status });
  });
  it("rejects invalid UTF-8 rather than replacing bytes", async () => {
    await expect(
      parseBody(
        new Request("https://relay.example", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([0xff]),
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("runs guards by phase before schema and transformer; denies without publishing", async () => {
    const f = fixture();
    const order: string[] = [];
    const publish = vi.fn();
    const guard = (phase: Guard["phase"]): Guard => ({
      type: phase,
      phase,
      fields: [],
      check: async () => {
        order.push(phase);
        return { allowed: phase !== "bot", status: 403 };
      },
    });
    const config = {
      ...f.config,
      forms: {
        contact: {
          ...f.config.forms.contact,
          guards: [guard("bot"), guard("auth"), guard("rate")],
          schema: { parse: vi.fn() },
          message: vi.fn(),
        },
      },
    };
    await expect(
      ingest(
        config,
        { formId: "contact", body: {}, headers: {} },
        {
          ...f,
          signal: new AbortController().signal,
          publisher: { publish },
          rateLimit: async () => true,
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(order).toEqual(["rate", "auth", "bot"]);
    expect(config.forms.contact.schema.parse).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it("preflights encoded job bytes before any publication", async () => {
    const f = fixture();
    const publish = vi.fn();
    const config = {
      ...f.config,
      forms: {
        contact: {
          ...f.config.forms.contact,
          message: () => ({ text: "😀".repeat(5000) }),
        },
      },
    };
    await expect(
      ingest(
        config,
        { formId: "contact", body: { message: "hello" }, headers: {} },
        {
          ...f,
          publisher: { publish },
          signal: new AbortController().signal,
          rateLimit: async () => true,
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(publish).not.toHaveBeenCalled();
  });
  it("rejects oversized whole batches with zero sendBatch calls", async () => {
    const sendBatch = vi.fn();
    const publisher = cloudflarePublisher({ sendBatch });
    await expect(
      publisher.publish(Array(11).fill({ message: { text: "hello" } })),
    ).rejects.toMatchObject({ status: 422 });
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it("never reports uncertain publication as successful or claims zero effect", async () => {
    const f = fixture();
    const sendBatch = vi.fn(() => new Promise<never>(() => {}));
    await expect(
      ingest(
        f.config,
        { formId: "contact", body: { message: "hello" }, headers: {} },
        {
          ...f,
          signal: new AbortController().signal,
          rateLimit: async () => true,
          publisher: cloudflarePublisher({ sendBatch }, 5),
        },
      ),
    ).rejects.toMatchObject({ status: 503, code: "QUEUE_UNAVAILABLE" });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(f.events.some((event) => event.code === "ACCEPTANCE_UNKNOWN")).toBe(
      true,
    );
  });
});
