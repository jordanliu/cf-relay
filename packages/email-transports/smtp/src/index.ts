import { connect } from "cloudflare:sockets";
import { createSmtpTransport } from "./transport";

export function smtpEmailTransport(url: string) {
  return createSmtpTransport(url, (address, options) =>
    connect(address, { ...options, allowHalfOpen: false }),
  );
}
