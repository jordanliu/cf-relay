# Acceptance matrix

The checks cover configuration contracts, request validation, provider behavior, and Queue settlement using Vitest, TypeScript fixtures, the Cloudflare Vitest plugin, and local Miniflare. Run the complete suite with:

```sh
npm run check
```

Tests use fake credentials and mocked provider capabilities. Workers tests mock outbound HTTP. The dead-letter Queue fixture denies provider HTTP and uses temporary local KV to capture the exhausted job for assertions. The application requires no database.

## Configuration

| Behavior | Evidence |
| --- | --- |
| Typed provider configuration, required revisions, and schema-inferred message data | [Type fixtures](../tests/types/config.ts) and [configuration tests](../tests/contracts/config.test.ts) |
| Rejection of unknown providers or destinations, invalid revisions, extra provider fields, and duplicate registry entries | [Configuration tests](../tests/contracts/config.test.ts) and [provider tests](../tests/contracts/providers.test.ts) |
| Required API-key protection or rate limiting with Turnstile; explicit unsafe opt-out | [Type fixtures](../tests/types/config.ts) and [configuration tests](../tests/contracts/config.test.ts) |
| Frozen configuration snapshots and parsed defaults | [Configuration tests](../tests/contracts/config.test.ts) and [runtime tests](../tests/contracts/runtime.test.ts) |
| Scoped secret resolution and lazy provider dependency factories | [Dispatch tests](../tests/contracts/dispatch.test.ts) and [runtime tests](../tests/contracts/runtime.test.ts) |

## HTTP ingestion

| Behavior | Evidence |
| --- | --- |
| Single-pass JSON and URL-encoded parsing; security fields separated from business data | [Ingress tests](../tests/contracts/ingress.test.ts) |
| Rejection of multipart bodies, oversized bodies, malformed encoding, invalid UTF-8, and duplicate keys | [Ingress tests](../tests/contracts/ingress.test.ts) and [Worker tests](../tests/integration/worker.test.ts) |
| Cancellation of stalled or aborted body reads | [Ingress tests](../tests/contracts/ingress.test.ts) |
| Guard execution before schema parsing and message transformation | [Ingress tests](../tests/contracts/ingress.test.ts) |
| Encoded job and batch limits checked before publication | [Ingress tests](../tests/contracts/ingress.test.ts) |
| Only rendered messages queued; raw submissions, secret references, and tokens excluded | [Ingress serialization tests](../tests/contracts/ingress.test.ts) |
| Required capabilities and secrets checked before publication | [Runtime tests](../tests/contracts/runtime.test.ts) and [Worker tests](../tests/integration/worker.test.ts) |
| CORS, allowed methods, health response, and authentication | [Worker tests](../tests/integration/worker.test.ts) |
| One Queue batch submitted; `202` returned after confirmed publication | [Worker tests](../tests/integration/worker.test.ts) |
| Publication rejection or timeout returns `503`; late acceptance remains possible and emits `ACCEPTANCE_UNKNOWN` | [Ingress tests](../tests/contracts/ingress.test.ts) |

## Providers and policies

| Behavior | Evidence |
| --- | --- |
| Acceptance requires Slack `200 ok`, a Discord message ID with `wait=true`, or an email transport message ID | [Provider tests](../tests/contracts/providers.test.ts) |
| Slack and Discord mention handling, payload limits, and safe rendering | [Provider tests](../tests/contracts/providers.test.ts) |
| Escaped email HTML and validated headers | [Provider tests](../tests/contracts/providers.test.ts) |
| Cloudflare and Resend email transports share the same message and destination configuration | [Provider tests](../tests/contracts/providers.test.ts) |
| API-key verification, Turnstile hostname and action checks, honeypot handling, and rate-limit results | [Policy tests](../tests/contracts/policies.test.ts) |
| Log redaction of content, credentials, addresses, URLs, and upstream exceptions | [Policy tests](../tests/contracts/policies.test.ts) and [dispatch tests](../tests/contracts/dispatch.test.ts) |
| Provider extensions use portable contracts | [Custom provider example](../examples/custom-provider/index.ts), [boundary checks](../scripts/check-boundaries.mjs), and core type checks |

## Delivery and Queue settlement

| Behavior | Evidence |
| --- | --- |
| Destination ID, provider, and revision checked before secret resolution or provider construction | [Dispatch tests](../tests/contracts/dispatch.test.ts) and [runtime tests](../tests/contracts/runtime.test.ts) |
| Transient errors, timeouts, and unexpected exceptions produce bounded retries | [Provider tests](../tests/contracts/providers.test.ts) and [dispatch tests](../tests/contracts/dispatch.test.ts) |
| Invalid envelopes, unsupported versions, and oversized jobs produce sanitized failures | [Dispatch tests](../tests/contracts/dispatch.test.ts) |
| Terminal failure record published before acknowledgment | [Dispatch tests](../tests/contracts/dispatch.test.ts) and [Worker tests](../tests/integration/worker.test.ts) |
| Failure-sink errors cause explicit retries; stalled writes are bounded | [Dispatch tests](../tests/contracts/dispatch.test.ts) and [Worker tests](../tests/integration/worker.test.ts) |
| Mixed batches settle each message independently | [Dispatch tests](../tests/contracts/dispatch.test.ts) and [Worker tests](../tests/integration/worker.test.ts) |
| Retry exhaustion preserves the original delivery envelope in the DLQ | [Local platform test](../tests/platform/dlq.test.ts) |
| Failure Queue contains sanitized records and original exhausted jobs | [Dispatch tests](../tests/contracts/dispatch.test.ts), [local platform test](../tests/platform/dlq.test.ts), and [inspection procedure](operations.md#monitor-and-inspect-failures) |

## Build checks

| Command | Validates |
| --- | --- |
| `npm run lint` | Source lint and module import boundaries |
| `npm run typecheck` | Application types, portable core types, and configuration fixtures |
| `npm run types:check` | Generated Worker bindings match Wrangler configuration |
| `npm run build` | Worker bundling with a Wrangler deployment dry run |

## Tooling and browser example

| Behavior | Evidence |
| --- | --- |
| Browser and server starters for Slack, Discord, native email, and Resend use only their selected bindings and credentials | [CLI tests](../tests/tooling/cli.test.ts) |
| Existing starter files require explicit overwrite; local credentials survive regeneration | [CLI tests](../tests/tooling/cli.test.ts) |
| Doctor detects missing credentials and bindings, Queue mismatches, and native email allowlist mismatches without printing values | [CLI tests](../tests/tooling/cli.test.ts) |
| Preview separates guard fields, enforces schema and body limits, uses built-in renderers, and reports rendering failures | [CLI tests](../tests/tooling/cli.test.ts) |
| HTML previews escape content, sandbox email HTML, and refuse implicit overwrite | [CLI tests](../tests/tooling/cli.test.ts) |
| Browser submission uses URL-encoded fields, prevents concurrent sends, displays acceptance, and resets Turnstile | [Browser client tests](../tests/tooling/browser.test.ts) |
| Browser errors preserve fields; uncertain acceptance receives no automatic retry and manual retry uses a new token | [Browser client tests](../tests/tooling/browser.test.ts) |

Browser client tests exercise the submit event, status text, button state, and form fields with DOM boundary fixtures and mocked fetch. They do not run a live Turnstile challenge or provider delivery.

## Verification limits

Local checks do not establish production retention, plan entitlements, valid provider credentials, sender-domain setup, or downstream delivery. They create no live Worker, Queue, secret, sender domain, or notification.

Operational constraints remain:

- Changing a credential without updating the destination revision cannot be detected through symbolic secret references.
- HTTP and delivery retries can duplicate notifications; correlation IDs do not provide durable deduplication.
- Native email and Queue operations may be accepted after a timeout because the underlying calls cannot be canceled.
- Provider rendering can exceed downstream payload limits even when the core message is valid. Such failures are terminal and content is not silently truncated.

See [development limits](development.md#limits-and-rendering) and [deployment operations](operations.md). This matrix describes coverage; validation results for a change come from that change's check run and CI status.
