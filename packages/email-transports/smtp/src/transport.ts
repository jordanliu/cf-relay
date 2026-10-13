import {
  DeadlineError,
  type DeliveryOutcome,
  type EmailTransport,
  emailAddressSchema,
  type OutgoingEmail,
} from "@cf-relay/core";
import { renderMime } from "./mime";

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close(): Promise<void>;
  startTls(): SmtpSocket;
}
export type SmtpConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "starttls" },
) => SmtpSocket;

function connectionSettings(value: string) {
  try {
    const url = new URL(value);
    const port = Number(url.port || (url.protocol === "smtps:" ? 465 : 587));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (
      !["smtp:", "smtps:"].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      port === 25 ||
      Boolean(user) !== Boolean(password) ||
      /[\r\n\0]/.test(user + password) ||
      new TextEncoder().encode(user + password).byteLength > 350
    )
      throw new Error();
    return {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port,
      user,
      password,
      secureTransport:
        url.protocol === "smtps:" ? ("on" as const) : ("starttls" as const),
    };
  } catch {
    throw new Error(
      "SMTP_URL must specify a valid smtp:// or smtps:// submission endpoint and optional username/password. Port 25 is unavailable.",
    );
  }
}

type Reply = { code: number; lines: string[] };
class SmtpError extends Error {
  constructor(readonly outcome: DeliveryOutcome) {
    super("SMTP request rejected");
  }
}
function expectReply(
  reply: Reply,
  codes: readonly number[],
  stage: "auth" | "destination" | "payload" = "destination",
) {
  if (codes.includes(reply.code)) return reply;
  if (reply.code >= 400 && reply.code < 500)
    throw new SmtpError({ status: "retry", code: "UPSTREAM_UNAVAILABLE" });
  if (reply.code >= 500 && reply.code < 600)
    throw new SmtpError({
      status: "failed",
      code:
        stage === "auth" || [530, 535, 538].includes(reply.code)
          ? "AUTHENTICATION_FAILED"
          : stage === "payload"
            ? "INVALID_PAYLOAD"
            : "INVALID_DESTINATION",
    });
  throw new Error("Unexpected SMTP reply");
}
function base64(value: string) {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}

class Session {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(
    private socket: SmtpSocket,
    private readonly signal: AbortSignal,
  ) {
    void socket.closed.catch(() => {});
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      void promise.catch(() => {});
      throw new DeadlineError();
    }
    let abort: () => void = () => {};
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(new DeadlineError());
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([promise, canceled]);
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }
  async open() {
    await this.wait(this.socket.opened);
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    let code: number | undefined;
    while (lines.length < 64) {
      let end = this.buffer.indexOf("\r\n");
      while (end === -1) {
        if (!this.reader) throw new Error("SMTP socket closed");
        const { value, done } = await this.wait(this.reader.read());
        if (done) throw new Error("SMTP socket closed");
        if (value.byteLength > 16384)
          throw new Error("SMTP reply exceeds limit");
        this.buffer += this.decoder.decode(value, { stream: true });
        if (this.buffer.length > 16384)
          throw new Error("SMTP reply exceeds limit");
        end = this.buffer.indexOf("\r\n");
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (
        new TextEncoder().encode(line).byteLength > 510 ||
        /[\r\n\0]/.test(line)
      )
        throw new Error("Invalid SMTP reply");
      const match = /^(\d{3})([- ])?(.*)$/.exec(line);
      if (!match || (!match[2] && match[3]))
        throw new Error("Invalid SMTP reply");
      const next = Number(match[1]);
      if (code !== undefined && code !== next)
        throw new Error("Invalid SMTP reply");
      code = next;
      lines.push(match[3] ?? "");
      if (match[2] !== "-") return { code, lines };
    }
    throw new Error("SMTP reply exceeds limit");
  }
  async write(value: string) {
    if (this.signal.aborted) throw new DeadlineError();
    if (!this.writer) throw new Error("SMTP socket closed");
    await this.wait(this.writer.write(new TextEncoder().encode(value)));
  }
  async command(
    command: string,
    codes: readonly number[],
    stage?: "auth" | "destination" | "payload",
  ) {
    await this.write(`${command}\r\n`);
    return expectReply(await this.reply(), codes, stage);
  }
  async startTls() {
    if (this.buffer) throw new Error("Unexpected SMTP data before TLS");
    this.reader?.releaseLock();
    this.writer?.releaseLock();
    this.reader = undefined;
    this.writer = undefined;
    this.socket = this.socket.startTls();
    void this.socket.closed.catch(() => {});
    await this.open();
  }
  close() {
    // Do not let an unresponsive server delay cancellation or an accepted result.
    try {
      void this.socket.close().catch(() => {});
    } catch {}
  }
}

export function createSmtpTransport(
  value: string,
  connect: SmtpConnect,
): EmailTransport {
  const { user, password, ...settings } = connectionSettings(value);
  return {
    async send(email: OutgoingEmail, context): Promise<DeliveryOutcome> {
      if (context.signal.aborted) return { status: "retry", code: "TIMEOUT" };
      let mime: ReturnType<typeof renderMime>;
      try {
        emailAddressSchema.parse(email.from);
        if (!email.to.length || email.to.length > 50) throw new Error();
        for (const address of email.to) emailAddressSchema.parse(address);
        if (email.replyTo) emailAddressSchema.parse(email.replyTo);
        mime = renderMime(email);
      } catch {
        return { status: "failed", code: "INVALID_PAYLOAD" };
      }
      let session: Session | undefined;
      const abort = () => session?.close();
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        session = new Session(
          connect(
            { hostname: settings.hostname, port: settings.port },
            { secureTransport: settings.secureTransport },
          ),
          context.signal,
        );
        await session.open();
        expectReply(await session.reply(), [220]);
        const hello = `EHLO ${email.from.split("@")[1]}`;
        let capabilities = await session.command(hello, [250]);
        if (settings.secureTransport === "starttls") {
          if (
            !capabilities.lines.some((line) => /^STARTTLS(?:\s|$)/i.test(line))
          )
            throw new SmtpError({
              status: "failed",
              code: "INVALID_DESTINATION",
            });
          await session.command("STARTTLS", [220]);
          await session.startTls();
          capabilities = await session.command(hello, [250]);
        }
        if (user) {
          const auth =
            capabilities.lines
              .find((line) => /^AUTH(?:\s|=)/i.test(line))
              ?.toUpperCase()
              .split(/[\s=]+/)
              .slice(1) ?? [];
          if (auth.includes("PLAIN")) {
            const initial = await session.command(
              `AUTH PLAIN ${base64(`\0${user}\0${password}`)}`,
              [235, 334],
              "auth",
            );
            if (initial.code === 334)
              await session.command(
                base64(`\0${user}\0${password}`),
                [235],
                "auth",
              );
          } else if (auth.includes("LOGIN")) {
            await session.command("AUTH LOGIN", [334], "auth");
            await session.command(base64(user), [334], "auth");
            await session.command(base64(password), [235], "auth");
          } else
            throw new SmtpError({
              status: "failed",
              code: "AUTHENTICATION_FAILED",
            });
        }
        await session.command(`MAIL FROM:<${email.from}>`, [250]);
        for (const address of email.to)
          await session.command(`RCPT TO:<${address}>`, [250, 251, 252]);
        // Confirm every recipient before DATA; a rejected recipient sends no message.
        await session.command("DATA", [354], "payload");
        await session.write(
          `${mime.body.replace(/(^|\r\n)\./g, "$1..")}\r\n.\r\n`,
        );
        expectReply(await session.reply(), [250], "payload");
        return { status: "accepted", externalId: mime.messageId };
      } catch (error) {
        if (context.signal.aborted || error instanceof DeadlineError)
          return { status: "retry", code: "TIMEOUT" };
        if (error instanceof SmtpError) return error.outcome;
        return { status: "retry", code: "UPSTREAM_UNAVAILABLE" };
      } finally {
        context.signal.removeEventListener("abort", abort);
        session?.close();
      }
    },
  };
}
