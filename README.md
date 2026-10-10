# cf-relay

Send contact forms and API submissions to **Slack, Discord, or email** through a Cloudflare Worker.

Submissions are protected, validated, and queued for delivery. Email supports Cloudflare Email Service or Resend. No dashboard or application database is required.

## Get started

Requires Node.js 22.12+ and npm.

```sh
git clone https://github.com/jordanliu/cf-relay.git
cd cf-relay
npm ci
npm run check
```

This verifies the project locally, including tests and a deployment dry run. It does not deploy or send notifications.

1. **Configure your forms and destinations** in [relay.config.ts](apps/worker/relay.config.ts).
2. **Set up Cloudflare and credentials** using the [deployment guide](docs/operations.md).
3. **Connect your client** using the [browser form](examples/contact-form/index.html) or [server client](examples/server-to-server/client.ts) example.

## Submit a form

Send JSON or URL-encoded data to `POST /v1/forms/:formId`. Bodies are limited to 32 KiB; file uploads are unsupported.

Browser forms use rate limiting and Turnstile. Server submissions use an API key. Secrets stay on the server.

A successful response confirms that the submission was queued:

```json
{"id":"sub_...","status":"queued","destinations":3}
```

Delivery happens asynchronously. Retries can produce duplicate notifications. When changing a destination or its credentials, bump its revision; see the [revision guide](docs/operations.md#revision-changes-and-draining).

## Documentation

- [Deploy and operate](docs/operations.md) — setup, secrets, failures, and monitoring.
- [Customize and extend](docs/development.md) — providers, email transports, and limits.
- [Test coverage](docs/acceptance.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

[MIT license](LICENSE).
