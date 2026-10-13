# Contributing

## Local setup

Use Node.js 22.12+ and npm. Install dependencies and run the project checks before proposing changes:

```sh
npm ci
npm run check
```

| Command | Purpose |
| --- | --- |
| `npm run check` | Run lint, type checks, tests, binding verification, and a deployment dry run |
| `npm run format` | Format source files |
| `npm run types:generate` | Regenerate Worker bindings after changes to Wrangler configuration |
| `npm run doctor -- --strict` | Check local configuration, required bindings, and secret names |
| `npm run preview -- --form contact --input examples/fixtures/contact.json` | Validate a fixture and inspect rendered notifications |

See the [development guide](docs/development.md) for provider and runtime extension contracts.

## Module boundaries

| Module | Responsibility | Import constraints |
| --- | --- | --- |
| Core | Configuration, validation, ingestion, and dispatch | No Cloudflare, Hono, provider, policy, or email transport imports |
| Providers | Message rendering and upstream protocol handling | No runtime adapter or application composition imports |
| Runtime adapters | HTTP parsing, capabilities, and Queue settlement | No provider or email transport imports |
| Worker application | Configuration and dependency composition | Connects the modules and platform bindings |

Keep type erasure at registry boundaries. Public builders must preserve literal keys and schema inference. Use strict schemas, scoped secrets, safe error codes, and bounded network bodies. Do not log raw errors, submissions, tokens, addresses, or endpoint credentials.

## Test requirements

Tests use fake credentials and mocked HTTP or email capabilities. Tests and CI must not send live notifications, deploy resources, or write to production infrastructure. Platform fixtures may use temporary local storage for assertions; the application requires no database.

Test observable behavior, including security checks and Queue settlement. Avoid assertions that only duplicate implementation details. The [acceptance matrix](docs/acceptance.md) maps requirements to existing tests.

## Change requirements

- Provider changes must cover mention and markup handling, upstream acceptance, transient and terminal failures, payload limits, and cancellation.
- Tooling changes must cover the CLI interface, overwrite behavior, credential redaction, and generated profiles. Browser example changes must preserve fields on errors and refresh Turnstile before retrying.
- Queue changes must preserve independent message settlement, sanitized failure publication before acknowledgment, uncertain publication handling, and destination revision checks before secret resolution.
- Describe any Queue wire-format or operational migration in the pull request. Include validation results and required deployment steps.
