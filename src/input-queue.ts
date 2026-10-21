import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { withinProject } from "./boundary.js";

const Input = z.object({ id: z.string().uuid(), text: z.string().min(1).max(16_000), at: z.string().datetime() });
const SavedQueue = z.object({ version: z.literal(1), entries: z.array(Input).max(32) });
export type ProjectInput = z.infer<typeof Input>;

/** Accepted feedback survives a paused worker without sharing its long-lived project state lock. */
export class ProjectInputQueue {
  readonly file: string;
  private readonly directory: string;
  private input: ProjectInput[] = [];
  private loaded = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    this.directory = resolve(directory);
    this.file = join(this.directory, ".openagi", "input-queue.json");
  }
  get count() { return this.input.length; }
  get entries(): readonly ProjectInput[] { return this.input.map(entry => ({ ...entry })); }
  peek(): ProjectInput | undefined { const entry = this.input[0]; return entry && { ...entry }; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
  async load(): Promise<void> {
    await this.serial(async () => {
      if (this.loaded) return;
      try { this.input = SavedQueue.parse(JSON.parse(await readFile(await withinProject(this.directory, this.file), "utf8"))).entries; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.loaded = true;
    });
  }
  private async save(entries: ProjectInput[]): Promise<void> {
    await withinProject(this.directory, this.file);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await withinProject(this.directory, temporary);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, entries }) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
      this.input = entries;
    } finally { await rm(temporary, { force: true }); }
  }
  async enqueue(text: string): Promise<ProjectInput> {
    if (!text.trim()) throw new Error("请输入消息。");
    if (text.length > 16_000) throw new Error("消息过长，请控制在 16000 个字符以内。");
    await this.load();
    return this.serial(async () => {
      if (this.input.length >= 32) throw new Error("待处理消息已满，请等待当前步骤完成后再提交。");
      const entry = { id: randomUUID(), text, at: new Date().toISOString() };
      await this.save([...this.input, entry]);
      return { ...entry };
    });
  }
  async complete(id: string): Promise<void> {
    await this.load();
    await this.serial(async () => {
      if (!this.input.some(entry => entry.id === id)) return;
      if (this.input[0]?.id !== id) throw new Error("消息必须按提交顺序处理。");
      await this.save(this.input.slice(1));
    });
  }
}
