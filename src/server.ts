import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeError, OpenCodeRuntime } from "./opencode.js";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withinProject } from "./boundary.js";

export interface ManagedServer {
  url: string;
  password: string;
  close(): Promise<void>;
}
export interface ServerOptions {
  url: string;
  directory: string;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (message: string) => void;
  /** Injectable process launcher for transport/lifecycle integration tests. */
  launch?: (hostname: string, port: number, password: string) => ChildProcess;
  environment?: NodeJS.ProcessEnv;
  sandbox?: { command: string; args: string[] };
  redact?: string[];
  executable?: string;
}

export function canStartLocally(url: string): boolean {
  const target = new URL(url);
  return target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && (!target.pathname || target.pathname === "/") && !target.username && !target.password && !target.search && !target.hash;
}

/** Inspect only this project's npm cache; never search the user's global npm/OpenCode installs. */
async function cachedBinary(directory: string, cache: string | undefined): Promise<string | undefined> {
  if (!cache) return undefined;
  let root: string;
  try { root = await withinProject(directory, join(cache, "_npx")); }
  catch { return undefined; }
  let entries: string[];
  try { entries = await readdir(root); } catch { return undefined; }
  for (const entry of entries) {
    try {
      const folder = join(root, entry, "node_modules", "@opencode", "cli");
      const manifest = JSON.parse(await readFile(await withinProject(directory, join(folder, "package.json")), "utf8"));
      if (manifest.name !== "@opencode/cli" || manifest.version !== "2.0.26" || typeof manifest.bin?.opencode2 !== "string") continue;
      const binary = await withinProject(directory, join(folder, manifest.bin.opencode2));
      await access(binary);
      return binary;
    } catch { /* Incomplete installs or paths outside the project are not executable candidates. */ }
  }
  return undefined;
}

/** A foreground backend belongs to this interactive run; existing services are never stopped. */
export async function startLocalServer(options: ServerOptions): Promise<ManagedServer> {
  if (!canStartLocally(options.url)) throw new Error("只会自动启动本机回环地址上的 OpenCode 服务；远程地址请连接已有服务。");
  options.signal?.throwIfAborted();
  const target = new URL(options.url);
  const hostname = target.hostname === "localhost" ? "127.0.0.1" : target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || 80);
  const url = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  const password = randomBytes(24).toString("base64url");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const binary = options.launch ? undefined : options.executable ?? await cachedBinary(options.directory, options.environment?.npm_config_cache);
  const executable = binary ?? npm;
  const arguments_ = binary ? ["serve", "--hostname", hostname, "--port", String(port)] : [
    "exec", "--yes", "--package", "@opencode/cli@2.0.26", "--", "opencode2", "serve", "--hostname", hostname, "--port", String(port),
  ];
  const child = options.launch ? options.launch(hostname, port, password) : spawn(options.sandbox?.command ?? executable, options.sandbox ? [...options.sandbox.args, executable, ...arguments_] : arguments_, {
    cwd: options.directory, env: { ...(options.environment ?? process.env), OPENCODE_PASSWORD: password },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let spawnError: Error | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let logs = "";
  const record = (chunk: Buffer) => { logs = (logs + chunk.toString("utf8")).slice(-4_000); };
  const diagnostics = () => [password, ...(options.redact ?? [])].filter(Boolean).reduce((text, secret) => text.split(secret).join("[hidden]"), logs).trim();
  child.stdout?.on("data", record); child.stderr?.on("data", record);
  child.on("error", error => { spawnError = error; });
  child.on("close", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
  let closePromise: Promise<void> | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => child.kill(signal));
    } else {
      try { process.kill(-child.pid, signal); }
      catch { child.kill(signal); }
    }
  };
  const close = () => closePromise ??= (async () => {
    terminate("SIGTERM");
    const deadline = Date.now() + 2_000;
    while (!exited && Date.now() < deadline) await delay(25);
    // npm may exit before a descendant: terminate the retained process group too.
    terminate("SIGKILL");
    child.stdout?.destroy(); child.stderr?.destroy();
  })();
  const abort = () => { void close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const dispose = async () => { options.signal?.removeEventListener("abort", abort); await close(); };
  const deadline = Date.now() + (options.startupTimeoutMs ?? 120_000);
  let nextProgress = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (spawnError || exited) throw new Error(`OpenCode v2 启动失败${exitCode !== null ? `（退出码 ${exitCode}）` : exitSignal ? `（信号 ${exitSignal}）` : ""}：${spawnError?.message ?? (diagnostics() || "没有诊断信息")}`);
      try {
        await new OpenCodeRuntime({ baseUrl: url, username: "opencode", password, timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())), signal: options.signal }).check();
        return { url, password, close: dispose };
      } catch (error) {
        // OpenCode v2 listens before its initialization completes; /api/info
        // returns 503 with version/process metadata during this phase.
        const starting = error instanceof OpenCodeError && error.kind === "http" && error.status === 503;
        if (!(error instanceof OpenCodeError) || (!starting && !["transport", "timeout"].includes(error.kind))) throw new Error(`OpenCode 后端就绪检查失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (Date.now() >= nextProgress) { options.onProgress?.("仍在准备 OpenCode v2，首次运行可能需要下载依赖…"); nextProgress = Date.now() + 10_000; }
      await delay(options.pollIntervalMs ?? 300, undefined, { signal: options.signal });
    }
    throw new Error(`OpenCode v2 在启动期限内没有就绪：${url}${diagnostics() ? `\n${diagnostics()}` : ""}`);
  } catch (error) { await dispose(); throw error; }
}
