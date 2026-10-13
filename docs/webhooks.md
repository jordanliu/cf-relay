# Webhooks

Generic webhooks are outbound notification destinations. Select them alone or alongside Slack, Discord, and email:

```sh
npm run setup -- --providers slack,webhook --webhook-auth signing
```

Setup collects the HTTPS endpoint, generates a signing key, and prepares local credentials. Upload the selected credentials and deploy using the [operations guide](operations.md#configure-and-deploy).

## Configuration

Register `webhookProvider()` from `@cf-relay/provider-webhook`. A destination uses secret references:

```ts
import { secret } from "@cf-relay/core";

const destination = {
  provider: "webhook",
  revision: "v1",
  url: secret("WEBHOOK_URL_V1"),
  signingSecret: secret("WEBHOOK_SIGNING_SECRET_V1"),
  bearerToken: secret("WEBHOOK_BEARER_TOKEN_V1"),
};
```

Signing and bearer authentication are independently optional. Setup offers `signing` (default), `bearer`, `both`, and `none`. Omit unused fields; a configured reference must have a value. Endpoints come from trusted configuration, require HTTPS, and cannot contain URL credentials or fragments. Redirects are not followed.

## Payload

Each destination receives a JSON `POST`:

```json
{
  "version": 1,
  "deliveryId": "sub_123:events_webhook",
  "submissionId": "sub_123",
  "formId": "events",
  "createdAt": "2026-10-13T00:00:00.000Z",
  "message": { "title": "Example event", "text": "Notification content" }
}
```

The payload contains the transformed notification, not raw submission fields or credentials. `message` can also include `fields` and `replyTo`. Payload and delivery IDs remain stable across retries.

## Authentication and receiving

Bearer authentication adds `Authorization: Bearer <token>`. Signing follows the [Standard Webhooks HMAC conventions](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):

| Header | Value |
| --- | --- |
| `webhook-id` | Base64url encoding of the stable delivery ID |
| `webhook-timestamp` | Attempt time as Unix seconds |
| `webhook-signature` | `v1,` followed by the base64 HMAC-SHA256 signature |

The signed input is `<webhook-id>.<webhook-timestamp>.<exact body>`. Keys use `whsec_` followed by base64-encoded key bytes; setup generates 32 bytes per new signing key. Attempt timestamps and signatures change on retries.

The [receiver example](../examples/webhook-receiver/index.ts) verifies the exact body and allows a five-minute clock difference. Its `acceptOnce` dependency must atomically store the webhook ID together with processing or enqueueing the event. Use durable storage so deduplication survives restarts and multiple instances. An already accepted ID returns `204`; new accepted events return `202`.

## Delivery behavior

| Response | Outcome |
| --- | --- |
| Any `2xx` | Accepted |
| `408`, `429`, `5xx`, network failure, timeout | Retry within the configured budget |
| Redirect or other HTTP failure | Terminal failure |

Response bodies are discarded. Logs omit URLs, credentials, notification content, and upstream error text. Delivery uses the existing Queue consumer, deadlines, and [failure handling](operations.md#monitor-and-inspect-failures). Receivers should acknowledge after durably accepting work, then process asynchronously. Retries can duplicate requests; use the stable webhook ID for deduplication.
