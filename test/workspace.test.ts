import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { GitWorkspace, runChecks, type Workspace } from "../src/workspace.js";
import { prepareIsolation, type Isolation } from "../src/isolation.js";

const exec = promisify(execFile);

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch { /* The hook/check has not started yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process did not start: ${file}`);
}

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", directory, ...args])).stdout.trim();
}

async function repository(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openagi-workspace-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "OpenAGI Test");
  await git(directory, "config", "user.email", "openagi-test@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(join(directory, "feature.txt"), "before\n");
  await writeFile(join(directory, ".gitignore"), ".openagi/\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

async function changedTask(directory: string): Promise<{ manager: GitWorkspace; workspace: Workspace; head: string }> {
  const manager = new GitWorkspace(directory);
  const workspace = await manager.create("feature/task");
  await writeFile(join(workspace.directory, "feature.txt"), "after\n");
  const head = await manager.checkpoint(workspace, "Implement feature");
  return { manager, workspace, head };
}

test("isolates changes, checkpoints and fast-forwards the validated commit", async (t) => {
  const directory = await repository(t);
  await mkdir(join(directory, ".openagi"));
  await writeFile(join(directory, ".openagi", "state.json"), "source state");
  const { manager, workspace, head } = await changedTask(directory);
  assert.equal(await readFile(join(directory, "feature.txt"), "utf8"), "before\n");
  assert.match(await manager.diff(workspace), /\+after/);
  assert.equal(await manager.head(workspace), head);
  assert.equal(await manager.checkpoint(workspace, "No new changes"), head);
  const checks = await runChecks(workspace.directory, [{
    name: "acceptance", command: process.execPath,
    args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('feature.txt', 'utf8'), 'after\\n')"],
    timeoutMs: 5_000,
  }]);
  assert.equal(checks[0]?.ok, true);
  await manager.merge(workspace, head);
  assert.equal(await git(directory, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(directory, "feature.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(directory, ".openagi", "state.json"), "utf8"), "source state");
  await access(workspace.directory);
});

test("a fresh nested project initializes its own empty baseline and completes an isolated merge", { skip: process.platform === "win32" }, async (t) => {
  const parent = await repository(t);
  const parentHead = await git(parent, "rev-parse", "HEAD");
  const parentConfig = await readFile(join(parent, ".git", "config"), "utf8");
  const directory = join(parent, "new-project");
  await mkdir(join(directory, ".openagi"), { recursive: true });
  await writeFile(join(directory, ".openagi", "state.json"), "private project state\n");
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete environment[key];
  const isolation: Isolation = { root: directory, runtime: join(directory, ".openagi", "runtime"), profile: "", command: "/usr/bin/env", args: [], environment };
  const manager = new GitWorkspace(directory, undefined, isolation);
  const workspace = await manager.create("first-feature");
  assert.equal(await git(directory, "rev-parse", "--show-toplevel"), await realpath(directory));
  assert.equal(workspace.baseBranch, "main");
  assert.equal(await git(directory, "ls-tree", "-r", "--name-only", workspace.baseCommit), "");
  assert.equal(await git(directory, "config", "--local", "user.name"), "OpenAGI");
  assert.equal(await git(directory, "config", "--local", "user.email"), "openagi@localhost");
  assert.equal(await git(directory, "status", "--porcelain"), "");
  await writeFile(join(workspace.directory, "game.js"), "export const score = 0;\n");
  const head = await manager.checkpoint(workspace, "Create game");
  await manager.merge(workspace, head);
  assert.equal(await readFile(join(directory, "game.js"), "utf8"), "export const score = 0;\n");
  assert.equal(await git(directory, "ls-files"), "game.js");
  assert.equal(await readFile(join(directory, ".openagi", "state.json"), "utf8"), "private project state\n");
  assert.equal(await git(parent, "rev-parse", "HEAD"), parentHead);
  assert.equal(await readFile(join(parent, ".git", "config"), "utf8"), parentConfig);
  assert.equal(await git(parent, "diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(join(parent, "feature.txt"), "utf8"), "before\n");
  await access(workspace.directory);
});

test("fresh project creation and merge work when the macOS sandbox prevents parent Git discovery", { skip: process.platform !== "darwin" }, async (t) => {
  const parent = await repository(t);
  const parentHead = await git(parent, "rev-parse", "HEAD");
  const directory = join(parent, "sandbox-project");
  await mkdir(directory);
  const isolation = await prepareIsolation(directory, join(directory, ".openagi", "config.json"));
  await assert.rejects(exec(isolation.command, [...isolation.args, "git", "-C", directory, "rev-parse", "--show-toplevel"], { env: isolation.environment }), /not a git repository/);
  const manager = new GitWorkspace(directory, undefined, isolation);
  const workspace = await manager.create("sandbox-feature");
  await writeFile(join(workspace.directory, "index.html"), "<!doctype html><title>Snake</title>\n");
  const head = await manager.checkpoint(workspace, "Create entry point");
  await manager.merge(workspace, head);
  assert.equal(await readFile(join(directory, "index.html"), "utf8"), "<!doctype html><title>Snake</title>\n");
  assert.equal(await git(directory, "ls-files"), "index.html");
  assert.equal(await git(parent, "rev-parse", "HEAD"), parentHead);
});

test("nonempty folders never initialize or borrow their parent's repository", async (t) => {
  const parent = await repository(t);
  const parentHead = await git(parent, "rev-parse", "HEAD");
  const directory = join(parent, "existing-project");
  await mkdir(directory);
  await writeFile(join(directory, "user.txt"), "existing user work\n");
  await assert.rejects(new GitWorkspace(directory).create("must-not-initialize"), /nonempty project needs its own Git repository/);
  await assert.rejects(access(join(directory, ".git")));
  assert.equal(await readFile(join(directory, "user.txt"), "utf8"), "existing user work\n");
  assert.equal(await git(parent, "rev-parse", "HEAD"), parentHead);
});

test("an already paused fresh project never initializes Git", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-fresh-paused-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort(new Error("already paused"));
  await assert.rejects(new GitWorkspace(directory, undefined, undefined, controller.signal).create("must-not-start"), /already paused/);
  await assert.rejects(access(join(directory, ".git")));
});

test("pausing after Git init preserves an owned bootstrap that explicit resume completes", { skip: process.platform === "win32" }, async (t) => {
  const parent = await repository(t);
  const parentHead = await git(parent, "rev-parse", "HEAD");
  const directory = join(parent, "interrupted-project");
  await mkdir(join(directory, ".openagi"), { recursive: true });
  await writeFile(join(directory, ".openagi", "state.json"), "retained project state\n");
  const ready = join(directory, ".openagi", "init-ready");
  const wrapper = join(directory, ".openagi", "pause-after-init.cjs");
  await writeFile(wrapper, `const {spawnSync} = require('node:child_process');
const result = spawnSync(process.argv[2], process.argv.slice(3), {stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.argv[5] === 'init') {
  require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'initialized');
  setInterval(() => {}, 1000);
} else process.exit(0);
`);
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const isolation: Isolation = { root: directory, runtime: join(directory, ".openagi", "runtime"), profile: "", command: process.execPath, args: [wrapper], environment };
  const controller = new AbortController();
  const operation = new GitWorkspace(directory, undefined, isolation, controller.signal).create("paused-initialization");
  const rejected = assert.rejects(operation, /pause initialization/);
  await waitForFile(ready);
  assert.equal(await git(directory, "symbolic-ref", "--short", "HEAD"), "main");
  controller.abort(new Error("pause initialization"));
  await rejected;
  await assert.rejects(git(directory, "rev-parse", "--verify", "HEAD"));
  assert.equal(await git(parent, "rev-parse", "HEAD"), parentHead);
  const resumed = new GitWorkspace(directory);
  const workspace = await resumed.create("resume-initialization");
  assert.equal(await git(directory, "ls-tree", "-r", "--name-only", workspace.baseCommit), "");
  await writeFile(join(workspace.directory, "game.js"), "export const ready = true;\n");
  const head = await resumed.checkpoint(workspace, "Deliver game after pause");
  await resumed.merge(workspace, head);
  assert.equal(await readFile(join(directory, "game.js"), "utf8"), "export const ready = true;\n");
  assert.equal(await readFile(join(directory, ".openagi", "state.json"), "utf8"), "retained project state\n");
  assert.equal(await git(parent, "rev-parse", "HEAD"), parentHead);
  await assert.rejects(access(join(directory, ".git", "openagi-bootstrap.json")));
});

test("merging the same validated commit is idempotent after a lost state write", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await manager.merge(workspace, head);
  await manager.merge(workspace, head);
  assert.equal(await git(directory, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(directory, "feature.txt"), "utf8"), "after\n");
});

test("merge surfaces dirty source mutations made by repository hooks", { skip: process.platform === "win32" }, async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  const hook = join(directory, ".git", "hooks", "post-merge");
  await writeFile(hook, "#!/bin/sh\nprintf 'hook mutation\\n' >> feature.txt\n");
  await chmod(hook, 0o755);
  await assert.rejects(manager.merge(workspace, head), /uncommitted or untracked/);
  assert.equal(await git(directory, "rev-parse", "HEAD"), head);
  assert.match(await readFile(join(directory, "feature.txt"), "utf8"), /hook mutation/);
  await access(workspace.directory);
});

test("failed configured checks preserve the source and task worktree", async (t) => {
  const directory = await repository(t);
  const { workspace } = await changedTask(directory);
  const results = await runChecks(workspace.directory, [
    { name: "failure", command: process.execPath, args: ["-e", "console.log('diagnostic'); console.error('reason'); process.exit(3)"], timeoutMs: 5_000 },
    { name: "remaining check", command: process.execPath, args: ["-e", "console.log('ran')"], timeoutMs: 5_000 },
  ]);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.exitCode, 3);
  assert.match(results[0]!.stdout, /diagnostic/);
  assert.match(results[0]!.stderr, /reason/);
  assert.equal(results[1]?.ok, true);
  assert.equal(await readFile(join(directory, "feature.txt"), "utf8"), "before\n");
  await access(workspace.directory);
});

test("creation rejects dirty tracked files and untracked project files", async (t) => {
  const directory = await repository(t);
  const manager = new GitWorkspace(directory);
  await writeFile(join(directory, "feature.txt"), "dirty\n");
  await assert.rejects(manager.create("tracked"), /uncommitted or untracked/);
  await git(directory, "restore", "feature.txt");
  await writeFile(join(directory, "untracked.txt"), "untracked\n");
  await assert.rejects(manager.create("untracked"), /uncommitted or untracked/);
});

test("explicit baseline preserves deletions and new source while excluding runtime and Finder metadata", async t => {
  const directory = await repository(t);
  const manager = new GitWorkspace(directory);
  await rm(join(directory, "feature.txt"));
  await writeFile(join(directory, "tetris.js"), "new source\n");
  await writeFile(join(directory, ".DS_Store"), "Finder metadata");
  await mkdir(join(directory, ".openagi"), { recursive: true });
  await writeFile(join(directory, ".openagi", "private.json"), "private runtime");
  const before = (await git(directory, "rev-parse", "HEAD")).trim();
  const baseline = await manager.saveBaseline();
  assert.notEqual(baseline, before);
  const tree = await git(directory, "ls-tree", "-r", "--name-only", "HEAD");
  assert(tree.includes("tetris.js"));
  assert(!tree.includes("feature.txt"));
  assert(!tree.includes(".DS_Store"));
  assert(!tree.includes(".openagi"));
  const workspace = await manager.create("tetris");
  assert.equal(workspace.baseCommit, baseline);
  assert.equal(await readFile(join(workspace.directory, "tetris.js"), "utf8"), "new source\n");
  await assert.rejects(access(join(workspace.directory, "feature.txt")));
  assert.equal(await manager.saveBaseline(), baseline);
});

test("creation requires a committed HEAD and a named source branch", async (t) => {
  const directory = await repository(t);
  const blank = await mkdtemp(join(tmpdir(), "openagi-unborn-test-"));
  t.after(() => rm(blank, { recursive: true, force: true }));
  await git(blank, "init", "-b", "main");
  const unbornConfig = await readFile(join(blank, ".git", "config"), "utf8");
  const unbornHead = await readFile(join(blank, ".git", "HEAD"), "utf8");
  await assert.rejects(new GitWorkspace(blank).create("empty"), /initial Git commit/);
  assert.equal(await readFile(join(blank, ".git", "config"), "utf8"), unbornConfig);
  assert.equal(await readFile(join(blank, ".git", "HEAD"), "utf8"), unbornHead);
  await assert.rejects(git(blank, "rev-parse", "--verify", "HEAD"));
  await git(directory, "checkout", "--detach");
  await assert.rejects(new GitWorkspace(directory).create("detached"), /named Git branch/);
});

test("merge rejects dirty source and preserves the task branch", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await writeFile(join(directory, "feature.txt"), "user edit\n");
  await assert.rejects(manager.merge(workspace, head), /uncommitted or untracked/);
  assert.equal(await git(directory, "rev-parse", "HEAD"), workspace.baseCommit);
  assert.equal(await manager.head(workspace), head);
});

test("merge rejects a moved base commit without overwriting it", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await writeFile(join(directory, "user.txt"), "new user work\n");
  await git(directory, "add", "user.txt");
  await git(directory, "commit", "-m", "user work");
  const moved = await git(directory, "rev-parse", "HEAD");
  await assert.rejects(manager.merge(workspace, head), /base branch moved/);
  assert.equal(await git(directory, "rev-parse", "HEAD"), moved);
});

test("merge rejects a changed source branch", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await git(directory, "checkout", "-b", "user-branch");
  await assert.rejects(manager.merge(workspace, head), /source branch changed/);
  assert.equal(await git(directory, "symbolic-ref", "--short", "HEAD"), "user-branch");
});

test("explicit base refresh rebases task changes without changing the source", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await writeFile(join(directory, "user.txt"), "concurrent user feature\n");
  await git(directory, "add", "user.txt");
  await git(directory, "commit", "-m", "user feature");
  const baseCommit = await git(directory, "rev-parse", "HEAD");
  const refreshed = await manager.refreshBase(workspace);
  assert.equal(refreshed.directory, workspace.directory);
  assert.equal(refreshed.branch, workspace.branch);
  assert.equal(refreshed.baseCommit, baseCommit);
  assert.notEqual(refreshed.headCommit, head);
  assert.equal(workspace.baseCommit, await git(directory, "rev-parse", "HEAD~1"));
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseCommit);
  assert.equal(await readFile(join(directory, "feature.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(refreshed.directory, "feature.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(refreshed.directory, "user.txt"), "utf8"), "concurrent user feature\n");
  await assert.rejects(manager.merge(refreshed, head), /head changed after validation/);
  await manager.merge(refreshed, refreshed.headCommit!);
  assert.equal(await git(directory, "rev-parse", "HEAD"), refreshed.headCommit);
});

test("conflicting base refresh preserves source and requires manual continue or abort", async (t) => {
  const directory = await repository(t);
  const { manager, workspace } = await changedTask(directory);
  await writeFile(join(directory, "feature.txt"), "conflicting user change\n");
  await git(directory, "add", "feature.txt");
  await git(directory, "commit", "-m", "conflicting user feature");
  const sourceHead = await git(directory, "rev-parse", "HEAD");
  await assert.rejects(manager.refreshBase(workspace), /git rebase --continue.*git rebase --abort/);
  assert.equal(await git(directory, "rev-parse", "HEAD"), sourceHead);
  assert.equal(await readFile(join(directory, "feature.txt"), "utf8"), "conflicting user change\n");
  assert.match(await git(workspace.directory, "status", "--porcelain"), /UU feature.txt/);
  await assert.rejects(manager.refreshBase(workspace), /rebase is still in progress/);
  await git(workspace.directory, "rebase", "--abort");
  assert.equal(await readFile(join(workspace.directory, "feature.txt"), "utf8"), "after\n");
});

test("merge rejects head changes made after validation", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await writeFile(join(workspace.directory, "feature.txt"), "later\n");
  await manager.checkpoint(workspace, "Later change");
  await assert.rejects(manager.merge(workspace, head), /head changed after validation/);
  assert.equal(await git(directory, "rev-parse", "HEAD"), workspace.baseCommit);
});

test("merge rejects uncommitted task changes after validation", async (t) => {
  const directory = await repository(t);
  const { manager, workspace, head } = await changedTask(directory);
  await writeFile(join(workspace.directory, "feature.txt"), "unstaged later change\n");
  await assert.rejects(manager.head(workspace), /uncommitted or untracked/);
  await assert.rejects(manager.merge(workspace, head), /uncommitted or untracked/);
  assert.equal(await git(directory, "rev-parse", "HEAD"), workspace.baseCommit);
});

test("head rejects a check that creates untracked project files", async (t) => {
  const directory = await repository(t);
  const { manager, workspace } = await changedTask(directory);
  const results = await runChecks(workspace.directory, [{
    name: "mutating check", command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('unexpected.txt', 'new source')"], timeoutMs: 5_000,
  }]);
  assert.equal(results[0]?.ok, true);
  await assert.rejects(manager.head(workspace), /uncommitted or untracked/);
});

test("protected state and branch mutation are rejected", async (t) => {
  const directory = await repository(t);
  const { manager, workspace } = await changedTask(directory);
  await mkdir(join(workspace.directory, ".openagi"));
  await writeFile(join(workspace.directory, ".openagi", "state.json"), "worker state mutation");
  await assert.rejects(manager.checkpoint(workspace, "Wrong state"), /protected .openagi/);
  await rm(join(workspace.directory, ".openagi"), { recursive: true });
  await git(workspace.directory, "checkout", "-b", "unexpected-branch");
  await assert.rejects(manager.head(workspace), /registration or branch was modified/);
});

test("workspace paths cannot escape the configured root", async (t) => {
  const directory = await repository(t);
  const { manager, workspace } = await changedTask(directory);
  await assert.rejects(manager.head({ ...workspace, directory }), /outside the configured/);
  assert.throws(() => new GitWorkspace(directory, join(directory, "ordinary-worktrees")), /outside the project/);
});

test("missing commands and invalid checks produce failed results", async (t) => {
  const directory = await repository(t);
  const results = await runChecks(directory, [
    { name: "missing", command: join(directory, "no-such-command"), args: [], timeoutMs: 500 },
    { name: "invalid", command: "", args: [], timeoutMs: 0 },
  ]);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.exitCode, null);
  assert.match(results[0]!.stderr, /ENOENT/);
  assert.equal(results[1]?.ok, false);
  assert.deepEqual(await runChecks(directory, []), []);
});

test("check argv is literal and retained output is bounded", async (t) => {
  const directory = await repository(t);
  const literal = "$(touch unexpected); *.txt";
  const results = await runChecks(directory, [
    { name: "argv", command: process.execPath, args: ["-e", "console.log(process.argv[1])", literal], timeoutMs: 5_000 },
    { name: "output", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000))"], timeoutMs: 5_000 },
  ]);
  assert.equal(results[0]?.stdout.trim(), literal);
  assert.equal(results[1]?.ok, true);
  assert.ok(results[1]!.stdout.length < 66_000);
  assert.ok(results[1]!.stderr.length < 66_000);
  assert.match(results[1]!.stdout, /output truncated/);
  await assert.rejects(access(join(directory, "unexpected")));
});

test("configured Node test runners execute suites independently of the embedding harness", async (t) => {
  const directory = await repository(t);
  await writeFile(join(directory, "passing.test.cjs"), "const {test} = require('node:test'); test('independent pass', () => require('node:assert/strict').equal(1, 1));\n");
  await writeFile(join(directory, "failing.test.cjs"), "const {test} = require('node:test'); test('independent failure', () => require('node:assert/strict').equal(1, 2));\n");
  const results = await runChecks(directory, [
    { name: "pass", command: process.execPath, args: ["--test", "--test-reporter=tap", "passing.test.cjs"], timeoutMs: 5_000 },
    { name: "fail", command: process.execPath, args: ["--test", "--test-reporter=tap", "failing.test.cjs"], timeoutMs: 5_000 },
  ]);
  assert.equal(results[0]?.ok, true);
  assert.match(results[0]!.stdout, /ok 1 - independent pass/);
  assert.equal(results[1]?.ok, false);
  assert.match(results[1]!.stdout, /not ok 1 - independent failure/);
});

test("timeout terminates the check process group, including subprocesses", { skip: process.platform === "win32" }, async (t) => {
  const directory = await repository(t);
  const sentinel = join(directory, "escaped-child.txt");
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'escaped'), 600); setInterval(() => {}, 1000)`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); console.log('child spawned'); setInterval(() => {}, 1000)`;
  const results = await runChecks(directory, [{ name: "timeout", command: process.execPath, args: ["-e", parentCode], timeoutMs: 200 }]);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.timedOut, true);
  assert.match(results[0]!.stdout, /child spawned/);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(access(sentinel));
});

test("pausing cancels a Git hook and its subprocesses while preserving the task for retry", { skip: process.platform === "win32" }, async (t) => {
  const directory = await repository(t);
  const controller = new AbortController();
  const manager = new GitWorkspace(directory, undefined, undefined, controller.signal);
  const workspace = await manager.create("cancelled-task");
  await writeFile(join(workspace.directory, "feature.txt"), "retained task changes\n");
  const ready = join(directory, ".openagi", "hook-ready");
  const sentinel = join(directory, ".openagi", "escaped-hook-child");
  const hookScript = join(directory, ".git", "hooks", "slow-hook.cjs");
  const hook = join(directory, ".git", "hooks", "pre-commit");
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'escaped'), 1000); setInterval(() => {}, 1000)`;
  await writeFile(hookScript, `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);\n`);
  await writeFile(hook, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}\n`);
  await chmod(hook, 0o755);
  const operation = manager.checkpoint(workspace, "Cancelable implementation");
  const rejected = assert.rejects(operation, /task paused/);
  await waitForFile(ready);
  const beforeAbort = Date.now();
  controller.abort(new Error("task paused"));
  await rejected;
  assert.ok(Date.now() - beforeAbort < 2_000, "Pause should not wait for the 60-second Git timeout");
  assert.equal(await git(directory, "rev-parse", "HEAD"), workspace.baseCommit);
  assert.equal(await readFile(join(workspace.directory, "feature.txt"), "utf8"), "retained task changes\n");
  await access(workspace.directory);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(access(sentinel));
  await rm(hook);
  const resumed = new GitWorkspace(directory);
  const resumedHead = await resumed.checkpoint(workspace, "Resume retained implementation");
  assert.notEqual(resumedHead, workspace.baseCommit);
  assert.equal(await git(directory, "rev-parse", "HEAD"), workspace.baseCommit);
});

test("an already paused task never starts a Git workspace mutation", async (t) => {
  const directory = await repository(t);
  const controller = new AbortController();
  controller.abort(new Error("already paused"));
  const manager = new GitWorkspace(directory, undefined, undefined, controller.signal);
  await assert.rejects(manager.create("must-not-start"), /already paused/);
  await assert.rejects(access(join(directory, ".openagi", "worktrees")));
});

test("pausing stops check subprocesses and prevents subsequent checks from running", { skip: process.platform === "win32" }, async (t) => {
  const directory = await repository(t);
  const ready = join(directory, "check-ready");
  const sentinel = join(directory, "escaped-check-child");
  const later = join(directory, "later-check");
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'escaped'), 1000); setInterval(() => {}, 1000)`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`;
  const controller = new AbortController();
  const operation = runChecks(directory, [
    { name: "long check", command: process.execPath, args: ["-e", parentCode], timeoutMs: 60_000 },
    { name: "later check", command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(later)}, 'ran')`], timeoutMs: 5_000 },
  ], controller.signal);
  await waitForFile(ready);
  controller.abort();
  const results = await operation;
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.timedOut, false);
  assert.match(results[0]!.stderr, /Check cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(access(sentinel));
  await assert.rejects(access(later));
});
