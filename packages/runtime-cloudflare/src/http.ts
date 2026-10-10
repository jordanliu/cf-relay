import { LIMITS, RelayError, withDeadline } from "@cf-relay/core";

const badBody = () =>
  new RelayError(400, "INVALID_BODY", "Malformed submission body.");
export async function parseBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    mediaType !== "application/json" &&
    mediaType !== "application/x-www-form-urlencoded"
  )
    throw new RelayError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Use JSON or URL-encoded form data.",
    );
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > LIMITS.rawBodyBytes))
    throw new RelayError(
      413,
      "BODY_TOO_LARGE",
      "Submission body exceeds 32 KiB.",
    );
  if (!request.body) throw badBody();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    await withDeadline(async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > LIMITS.rawBodyBytes)
          throw new RelayError(
            413,
            "BODY_TOO_LARGE",
            "Submission body exceeds 32 KiB.",
          );
        chunks.push(value);
      }
    }, 5000);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw badBody();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badBody();
  }
  if (mediaType === "application/json") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw badBody();
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw badBody();
    if (Object.keys(value).some(unsafeKey)) throw badBody();
    return value as Record<string, unknown>;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(
        (index < 0 ? pair : pair.slice(0, index)).replace(/\+/g, " "),
      );
      value = decodeURIComponent(
        (index < 0 ? "" : pair.slice(index + 1)).replace(/\+/g, " "),
      );
    } catch {
      throw badBody();
    }
    if (!key || unsafeKey(key) || Object.hasOwn(result, key)) throw badBody();
    result[key] = value;
  }
  return result;
}
function unsafeKey(key: string): boolean {
  return (
    ["__proto__", "prototype", "constructor"].includes(key) || /[[\]]/.test(key)
  );
}
