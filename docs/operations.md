# Operations

## Configure and deploy

Start with the [README's Slack server starter](../README.md#quick-start), or choose [another profile](development.md#generate-a-starter).

| File | Configure |
| --- | --- |
| [relay.config.ts](../apps/worker/relay.config.ts) | Schemas, guards, messages, destinations, revisions |
| [wrangler.jsonc](../apps/worker/wrangler.jsonc) | Worker and Queue names, bindings, consumer settings |

Keep producer, consumer, and dead-letter Queue names consistent. Run `npm run doctor -- --strict` to check configuration and list required secrets.

Authenticate and create the Queues using the names in Wrangler:

```sh
npx wrangler login
npx wrangler queues create cf-relay-deliveries
npx wrangler queues create cf-relay-failures
```

For the README's Slack server starter, set:

```sh
npx wrangler secret put SLACK_WEBHOOK_V1 --config apps/worker/wrangler.jsonc
npx wrangler secret put SERVER_API_KEY --config apps/worker/wrangler.jsonc
```

For other configurations, set the names reported by doctor. Enter values through Wrangler's prompts. Declare secret types in `WorkerEnv`; platform binding types are generated.

Validate and deploy:

```sh
npm run doctor -- --strict
npm run types:generate
npm run check
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

Checks perform local validation and a deployment dry run. The final command deploys. Set any custom domain or route, update client URLs, and verify delivery with a controlled submission to a destination you own.

## Browser and email setup

For browser forms, configure the page's exact `allowedOrigins`, Turnstile `expectedHostname`, and action `contact`. Set the public site key and endpoint in the [HTML client](../examples/contact-form/index.html), and serve it with [client.js](../examples/contact-form/client.js). Its `website` honeypot stays empty; Turnstile tokens are refreshed after requests. See [token validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

Choose an account-unique rate-limit namespace unless shared counters are intentional. Rate limiting uses the form ID and a transient client-IP hash; it is distributed abuse protection, not an exact global quota. Local adapters must supply a trusted client identity. See [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

For native email, [onboard the sending domain](https://developers.cloudflare.com/email-service/get-started/send-emails/) and restrict senders and recipients in the [`EMAIL` binding](https://developers.cloudflare.com/email-service/configuration/send-bindings/). For Resend, use the [transport guide](development.md#swap-email-transports).

## Local development

Copy the selected starter's secret template:

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Fill in `.dev.vars`, then run:

```sh
npm run doctor -- --local
npm run dev
```

The Worker runs at `http://localhost:8787`. Use the [README request](../README.md#send-a-request) with this endpoint. Use test destinations: local provider calls can send real notifications. For rendering without delivery, use [preview](development.md#preview-notifications).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Doctor reports a missing local secret | Fill in the named binding in `.dev.vars`; run with `--local` again |
| `401` | Bearer token matches `SERVER_API_KEY` |
| `403` | Exact page origin, Turnstile hostname/action, fresh token, empty honeypot |
| `422` | Fixture matches the schema and [message limits](development.md#limits-and-rendering) |
| `429` | Wait before retrying; review rate-limit settings |
| `503` | Response error code, required secrets/bindings, Queue availability |
| Accepted request but no notification | Worker logs, delivery backlog, failure Queue |

Doctor cannot verify live credentials, DNS, or provider acceptance. `/healthz` only confirms the HTTP handler responds. Queue publication can remain uncertain after `503`; a retry may duplicate notifications.

## Revision changes and draining

Change a destination's revision when its audience, endpoint, or credential changes, including values behind an existing secret name. Jobs must match the current destination ID, provider, and revision before delivery.

To preserve pending deliveries:

1. Stop incoming submissions.
2. Wait for backlog and in-flight attempts to drain.
3. Update configuration, credentials, and revision together; resume submissions.

Alternatively, keep explicit old and new destination IDs and credentials until old jobs drain. Removing or changing a destination produces `DESTINATION_REVISION_MISMATCH` for old jobs. Credential rotation without a revision change cannot be detected through secret references.

## Retry budgets and uncertain acceptance

Default consumer settings:

| Setting | Value |
| --- | --- |
| Retries | 5 |
| Batch size / wait | 10 messages / 5 seconds |
| Concurrent invocations | 10 |
| Retry-delay cap | 1 hour |

Attempts use `message.attempts`. Retry delays are positive integer seconds and bound upstream `Retry-After` hints. Messages run sequentially per batch; concurrent batches share the consumer, with no per-destination throttling. See [batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/) and [concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/).

| Operation | Deadline |
| --- | --- |
| Raw-body read, each guard, Queue or failure publication | 5 seconds each |
| Provider attempt | 10 seconds |

HTTP sends receive an `AbortSignal` and disable redirects. Native email and Queue writes cannot be canceled and may succeed after a timeout. Pending work is retained where possible; retries can duplicate notifications or failure records. Delivery has no durable deduplication.

## Monitor and inspect failures

```sh
npx wrangler tail --config apps/worker/wrangler.jsonc
```

Logs contain safe event codes and correlation IDs, omitting content, credentials, addresses, URLs, and upstream errors. Monitor both Queues' backlog and oldest-message age; alert on failure backlog and approaching retention expiry.

The failure Queue contains:

| Envelope | Meaning | Rendered content? |
| --- | --- | --- |
| `failure.record`, version 1 | Terminal or invalid-job metadata | No |
| `delivery`, version 1 | Original job exhausted platform retries | Yes, possibly personal data |
| Other | Malformed or unsupported original job | Unknown; treat as sensitive |

Use the authenticated [peek API](https://developers.cloudflare.com/api/typescript/resources/queues/subresources/messages/methods/peek/) to inspect without leasing or consuming messages:

```text
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/queues/{queue_id}/messages/peek
Authorization: Bearer <operator-token>
Content-Type: application/json

{"batch_size":1}
```

Peek requires `Queues Write` or `Workers Scripts Write`; restrict tokens to the required account and operators. Validate supported envelopes with `failureEnvelopeSchema.safeParse()`. Do not publish payloads or automatically replay unknown shapes. Resolve the failure before resubmitting; this release has no replay API. See [dead-letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

## Retention and limits

Queues retain rendered content until acknowledgment, expiry, or DLQ transfer. Paid-plan retention defaults to four days, configurable up to 14; free-plan retention is fixed at 24 hours. Unconsumed failure messages also expire. Set retention deliberately and export sanitized incident metadata if longer history is needed. See [configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/) and [limits](https://developers.cloudflare.com/queues/platform/limits/).
