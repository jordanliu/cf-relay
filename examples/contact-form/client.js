const form = document.querySelector("form");
const button = form?.querySelector('button[type="submit"]');
const status = document.querySelector("[role=status]");
const widget = document.querySelector(".cf-turnstile");
let submitting = false;

async function submit(event) {
  event.preventDefault();
  if (submitting || !form || !button || !status) return;
  const fields = new FormData(form);
  if (!fields.get("cf-turnstile-response")) {
    status.textContent = "Complete the verification before submitting.";
    return;
  }
  submitting = true;
  button.disabled = true;
  status.textContent = "Submitting...";
  try {
    const body = new URLSearchParams();
    for (const [name, value] of fields)
      if (typeof value === "string") body.append(name, value);
    const response = await fetch(form.action, {
      method: "POST",
      body,
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 202) {
      status.textContent = "Your message has been submitted.";
      form.reset();
    } else if (response.status === 403) {
      status.textContent =
        "Verification was rejected. Complete the new verification and try again. If this continues, contact the site owner.";
    } else if (response.status === 422) {
      status.textContent =
        "Check the required fields and message length, then try again.";
    } else if (response.status === 429) {
      status.textContent =
        "Too many submissions. Please wait before trying again.";
    } else if (response.status >= 500) {
      status.textContent =
        "We could not confirm submission. Retrying may send a duplicate.";
    } else {
      status.textContent =
        "Your message was not accepted. Check the fields or contact the site owner.";
    }
  } catch {
    status.textContent =
      "We could not confirm submission. Check your connection. Retrying may send a duplicate.";
  } finally {
    submitting = false;
    button.disabled = false;
    if (widget && window.turnstile) window.turnstile.reset(widget);
  }
}

form?.addEventListener("submit", (event) => {
  void submit(event);
});
