# cf-relay

A headless submission relay you deploy in your own Cloudflare account. One Worker accepts protected contact forms and API submissions, renders a small canonical message, and queues one independent delivery per configured Slack, Discord, or email destination.

The TypeScript core is independent of Cloudflare. Providers use scoped HTTP or email capabilities; only the composition root connects concrete infrastructure. No dashboard or application database is required. The workspace packages are private source modules, not published npm packages.

## Start locally

Use Node 22.12+ (CI uses Node 24) and npm.

```sh
git clone https://github.com/jordanliu/cf-relay.git
cd cf-relay
npm ci
npm run check
```

Checks run formatting/lint, architectural boundaries, type-level negative fixtures, Vitest contracts, local Workers integration, local DLQ exhaustion, generated binding consistency, and a Wrangler deployment dry run. Tests use fake credentials and transports; they do not send live notifications. Local runtime tests require loopback sockets.

Edit [relay.config.ts](apps/worker/relay.config.ts) to select destinations and schemas. Configure exact origins, Turnstile hostname/action, sender and recipient addresses, and an account-unique rate-limit namespace in [wrangler.jsonc](apps/worker/wrangler.jsonc). Configuration validates at import/build time. A public form requires rate limit plus Turnstile; a server form requires an API key. A honeypot alone is insufficient. `unsafeAllowUnprotected: true` is an explicit unsafe opt-out intended for controlled experiments.

```ts
const destinations = defineDestinations(providers, {
  team: {
    provider: "slack",
    revision: "v1",
    webhook: secret("TEAM_SLACK_WEBHOOK_V1"),
  },
});
```

`secret()` stores a binding name, never a credential. Forms reference destination keys; transformers receive schema-inferred, parsed business data. Unknown providers, incompatible configs, empty revisions, and unknown destination references are rejected. Programmatic registries can use `defineDestinationEntries()` to detect duplicate IDs before converting entries into an object. Duplicate literal object keys are rejected by TypeScript.

Copy `.dev.vars.example` to ignored `.dev.vars` only when intentionally exercising your configured services. Local `wrangler dev` uses simulated Queues, but outbound provider HTTP can still contact real providers if you supply real credentials. The test commands remain fully mocked.

## HTTP contract

| Route | Result |
| --- | --- |
| `POST /v1/forms/:formId` | Protect, validate, render, and publish one bounded batch |
| `OPTIONS /v1/forms/:formId` | CORS preflight for that form's exact configured origins |
| `GET /healthz` | Runtime liveness; does not check destinations |

JSON and URL-encoded bodies are supported; multipart and attachments are not. The body is streamed once under a 32 KiB limit. Guard tokens and honeypot fields are removed before business schema validation. Duplicate URL-encoded keys, nested bracket notation, unsafe property keys, malformed percent escapes, and invalid UTF-8 are rejected.

Only a **confirmed** single `sendBatch()` returns `202`:

```json
{"id":"sub_...","status":"queued","destinations":3}
```

`queued` does not mean downstream delivery completed. Publication rejection or timeout returns `503 QUEUE_UNAVAILABLE`; it may still have accepted jobs. Client retries can create duplicate notifications. There is no HTTP deduplication store or exactly-once guarantee.

Errors contain a safe `error.code` and `error.message`: `400` malformed body, `401` API authentication, `403` access denial, `404` unknown form, `405` wrong method, `413` raw body too large, `415` media type, `422` business/message limits, `429` rate limit, and `503` unavailable capability or uncertain publication. No submitted fields or upstream error text are returned.

## Delivery and privacy

Jobs contain the rendered message, correlation IDs, and destination ID/provider/revision. They exclude raw submission data, security fields, webhooks, and secret references. Destinations are verified before secrets are resolved; an old job is never redirected to a changed target. **Bump the revision when an endpoint, recipient, or the value behind a secret changes.** The runtime cannot discover an unversioned secret rotation.

Each Queue message is acknowledged or retried independently. Provider acceptance acknowledges it. Permanent failures first publish a sanitized failure record; a failed sink explicitly retries the original. Retry exhaustion moves the original rendered job into the failure Queue. Retries use platform attempt counts, positive capped exponential delay with jitter, and bounded upstream hints.

Delivery is at least once. Timeouts and native email's non-cancellable send can cause duplicates. `accepted` means upstream acceptance, not human receipt or inbox delivery. The failure Queue contains both sanitized `failure.record` envelopes and original `delivery` jobs, plus potentially malformed original messages. Queue contents are ephemeral and may contain personal data; inspect with restricted access.

## Guides and examples

- [Deployment and operations](docs/operations.md): later Cloudflare setup, revisions, draining, monitoring, retention, and authenticated peek.
- [Provider and runtime development](docs/development.md): contracts, extension example, transport swap, limits, and versioning.
- [Acceptance matrix](docs/acceptance.md): checks and actual verification limits.
- [Browser contact form](examples/contact-form/index.html), [server client](examples/server-to-server/client.ts), and [custom provider](examples/custom-provider/index.ts).
- [Security policy](SECURITY.md) and [contributing](CONTRIBUTING.md).

Licensed under MIT. See [LICENSE](LICENSE).
