import { boundedResponseText, DeadlineError } from "@cf-relay/core";
import {
  decodeSigningSecret,
  type WebhookPayloadV1,
  webhookPayloadSchema,
} from "@cf-relay/provider-webhook";

export interface ReceiverDependencies {
  signingSecret: string;
  // Atomically persist the ID together with processing or enqueueing the event.
  // Return false for an already accepted ID. Use durable storage, not an isolate-local Set.
  acceptOnce(id: string, payload: WebhookPayloadV1): Promise<boolean>;
}

export async function receiveWebhook(
  request: Request,
  dependencies: ReceiverDependencies,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Use POST", {
      status: 405,
      headers: { allow: "POST" },
    });
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatures = request.headers.get("webhook-signature") ?? "";
  if (
    !id ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(id) ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    signatures.length > 4096
  )
    return new Response("Unauthorized", { status: 401 });
  let body: string;
  try {
    body = await boundedResponseText(
      new Response(request.body),
      16000,
      AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    );
  } catch (error) {
    if (error instanceof DeadlineError)
      return new Response("Try again later", { status: 503 });
    return new Response("Invalid payload", { status: 400 });
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      decodeSigningSecret(dependencies.signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    for (const signature of signatures.split(" ")) {
      if (!/^v1,[A-Za-z0-9+/]+={0,2}$/.test(signature)) continue;
      const bytes = Uint8Array.from(atob(signature.slice(3)), (character) =>
        character.charCodeAt(0),
      );
      if (await crypto.subtle.verify("HMAC", key, bytes, data)) {
        valid = true;
        break;
      }
    }
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!valid) return new Response("Unauthorized", { status: 401 });
  const parsed = (() => {
    try {
      return webhookPayloadSchema.safeParse(JSON.parse(body));
    } catch {
      return undefined;
    }
  })();
  if (!parsed?.success) return new Response("Invalid payload", { status: 400 });
  try {
    const accepted = await dependencies.acceptOnce(id, parsed.data);
    return new Response(null, { status: accepted ? 202 : 204 });
  } catch {
    return new Response("Try again later", { status: 503 });
  }
}
