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

Setup runs strict doctor and fixture checks, generates Worker bindings, and creates ignored `.dev.vars`. A new server credential file receives a random `SERVER_API_KEY`; existing files are preserved. Setup copies legacy `apps/worker/.dev.vars` to the root when no root credential file exists. Fill in the other credentials before local requests or deployment.

Use `--config <path>` for another starter, with `--input` and `--form` for custom fixtures. Setup performs local checks without provisioning or delivery. It imports trusted configuration code; see [extension trust](../SECURITY.md#extension-trust).

### Generate a starter

`npm run init` prompts for mode and provider. For repeatable generation, use flags:

```sh
npm run init -- --mode browser --provider email --email-transport resend \
  --origin https://www.your-domain.com --from forms@your-domain.com \
  --to team@your-domain.com --output .scratch/browser-email
```

| Option | Values |
| --- | --- |
| `--mode` | `server` (API key) or `browser` (rate limiting, Turnstile, honeypot) |
| `--provider` | `slack`, `discord`, `email` |
| `--email-transport` | `cloudflare` (default) or `resend` |
| `--origin` | Exact browser origin without a path |
| `--from`, `--to` | Email sender and comma-separated recipients |
| `--name` | Worker name, also used for Queue names |
| `--output` | Directory; defaults to `apps/worker` |
| `--force` | Replace existing starter files; preserve `.dev.vars` |

Starters configure API ingestion and delivery, with no frontend assets. They contain one form, one destination, `relay.config.ts`, `src/index.ts`, `wrangler.jsonc`, `.dev.vars.example`, and `fixture.json`. Run setup after generation, using `--config <output>/relay.config.ts` for a separate directory. The default Worker source stays in `apps/worker`; Wrangler configuration and secrets live at the repository root. Separate output directories keep all starter files together.

Combine the selected form and provider requirements:

| Selection | Secrets | Additional setup |
| --- | --- | --- |
| Server form | `SERVER_API_KEY` | Delivery and failure Queues |
| Browser form | `TURNSTILE_SECRET` | Queues, `FORM_RATE_LIMIT`, public Turnstile site key |
| Slack | `SLACK_WEBHOOK_V1` | Incoming webhook |
| Discord | `DISCORD_WEBHOOK_V1` | Webhook |
| Native email | None for the transport | `EMAIL` binding, sending domain |
| Resend | `RESEND_API_KEY` | Verified sending domain |

Browser starters use Turnstile action `contact` and derive `expectedHostname` from `--origin`. Verify the generated rate-limit namespace is unique in your account.

When switching profiles, add any newly required secret names to an existing `.dev.vars`.

### Inspect configuration

```sh
npm run doctor -- --strict
npm run doctor -- --local --json
```

Doctor checks Queue wiring, required bindings and secret names, native email allowlists, placeholders, and secret type declarations. `--local` checks credential presence in `.dev.vars` without printing values. Errors exit with code 1; `--strict` also fails on warnings.

The default Worker uses root `wrangler.jsonc` and `.dev.vars`. For another starter, use `--config <path>` with Wrangler configuration and credentials beside it. Inspection covers root Wrangler settings, inline dependency factories, and literal hostnames. Verify per-form Turnstile settings separately. Live credentials, DNS, computed settings, and alternate Wrangler environments are not checked.

### Preview notifications

For the default API, or a generated browser configuration:

```sh
npm run preview -- --input apps/worker/fixture.json --output .scratch/preview.html
# After generating a browser configuration:
npm run preview -- --input examples/fixtures/contact.json
```

Preview parses a UTF-8 JSON object within 32 KiB, removes declared guard fields, validates the schema and message, checks job size, and renders each built-in destination. Guard fields may be omitted. A single-form configuration needs no `--form`; `--origin` supplies origin metadata to the transform.

Output defaults to JSON; `.html` paths add a page with sandboxed email HTML. Existing files require `--force`. Rendering failures exit with code 1; custom providers return `UNSUPPORTED_PREVIEW`. Preview bypasses guards and delivery. Both tools execute trusted configuration code; see [extension trust](../SECURITY.md#extension-trust).

## Default configuration

The included [relay.config.ts](../apps/worker/relay.config.ts) defines `events` with `event` and `details` fields, API-key authentication, and one Slack destination. The [multi-destination example](../examples/multi-destination/relay.config.ts) shows browser and server forms with Slack, Discord, and email.

## Add a provider

1. Implement `ProviderDefinition<"your-type", DeclaredConfig, Dependencies>` with a strict configuration schema and a stable lowercase type.
2. Declare credentials as `SecretRef`. Executors receive `ResolveSecrets<DeclaredConfig>`.
3. Register providers and destinations in `relay.config.ts`; supply dependency factories in the Worker entry point.

An executor receives correlation IDs, a `RelayMessage`, resolved destination configuration, and HTTP, logging, and cancellation capabilities. See the [custom provider example](../examples/custom-provider/index.ts).

| Outcome | Meaning |
| --- | --- |
| `accepted` | Upstream acceptance confirmed |
| `retry` | Transient failure, optionally with a bounded delay hint |
| `failed` | Terminal failure requiring a sanitized failure record |

Respect `AbortSignal`, bound response bodies, and use safe error codes. The dispatcher enforces deadlines and converts unexpected exceptions to `UNKNOWN` retries. The runtime owns Queue settlement. Factories run only for selected providers.

## Swap email transports

Start with an email API configuration. Forms and destinations are unchanged when switching transports. For Resend, add `RESEND_API_KEY: string` to `WorkerEnv` and replace the native transport import and factory in [the entry point](../apps/worker/src/index.ts):

```ts
import { resendEmailTransport } from "@cf-relay/email-resend";

const relay = createCloudflareRelay(config, {
  providerDependencies: {
    email: (env: WorkerEnv) => ({
      transport: resendEmailTransport(env.RESEND_API_KEY),
    }),
  },
});
```

Keep the existing `createCloudflareRelay` and `config` imports. Remove an unused native `EMAIL` binding, regenerate types, verify the Resend sending domain, and set the credential:

```sh
npx wrangler secret put RESEND_API_KEY
```

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
| Email | Escaped HTML, plain text, validated headers; requires a transport message ID. [Resend API](https://resend.com/docs/api-reference/emails/send-email) |

## Guard and runtime extensions

Guards declare security fields, binding names, and secret names. Ingestion separates guard fields and runs rate, authentication, and bot checks before schema parsing and message transformation. CORS is enforced separately from authentication.

Runtime adapters supply `HttpClient`, `SecretReader`, `JobPublisher`, `FailureSink`, and guard capabilities. They must explicitly settle each Queue message with acknowledgment or retry, including after caught errors. See [Queue settlement](https://developers.cloudflare.com/queues/configuration/javascript-apis/) and [deadlines and uncertain acceptance](operations.md#retry-budgets-and-uncertain-acceptance).

## Versioning

The source API is pre-1.0 (`0.1.0`). Queue envelopes have separate `kind` and integer `version` fields. Unsupported versions produce sanitized failures; failed failure publication retries the original job.

Destination or credential changes require a new revision and a [draining plan](operations.md#revision-changes-and-draining). Pending jobs must not be silently redirected.
