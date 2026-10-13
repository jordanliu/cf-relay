# Operations

## Deploy from the dashboard

Use the [Deploy to Cloudflare button](../README.md#quick-start):

1. Sign in to Cloudflare and connect GitHub. Cloudflare creates a copy of this public repository in your account.
2. Choose the Worker and Queue names.
3. Supply a randomly generated `SERVER_API_KEY`.
4. Accept the build and deploy commands to provision both Queues and deploy the API.
5. [Configure a provider](#configure-a-provider) before sending submissions.

The button uses the whole repository, including workspace dependencies. Keep the build root at the repository root. The default commands are `npm run build` and `npm run deploy`; dashboard deployment does not need local setup or secret upload.

Cloudflare requires every uncommented secret in `.dev.vars.example`, with no optional-field setting. Provider entries are commented out so they do not block deployment. See [Cloudflare's open issue](https://github.com/cloudflare/developer-platform/issues/28). The API returns `503` without publishing jobs until its configured destination is ready; `/healthz` remains available.

Workers Builds deploys subsequent changes from the configured production branch. See [Cloudflare's deploy button guide](https://developers.cloudflare.com/workers/platform/deploy-buttons/). After provider setup, connect a server client using the deployed URL and API key, then verify with a controlled submission.

## Configure a provider

Choose any combination of providers. Adding a secret alone does not change routing.

| Provider | Configuration | Credentials and bindings |
| --- | --- | --- |
| Slack | `--providers slack` | `SLACK_WEBHOOK_V1` |
| Discord | `--providers discord` | `DISCORD_WEBHOOK_V1` |
| Cloudflare Email Service | `--providers email`, sender and recipients | `EMAIL` binding, verified sending domain |
| Resend | Email with `--email-transport resend` | `RESEND_API_KEY`, verified sending domain |
| Webhook | `--providers webhook`, optional `--webhook-auth` | HTTPS URL, selected signing/bearer credentials |

For dashboard deployments, work in the repository Cloudflare copied to your account. Supply the existing API key in `.dev.vars` or `RELAY_API_KEY` before setup:

```sh
npm ci
npm run setup -- --providers slack,discord
npm run check
```

Setup preserves the Worker and Queue names chosen during deployment. Configure production secrets in the dashboard or with `npm run secrets`, then commit and push configuration changes to the production branch. `.dev.vars` stays ignored. See [setup options](development.md#prepare-local-setup) and [webhooks](webhooks.md).

## Configure and deploy

For deployment from your machine:

Start with the [README's default Slack API](../README.md#quick-start), or choose [another profile](development.md#generate-a-starter).

| File | Configure |
| --- | --- |
| [relay.config.ts](../apps/worker/relay.config.ts) | Schemas, guards, messages, destinations, revisions |
| [wrangler.jsonc](../wrangler.jsonc) | Worker and Queue names, bindings, consumer settings |

Keep producer, consumer, and dead-letter Queue names consistent. Run `npm run doctor -- --strict` to check configuration and list required secrets.

Authenticate and create the Queues using the names in Wrangler:

```sh
npx wrangler login
npx wrangler queues create cf-relay-deliveries
npx wrangler queues create cf-relay-failures
```

Run `npm run setup` to choose destinations and enter credentials. Noninteractive setup prepares `.dev.vars` entries for manual completion; doctor lists the required names. Declare secret types in `WorkerEnv`; platform binding types are generated.

Upload and deploy:

```sh
npm run secrets
npm run check
npm run deploy
```

`secrets` validates local credentials, then uploads all entries in `.dev.vars`. Use values intended for this Worker. For separate production credentials, set each name through Wrangler's interactive prompt instead:

```sh
npx wrangler secret put SLACK_WEBHOOK_V1
npx wrangler secret put SERVER_API_KEY
```

Checks perform local validation and a deployment dry run. `npm run deploy` publishes the API. Set any custom domain or route, update client URLs, and verify delivery with a controlled submission to a destination you own.

## Browser and email setup

For browser submissions, generate a `browser` API configuration and configure the page's exact `allowedOrigins`, Turnstile `expectedHostname`, and action `contact`. Connect your own frontend or follow the [browser example](../examples/README.md#browser-client). Its `website` honeypot stays empty; Turnstile tokens are refreshed after requests. See [token validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

Choose an account-unique rate-limit namespace unless shared counters are intentional. Rate limiting uses the form ID and a transient client-IP hash; it is distributed abuse protection, not an exact global quota. Local adapters must supply a trusted client identity. See [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

For native email, [onboard the sending domain](https://developers.cloudflare.com/email-service/get-started/send-emails/) and restrict senders and recipients in the [`EMAIL` binding](https://developers.cloudflare.com/email-service/configuration/send-bindings/). For Resend, use the [transport guide](development.md#swap-email-transports).

## Local development

Run setup to prepare bindings, validate the fixture, and create `.dev.vars` without replacing existing credentials:

```sh
npm run setup
```

Complete any missing credentials, then run:

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
| `503` | Run authenticated remote doctor for the selected form; check required secrets/bindings and Queues |
| Remote doctor reports configuration mismatch | Deploy the intended destination IDs, providers, and revisions before testing |
| Accepted request but no notification | Worker logs, delivery backlog, failure Queue |

Doctor cannot verify credential validity, DNS, or provider acceptance. `/healthz` only confirms the HTTP handler responds; authenticated `/v1/readiness` checks configured capabilities per form. Queue publication can remain uncertain after `503`; a retry may duplicate notifications.

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
npx wrangler tail
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
