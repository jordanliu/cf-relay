// Run deliberately from a server environment after configuring the endpoint and API key.
// Do not put this credential in browser bundles or print the request headers.
const endpoint = process.env.RELAY_ENDPOINT;
const key = process.env.RELAY_API_KEY;
if (!endpoint || !key) throw new Error("Set RELAY_ENDPOINT and RELAY_API_KEY");
const response = await fetch(new URL("/v1/forms/events", endpoint), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    event: "Example event",
    details: "A structured server submission",
  }),
  signal: AbortSignal.timeout(10000),
  redirect: "error",
});
if (response.status === 503)
  throw new Error(
    "Acceptance is unknown; retrying may duplicate notifications",
  );
if (response.status !== 202)
  throw new Error(`Relay rejected submission (${response.status})`);
console.log("Submission queued; downstream delivery is asynchronous");

export {};
