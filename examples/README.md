# Examples

cf-relay deploys an API. These clients and configuration examples are optional; frontend assets are hosted with your own site.

| Example | Purpose |
| --- | --- |
| [Server client](server-to-server/client.ts) | Send authenticated JSON events from a trusted server |
| [Browser client](contact-form/index.html) | Submit URL-encoded fields with Turnstile and status feedback |
| [Multi-destination configuration](multi-destination/relay.config.ts) | Route protected browser and server submissions to Slack, Discord, and email |
| [Webhook receiver](webhook-receiver/index.ts) | Verify HMAC signatures and deduplicate through a durable store |
| [Custom provider](custom-provider/index.ts) | Implement and register another delivery provider |
| [Fixtures](fixtures/) | Preview notification content without sending |

## Server client

The default Worker accepts `event` and `details` at `POST /v1/forms/events`. Set `RELAY_ENDPOINT` and `RELAY_API_KEY` in your server environment, then run:

```sh
node --experimental-strip-types examples/server-to-server/client.ts
```

The client sends one event and treats `503` as uncertain acceptance. Keep its API key in your server environment.

## Browser client

Generate API configuration for browser submissions, using your page's exact origin:

```sh
npm run init -- --mode browser --provider slack --origin https://www.your-domain.com --force
npm run setup
```

Deploy using the [operations guide](../docs/operations.md). Serve [index.html](contact-form/index.html) and [client.js](contact-form/client.js) together from your site. Set the form endpoint and public Turnstile site key, with action `contact`. The client preserves fields on errors and refreshes tokens before a manual retry.

You can use any frontend that submits the configured fields and guard token to the API.

## Configuration examples

The multi-destination example is a configuration reference. Adapt it to your Worker and supply its matching secrets, guard bindings, and email dependency factory. See [provider composition](../docs/development.md#add-a-provider) and [email transports](../docs/development.md#swap-email-transports).

Fixtures contain business fields only. Use `npm run preview` with a matching API configuration; see [preview options](../docs/development.md#preview-notifications).
