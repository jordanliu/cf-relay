# v1.1 acceptance matrix

Tests run offline with Vitest, strict TypeScript fixtures, the current Cloudflare Vitest plugin, and local Miniflare. Unit suites never send live provider notifications. Workers tests mock outbound fetch; the DLQ fixture denies provider HTTP and uses temporary local KV solely to capture the original exhausted envelope for assertions. Production still requires no application database.

| Requirement | Evidence |
| --- | --- |
| Typed Slack/Discord/email config; unknown provider | `tests/types/config.ts`; `contracts/config.test.ts` |
| Non-empty revisions; cross-provider extra fields | Type fixtures plus runtime strict schema validation |
| Unknown form destination; schema-inferred transformer fields | Type fixtures; runtime registry tests |
| Duplicate provider types / destination IDs | Config tests; programmatic entries preserve duplicate detection |
| Effective protection; explicit unsafe opt-out | Config tests: API key or rate-limit + Turnstile, honeypot alone rejected |
| Parse-once JSON and URL encoding; security separation | `contracts/ingress.test.ts` with strict business schema and minimal serialized jobs |
| Multipart, raw limit, malformed encoding/UTF-8/duplicate keys | Ingress tests and Worker HTTP tests; zero publication |
| Encoded message/job/batch preflight | Ingress tests for Unicode byte overflow and overlarge batches |
| Required secret/binding unavailable | Dispatch/policy tests and Worker HTTP fail-closed checks |
| Stable config; scoped secret resolution | `contracts/dispatch.test.ts` |
| Removed/rotated provider or revision | Revision tests assert no secret read or provider invocation |
| Secret changed without revision | Invalid operational change documented in `operations.md`; symbolic references cannot detect it |
| Provider accepted | Slack `200 ok`, Discord `wait=true` returned ID, email returned ID; Queue ack tests |
| 429 / 5xx / timeout / unexpected throw | Provider and dispatch tests; bounded per-message retry |
| Terminal failure; healthy sink | Invocation order asserts record before ack; Workers test uses real Queue producer |
| Broken/hung sink | Explicit retry tests and bounded failure publisher; no auto-ack by successful handler return |
| Exhausted retries | `tests/platform/dlq.test.ts`: actual local Queue mechanism preserves original `delivery` envelope |
| Heterogeneous failure Queue / invalid originals | Strict known-envelope schema; sanitized invalid-job handling; runbook requires safe handling of unknown envelopes |
| Mixed batch | Contract and Workers settlement tests: successful ack, retry only failed/retryable messages |
| `sendBatch()` timeout/rejection | Unit timeout test: one call, safe 503, `ACCEPTANCE_UNKNOWN`, no zero-effect claim |
| Confirmed publication | Workers test spies on one real Queue `sendBatch` before 202 |
| HTTP retries / downstream duplicate risk | At-least-once and no durable HTTP idempotency documented; stable IDs do not deduplicate new requests |
| No raw data / secret refs / tokens queued | Serialization assertions in ingress tests |
| Email transport swapped | Same input/config tested against fake native binding and Resend HTTP transport |
| New provider independent of runtime | `examples/custom-provider`; architecture import check; core compiles without platform types |
| Slack/Discord mentions; email HTML/header injection | `contracts/providers.test.ts` |
| No raw logs / upstream exception details | `contracts/policies.test.ts`; broken-sink logs inspected in dispatch tests |
| CORS / methods / health / auth | Local Workers integration tests |
| Build and binding declarations | `wrangler types --check`, strict `tsc`, and `wrangler deploy --dry-run` |

## Verification limits

Local simulation validates application behavior and a local retry-exhaustion path, not production Cloudflare retention, paid-plan entitlements, provider credentials, sender DNS onboarding, or actual inbox delivery. No live Worker, Queue, secret, sender domain, or provider notification is created by the checks. Native email cancellation is unavailable; a deadline race may still be followed by acceptance. Discord cannot represent every core-valid message after safe escaping; over-limit payloads fail terminally without truncation. Field keys have an additional bounded length. These limits are documented in the development and operator guides.

The final repository commit and its CI run are the release evidence; this file describes what each check exercises rather than claiming checks that have not run.
