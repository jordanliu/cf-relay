import type { DeliveryOutcome, HttpClient } from "../index";
import { DeadlineError } from "./deadline";

export function classifyHttp(response: Response): DeliveryOutcome | undefined {
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const value =
      header && /^\d+(\.\d+)?$/.test(header)
        ? Number(header)
        : header
          ? (Date.parse(header) - Date.now()) / 1000
          : undefined;
    return {
      status: "retry",
      code: "RATE_LIMITED",
      ...(value !== undefined && Number.isFinite(value)
        ? { retryAfterSeconds: Math.max(1, Math.min(86400, Math.ceil(value))) }
        : {}),
    };
  }
  if (response.status >= 500)
    return { status: "retry", code: "UPSTREAM_UNAVAILABLE" };
  if (response.status === 401 || response.status === 403)
    return { status: "failed", code: "AUTHENTICATION_FAILED" };
  if (response.status === 404 || response.status === 410)
    return { status: "failed", code: "INVALID_DESTINATION" };
  if (!response.ok) return { status: "failed", code: "INVALID_PAYLOAD" };
  return undefined;
}
export async function boundedResponseText(
  response: Response,
  maxBytes = 16384,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DeadlineError();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DeadlineError();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Upstream response exceeds limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Preserve the BOM so consumers that verify signatures retain the exact bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function postJson(
  http: HttpClient,
  url: string,
  body: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (signal.aborted) throw new DeadlineError();
  return http.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
}
