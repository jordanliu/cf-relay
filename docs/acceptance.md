# Test coverage

Run the full suite with `npm run check`. Tests use fake credentials and mocked provider calls. Worker integration tests use fixed configuration; Miniflare tests use temporary local storage. No live infrastructure or notifications are created.

| Area | Coverage | Evidence |
| --- | --- | --- |
| Configuration | Typed registries and inferred data; strict schemas, revisions, protection requirements, frozen snapshots | [Type fixtures](../tests/types/config.ts), [configuration tests](../tests/contracts/config.test.ts) |
| Ingestion | JSON and URL-encoded parsing, malformed/oversized bodies, duplicate keys, cancellation, guards before schema, job limits, safe serialization, uncertain publication | [Ingress tests](../tests/contracts/ingress.test.ts) |
| Runtime | Scoped secrets, selected-provider dependencies, capability checks before publication | [Runtime tests](../tests/contracts/runtime.test.ts) |
| Providers | Rendering, mentions/markup, headers, payload limits, upstream acceptance, native and Resend transports, cancellation and failure classification | [Provider tests](../tests/contracts/providers.test.ts) |
| Policies | API keys, Turnstile hostname/action, honeypot, rate limits, log redaction | [Policy tests](../tests/contracts/policies.test.ts) |
| Dispatch | Job/version validation, revision checks before secrets, bounded retries, sanitized failure publication before acknowledgment, failure-sink retries | [Dispatch tests](../tests/contracts/dispatch.test.ts) |
| Workers runtime | CORS, methods, authentication, rejection without Queue writes, confirmed batch publication, independent message settlement | [Worker tests](../tests/integration/worker.test.ts) |
| Dead-letter Queue | Retry exhaustion preserves the original delivery envelope | [Platform test](../tests/platform/dlq.test.ts) |
| CLI | All starter profiles, overwrite protection, secret redaction, doctor diagnostics, fixture limits, rendering failures, escaped/sandboxed HTML | [CLI tests](../tests/tooling/cli.test.ts) |
| Browser client | URL-encoded submission, concurrent-send prevention, status feedback, preserved fields, fresh tokens and manual retries | [Browser tests](../tests/tooling/browser.test.ts) |

Browser tests use DOM boundary fixtures and mocked fetch; they do not run a live Turnstile challenge.

## Build checks

| Command | Validates |
| --- | --- |
| `npm run lint` | Lint and [module boundaries](../scripts/check-boundaries.mjs) |
| `npm run typecheck` | Application, portable core, and type fixtures |
| `npm test` | Contract, CLI, and browser tests |
| `npm run test:workers` | Local Workers runtime |
| `npm run test:dlq` | Local Queue retry exhaustion |
| `npm run types:check` | Application and test-fixture bindings match Wrangler |
| `npm run build` | Wrangler deployment dry run |

## Verification limits

Local tests cannot verify live credentials, sender DNS, plan entitlements, production retention, or downstream delivery. Secret references cannot detect credential rotation without a revision change. Retries provide no durable deduplication; native email and Queue writes may succeed after a timeout.

See [rendering limits](development.md#limits-and-rendering) and [operations](operations.md) for deployment checks and failure handling.
