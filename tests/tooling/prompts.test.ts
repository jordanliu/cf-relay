import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalPrompts } from "../../scripts/tooling/prompts";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
}
function terminal(initialRaw = false) {
  const input = new Input();
  input.isRaw = initialRaw;
  let output = "";
  const writer = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  const prompts = new TerminalPrompts(input, writer);
  return { input, prompts, output: () => output };
}
describe("credential prompts", () => {
  it("does not echo credentials or retain them in input history", async () => {
    const t = terminal();
    const answer = t.prompts.secret("WEBHOOK_TOKEN");
    t.input.write("private-pasted-secret\r");
    expect(await answer).toBe("private-pasted-secret");
    const next = t.prompts.ask("Provider", "slack");
    t.input.write("\u001b[A\r");
    expect(await next).toBe("slack");
    expect(t.output()).not.toContain("private-pasted-secret");
    t.prompts.close();
    expect(t.input.isRaw).toBe(false);
  });
  it("cancels cleanly and restores the previous terminal mode", async () => {
    const t = terminal(true);
    const answer = t.prompts.secret("TOKEN");
    const assertion = expect(answer).rejects.toThrow(/canceled/);
    t.input.write("private-partial\u0003");
    await assertion;
    t.prompts.close();
    expect(t.input.isRaw).toBe(true);
    expect(t.output()).not.toContain("private-partial");
  });
});
