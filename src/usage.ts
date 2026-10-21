import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contains, withinProject } from "./boundary.js";

const Count = z.number().finite().nonnegative();
export const UsageTokens = z.object({ input: Count, output: Count, reasoning: Count, cache: z.object({ read: Count, write: Count }) });
export type UsageTokens = z.infer<typeof UsageTokens>;
const Entry = z.object({ id: z.string(), providerID: z.string(), modelID: z.string(), tokens: UsageTokens.optional() });
type Entry = z.infer<typeof Entry>;
export interface ModelUsage extends UsageTokens { providerID: string; modelID: string; requests: number; unreported: number; total: number }
export interface UsageSummary { models: ModelUsage[]; total: number; requests: number; unreported: number; updatedAt?: string; error?: string }
const Page = z.object({ cursor: z.object({ next: z.string().nullish() }) });
const Sessions = Page.extend({ data: z.array(z.object({ id: z.string(), location: z.object({ directory: z.string() }), time: z.object({ updated: z.number() }) })) });
const Messages = Page.extend({ data: z.array(z.object({ id: z.string(), type: z.string(), status: z.string().optional(), model: z.object({ providerID: z.string(), id: z.string() }).optional(), tokens: UsageTokens.optional() })) });

/** A separate, append-only usage ledger. Native message snapshots replace by ID, never add twice. */
export class UsageTracker {
  private entries = new Map<string, Entry>();
  private modelSummary?: ModelUsage[];
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private revisions = new Map<string, number>();
  private syncing?: Promise<void>;
  private updatedAt?: string;
  private error?: string;
  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    await (this.loaded ??= (async () => {
      const file = await withinProject(this.directory, ".openagi/usage.jsonl");
      const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
      for (const line of content.split("\n").filter(Boolean)) {
        const entry = Entry.parse(JSON.parse(line));
        this.entries.set(entry.id, entry);
      }
      this.modelSummary = undefined;
    })().catch(error => { this.error = "storage"; throw error; }));
  }

  summary(): UsageSummary {
    const rows = this.modelSummary ??= this.aggregate();
    return { models: rows, total: rows.reduce((sum, row) => sum + row.total, 0), requests: rows.reduce((sum, row) => sum + row.requests, 0), unreported: rows.reduce((sum, row) => sum + row.unreported, 0), updatedAt: this.updatedAt, error: this.error };
  }

  private aggregate(): ModelUsage[] {
    const models = new Map<string, ModelUsage>();
    for (const entry of this.entries.values()) {
      const key = JSON.stringify([entry.providerID, entry.modelID]);
      const row = models.get(key) ?? { providerID: entry.providerID, modelID: entry.modelID, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0, requests: 0, unreported: 0 };
      row.requests++;
      if (!entry.tokens) row.unreported++;
      if (entry.tokens) {
        row.input += entry.tokens.input; row.output += entry.tokens.output; row.reasoning += entry.tokens.reasoning;
        row.cache.read += entry.tokens.cache.read; row.cache.write += entry.tokens.cache.write;
        row.total += entry.tokens.input + entry.tokens.output + entry.tokens.reasoning + entry.tokens.cache.read + entry.tokens.cache.write;
      }
      models.set(key, row);
    }
    return [...models.values()].sort((a, b) => b.total - a.total || a.modelID.localeCompare(b.modelID));
  }

  async recordJev(modelID: string, usage: { input_tokens: number; output_tokens: number }): Promise<void> {
    await this.record([{ id: `jev:${randomUUID()}`, providerID: "typesafe", modelID, tokens: { input: usage.input_tokens, output: usage.output_tokens, reasoning: 0, cache: { read: 0, write: 0 } } }]).catch(() => { this.error = "storage"; });
  }

  /** A background read of reported usage; it never admits a prompt or interrupts execution. */
  async sync(server: { url: string; password: string }, signal?: AbortSignal): Promise<void> {
    await (this.syncing ??= this.collect(server, signal).catch(() => {
      this.error = "sync";
    }).finally(() => { this.syncing = undefined; }));
  }

  private async collect(server: { url: string; password: string }, signal?: AbortSignal) {
    await this.load();
    const deadline = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const get = async (path: string) => {
      const response = await fetch(new URL(path, server.url), { signal: requestSignal, headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}` } });
      if (!response.ok) throw new Error("Usage read failed");
      return response.json();
    };
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor); else query.set("order", "desc");
      const sessions = Sessions.parse(await get(`/api/session?${query}`));
      for (const session of sessions.data) {
        if (!contains(resolve(this.directory), resolve(session.location.directory)) || this.revisions.get(session.id) === session.time.updated) continue;
        let messageCursor: string | undefined;
        do {
          const params = new URLSearchParams({ limit: "200" });
          if (messageCursor) params.set("cursor", messageCursor); else params.set("order", "desc");
          const messages = Messages.parse(await get(`/api/session/${encodeURIComponent(session.id)}/message?${params}`));
          await this.record(messages.data.filter(message => message.type === "assistant" || (message.type === "compaction" && message.status !== "running")).map(message => ({
            id: `native:${message.id}`, providerID: message.model?.providerID.replace(/^openagi-config-/, "") ?? "unknown", modelID: message.model?.id ?? "unknown", tokens: message.tokens,
          })));
          messageCursor = messages.cursor.next ?? undefined;
        } while (messageCursor);
        this.revisions.set(session.id, session.time.updated);
      }
      cursor = sessions.cursor.next ?? undefined;
    } while (cursor);
    this.updatedAt = new Date().toISOString(); this.error = undefined;
  }

  private async record(entries: Entry[]): Promise<void> {
    const operation = this.writes.then(async () => {
      await this.load();
      const changed = entries.map(entry => Entry.parse(entry)).filter(entry => JSON.stringify(this.entries.get(entry.id)) !== JSON.stringify(entry));
      if (!changed.length) return;
      const file = await withinProject(this.directory, ".openagi/usage.jsonl");
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, changed.map(entry => JSON.stringify(entry) + "\n").join(""), { mode: 0o600 });
      changed.forEach(entry => this.entries.set(entry.id, entry));
      this.modelSummary = undefined;
    });
    this.writes = operation.catch(() => { this.error = "storage"; });
    await operation;
  }
}
