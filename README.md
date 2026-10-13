# cf-relay

A Cloudflare Worker that validates form submissions and API events, then queues notifications for delivery to Slack, Discord, and email. Forms, guards, destinations, and message transforms are configured in TypeScript.

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
| Tooling | Starter generation, configuration diagnostics, notification preview |

## Quick start

Requires Node.js 22.12+, npm, a Cloudflare account with Workers and Queues, and a Slack incoming webhook for this example.

### 1. Install

```sh
git clone https://github.com/jordanliu/cf-relay.git
cd cf-relay
npm ci
```

### 2. Configure

Generate a server form with API-key authentication and one Slack destination:

```sh
npm run init -- --mode server --provider slack --force
```

`--force` replaces the included configuration and starter files, preserving `.dev.vars`. Use `--output <directory>` for a separate starter. See [other profiles and options](docs/development.md#generate-a-starter).

Edit [relay.config.ts](apps/worker/relay.config.ts) for schemas, guards, destinations, and messages. Set Worker and Queue names in [wrangler.jsonc](apps/worker/wrangler.jsonc), then inspect the configuration and render a fixture:

```sh
npm run doctor -- --strict
npm run preview -- --input apps/worker/fixture.json
```

Preview validates and renders content without running guards or sending notifications. Add `--output .scratch/preview.html` for HTML output.

### 3. Deploy

Follow the [deployment guide](docs/operations.md#configure-and-deploy) to authenticate, create Queues, and set `SLACK_WEBHOOK_V1` and `SERVER_API_KEY`. Then run:

```sh
npm run types:generate
npm run check
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

`check` runs lint, type checks, tests, binding verification, and a deployment dry run. The final command deploys the Worker.

## Send a request

Submit to `POST /v1/forms/<formId>`. This starter uses `events`. Set `RELAY_ENDPOINT` to the Worker URL and `RELAY_API_KEY` to the value stored as `SERVER_API_KEY`:

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

For browser forms, generate a `browser` starter and use the [contact form example](examples/contact-form/index.html) with [client.js](examples/contact-form/client.js). Set its endpoint and public Turnstile site key, then configure the [origin and Turnstile settings](docs/operations.md#browser-and-email-setup). API keys and provider credentials stay on the server.

## Documentation

- [Operations](docs/operations.md): deployment, local development, troubleshooting, retries, and failures.
- [Development](docs/development.md): starter options, tooling, providers, transports, and limits.
- [Test coverage](docs/acceptance.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

No application database is required. Queues retain rendered content, which may include personal data. File uploads are unsupported. Destination or credential changes require a new revision; see [revision changes and draining](docs/operations.md#revision-changes-and-draining).
