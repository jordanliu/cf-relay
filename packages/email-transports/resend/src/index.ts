import {
  boundedResponseText,
  classifyHttp,
  type EmailTransport,
  postJson,
} from "@cf-relay/core";
export function resendEmailTransport(apiKey: string): EmailTransport {
  if (!apiKey) throw new Error("Resend credential unavailable");
  return {
    async send(email, context) {
      const { replyTo, ...data } = email;
      const response = await postJson(
        context.http,
        "https://api.resend.com/emails",
        { ...data, ...(replyTo ? { reply_to: replyTo } : {}) },
        context.signal,
        { authorization: `Bearer ${apiKey}` },
      );
      const outcome = classifyHttp(response);
      if (outcome) {
        await response.body?.cancel();
        return outcome;
      }
      try {
        const result: unknown = JSON.parse(await boundedResponseText(response));
        return result &&
          typeof result === "object" &&
          "id" in result &&
          typeof result.id === "string" &&
          result.id.length > 0 &&
          result.id.length <= 256
          ? { status: "accepted", externalId: result.id }
          : { status: "retry", code: "UNKNOWN" };
      } catch {
        return { status: "retry", code: "UNKNOWN" };
      }
    },
  };
}
