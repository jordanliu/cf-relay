# Developing cf-relay

The Worker application composes the core, runtime adapter, providers, and policies. CI checks module import boundaries and configuration type fixtures.

| Module | Responsibility |
| --- | --- |
| Core | Configuration validation, submission ingestion, delivery dispatch, and portable contracts |
| Runtime adapter | HTTP parsing, platform capabilities, secrets, Queue publication, and settlement |
| Providers | Notification rendering and upstream response classification |
| Policies | Rate limiting, authentication, and bot checks |
| Worker application | Registers forms and destinations and supplies provider dependencies |

Workspace exports point to TypeScript source. All workspaces are private modules, not public npm packages. Wrangler produces a single Worker bundle. See the [public contracts](../packages/core/src/contracts/ports.ts), [custom provider example](../examples/custom-provider/index.ts), and [contribution requirements](../CONTRIBUTING.md).

## Local tooling

Run tooling from the repository root after `npm ci`. All commands accept `--help`.

### Generate a starter

`npm run init` prompts for submission mode and provider in an interactive terminal. Supply flags for repeatable generation:

```sh
npm run init -- --mode browser --provider email --email-transport resend \
  --origin https://www.your-domain.com --from forms@your-domain.com \
  --to team@your-domain.com --output .scratch/browser-email
```

| Profile | Required secrets | Platform capabilities |
| --- | --- | --- |
| Server form | `SERVER_API_KEY` | Delivery and failure Queues |
| Browser form | `TURNSTILE_SECRET` | Delivery and failure Queues, `FORM_RATE_LIMIT` |
| Slack provider | `SLACK_WEBHOOK_V1` | No additional bindings |
| Discord provider | `DISCORD_WEBHOOK_V1` | No additional bindings |
| Native email | None for the transport | `EMAIL` binding and sending-domain setup |
| Resend email | `RESEND_API_KEY` | Verified sending domain |

Each starter contains `relay.config.ts`, `src/index.ts`, `wrangler.jsonc`, `.dev.vars.example`, and `fixture.json`. It registers one provider, one destination, and one protected form. Browser starters use Turnstile action `contact` and set `expectedHostname` from `--origin`. The rate-limit namespace is randomly generated; verify account uniqueness before deployment. Configure the public Turnstile site key in the browser client separately.

The default output is `apps/worker`. Existing generated files require `--force`; local `.dev.vars` is preserved. The command prints a Wrangler binding-generation command for the selected directory. Generate bindings before type checking. A separate output directory is useful for comparison; the repository's standard build and development commands continue to target `apps/worker`.

### Inspect configuration

```sh
npm run doctor -- --strict
npm run doctor -- --local --json
```

Doctor reports each form's destinations, secret names, and required bindings. It checks Queue producer and consumer wiring, guard bindings, native email binding and allowlists, sample origins and addresses, secret type declarations, and literal Turnstile hostnames. `--local` also checks that required credentials are present in `.dev.vars` beside the relay configuration. Credential values are never printed.

Errors produce exit code 1. Warnings produce exit code 1 with `--strict`; otherwise warnings are informational. `--json` emits a structured report. Use `--config <path>` for a generated or alternative configuration; its Wrangler file must be named `wrangler.jsonc` in the same directory.

Doctor inspects the root Wrangler configuration and direct environment references in inline provider dependency factories. Computed configuration, external factories, alternate Wrangler environments, live secrets, DNS, and provider acceptance require separate verification. Literal hostname checks compare against all configured browser origins and do not establish a per-form match.

### Preview notifications

```sh
npm run preview -- --form contact --input examples/fixtures/contact.json
npm run preview -- --form events --input examples/fixtures/events.json --output .scratch/events.html
```

Preview reads a UTF-8 JSON object within the 32 KiB body limit, separates declared guard fields, parses the business schema, runs the message transform, checks serialized job limits, and calls the built-in Slack, Discord, or email renderer for each destination. Guard fields can be omitted from fixtures. It infers the form ID when the configuration contains one form. Use `--origin` if the transform reads submission origin metadata.

The default output is JSON. An output path ending in `.html` creates a page with payloads and sandboxed email HTML. Existing output files require `--force`. Provider rendering errors appear by destination and produce exit code 1. Custom providers have no preview renderer and produce `UNSUPPORTED_PREVIEW`.

Preview reads no credential file, constructs no delivery executor, and publishes no Queue jobs. It bypasses guards and cannot confirm delivery or provider acceptance. Doctor and preview import the relay configuration as trusted local code, and preview also executes schemas and message transforms. They provide no sandbox for arbitrary configuration side effects. Fixtures and preview files contain submission content and may include personal data; use `.scratch` for temporary local outputs.

## Add a provider

1. Implement `ProviderDefinition<"your-type", DeclaredConfig, Dependencies>` with a strict configuration schema and a stable lowercase provider type.
2. Declare credentials as `SecretRef` values. The executor receives `ResolveSecrets<DeclaredConfig>`, with references resolved to strings.
3. Register the provider and its destinations in [relay.config.ts](../apps/worker/relay.config.ts). Supply any factory dependencies in [the Worker entry point](../apps/worker/src/index.ts).

An executor receives correlation IDs, a `RelayMessage`, its resolved destination configuration, and a context containing HTTP, logging, and cancellation capabilities. Additional dependencies are passed to its factory.

| Delivery outcome | Meaning |
| --- | --- |
| `accepted` | The upstream service confirmed acceptance |
| `retry` | A transient failure requires another attempt, optionally with a bounded delay hint |
| `failed` | A terminal failure requires a sanitized failure record |

Validate upstream acceptance, respect the `AbortSignal`, and read or cancel response bodies within limits. Do not log raw provider errors. The dispatcher enforces deadlines, validates outcomes, and converts unexpected exceptions to `UNKNOWN` retries. The runtime adapter owns Queue acknowledgment and retry calls.

Providers run as trusted code in the same Worker and can access globals. Narrow contracts reduce accidental exposure but provide no sandbox isolation. Review third-party modules before use.

## Swap email transports

Email transports share the same form and destination configuration. To use Resend, add `RESEND_API_KEY: string` to `WorkerEnv` in [the Worker entry point](../apps/worker/src/index.ts), then replace its Cloudflare email transport import and relay initialization with:

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

The existing `createCloudflareRelay` and `config` imports remain in use. Set the credential with an interactive Wrangler prompt:

```sh
npx wrangler secret put RESEND_API_KEY --config apps/worker/wrangler.jsonc
```

Verify the sending domain and scope the API credential. The Resend transport sends to the fixed Resend endpoint and maps `replyTo` to `reply_to`. It supplies no durable idempotency guarantee. The native Cloudflare transport uses structured messages and validates the returned `messageId`; it cannot cancel an in-flight native send after a deadline.

Dependency factories run only for providers selected by the form or validated delivery job. Unrelated provider dependencies are not constructed.

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

Title, text, and field-value limits are measured in Unicode code points. IDs and revisions use bounded ASCII identifiers. Only JSON and flat URL-encoded bodies are accepted. Schema or payload-limit failures reject the submission before publication. The application submits all delivery jobs in a single batch rather than splitting them across multiple batches.

| Provider | Rendering and acceptance |
| --- | --- |
| Slack | Plain-text section blocks, fixed fallback text, disabled unfurling, and chunks of at most 1,500 Unicode code points within 50 blocks. Acceptance requires `200 ok`. |
| Discord | Disabled allowed mentions, escaped markup, and content split into embeds within one request. Uses `wait=true` and requires a returned message ID. |
| Email | Text and escaped HTML content, validated addresses and subject headers, and a returned transport message ID. |

Content is not silently truncated. A message accepted by core validation can still exceed a provider's rendered payload limits. For example, escaped Discord content exceeding its aggregate 6,000-character or field limits produces terminal `INVALID_PAYLOAD`.

Protocol references: [Slack sections](https://docs.slack.dev/reference/block-kit/blocks/section-block/), [Slack webhook responses](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), [Discord execute webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook), [Discord embeds](https://docs.discord.com/developers/resources/message#embed-object), and [Resend send email](https://resend.com/docs/api-reference/emails/send-email).

## Guard and runtime extensions

Guards declare security fields and required binding or secret names. Ingestion separates security fields from business data, then runs rate, authentication, and bot guards in that order. Business schema parsing and message transformation follow guard acceptance.

| Guard result | HTTP status |
| --- | --- |
| Required guard infrastructure unavailable | `503` |
| API-key authentication rejected | `401` |
| Bot or access check rejected | `403` |
| Rate limit reached | `429` |

Turnstile checks success, hostname, and configured action. API keys are checked using Web Crypto HMAC verification. Honeypot checks are supplementary. The HTTP adapter enforces CORS separately from authentication.

A runtime supplies `HttpClient`, `SecretReader`, `JobPublisher`, `FailureSink`, and guard capabilities, then maps delivery outcomes to its settlement API. The core imports no Cloudflare binding types.

The Cloudflare adapter validates Queue envelopes and explicitly calls `ack()` or `retry()` for each message. A successful handler return acknowledges unsettled messages according to the [Queue settlement API](https://developers.cloudflare.com/queues/configuration/javascript-apis/). A caught error must therefore result in an explicit retry. Queue publication errors can leave acceptance uncertain; adapters must preserve that distinction.

## Versioning

The source API is pre-1.0 (`0.1.0`). Queue envelopes use a separate wire contract identified by `kind` and integer `version`.

Unsupported delivery versions produce a sanitized failure record before acknowledgment. If failure publication fails, the original message is retried and can eventually reach the dead-letter Queue. Future versions require explicit decoding and migration rules.

Changes to destination identity or credentials require a new revision. Existing jobs must not be silently redirected to a changed destination. Follow the [revision and draining procedure](operations.md#revision-changes-and-draining).
