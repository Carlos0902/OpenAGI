import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Isolation } from "./isolation.js";
import { withinProject } from "./boundary.js";

export type Workspace = {
  directory: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  headCommit?: string;
};

export type CheckSpec = { name: string; command: string; args: string[]; timeoutMs: number };
export type CheckResult = {
  name: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const projectPaths = ["--", ".", ":(exclude).openagi", ":(exclude).openagi/**", ":(exclude).DS_Store", ":(exclude)**/.DS_Store"];
const outputLimit = 64 * 1024;
const gitOutputLimit = 8 * 1024 * 1024;

/** Hooks and their children belong to the task too, so pausing must stop the whole tree. */
function terminateProcessTree(child: ChildProcess, killSignal: NodeJS.Signals = "SIGKILL"): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.on("error", () => child.kill("SIGKILL"));
    killer.on("close", (code) => { if (code !== 0) child.kill("SIGKILL"); });
  } else {
    try { process.kill(-child.pid, killSignal); }
    catch { child.kill(killSignal); }
  }
}

async function git(directory: string, args: string[], isolation?: Isolation, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (isolation) await withinProject(isolation.root, directory);
  signal?.throwIfAborted();
  const command = isolation?.command ?? "git";
  const arguments_ = isolation ? [...isolation.args, "git", "-C", directory, ...args] : ["-C", directory, ...args];
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, arguments_, {
      env: { ...(isolation?.environment ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    let failure: unknown;
    let failed = false;
    let termination: Promise<void> | undefined;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      failure = error;
      // Let Git release its own locks before forcing unresponsive hooks to exit.
      terminateProcessTree(child, "SIGTERM");
      termination = new Promise((finished) => setTimeout(() => {
        terminateProcessTree(child);
        finished();
      }, 250));
    };
    const retain = (stream: "stdout" | "stderr", data: Buffer) => {
      if (failed) return;
      if (lengths[stream] + data.length > gitOutputLimit) {
        fail(new Error(`Git ${stream} exceeded the 8 MiB output limit.`));
        return;
      }
      lengths[stream] += data.length;
      chunks[stream].push(data);
    };
    child.stdout.on("data", (data: Buffer) => retain("stdout", data));
    child.stderr.on("data", (data: Buffer) => retain("stderr", data));
    child.on("error", (error) => { if (!failed) { failed = true; failure = error; } });
    const abort = () => fail(signal?.reason ?? new DOMException("Git operation cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => fail(new Error("Git operation timed out after 60 seconds.")), 60_000);
    // Cancellation may arrive between the initial check and listener registration.
    if (signal?.aborted) abort();
    child.on("close", async (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failed) { await termination; reject(failure); return; }
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      if (code !== 0) {
        const stderr = Buffer.concat(chunks.stderr).toString("utf8").trim();
        reject(new Error(`Git command failed (${childSignal ?? `exit ${code}`}): ${stderr || stdout.trim()}`));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function currentBranch(directory: string, isolation?: Isolation, signal?: AbortSignal): Promise<string> {
  try {
    return (await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], isolation, signal)).trim();
  } catch {
    signal?.throwIfAborted();
    throw new Error("A named Git branch is required; detached HEAD cannot be used as the base or task branch.");
  }
}

async function commitHead(directory: string, isolation?: Isolation, signal?: AbortSignal): Promise<string> {
  try {
    return (await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"], isolation, signal)).trim();
  } catch {
    signal?.throwIfAborted();
    throw new Error("The project needs an initial Git commit before a task worktree can be used.");
  }
}

async function assertClean(directory: string, isolation?: Isolation, signal?: AbortSignal): Promise<void> {
  const status = await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none", ...projectPaths], isolation, signal);
  if (status) throw new DirtyProjectError(status);
}

export class DirtyProjectError extends Error {
  constructor(status: string) {
    const paths = status.split("\0").filter(Boolean).slice(0, 20).join("\n");
    super(`The project has uncommitted or untracked changes.\n项目当前有未保存到 Git 的改动：\n${paths}\n这些改动会保留；需保存为本地基线后才能创建或合并隔离工作区。`);
    this.name = "DirtyProjectError";
  }
}

/** Task branches are retained for inspection, including when acceptance fails. */
export class GitWorkspace {
  readonly repository: string;
  readonly workspaceRoot: string;

  constructor(repository: string, workspaceRoot?: string, private isolation?: Isolation, private signal?: AbortSignal) {
    this.repository = resolve(repository);
    this.workspaceRoot = resolve(this.repository, workspaceRoot ?? ".openagi/worktrees");
    if (this.workspaceRoot === this.repository ||
        (isWithin(this.repository, this.workspaceRoot) &&
         !isWithin(resolve(this.repository, ".openagi"), this.workspaceRoot) &&
         this.workspaceRoot !== resolve(this.repository, ".openagi"))) {
      throw new Error("Worktrees must be outside the project or inside its .openagi directory.");
    }
  }
  private git(directory: string, args: string[]): Promise<string> { return git(directory, args, this.isolation, this.signal); }

  private async initializeFreshProject(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.isolation) await withinProject(this.isolation.root, this.repository);
    const root = await realpath(this.repository);
    const localGit = join(root, ".git");
    const marker = join(localGit, "openagi-bootstrap.json");
    const entries = await readdir(this.repository);
    // A worktree's .git may be a file. Existing repositories, including unborn
    // ones, keep their own branch, index and initial-commit requirements.
    if (entries.includes(".git")) {
      let owned = false;
      try {
        const metadata = await lstat(localGit);
        const saved = await lstat(marker);
        if (metadata.isDirectory() && saved.isFile() && saved.size <= 4096) {
          const record = JSON.parse(await readFile(marker, "utf8")) as { version?: unknown; root?: unknown; id?: unknown };
          owned = record.version === 1 && record.root === root && typeof record.id === "string" && /^[a-f0-9-]{36}$/.test(record.id);
        }
      } catch { this.signal?.throwIfAborted(); }
      if (!owned) return;
      // A pause may happen after the baseline commit but before marker cleanup.
      // Use the completed repository normally without changing its history.
      let completed = false;
      try {
        const [head, objects, refs] = await Promise.all([lstat(join(localGit, "HEAD")), lstat(join(localGit, "objects")), lstat(join(localGit, "refs"))]);
        // Before init completes this marker directory is not a Git repository;
        // invoking rev-parse there could otherwise discover an ancestor.
        if (head.isFile() && objects.isDirectory() && refs.isDirectory()) { await commitHead(root, this.isolation, this.signal); completed = true; }
      }
      catch { this.signal?.throwIfAborted(); }
      if (completed) { await this.assertRepository(); await unlink(marker); return; }
    }
    if (entries.some(entry => entry !== ".openagi" && entry !== ".git")) {
      throw new Error("The nonempty project needs its own Git repository before an isolated task can start. Initialize and commit it in this project folder; OpenAGI will not use a parent directory's repository.");
    }
    this.signal?.throwIfAborted();
    if (!entries.includes(".git")) {
      // Exclusive creation prevents claiming a repository created concurrently.
      // Write ownership before the cancellable Git command so an interrupted
      // init can be recovered without touching a user's existing unborn repo.
      await mkdir(localGit);
      await writeFile(marker, JSON.stringify({ version: 1, root, id: randomUUID() }), { flag: "wx", mode: 0o600 });
    }
    let head = "";
    try { head = (await readFile(join(localGit, "HEAD"), "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (head && head !== "ref: refs/heads/main") throw new Error("The fresh project's branch changed during Git initialization. Restore or complete its Git setup before continuing.");
    // Initialize inside the selected folder before Git can discover a parent
    // repository. No source files or private runtime state enter the baseline.
    await this.git(this.repository, ["init", "--initial-branch=main", "--template=", "--", "."]);
    await this.assertRepository();
    const info = join(this.repository, ".git", "info");
    await mkdir(info, { recursive: true });
    const excludeFile = join(info, "exclude");
    let exclude = "";
    try { exclude = await readFile(excludeFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!exclude.split(/\r?\n/).includes("/.openagi/")) await writeFile(excludeFile, `${exclude}${exclude && !exclude.endsWith("\n") ? "\n" : ""}/.openagi/\n`, { mode: 0o600 });
    for (const [key, fallback] of [["user.name", "OpenAGI"], ["user.email", "openagi@localhost"]] as const) {
      let configured = "";
      try { configured = (await this.git(this.repository, ["config", "--get", key])).trim(); }
      catch { this.signal?.throwIfAborted(); }
      if (!configured) await this.git(this.repository, ["config", "--local", key, fallback]);
    }
    // This is a new local repository; signing must not depend on a GUI prompt
    // or unavailable global signing credentials during automated checkpoints.
    await this.git(this.repository, ["config", "--local", "commit.gpgsign", "false"]);
    if ((await this.git(this.repository, ["diff", "--cached", "--name-only"])).trim()) throw new Error("The fresh project's Git index changed during initialization. Preserve and resolve those staged files before continuing.");
    await this.git(this.repository, ["commit", "--allow-empty", "-m", "OpenAGI: initialize project"]);
    await unlink(marker);
  }

  private async assertRepository(): Promise<string> {
    this.signal?.throwIfAborted();
    const directory = await realpath(this.repository);
    const top = await realpath((await this.git(this.repository, ["rev-parse", "--show-toplevel"])).trim());
    if (directory !== top) throw new Error("The repository must be the project Git root.");
    return directory;
  }

  /** Explicit local baseline: preserves current source changes, excludes private runtime state. */
  async saveBaseline(): Promise<string> {
    await this.assertRepository();
    await currentBranch(this.repository, this.isolation, this.signal);
    await commitHead(this.repository, this.isolation, this.signal);
    const status = await this.git(this.repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...projectPaths]);
    if (status) {
      const tracked = await this.git(this.repository, ["diff", "HEAD", "--name-only", "--no-renames", "-z", ...projectPaths]);
      const untracked = await this.git(this.repository, ["ls-files", "--others", "--exclude-standard", "-z", ...projectPaths]);
      const paths = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))];
      if (!paths.length) throw new Error("当前改动需要手动处理，尚未保存基线。");
      await this.git(this.repository, ["--literal-pathspecs", "add", "-A", "--", ...paths]);
      await this.git(this.repository, ["--literal-pathspecs", "-c", "user.name=OpenAGI", "-c", "user.email=openagi@localhost", "commit", "--only", "--no-gpg-sign", "-m", "OpenAGI: preserve project baseline", "--", ...paths]);
    }
    await assertClean(this.repository, this.isolation, this.signal);
    return commitHead(this.repository, this.isolation, this.signal);
  }

  async create(taskId: string): Promise<Workspace> {
    await this.initializeFreshProject();
    await this.assertRepository();
    await assertClean(this.repository, this.isolation, this.signal);
    const baseBranch = await currentBranch(this.repository, this.isolation, this.signal);
    const baseCommit = await commitHead(this.repository, this.isolation, this.signal);
    const slug = taskId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
    const name = `${slug}-${randomUUID()}`;
    const branch = `openagi/${name}`;
    const directory = resolve(this.workspaceRoot, name);
    await mkdir(this.workspaceRoot, { recursive: true });
    await this.git(this.repository, ["worktree", "add", "-b", branch, "--", directory, baseCommit]);
    const workspace: Workspace = { directory, branch, baseBranch, baseCommit };
    await this.assertWorkspace(workspace);
    return workspace;
  }

  private async assertWorkspace(workspace: Workspace): Promise<void> {
    await this.assertRepository();
    if (!/^openagi\/[a-zA-Z0-9_-]+$/.test(workspace.branch) || !/^[a-f0-9]{40,64}$/.test(workspace.baseCommit)) {
      throw new Error("Invalid task workspace identity.");
    }
    const root = await realpath(this.workspaceRoot);
    const directory = await realpath(workspace.directory);
    if (!isWithin(root, directory)) throw new Error("Task workspace is outside the configured worktree root.");
    const worktrees = await this.git(this.repository, ["worktree", "list", "--porcelain", "-z"]);
    const registered = worktrees.split("\0\0").some((record) => {
      const fields = record.split("\0");
      return fields.includes(`worktree ${directory}`) && fields.includes(`branch refs/heads/${workspace.branch}`);
    });
    if (!registered) throw new Error("Task worktree registration or branch was modified.");
    const top = await realpath((await this.git(directory, ["rev-parse", "--show-toplevel"])).trim());
    const commonDirectory = await realpath((await this.git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    const repositoryCommonDirectory = await realpath((await this.git(this.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    if (top !== directory || commonDirectory !== repositoryCommonDirectory ||
        await currentBranch(directory, this.isolation, this.signal) !== workspace.branch) {
      throw new Error("Task worktree Git metadata or branch was modified.");
    }
    try {
      await this.git(directory, ["merge-base", "--is-ancestor", workspace.baseCommit, "HEAD"]);
    } catch {
      this.signal?.throwIfAborted();
      throw new Error("Task branch no longer descends from its recorded base commit.");
    }
    const stateStatus = await this.git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--", ".openagi"]);
    const stateDiff = await this.git(directory, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "HEAD", "--", ".openagi"]);
    if (stateStatus || stateDiff) throw new Error("Task worktree modified protected .openagi state.");
  }

  async head(workspace: Workspace): Promise<string> {
    await this.assertWorkspace(workspace);
    await assertClean(workspace.directory, this.isolation, this.signal);
    return commitHead(workspace.directory, this.isolation, this.signal);
  }

  async checkpoint(workspace: Workspace, taskTitle: string): Promise<string> {
    await this.assertWorkspace(workspace);
    const status = await this.git(workspace.directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none", ...projectPaths]);
    if (status) {
      await this.git(workspace.directory, ["add", "-A", ...projectPaths]);
      const title = taskTitle.replace(/[\r\n\0]+/g, " ").trim().slice(0, 160) || "task implementation";
      // Preserve repository hooks: a rejected commit remains in the task worktree.
      await this.git(workspace.directory, ["commit", "-m", `OpenAGI: ${title}`]);
    }
    await this.assertWorkspace(workspace);
    await assertClean(workspace.directory, this.isolation, this.signal);
    return commitHead(workspace.directory, this.isolation, this.signal);
  }

  async diff(workspace: Workspace): Promise<string> {
    await this.assertWorkspace(workspace);
    return this.git(workspace.directory, ["diff", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "HEAD", ...projectPaths]);
  }

  async merge(workspace: Workspace, validatedHead: string): Promise<void> {
    await this.assertWorkspace(workspace);
    await assertClean(workspace.directory, this.isolation, this.signal);
    const taskHead = await commitHead(workspace.directory, this.isolation, this.signal);
    if (taskHead !== validatedHead) throw new Error("Task head changed after validation. Validate the current commit before merging.");
    if (await currentBranch(this.repository, this.isolation, this.signal) !== workspace.baseBranch) {
      throw new Error("The source branch changed after task creation. Return to the recorded base branch before merging.");
    }
    await assertClean(this.repository, this.isolation, this.signal);
    const sourceHead = await commitHead(this.repository, this.isolation, this.signal);
    // A preceding fast-forward may have succeeded before state persistence was
    // interrupted; retrying that exact accepted commit is safe and idempotent.
    if (sourceHead === validatedHead) return;
    if (sourceHead !== workspace.baseCommit) {
      throw new Error("The base branch moved after task creation. Rebase and validate a new task before merging.");
    }
    // Merge the validated commit itself, never a branch name that can move.
    await this.git(this.repository, ["merge", "--ff-only", "--no-edit", validatedHead]);
    if (await currentBranch(this.repository, this.isolation, this.signal) !== workspace.baseBranch || await commitHead(this.repository, this.isolation, this.signal) !== validatedHead) {
      throw new Error("The source branch or HEAD changed during merge. Inspect repository hooks and the retained worktree before retrying.");
    }
    await assertClean(this.repository, this.isolation, this.signal);
  }

  /** Explicitly replay the task onto the current source; acceptance must run again. */
  async refreshBase(workspace: Workspace): Promise<Workspace> {
    await this.assertRepository();
    if (!isWithin(await realpath(this.workspaceRoot), await realpath(workspace.directory))) {
      throw new Error("Task workspace is outside the configured worktree root.");
    }
    for (const kind of ["rebase-merge", "rebase-apply"]) {
      const location = (await this.git(workspace.directory, ["rev-parse", "--path-format=absolute", "--git-path", kind])).trim();
      try {
        await access(location);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`Task rebase is still in progress. In ${workspace.directory}, resolve conflicts and run git rebase --continue, or run git rebase --abort before retrying.`);
    }
    await this.assertWorkspace(workspace);
    await assertClean(workspace.directory, this.isolation, this.signal);
    if (await currentBranch(this.repository, this.isolation, this.signal) !== workspace.baseBranch) {
      throw new Error("The source branch changed. Return to the recorded base branch before rebasing.");
    }
    await assertClean(this.repository, this.isolation, this.signal);
    const baseCommit = await commitHead(this.repository, this.isolation, this.signal);
    if (baseCommit !== workspace.baseCommit) {
      try {
        await this.git(workspace.directory, ["rebase", "--onto", baseCommit, workspace.baseCommit]);
      } catch (error) {
        this.signal?.throwIfAborted();
        throw new Error(`Task rebase failed; the source branch was preserved. In ${workspace.directory}, resolve conflicts and run git rebase --continue, or run git rebase --abort before retrying.\n${String(error)}`);
      }
    }
    const refreshed = { ...workspace, baseCommit, headCommit: await commitHead(workspace.directory, this.isolation, this.signal) };
    await this.assertWorkspace(refreshed);
    await assertClean(refreshed.directory, this.isolation, this.signal);
    return refreshed;
  }
}

/** Run the complete configured suite in order, retaining bounded diagnostic output. */
export async function runChecks(directory: string, checks: CheckSpec[], signal?: AbortSignal, isolation?: Isolation): Promise<CheckResult[]> {
  if (isolation) await withinProject(isolation.root, directory);
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (signal?.aborted) { results.push({ name: check.name, ok: false, exitCode: null, stdout: "", stderr: "Check cancelled", timedOut: false }); break; }
    results.push(await runCheck(directory, check, signal, isolation));
  }
  return results;
}

async function runCheck(directory: string, check: CheckSpec, signal?: AbortSignal, isolation?: Isolation): Promise<CheckResult> {
  if (typeof check.command !== "string" || !check.command.trim() || check.command.includes("\0") ||
      !Number.isFinite(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > 2_147_483_647 ||
      !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    return { name: check.name, ok: false, exitCode: null, stdout: "", stderr: "Invalid check command, arguments, or timeout.", timedOut: false };
  }
  return new Promise((resolveResult) => {
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    let spawnError = "";
    const environment = { ...(isolation?.environment ?? process.env) };
    // An embedding Node test harness otherwise makes nested `node --test` skip
    // its entire suite and return success without running configured tests.
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(isolation?.command ?? check.command, isolation ? [...isolation.args, check.command, ...check.args] : check.args, {
      cwd: directory,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    function retain(stream: "stdout" | "stderr", data: Buffer): void {
      const available = outputLimit - lengths[stream];
      if (data.length > available) truncated[stream] = true;
      if (available > 0) {
        const kept = data.subarray(0, available);
        chunks[stream].push(kept);
        lengths[stream] += kept.length;
      }
    }
    child.stdout.on("data", (data: Buffer) => retain("stdout", data));
    child.stderr.on("data", (data: Buffer) => retain("stderr", data));
    child.on("error", (error) => { spawnError = error.message; });
    const terminate = () => terminateProcessTree(child);
    const abort = () => { spawnError = "Check cancelled"; terminate(); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, check.timeoutMs);
    if (signal?.aborted) abort();
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const output = (stream: "stdout" | "stderr") => Buffer.concat(chunks[stream]).toString("utf8") +
        (truncated[stream] ? "\n[output truncated at 64 KiB]" : "");
      resolveResult({
        name: check.name,
        ok: !timedOut && !spawnError && exitCode === 0,
        exitCode: spawnError ? null : exitCode,
        stdout: output("stdout"),
        stderr: [output("stderr"), spawnError].filter(Boolean).join("\n"),
        timedOut,
      });
    });
  });
}
