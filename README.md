# cf-relay

A Cloudflare Worker for validating and routing form submissions and API events to Slack, Discord, and email.

The Worker validates submissions and queues jobs for asynchronous delivery with retries. Forms, request guards, destinations, and message transforms are configured in TypeScript.

## Supported features

| Feature | Support |
| --- | --- |
| Destinations | Slack incoming webhooks, Discord webhooks, email |
| Email transports | Cloudflare Email Service (default), [Resend](docs/development.md#swap-email-transports) |
| Request formats | JSON and flat URL-encoded form data |
| Routing | One or multiple destinations per form |
| Validation | Strict input schemas and configurable message transforms |
| Request protection | API keys, rate limiting, Turnstile, and honeypot |
| Delivery | Cloudflare Queues, bounded retries, and a failure Queue |
| Local tooling | Minimal starters, configuration diagnostics, and notification previews |

## Quick start

Requirements:

- Node.js 22.12+ and npm.
- A Cloudflare account with Workers and Queues available.
- Credentials for configured destinations, such as Slack or Discord webhooks.
- A Turnstile widget for public browser forms and a configured sending domain for email delivery, when used.

### 1. Clone and install

```sh
git clone https://github.com/jordanliu/cf-relay.git
cd cf-relay
npm ci
```

### 2. Configure forms and destinations

Generate a starter with one form and one provider. For a server form delivering to Slack:

```sh
npm run init -- --mode server --provider slack --force
```

`--force` replaces the included relay configuration, Worker entry point, Wrangler configuration, secret template, and preview fixture. It preserves `.dev.vars`. Use `--output <directory>` to generate a separate configuration instead.

| Option | Values |
| --- | --- |
| `--mode` | `server` uses API-key authentication; `browser` uses rate limiting, Turnstile, and honeypot |
| `--provider` | `slack`, `discord`, or `email` |
| `--email-transport` | `cloudflare` (default) or `resend`, when using email |
| `--origin` | Exact browser page origin, such as `https://www.your-domain.com` |
| `--from`, `--to` | Sender and comma-separated recipients, when using email |

Define forms and destinations in [relay.config.ts](apps/worker/relay.config.ts). A form specifies an input schema, request guards, destination IDs, and a `message` transform. A destination specifies a provider, revision, and provider-specific configuration.

The included configuration, before generating a starter, defines two forms:

| Form ID | Request guards | Required business fields | Destinations |
| --- | --- | --- | --- |
| `contact` | Rate limiting, Turnstile, and honeypot | `name`, `email`, `message` | Slack, Discord, and email |
| `events` | API key | `event`, `details` | Slack |

Replace sample allowed origins, Turnstile hostname, and email addresses when used. Edit each form's `schema` to define accepted fields and its `message` function to generate notification content.

In [wrangler.jsonc](apps/worker/wrangler.jsonc), configure the Worker and Queue names, email allowlists, and rate-limit namespace. Store credentials as Wrangler secrets. For example, `secret("SERVER_API_KEY")` declares a reference to the `SERVER_API_KEY` binding; the credential value is supplied at runtime.

Inspect configuration and preview a generated fixture before setting credentials:

```sh
npm run doctor -- --strict
npm run preview -- --input apps/worker/fixture.json
```

For the included configuration, use `npm run preview -- --form contact --input examples/fixtures/contact.json`. Add `--output .scratch/preview.html` for an HTML preview. Preview validates and renders content without running guards or sending notifications. Both commands execute trusted local configuration code; see [tooling details](docs/development.md#local-tooling).

### 3. Provision and deploy

Follow the [deployment guide](docs/operations.md#configure-and-deploy) to create the Queues, configure secrets, and provision Turnstile or email capabilities required by the selected forms.

Before deploying, verify the project locally:

```sh
npm run types:generate
npm run check
```

This runs lint, type checks, tests, binding verification, and a deployment dry run. It does not deploy or send notifications. After provisioning the required resources and credentials, deploy with:

```sh
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

## Client integration

Submit requests to `POST /v1/forms/<formId>`, where `<formId>` is a key in the configured forms registry.

### Browser forms

The [HTML contact form example](examples/contact-form/index.html) submits URL-encoded data and uses [client.js](examples/contact-form/client.js) to show submission status in the page. It prevents concurrent submissions, preserves fields on errors, and refreshes Turnstile after each request. Set its `action` to the deployed endpoint, such as `https://submit.example.com/v1/forms/contact`, and replace `YOUR_PUBLIC_SITE_KEY` with the Turnstile site key. Serve both files together from your site.

Set `allowedOrigins` to the page's exact origin and `expectedHostname` to its hostname. The example uses Turnstile action `contact`, submits the `cf-turnstile-response` token, and includes a `website` honeypot field that must remain empty. Webhook URLs, API keys, and the Turnstile secret remain server-side; the Turnstile site key is public.

### Server requests

The [server client example](examples/server-to-server/client.ts) reads `RELAY_ENDPOINT` for the Worker URL and `RELAY_API_KEY` for the credential configured as `SERVER_API_KEY`. Authentication uses the `Authorization: Bearer` header.

Example request for the `events` form:

```http
POST /v1/forms/events
Content-Type: application/json
Authorization: Bearer <your-server-api-key>

{
  "event": "Deployment completed",
  "details": "API service deployed at version 1.2.3."
}
```

### HTTP responses

A successful request returns HTTP 202 Accepted:

```json
{
  "id": "sub_...",
  "status": "queued",
  "destinations": 1
}
```

`id` identifies the submission; `destinations` is the number of queued delivery jobs. A `202` confirms Queue publication, not downstream delivery. Retries can produce duplicate notifications. A `503` can indicate uncertain publication; inspect the response's `error.code` and `error.message` before retrying.

| Status | Meaning |
| --- | --- |
| `401` | The server API key is missing or invalid. |
| `403` | The browser origin, Turnstile verification, or honeypot check was rejected. |
| `413` / `415` | The body is too large or uses an unsupported content type. |
| `422` | The fields or generated notification do not meet the configured limits. |
| `429` | The form's rate limit was reached. |
| `503` | Required configuration is unavailable, a check could not complete, or queue acceptance could not be confirmed. |

## Operational constraints

- Requests must use JSON or flat URL-encoded form data. The body limit is 32 KiB; file uploads are unsupported.
- No application database is required. Queues retain rendered notification content while it awaits delivery; see [retention and limits](docs/operations.md#retention-and-limits).
- Changes to destination identity or credentials require a new `revision` and an explicit plan for pending jobs. Follow the [revision and draining guide](docs/operations.md#revision-changes-and-draining).

## Documentation

- [Deployment and operations](docs/operations.md): Cloudflare setup, secrets, monitoring, and failed deliveries.
- [Development guide](docs/development.md): custom providers, email transports, and detailed limits.
- [Test coverage](docs/acceptance.md): what the automated checks verify.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
