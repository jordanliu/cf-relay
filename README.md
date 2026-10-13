# cf-relay

A Cloudflare Worker that validates form submissions and API events, then queues notifications for delivery to Slack, Discord, and email. Forms, guards, destinations, and message transforms are configured in TypeScript. Deploy the API and connect your own frontend; client examples live in [examples/](examples/README.md).

## Supported features

| Feature | Support |
| --- | --- |
| Destinations | Slack incoming webhooks, Discord webhooks, email |
| Email transports | Cloudflare Email Service (default), [Resend](docs/development.md#swap-email-transports) |
| Requests | JSON and flat URL-encoded data, up to 32 KiB |
| Routing | One or multiple destinations per form |
| Validation | Strict schemas and message transforms |
| Protection | API keys, rate limiting, Turnstile, honeypot |
| Delivery | Cloudflare Queues, bounded retries, failure Queue |
| Tooling | Local setup, starter generation, configuration diagnostics, notification preview |

## Quick start

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fjordanliu%2Fcf-relay)

Deploy the default Slack API through Cloudflare's dashboard. Supply a Slack webhook and API key; Cloudflare provisions the Queues. See [dashboard deployment](docs/operations.md#deploy-from-the-dashboard).

For local setup, use Node.js 22.12+ and npm. Deployment requires a Cloudflare account with Workers and Queues, and a Slack incoming webhook for this example.

### 1. Install and prepare

```sh
git clone https://github.com/jordanliu/cf-relay.git
cd cf-relay
npm ci
npm run setup
```

The included API accepts `events` with API-key authentication and sends to one Slack destination. Setup validates configuration and a fixture, generates bindings, and creates ignored `.dev.vars` with a random `SERVER_API_KEY`. Existing credentials are preserved.

### 2. Configure

Add `SLACK_WEBHOOK_V1` to `.dev.vars`. Edit [relay.config.ts](apps/worker/relay.config.ts) for schemas and messages, and [wrangler.jsonc](wrangler.jsonc) for Worker and Queue names. Run setup again after changes.

For Discord, email, or browser submissions, generate [another API configuration](docs/development.md#generate-a-starter). HTML forms are optional client examples, hosted with your frontend.

### 3. Deploy

Follow the [deployment guide](docs/operations.md#configure-and-deploy) to authenticate and create Queues, then upload credentials and deploy:

```sh
npm run secrets
npm run check
npm run deploy
```

`secrets` uploads `.dev.vars` to the configured Worker. `check` runs local verification and a deployment dry run. `deploy` publishes the API.

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
- [Test coverage](docs/acceptance.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

No application database is required. Queues retain rendered content, which may include personal data. File uploads are unsupported. Destination or credential changes require a new revision; see [revision changes and draining](docs/operations.md#revision-changes-and-draining).
