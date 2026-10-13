import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = new URL(
  "../../examples/contact-form/client.js",
  import.meta.url,
);

async function browser(fetch: typeof globalThis.fetch) {
  const fields = {
    name: "Sender",
    email: "sender@example.com",
    message: "Keep these fields",
    website: "",
    "cf-turnstile-response": "token",
  };
  const button = { disabled: false };
  const status = { textContent: "" };
  const widget = {};
  const form = new EventTarget() as EventTarget & {
    action: string;
    querySelector: (selector: string) => unknown;
    reset: () => void;
  };
  form.action = "https://submit.example.com/v1/forms/contact";
  form.querySelector = () => button;
  form.reset = () => {
    for (const key of Object.keys(fields) as (keyof typeof fields)[])
      fields[key] = "";
  };
  const reset = vi.fn(() => {
    fields["cf-turnstile-response"] = "";
  });
  class FormData {
    get(name: keyof typeof fields) {
      return fields[name];
    }
    *[Symbol.iterator]() {
      yield* Object.entries(fields);
    }
  }
  const document = {
    querySelector: (selector: string) =>
      selector === "form"
        ? form
        : selector === "[role=status]"
          ? status
          : widget,
  };
  runInNewContext(await readFile(source, "utf8"), {
    document,
    FormData,
    URLSearchParams,
    fetch,
    AbortSignal,
    window: { turnstile: { reset } },
  });
  const submit = () =>
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { fields, button, status, reset, submit };
}

describe("browser contact form", () => {
  it("submits URL-encoded data once, shows acceptance, clears fields, and resets Turnstile", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((finish) => {
          resolve = finish;
        }),
    );
    const page = await browser(fetch);
    expect(page.submit()).toBe(false);
    page.submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.button.disabled).toBe(true);
    expect(page.status.textContent).toContain("Submitting");
    const [url, request] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://submit.example.com/v1/forms/contact");
    expect(request.method).toBe("POST");
    expect(request.body).toBeInstanceOf(URLSearchParams);
    expect((request.body as URLSearchParams).get("message")).toBe(
      "Keep these fields",
    );
    resolve(new Response(null, { status: 202 }));
    await vi.waitFor(() =>
      expect(page.status.textContent).toContain("submitted"),
    );
    expect(page.fields.message).toBe("");
    expect(page.button.disabled).toBe(false);
    expect(page.reset).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "verification"],
    [422, "fields"],
    [429, "wait"],
    [503, "duplicate"],
  ])("preserves input and explains HTTP %s", async (code, text) => {
    const page = await browser(
      vi.fn(async () => new Response(null, { status: code })),
    );
    page.submit();
    await vi.waitFor(() =>
      expect(page.status.textContent.toLowerCase()).toContain(text),
    );
    expect(page.fields.message).toBe("Keep these fields");
    expect(page.button.disabled).toBe(false);
    expect(page.reset).toHaveBeenCalledTimes(1);
  });

  it("does not send before verification and allows a manual retry with a new token after network failure", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const page = await browser(fetch);
    page.fields["cf-turnstile-response"] = "";
    page.submit();
    expect(fetch).not.toHaveBeenCalled();
    expect(page.status.textContent).toContain("verification");
    page.fields["cf-turnstile-response"] = "first-token";
    page.submit();
    await vi.waitFor(() =>
      expect(page.status.textContent).toContain("duplicate"),
    );
    expect(page.fields.message).toBe("Keep these fields");
    expect(fetch).toHaveBeenCalledTimes(1);
    page.fields["cf-turnstile-response"] = "new-token";
    page.submit();
    await vi.waitFor(() =>
      expect(page.status.textContent).toContain("submitted"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      (fetch.mock.calls[1]?.[1]?.body as URLSearchParams | undefined)?.get(
        "cf-turnstile-response",
      ),
    ).toBe("new-token");
  });
});
