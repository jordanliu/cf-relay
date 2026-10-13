# cf-relay

A Cloudflare Worker that validates form submissions and API events, then queues notifications for delivery to Slack, Discord, email, and webhooks. Forms, guards, destinations, and message transforms are configured in TypeScript.

## Supported features

| Feature | Support |
| --- | --- |
| Destinations | Slack incoming webhooks, Discord webhooks, email, HTTPS webhooks |
| Email transports | Cloudflare Email Service, Resend, SMTP |
| Requests | JSON and flat URL-encoded data, up to 32 KiB |
| Routing | One or multiple destinations per form |
| Validation | Strict schemas and message transforms |
| Protection | API keys, rate limiting, Turnstile, honeypot |
| Delivery | Cloudflare Queues, bounded retries, failure Queue |
| Tooling | Guided setup, starter generation, readiness checks, preview, test submissions |

## Quick start

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fjordanliu%2Fcf-relay)

Deploy through Cloudflare's dashboard with an API key; Cloudflare provisions the Queues. Configure destinations afterward. See [dashboard deployment](docs/operations.md#deploy-from-the-dashboard).

Local setup requires Node.js 22.12+ and npm. Deployment requires a Cloudflare account with Workers and Queues.

### 1. Install and prepare

```sh
git clone https://github.com/jordanliu/cf-relay.git
cd cf-relay
npm ci
npm run setup
```

The included `events` API uses API-key authentication. Setup lets you choose destinations and enter missing credentials, validates a fixture, generates bindings, and prepares ignored `.dev.vars`. Existing values are preserved; API and webhook signing keys are generated locally.

### 2. Configure

Choose any combination of destinations. For example:

```sh
npm run setup -- --providers slack,discord
```

Edit [relay.config.ts](apps/worker/relay.config.ts) for schemas and messages, and [wrangler.jsonc](wrangler.jsonc) for Worker and Queue names. Use `--dry-run` to inspect setup changes. An active form needs at least one destination; missing credentials for a selected destination block submissions.

See [setup options](docs/development.md#prepare-local-setup) for email and webhooks, or generate a [browser configuration](docs/development.md#generate-a-starter).

### 3. Deploy

Follow the [deployment guide](docs/operations.md#configure-and-deploy) to authenticate and create Queues, then upload credentials and deploy:

```sh
npm run secrets
npm run check
npm run deploy
```

`secrets` uploads `.dev.vars` to the configured Worker. `check` runs local verification and a deployment dry run. `deploy` publishes the API.

## Verify setup

Set `RELAY_ENDPOINT` to the deployed Worker URL and `RELAY_API_KEY` to its `SERVER_API_KEY`:

```sh
npm run doctor -- --endpoint "$RELAY_ENDPOINT" --form events
npm run send -- --endpoint "$RELAY_ENDPOINT" --form events --live
```

Doctor checks configuration presence. The test command sends one submission and reports Queue acceptance; verify receipt at the destination. Omit `--live` to preview without sending.

## Send a request

Submit to `POST /v1/forms/<formId>`. The default configuration uses `events`. Set `RELAY_ENDPOINT` to the Worker URL and `RELAY_API_KEY` to the value stored as `SERVER_API_KEY`:

```sh
curl --request POST "${RELAY_ENDPOINT%/}/v1/forms/events" \
  --header "Content-Type: application/json" \
  --header "Authorization: Bearer ${RELAY_API_KEY}" \
  --data-binary @apps/worker/fixture.json
```

See the [TypeScript client example](examples/server-to-server/client.ts) for application integration.

Successful requests return HTTP 202:

```json
{"id":"sub_...","status":"queued","destinations":1}
```

`202` confirms Queue acceptance. Delivery is asynchronous and retries may duplicate notifications. A `503` can mean acceptance is uncertain; inspect `error.code` and `error.message` before retrying.

| Status | Meaning |
| --- | --- |
| `400` | Malformed request body |
| `401` | Missing or invalid API key |
| `403` | Origin or bot check rejected |
| `413` / `415` | Body too large or unsupported content type |
| `422` | Invalid fields or generated message |
| `429` | Rate limit reached |
| `503` | Configuration, verification, or Queue publication unavailable |

For browser submissions, use a `browser` API configuration and your own form. The [examples guide](examples/README.md) covers browser and server clients; API keys and provider credentials stay on the server.

## Documentation

- [Operations](docs/operations.md): deployment, local development, troubleshooting, retries, and failures.
- [Development](docs/development.md): starter options, tooling, providers, transports, and limits.
- [Webhooks](docs/webhooks.md): payloads, authentication, retries, and receiver example.
- [Examples](examples/README.md): browser and server clients, configurations, and providers.
- [Test coverage](docs/acceptance.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

No application database is required. Queues retain rendered content, which may include personal data. File uploads are unsupported. Destination or credential changes require a new revision; see [revision changes and draining](docs/operations.md#revision-changes-and-draining).
