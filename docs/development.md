# Development

The Worker composes private TypeScript workspaces into one bundle:

| Module | Responsibility |
| --- | --- |
| Core | Configuration, validation, ingestion, dispatch, portable contracts |
| Runtime adapter | HTTP parsing, bindings, Queue publication and settlement |
| Providers | Rendering and upstream response handling |
| Policies | Authentication, rate limiting, bot checks |
| Worker application | Forms, destinations, provider dependencies |

See the [public contracts](../packages/core/src/contracts/ports.ts) and [contribution requirements](../CONTRIBUTING.md).

## Local tooling

Run commands from the repository root after `npm ci`. Each accepts `--help`.

### Prepare local setup

```sh
npm run setup
```

Interactive setup selects a form and providers, then collects only missing selected credentials with hidden input. It preserves existing values and comments, generates API and signing keys, validates configuration and a fixture, and generates bindings. Credentials stay in ignored `.dev.vars` with owner-only permissions.

For repeatable selection, use flags:

```sh
npm run setup -- --providers slack,discord --form events
npm run setup -- --providers email --from forms@your-domain.com --to team@your-domain.com
npm run setup -- --providers webhook --webhook-auth signing
npm run setup -- --providers slack,webhook --dry-run
```

Each provider is optional; an active form requires at least one destination. Setup changes only the selected form's routes and adds needed definitions. Existing schemas, transforms, guards, other forms, Worker names, Queues, and bindings are preserved. Old destination definitions remain available for pending jobs. Changing existing email addresses, transports, or webhook authentication requires the [revision and draining procedure](operations.md#revision-changes-and-draining).

Guided editing supports static TypeScript builder declarations and `WorkerEnv`. Computed configurations receive manual instructions without writes. Dry runs report routes, new destinations, changed files, and required secret names without applying changes.

Without a terminal, setup prepares missing entries and reports credentials still needed. Use `doctor --local --strict` before uploading. `SERVER_API_KEY` can be supplied through `RELAY_API_KEY`; otherwise a new local key is generated. Existing local values take precedence. Legacy `apps/worker/.dev.vars` is copied when no root credential file exists.

Use `--config <path>`, `--input`, and `--form` for other configurations and fixtures. Setup performs no deployment, secret upload, or notification delivery. It executes trusted configuration code; see [extension trust](../SECURITY.md#extension-trust).

### Generate a starter

`npm run init` prompts for mode and providers. For repeatable generation, use flags:

```sh
npm run init -- --mode browser --providers email --email-transport resend \
  --origin https://www.your-domain.com --from forms@your-domain.com \
  --to team@your-domain.com --output .scratch/browser-email
```

| Option | Values |
| --- | --- |
| `--mode` | `server` (API key) or `browser` (rate limiting, Turnstile, honeypot) |
| `--providers` | Comma-separated selection of `slack`, `discord`, `email`, `webhook` |
| `--provider` | Legacy single-provider selection; cannot be combined with `--providers` |
| `--webhook-auth` | `signing` (default), `bearer`, `both`, `none` |
| `--email-transport` | `cloudflare`, `resend`, `smtp` |
| `--origin` | Exact browser origin without a path |
| `--from`, `--to` | Email sender and comma-separated recipients |
| `--name` | Worker name, also used for Queue names |
| `--output` | Directory; defaults to `apps/worker` |
| `--force` | Replace existing starter files; preserve `.dev.vars` |

Starters configure API ingestion and delivery, with no frontend assets. They contain one form and one destination per selected provider, `relay.config.ts`, `src/index.ts`, `wrangler.jsonc`, `.dev.vars.example`, and `fixture.json`. Provider secrets are commented out in the example file so they can be configured after dashboard deployment; setup creates all credentials needed locally. Run setup after generation, using `--config <output>/relay.config.ts` for a separate directory. The default Worker source stays in `apps/worker`; Wrangler configuration and secrets live at the repository root. Separate output directories keep all starter files together.

Combine the selected form and provider requirements:

| Selection | Secrets | Additional setup |
| --- | --- | --- |
| Server form | `SERVER_API_KEY` | Delivery and failure Queues |
| Browser form | `TURNSTILE_SECRET`, operator `SERVER_API_KEY` | Queues, `FORM_RATE_LIMIT`, public Turnstile site key |
| Slack | `SLACK_WEBHOOK_V1` | Incoming webhook |
| Discord | `DISCORD_WEBHOOK_V1` | Webhook |
| Native email | None for the transport | `EMAIL` binding, sending domain |
| Resend | `RESEND_API_KEY` | Verified sending domain |
| SMTP | `SMTP_URL` | TLS SMTP submission server, authorized sender |
| Webhook | URL, optional signing key and bearer token | HTTPS receiver; [authentication and payload](webhooks.md) |

Browser starters use Turnstile action `contact` and derive `expectedHostname` from `--origin`. Verify the generated rate-limit namespace is unique in your account.

Setup adds missing credential entries. Browser clients never receive the operator API key. Guided setup uses one email transport per Worker.

### Inspect configuration

```sh
npm run doctor -- --strict
npm run doctor -- --local --json
npm run doctor -- --endpoint "$RELAY_ENDPOINT" --form events --json
```

Remote doctor authenticates with `RELAY_API_KEY` or local `SERVER_API_KEY`, reports missing configuration, and checks that deployed destination IDs, providers, and revisions match the local form. It does not test provider acceptance.

Local doctor checks Queue wiring, required bindings and secret names, native email allowlists, placeholders, and secret type declarations. `--local` checks credential presence in `.dev.vars` without printing values. Errors exit with code 1; `--strict` also fails on warnings.

The default Worker uses root `wrangler.jsonc` and `.dev.vars`. For another starter, use `--config <path>` with Wrangler configuration and credentials beside it. Inspection covers root Wrangler settings, inline dependency factories, and literal hostnames. Verify per-form Turnstile settings separately. Live credentials, DNS, computed settings, and alternate Wrangler environments are not checked.

### Preview notifications

For the default API, or a generated browser configuration:

```sh
npm run preview -- --input apps/worker/fixture.json --output .scratch/preview.html
# After generating a browser configuration:
npm run preview -- --input examples/fixtures/contact.json
```

Preview parses a UTF-8 JSON object within 32 KiB, removes declared guard fields, validates the schema and message, checks job size, and renders each built-in destination. Guard fields may be omitted. A single-form configuration needs no `--form`; `--origin` supplies origin metadata to the transform.

Output defaults to JSON; `.html` paths add a page with sandboxed email HTML. Existing files require `--force`. Rendering failures exit with code 1; webhook previews include notification JSON without credentials or signatures; custom providers return `UNSUPPORTED_PREVIEW`. Preview bypasses guards and delivery. Both tools execute trusted configuration code; see [extension trust](../SECURITY.md#extension-trust).

## Default configuration

The included [relay.config.ts](../apps/worker/relay.config.ts) defines `events` with `event` and `details` fields, API-key authentication, and one Slack destination. The [multi-destination example](../examples/multi-destination/relay.config.ts) shows browser and server forms with Slack, Discord, and email.

## Test a submission

```sh
npm run send -- --input apps/worker/fixture.json
npm run send -- --endpoint "$RELAY_ENDPOINT" --form events --live
```

Without `--live`, this only previews. Live mode checks the selected form's readiness and submits once. A `202` confirms Queue acceptance, not delivery. A timeout or `503` is not automatically retried. Browser fixtures need a fresh Turnstile token and an allowed `--origin`.

## Add a provider

1. Implement `ProviderDefinition<"your-type", DeclaredConfig, Dependencies>` with a strict configuration schema and a stable lowercase type.
2. Declare credentials as `SecretRef`. Executors receive `ResolveSecrets<DeclaredConfig>`.
3. Register providers and destinations in `relay.config.ts`; supply dependency factories in the Worker entry point.

An executor receives correlation IDs, the submission creation time, a `RelayMessage`, resolved destination configuration, and HTTP, logging, and cancellation capabilities. See the [custom provider example](../examples/custom-provider/index.ts).

| Outcome | Meaning |
| --- | --- |
| `accepted` | Upstream acceptance confirmed |
| `retry` | Transient failure, optionally with a bounded delay hint |
| `failed` | Terminal failure requiring a sanitized failure record |

Respect `AbortSignal`, bound response bodies, and use safe error codes. The dispatcher enforces deadlines and converts unexpected exceptions to `UNKNOWN` retries. The runtime owns Queue settlement. Factories run only for selected providers.

## Swap email transports

For a new email configuration, select the transport during setup:

```sh
npm run setup -- --providers email --email-transport smtp \
  --from forms@your-domain.com --to team@your-domain.com
```

| Transport | Import | Credential or binding |
| --- | --- | --- |
| Cloudflare Email Service | `@cf-relay/email-cloudflare` | `EMAIL` binding |
| Resend | `@cf-relay/email-resend` | `RESEND_API_KEY` |
| SMTP | `@cf-relay/email-smtp` | `SMTP_URL` |

Existing Workers use one transport across all email destinations. To change it, update the import and factory in [the entry point](../apps/worker/src/index.ts), declare the secret in `WorkerEnv`, and follow the [revision and draining procedure](operations.md#revision-changes-and-draining). For SMTP:

```ts
import { smtpEmailTransport } from "@cf-relay/email-smtp";

const relay = createCloudflareRelay(config, {
  readinessGuard: apiKey({ secret: secret("SERVER_API_KEY") }),
  providerDependencies: {
    email: (env: WorkerEnv) => ({
      transport: smtpEmailTransport(env.SMTP_URL),
    }),
  },
});
```

Keep the existing runtime, configuration, and guard imports. Remove unused native bindings only after pending jobs drain, then regenerate types and set the production secret:

```sh
npx wrangler secret put SMTP_URL
```

### SMTP settings

Setup collects `SMTP_URL` with hidden input. Keep it in ignored `.dev.vars` locally and a Worker secret in production.

| URL | Connection |
| --- | --- |
| `smtps://username:password@smtp.your-domain.com:465` | Implicit TLS |
| `smtp://username:password@smtp.your-domain.com:587` | Required STARTTLS |

Percent-encode special characters in the username and password. Omit both for a relay that accepts unauthenticated TLS submissions. Authentication supports `PLAIN` and `LOGIN`; OAuth is not supported. TLS certificate verification remains enabled and encryption failures never fall back to plaintext.

Use an authorized sender and a publicly reachable SMTP server. Workers block port 25 and private addresses; see [TCP socket limits](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations). SMTP confirms every recipient before transmitting the message. Temporary `4xx` responses and connection failures retry; permanent `5xx` responses fail. Acceptance requires the final `250` after message data, and a timeout can still mean acceptance is uncertain.

## Limits and rendering

| Limit | Maximum |
| --- | --- |
| Raw body | 32,768 bytes |
| Destinations | 10 |
| Title | 200 Unicode code points |
| Text | 5,000 Unicode code points |
| Fields | 30 |
| Field name | 200 UTF-16 code units |
| Field value | 1,000 Unicode code points |
| Encoded job | 16,000 bytes |
| Encoded jobs array | 200,000 bytes |

Core validation and size checks run before a single Queue batch is published. Provider rendering may still fail during delivery with terminal `INVALID_PAYLOAD`; content is not truncated.

| Provider | Rendering and acceptance |
| --- | --- |
| Slack | Plain-text blocks, disabled unfurling, chunks up to 1,500 code points within 50 blocks; requires `200 ok`. [Reference](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) |
| Discord | Escaped markup, disabled mentions, bounded embeds; uses `wait=true` and requires a message ID. Aggregate content must fit 6,000 characters. [Reference](https://docs.discord.com/developers/resources/webhook#execute-webhook) |
| Webhook | Versioned JSON, optional HMAC signing and bearer authentication; any `2xx` confirms acceptance. [Protocol](webhooks.md) |
| Email | Escaped HTML, plain text, validated headers; native/API message ID or confirmed SMTP acceptance. |

## Guard and runtime extensions

Guards declare security fields, binding names, and secret names. Ingestion separates guard fields and runs rate, authentication, and bot checks before schema parsing and message transformation. CORS is enforced separately from authentication.

Runtime adapters supply `HttpClient`, `SecretReader`, `JobPublisher`, `FailureSink`, and guard capabilities. They must explicitly settle each Queue message with acknowledgment or retry, including after caught errors. See [Queue settlement](https://developers.cloudflare.com/queues/configuration/javascript-apis/) and [deadlines and uncertain acceptance](operations.md#retry-budgets-and-uncertain-acceptance).

`createCloudflareRelay` accepts an optional `readinessGuard: apiKey({ secret: secret("SERVER_API_KEY") })`. This enables authenticated `GET /v1/readiness`, returning per-form destinations and safe diagnostics for missing credentials, bindings, or provider dependencies. Configured Workers return `200`; incomplete Workers return `503`. The check sends no notifications and reports no credential values. Omitting the guard leaves the route disabled.

## Versioning

The source API is pre-1.0 (`0.1.0`). Queue envelopes have separate `kind` and integer `version` fields. Unsupported versions produce sanitized failures; failed failure publication retries the original job.

Destination or credential changes require a new revision and a [draining plan](operations.md#revision-changes-and-draining). Pending jobs must not be silently redirected.
