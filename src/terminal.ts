import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { PromptChoice } from "./web-types.js";
import type { WorkflowStage } from "./runtime.js";

export interface ConversationIO {
  write(message: string): void;
  error?(message: string): void;
  activity?(stage: WorkflowStage): void;
  /** Consume feedback entered during a running step, before beginning the next one. */
  takeInput?(): string | undefined;
  /** Durable admission identity and acknowledgement; memory/CLI conversations omit both. */
  readonly inputID?: string;
  completeInput?(): Promise<void>;
  ask(prompt: string, choices?: PromptChoice[]): Promise<string | null>;
  secret?(prompt: string): Promise<string | null>;
}

/** Buffer lines entered during model execution; EOF and Ctrl-C end the session cleanly. */
export function terminalIO(signal: AbortSignal, interrupt: () => void): ConversationIO & { close(): void } {
  let muted = false;
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  } }), { isTTY: process.stdout.isTTY, columns: process.stdout.columns });
  const readline = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY && !!process.stdout.isTTY });
  const lines: string[] = [];
  let ended = false;
  let waiting: ((line: string | null) => void) | undefined;
  readline.on("line", line => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); }
    else lines.push(line);
  });
  readline.on("close", () => { ended = true; waiting?.(null); waiting = undefined; });
  readline.on("SIGINT", interrupt);
  const abort = () => readline.close();
  signal.addEventListener("abort", abort, { once: true });
  async function ask(prompt: string): Promise<string | null> {
    if (signal.aborted) return null;
    process.stdout.write(prompt);
    if (lines.length) return lines.shift()!;
    if (ended) return null;
    return new Promise(resolve => { waiting = resolve; });
  }
  return {
    write: message => process.stdout.write(message + "\n"),
    ask,
    async secret(prompt) {
      muted = true;
      try { return await ask(prompt); }
      finally { muted = false; process.stdout.write("\n"); }
    },
    close() { signal.removeEventListener("abort", abort); readline.close(); output.end(); },
  };
}
