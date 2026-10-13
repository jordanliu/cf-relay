import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/tooling/cli";
import { type Project, readProject } from "../../scripts/tooling/project";
import { remoteDoctor, sendTest } from "../../scripts/tooling/remote";

const root = fileURLToPath(new URL("../../", import.meta.url));
let directory: string;
let project: Project;
beforeEach(async () => {
  await mkdir(join(root, ".scratch"), { recursive: true });
  directory = await mkdtemp(join(root, ".scratch/remote-"));
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("RELAY_API_KEY", undefined);
  expect(
    await main(["init", "--mode", "server", "--providers", "slack"], directory),
  ).toBe(0);
  project = await readProject(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function report(ready = true) {
  return {
    ready,
    forms: [
      {
        id: "events",
        ready,
        destinations: [{ id: "slack", provider: "slack", revision: "v1" }],
        diagnostics: ready
          ? []
          : [
              {
                code: "SECRET_MISSING",
                name: "SLACK_WEBHOOK_V1",
                destinationId: "slack",
              },
            ],
      },
    ],
  };
}
function client(responses: Response[]) {
  return {
    fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }),
  };
}

describe("remote doctor and deliberate test submissions", () => {
  it("previews without any network request or credential access unless --live is supplied", async () => {
    const http = client([]);
    const preview = await sendTest(
      project,
      { endpoint: "https://relay.example" },
      http,
    );
    expect(preview.mode).toBe("preview");
    expect(http.fetch).not.toHaveBeenCalled();
    expect(
      await main(["send", "--endpoint", "https://relay.example"], directory, {
        http,
      }),
    ).toBe(0);
    expect(http.fetch).not.toHaveBeenCalled();
  });
  it("uses local credentials, lets RELAY_API_KEY override them, and reports selected form diagnostics", async () => {
    await writeFile(project.secretsPath, "SERVER_API_KEY=private-local\n");
    const local = client([Response.json(report())]);
    expect(
      (await remoteDoctor(project, "https://relay.example", "events", local))
        .ready,
    ).toBe(true);
    expect(
      new Headers(local.fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer private-local");
    vi.stubEnv("RELAY_API_KEY", "private-env");
    const remote = client([Response.json(report(false), { status: 503 })]);
    const checked = await remoteDoctor(
      project,
      "https://relay.example",
      undefined,
      remote,
    );
    expect(checked.ready).toBe(false);
    expect(checked.forms[0]?.diagnostics[0]?.name).toBe("SLACK_WEBHOOK_V1");
    expect(
      new Headers(remote.fetch.mock.calls[0]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer private-env");
    expect(JSON.stringify(checked)).not.toContain("private-");
  });
  it("rejects mismatched destinations before sending to the deployed configuration", async () => {
    vi.stubEnv("RELAY_API_KEY", "private-env");
    const changed = report();
    const destination = changed.forms[0]?.destinations[0];
    if (!destination) throw new Error("Missing test destination");
    destination.revision = "v2";
    const http = client([Response.json(changed)]);
    await expect(
      sendTest(
        project,
        { live: true, endpoint: "https://relay.example" },
        http,
      ),
    ).rejects.toThrow(/differ/);
    expect(http.fetch).toHaveBeenCalledOnce();
  });
  it("checks readiness and submits exactly once, reporting queued rather than delivered", async () => {
    vi.stubEnv("RELAY_API_KEY", "private-env");
    const http = client([
      Response.json(report()),
      Response.json(
        { id: "sub_test", status: "queued", destinations: 1 },
        { status: 202 },
      ),
    ]);
    const result = await sendTest(
      project,
      { live: true, endpoint: "https://relay.example" },
      http,
    );
    expect(result).toMatchObject({
      mode: "live",
      id: "sub_test",
      status: "queued",
    });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(JSON.stringify(result)).not.toContain("private-env");
    expect(JSON.stringify(result)).not.toContain("delivered");
  });
  it("refuses a live submission while selected destinations are not ready", async () => {
    vi.stubEnv("RELAY_API_KEY", "private-env");
    const http = client([Response.json(report(false), { status: 503 })]);
    await expect(
      sendTest(
        project,
        { live: true, endpoint: "https://relay.example" },
        http,
      ),
    ).rejects.toThrow(/SLACK_WEBHOOK_V1/);
    expect(http.fetch).toHaveBeenCalledOnce();
  });
  it("never automatically retries uncertain Queue acceptance or prints upstream response text", async () => {
    vi.stubEnv("RELAY_API_KEY", "private-env");
    const http = client([
      Response.json(report()),
      new Response("private-upstream", { status: 503 }),
    ]);
    expect(
      await main(
        ["send", "--live", "--endpoint", "https://relay.example"],
        directory,
        { http },
      ),
    ).toBe(1);
    expect(http.fetch).toHaveBeenCalledTimes(2);
    const output = JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(output).toContain("unconfirmed");
    expect(output).not.toMatch(/private-env|private-upstream/);
  });
  it("rejects missing keys, untrusted HTTP endpoints, and malformed readiness without exposing response content", async () => {
    const http = client([]);
    await expect(
      remoteDoctor(project, "https://relay.example", undefined, http),
    ).rejects.toThrow(/RELAY_API_KEY/);
    expect(http.fetch).not.toHaveBeenCalled();
    vi.stubEnv("RELAY_API_KEY", "private-env");
    await expect(
      remoteDoctor(project, "http://relay.example", undefined, http),
    ).rejects.toThrow(/HTTPS/);
    const invalid = client([new Response("private-invalid-response")]);
    await expect(
      remoteDoctor(project, "https://relay.example", undefined, invalid),
    ).rejects.toThrow(/invalid/);
    const unauthorized = client([
      new Response("private-auth-response", { status: 401 }),
    ]);
    await expect(
      remoteDoctor(project, "https://relay.example", undefined, unauthorized),
    ).rejects.toThrow(/authentication/);
  });
});
