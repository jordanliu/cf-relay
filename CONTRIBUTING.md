# Contributing

Use Node.js 22.12+ and npm:

```sh
npm ci
npm run check
```

`check` runs lint, type checks, tests, binding verification, and a deployment dry run. Use `npm run format` for formatting and `npm run types:generate` after Wrangler changes.

## Module boundaries

| Module | Responsibility | Constraints |
| --- | --- | --- |
| Core | Configuration, validation, ingestion, dispatch | No platform, runtime, provider, policy, or transport imports |
| Providers | Rendering and upstream protocols | No runtime or application imports |
| Runtime adapters | HTTP, bindings, Queue settlement | No provider or transport imports |
| Worker application | Configuration and composition | Connects modules and bindings |

Preserve literal keys and schema inference in public builders. Keep type erasure at registry boundaries, use scoped secrets and bounded bodies, and follow the [extension contracts](docs/development.md). Never log raw errors, submissions, tokens, addresses, or credential URLs.

## Tests and changes

Test observable behavior with fake credentials and mocked provider calls. Tests must not deploy resources or send live notifications. Worker integration tests use a fixed fixture independent of the application configuration; local platform fixtures may use temporary storage.

- Providers: cover rendering, acceptance, payload limits, cancellation, and transient/terminal failures.
- Tooling and browser client: cover generated profiles, overwrite behavior, credential redaction, field preservation, and fresh Turnstile tokens on retry.
- Queues: preserve independent settlement, sanitized failure publication before acknowledgment, uncertain acceptance, and revision checks before credential resolution.

Include validation results and any wire-format or deployment migration in the pull request. See [test coverage](docs/acceptance.md) and [security requirements](SECURITY.md).
