import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { State } from "./domain.js";
import { withinProject } from "./boundary.js";

/** A single CLI operation holds the lock through model execution and its state transitions. */
export class ProjectStore {
  readonly directory: string;
  readonly file: string;
  private locked = false;
  constructor(directory: string) {
    this.directory = resolve(directory);
    this.file = join(this.directory, ".openagi", "state.json");
  }
  async exists(): Promise<boolean> {
    try { await readFile(await withinProject(this.directory, this.file)); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  async read(): Promise<State> {
    const state = State.parse(JSON.parse(await readFile(await withinProject(this.directory, this.file), "utf8")));
    if (!(await this.matchesDirectory(state.project.directory))) throw new Error("Project state belongs to another directory");
    return state;
  }
  async write(state: State): Promise<void> {
    if (!this.locked) throw new Error("State writes require a project lock");
    const parsed = State.parse(state);
    await withinProject(this.directory, this.file);
    if (!(await this.matchesDirectory(parsed.project.directory))) throw new Error("Project state belongs to another directory");
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(parsed, null, 2) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }
  private async matchesDirectory(directory: string): Promise<boolean> {
    try { return await realpath(resolve(directory)) === await realpath(this.directory); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.locked) throw new Error("Nested project locks are not supported");
    await withinProject(this.directory, dirname(this.file));
    await mkdir(dirname(this.file), { recursive: true });
    const path = join(dirname(this.file), "lock.json");
    await withinProject(this.directory, path);
    const token = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); }
        finally { await file.close(); }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new Error("Another OpenAGI operation holds this project's lock");
        const lock = JSON.parse(await readFile(path, "utf8")) as { pid: number };
        if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error("Invalid project lock; inspect .openagi/lock.json");
        try { process.kill(lock.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { await rm(path); continue; }
          throw error;
        }
        throw new Error(`Another OpenAGI operation holds this project's lock (PID ${lock.pid})`);
      }
    }
    this.locked = true;
    try { return await operation(); }
    finally {
      this.locked = false;
      const current = JSON.parse(await readFile(path, "utf8")) as { token: string };
      if (current.token === token) await rm(path, { force: true });
    }
  }
}
