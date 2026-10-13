import type { DeliveryContext } from "@cf-relay/core";
import { describe, expect, it, vi } from "vitest";
import { renderMime } from "../../packages/email-transports/smtp/src/mime";
import {
  createSmtpTransport,
  type SmtpConnect,
  type SmtpSocket,
} from "../../packages/email-transports/smtp/src/transport";

const email = {
  from: "forms@acme.io",
  to: ["team@acme.io", "audit@acme.io"],
  replyTo: "person@acme.io",
  subject: "Event ☁️",
  text: "Line one\n.Line two ☁️",
  html: "<p>Content ☁️</p>",
};
const url = "smtp://private-user:private-password@smtp.acme.io:587";
function context(signal = new AbortController().signal) {
  return {
    signal,
    http: { fetch: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies DeliveryContext;
}
function fakeServer(
  override?: (command: string, encrypted: boolean) => string | undefined,
  opening = true,
) {
  const commands: { command: string; encrypted: boolean }[] = [];
  const sockets: SmtpSocket[] = [];
  const close = vi.fn();
  const upgrade = vi.fn();
  function socket(encrypted: boolean, greeting: boolean): SmtpSocket {
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let resolveClosed: () => void = () => {};
    const emit = (value: string) => {
      // Split replies across chunks, including CRLF and UTF-8 boundaries.
      const bytes = new TextEncoder().encode(value);
      for (let start = 0; start < bytes.length; start += 7)
        controller.enqueue(bytes.slice(start, start + 7));
    };
    const current: SmtpSocket = {
      readable: new ReadableStream({
        start(value) {
          controller = value;
          if (greeting) emit("220 test server\r\n");
        },
      }),
      writable: new WritableStream({
        write(bytes) {
          const command = new TextDecoder().decode(bytes);
          commands.push({ command, encrypted });
          const response = override ? override(command, encrypted) : undefined;
          if (response !== undefined) {
            if (response) emit(response);
            return;
          }
          if (command.startsWith("EHLO "))
            emit("250-test server\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (command === "STARTTLS\r\n") emit("220 upgrade now\r\n");
          else if (command.startsWith("AUTH PLAIN "))
            emit("235 authenticated\r\n");
          else if (
            command.startsWith("MAIL FROM:") ||
            command.startsWith("RCPT TO:")
          )
            emit("250 ok\r\n");
          else if (command === "DATA\r\n") emit("354 send data\r\n");
          else if (command.endsWith("\r\n.\r\n"))
            emit("250 accepted private-server-id\r\n");
          else throw new Error("Unexpected test command");
        },
      }),
      opened: opening ? Promise.resolve() : new Promise(() => {}),
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      async close() {
        close();
        if (!closed) {
          closed = true;
          controller.close();
          resolveClosed();
        }
      },
      startTls() {
        upgrade();
        void current.close();
        return socket(true, false);
      },
    };
    sockets.push(current);
    return current;
  }
  const connect = vi.fn<SmtpConnect>((_address, options) =>
    socket(options.secureTransport === "on", true),
  );
  return { connect, commands, sockets, close, upgrade };
}

describe("SMTP transport", () => {
  it.each(["smtp", "smtps"])(
    "sends UTF-8 multipart email over %s and confirms server acceptance",
    async (scheme) => {
      const server = fakeServer();
      const ctx = context();
      const result = await createSmtpTransport(
        `${scheme}://private-user:private-password@smtp.acme.io`,
        server.connect,
      ).send(email, ctx);
      expect(result).toMatchObject({
        status: "accepted",
        externalId: expect.stringMatching(/^<.+@cf-relay.invalid>$/),
      });
      expect(server.connect).toHaveBeenCalledWith(
        { hostname: "smtp.acme.io", port: scheme === "smtp" ? 587 : 465 },
        { secureTransport: scheme === "smtp" ? "starttls" : "on" },
      );
      expect(server.upgrade).toHaveBeenCalledTimes(scheme === "smtp" ? 1 : 0);
      expect(
        server.commands
          .filter((item) => !item.encrypted)
          .map((item) => item.command),
      ).toEqual(scheme === "smtp" ? ["EHLO acme.io\r\n", "STARTTLS\r\n"] : []);
      const data =
        server.commands.find((item) => item.command.startsWith("From:"))
          ?.command ?? "";
      expect(data).toContain("Content-Type: multipart/alternative;");
      expect(data).toContain("Reply-To: person@acme.io");
      expect(data).not.toMatch(
        /private-user|private-password|private-server-id/,
      );
      const bodies = [
        ...data.matchAll(
          /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)(?=\r\n--)/g,
        ),
      ].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
      expect(bodies).toEqual([email.text.replaceAll("\n", "\r\n"), email.html]);
      expect(
        server.commands.filter((item) => item.command.startsWith("RCPT TO:")),
      ).toHaveLength(2);
      expect(server.close).toHaveBeenCalled();
      expect(ctx.http.fetch).not.toHaveBeenCalled();
      expect(ctx.logger.error).not.toHaveBeenCalled();
    },
  );
  it("requires STARTTLS and sends no credentials or content if encryption is unavailable", async () => {
    const server = fakeServer((command) =>
      command.startsWith("EHLO") ? "250 AUTH PLAIN\r\n" : undefined,
    );
    expect(
      await createSmtpTransport(url, server.connect).send(email, context()),
    ).toEqual({ status: "failed", code: "INVALID_DESTINATION" });
    expect(server.commands).toHaveLength(1);
    expect(server.close).toHaveBeenCalled();
  });
  it("discards pre-TLS capabilities and supports LOGIN after upgrading", async () => {
    let challenge = 0;
    const server = fakeServer((command, encrypted) => {
      if (command.startsWith("EHLO") && encrypted) return "250 AUTH LOGIN\r\n";
      if (command === "AUTH LOGIN\r\n") return "334 VXNlcm5hbWU6\r\n";
      if (command === `${btoa("private-user")}\r\n` && challenge++ === 0)
        return "334 UGFzc3dvcmQ6\r\n";
      if (command === `${btoa("private-password")}\r\n`)
        return "235 authenticated\r\n";
      return undefined;
    });
    expect(
      (await createSmtpTransport(url, server.connect).send(email, context()))
        .status,
    ).toBe("accepted");
    expect(
      server.commands.some((item) => item.command.startsWith("AUTH PLAIN")),
    ).toBe(false);
    expect(
      server.commands.filter((item) => item.command.startsWith("EHLO")),
    ).toHaveLength(2);
  });
  it("handles an AUTH PLAIN challenge and URL-encoded credentials", async () => {
    const auth = Buffer.from("\0private@user\0p:a#ss", "utf8").toString(
      "base64",
    );
    const server = fakeServer((command) =>
      command.startsWith("AUTH PLAIN")
        ? "334 \r\n"
        : command === `${auth}\r\n`
          ? "235 authenticated\r\n"
          : undefined,
    );
    expect(
      (
        await createSmtpTransport(
          "smtps://private%40user:p%3Aa%23ss@smtp.acme.io:465",
          server.connect,
        ).send(email, context())
      ).status,
    ).toBe("accepted");
    expect(server.commands.some((item) => item.command === `${auth}\r\n`)).toBe(
      true,
    );
  });
  it("supports a TLS relay without authentication", async () => {
    const server = fakeServer();
    expect(
      (
        await createSmtpTransport("smtps://smtp.acme.io", server.connect).send(
          email,
          context(),
        )
      ).status,
    ).toBe("accepted");
    expect(
      server.commands.some((item) => item.command.startsWith("AUTH")),
    ).toBe(false);
  });
  it.each([
    ["AUTH", "535", "failed", "AUTHENTICATION_FAILED"],
    ["AUTH", "454", "retry", "UPSTREAM_UNAVAILABLE"],
    ["RCPT TO:<audit", "550", "failed", "INVALID_DESTINATION"],
    ["RCPT", "450", "retry", "UPSTREAM_UNAVAILABLE"],
    ["From:", "554", "failed", "INVALID_PAYLOAD"],
    ["From:", "451", "retry", "UPSTREAM_UNAVAILABLE"],
  ])(
    "classifies %s %s as %s/%s without server details",
    async (prefix, code, status, outcome) => {
      const server = fakeServer((command) =>
        command.startsWith(prefix)
          ? `${code} private-server-response\r\n`
          : undefined,
      );
      const result = await createSmtpTransport(url, server.connect).send(
        email,
        context(),
      );
      expect(result).toEqual({ status, code: outcome });
      expect(JSON.stringify(result)).not.toContain("private");
      if (prefix.startsWith("RCPT"))
        expect(
          server.commands.some((item) => item.command === "DATA\r\n"),
        ).toBe(false);
    },
  );
  it.each([
    "https://smtp.acme.io",
    "smtp://smtp.acme.io:25",
    "smtp://private-user@smtp.acme.io",
    "smtp://user:%0A@smtp.acme.io",
    "smtp://smtp.acme.io/?insecure=true",
    "smtps://smtp.acme.io/#private",
  ])("rejects invalid settings before connecting", (invalid) => {
    const server = fakeServer();
    expect(() => createSmtpTransport(invalid, server.connect)).toThrow(
      /SMTP_URL/,
    );
    expect(server.connect).not.toHaveBeenCalled();
  });
  it("does not connect after cancellation and interrupts a hanging connection", async () => {
    const server = fakeServer(undefined, false);
    const abort = new AbortController();
    abort.abort();
    expect(
      await createSmtpTransport(url, server.connect).send(
        email,
        context(abort.signal),
      ),
    ).toEqual({ status: "retry", code: "TIMEOUT" });
    expect(server.connect).not.toHaveBeenCalled();
    expect(
      await createSmtpTransport(url, server.connect).send(
        email,
        context(AbortSignal.timeout(10)),
      ),
    ).toEqual({ status: "retry", code: "TIMEOUT" });
    expect(server.close).toHaveBeenCalled();
  });
  it("cancels a pending reply and rejects bounded malformed replies", async () => {
    const hanging = fakeServer((command) =>
      command.startsWith("MAIL") ? "" : undefined,
    );
    expect(
      await createSmtpTransport(url, hanging.connect).send(
        email,
        context(AbortSignal.timeout(10)),
      ),
    ).toEqual({ status: "retry", code: "TIMEOUT" });
    expect(
      hanging.commands.some((item) => item.command.startsWith("RCPT")),
    ).toBe(false);
    const malformed = fakeServer((command) =>
      command.startsWith("EHLO") ? `250 ${"x".repeat(512)}\r\n` : undefined,
    );
    expect(
      await createSmtpTransport(url, malformed.connect).send(email, context()),
    ).toEqual({ status: "retry", code: "UPSTREAM_UNAVAILABLE" });
    expect(malformed.close).toHaveBeenCalled();
  });
  it("rejects invalid payloads before SMTP and safely folds subject and body lines", async () => {
    const server = fakeServer();
    expect(
      await createSmtpTransport(url, server.connect).send(
        { ...email, subject: "Bad\r\nBcc: attacker@acme.io" },
        context(),
      ),
    ).toEqual({ status: "failed", code: "INVALID_PAYLOAD" });
    expect(server.connect).not.toHaveBeenCalled();
    const { html: _html, ...plain } = email;
    expect(
      await createSmtpTransport(url, server.connect).send(
        { ...plain, text: "x".repeat(131073) },
        context(),
      ),
    ).toEqual({ status: "failed", code: "INVALID_PAYLOAD" });
    const mime = renderMime({ ...plain, subject: "🛠".repeat(200) });
    expect(
      mime.body.split("\r\n").every((line) => Buffer.byteLength(line) <= 78),
    ).toBe(true);
    const encodedWords = mime.body.match(/=\?UTF-8\?B\?([^?]+)\?=/g) ?? [];
    const subject = encodedWords
      .map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8"))
      .join("");
    expect(subject).toBe("🛠".repeat(200));
    expect(renderMime({ ...email, subject: "" }).body).toContain(
      "Subject: \r\n",
    );
  });
});
