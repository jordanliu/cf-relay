import type { OutgoingEmail } from "@cf-relay/core";

function base64(value: string) {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}
function encodedSubject(value: string) {
  const parts: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (new TextEncoder().encode(chunk + character).byteLength > 42) {
      parts.push(`=?UTF-8?B?${base64(chunk)}?=`);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) parts.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return parts.join("\r\n ");
}
function part(type: string, value: string) {
  return [
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64(value.replace(/\r\n|\r|\n/g, "\r\n"))
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "",
  ].join("\r\n");
}
export function renderMime(email: OutgoingEmail) {
  if (/[\r\n\0]/.test(email.subject) || Array.from(email.subject).length > 200)
    throw new Error("Invalid subject");
  if (email.text.length > 131072 || (email.html?.length ?? 0) > 131072)
    throw new Error("SMTP message exceeds limit");
  const messageId = `<${crypto.randomUUID()}@cf-relay.invalid>`;
  const boundary = `relay_${crypto.randomUUID()}`;
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to.join(",\r\n ")}`,
    ...(email.replyTo ? [`Reply-To: ${email.replyTo}`] : []),
    `Subject: ${encodedSubject(email.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];
  const body =
    email.html === undefined
      ? [...headers, part("text/plain", email.text)].join("\r\n")
      : [
          ...headers,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          part("text/plain", email.text),
          `--${boundary}`,
          part("text/html", email.html),
          `--${boundary}--`,
        ].join("\r\n");
  if (new TextEncoder().encode(body).byteLength > 131072)
    throw new Error("SMTP message exceeds limit");
  return { body, messageId };
}
