# Developing cf-relay

The application core imports only validation contracts and portable Web APIs. Runtime adapters parse HTTP, adapt secrets/Queues, and settle messages. Provider modules own rendering and protocol classification. The Worker composition root connects adapters and narrowly scoped dependencies. CI checks forbidden cross-boundary imports and type-level config fixtures.

Workspace exports point to TypeScript source. This initial release keeps all workspaces private; they are logical modules, not public npm packages. Build output is a single Worker bundle from Wrangler. See `packages/core/src/contracts/ports.ts` for the public ports and `examples/custom-provider/index.ts` for a complete trusted-provider example.

## Add a provider

Implement `ProviderDefinition<"your-type", DeclaredConfig, Dependencies>`. Give it a strict config schema and a stable lower-case type. Declared credentials must be `SecretRef`s; `ResolveSecrets<DeclaredConfig>` is the resolved executor type. Register the provider and destinations at the composition root. No ingress, routing, or Queue-runtime edits are required.

An executor receives only correlation IDs, `RelayMessage`, its own resolved configuration, a generic HTTP/logger/cancellation context, and dependencies passed to its factory. It must classify upstream results as `accepted`, bounded `retry`, or terminal `failed`, respect the signal, validate upstream acceptance, cancel/read response bodies within limits, and never log raw provider errors. The dispatcher enforces deadlines, validates outcomes, and maps unexpected exceptions to `UNKNOWN` retry. Providers do not acknowledge or retry Queue messages themselves.

Third-party providers are trusted code in the same Worker, not sandboxed plugins. Narrow ports reduce accidental exposure, not malicious-code access to globals. Install and review community modules as a trust decision.

## Swap email transports

The email provider retains the same form/destination configuration. Only the composition root changes:

```ts
import { resendEmailTransport } from "@cf-relay/email-resend";

providerDependencies: {
  email: (env: WorkerEnvWithResend) => ({
    transport: resendEmailTransport(env.RESEND_API_KEY),
  }),
}
```

Factories are invoked only for providers selected by the form or the validated queued job. A missing unrelated capability cannot block another provider.

Declare that binding name in your composition types and use Wrangler secrets to supply it. For the Resend option, verify your sending domain and scope the API credential. It sends to the fixed Resend endpoint using `reply_to`. It does not claim exactly-once behavior or durable vendor idempotency. Native Cloudflare email supports structured messages and returns a `messageId`; its lack of AbortSignal support means a timed-out attempt can still be accepted.

## Limits and rendering

| Product limit | Default |
| --- | --- |
| Raw body | 32,768 bytes |
| Destinations | 10 |
| Title | 200 Unicode code points |
| Text | 5,000 Unicode code points |
| Fields | 30 |
| Field value | 1,000 Unicode code points |
| Encoded job | 16,000 bytes |
| Encoded jobs array | 200,000 bytes |

Field names are additionally limited to 200 UTF-16 units to bound keys and provider rendering. IDs/revisions use bounded ASCII identifiers. Only JSON and flat URL-encoded bodies are accepted. Invalid schema fields or generated payload limits fail before publication; there is no partial/multiple-batch fan-out. Character and byte limits are separate.

Slack uses plain-text section blocks, a fixed fallback, no unfurling, and chunks of at most 1,500 Unicode code points (at most 3,000 UTF-16 units) within 50 blocks. Content is not silently truncated. Discord explicitly disables allowed mentions and neutralizes markdown/mention syntax. It splits descriptions and fields into embeds within one request and forces `wait=true`, requiring a returned message ID. If escaped content exceeds Discord's aggregate 6,000-character or field limits, that destination produces terminal `INVALID_PAYLOAD`; the content is not dropped. Core's message limits therefore do not guarantee every provider can represent every accepted message. Email always contains text and escaped HTML; addresses and subject headers are validated.

Protocol references: [Slack sections](https://docs.slack.dev/reference/block-kit/blocks/section-block/), [Slack webhook responses](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), [Discord execute webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook), [Discord embeds](https://docs.discord.com/developers/resources/message#embed-object), and [Resend send email](https://resend.com/docs/api-reference/emails/send-email).

## Guard and runtime extensions

Guards declare security fields and required binding/secret names. The ingress separates those fields once and executes rate guards, authentication guards, then bot guards before business schema parsing and the transformer. Missing guard infrastructure is a `503`; API-key denial is `401`, spam/access denial `403`, and rate denial `429`. Turnstile checks success, hostname, and configured action. API keys are verified with Web Crypto HMAC verification rather than plaintext equality. Honeypot is supplementary. CORS is enforced by the HTTP adapter and is not an effective protection policy by itself.

A new runtime supplies `HttpClient`, `SecretReader`, `JobPublisher`, `FailureSink`, and the guard capabilities and maps outcomes to its own settlement semantics. The core never imports Cloudflare binding types. The Cloudflare runtime preserves uncertain Queue publication, validates Queue envelopes, and calls each message's explicit `ack()` or `retry()`. An ordinary successful Queue-handler return auto-acks unsettled messages, so omitting `ack()` after a caught error is insufficient.

## Versioning

The source API is pre-1.0 (`0.1.0`) and can evolve with documented changes. Queue `kind`/integer `version` is a separate wire contract. An unknown delivery version fails safely and is recorded before acknowledgment; a broken failure sink retries so the original can reach DLQ. Never reinterpret or redirect an old job to a new destination implicitly. Bump destination revisions for target identity changes and follow the drain procedure. Future job versions need explicit decoder/migration decisions, not relaxed schema checks.
