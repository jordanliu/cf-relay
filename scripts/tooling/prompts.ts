import { createInterface, type Interface } from "node:readline/promises";
import { type Readable, Writable } from "node:stream";
import { ToolError } from "./errors";

export interface Prompts {
  ask(label: string, fallback?: string): Promise<string>;
  secret(name: string): Promise<string>;
  close(): void;
}

export class TerminalPrompts implements Prompts {
  private muted = false;
  private readonly readline: Interface;
  private readonly abort = new AbortController();
  private readonly restoreRaw: (() => void) | undefined;
  constructor(
    input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {
    if (
      "setRawMode" in input &&
      typeof input.setRawMode === "function" &&
      "isRaw" in input &&
      typeof input.isRaw === "boolean"
    ) {
      const raw = input.isRaw;
      const setRawMode = input.setRawMode.bind(input);
      this.restoreRaw = () => {
        setRawMode(raw);
      };
    }
    const masked = new Writable({
      write: (chunk, _encoding, done) => {
        if (!this.muted) this.output.write(chunk);
        done();
      },
    });
    this.readline = createInterface({
      input,
      output: masked,
      terminal: true,
      historySize: 0,
    });
    this.readline.on("SIGINT", () => this.abort.abort());
    this.readline.on("close", () => this.abort.abort());
  }
  async ask(label: string, fallback?: string) {
    try {
      const value = (
        await this.readline.question(
          `${label}${fallback ? ` [${fallback}]` : ""}: `,
          { signal: this.abort.signal },
        )
      ).trim();
      return value || fallback || "";
    } catch {
      throw new ToolError("Setup canceled. No credentials were displayed.");
    }
  }
  async secret(name: string) {
    this.output.write(`${name} (hidden): `);
    this.muted = true;
    try {
      const value = (
        await this.readline.question("", { signal: this.abort.signal })
      ).trim();
      if (!value || /[\r\n\0]/.test(value))
        throw new ToolError(`Supply a nonempty, single-line ${name}.`);
      return value;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("Setup canceled. No credentials were displayed.");
    } finally {
      this.muted = false;
      this.output.write("\n");
    }
  }
  close() {
    this.readline.close();
    this.restoreRaw?.();
  }
}
