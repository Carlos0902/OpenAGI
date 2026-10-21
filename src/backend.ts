import { createServer } from "node:net";
import { OpenCodeRuntime, type OpenCodeOptions } from "./opencode.js";
import { startLocalServer, type ManagedServer } from "./server.js";
import { prepareIsolation, backendConfiguration, validateIsolation, type Isolation } from "./isolation.js";
import { ConfiguredRuntime } from "./configured-runtime.js";
import { settingsSecrets, type LoadedSettings } from "./settings.js";
import { UsageTracker } from "./usage.js";

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local backend port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function configuredBackend(directory: string, loaded: LoadedSettings, options: { signal?: AbortSignal; onProgress?: (message: string) => void; onInteraction?: OpenCodeOptions["onInteraction"]; onSession?: OpenCodeOptions["onSession"]; nativeInteractions?: boolean; executable?: string; usage?: UsageTracker }): Promise<{ runtime: ConfiguredRuntime; server: ManagedServer; isolation: Isolation }> {
  const isolation = await prepareIsolation(directory, loaded.file);
  await validateIsolation(isolation);
  const content = await backendConfiguration(loaded, isolation);
  const environment = { ...isolation.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(content) };
  if (loaded.settings.search && loaded.searchKey) {
    const names = { tavily: "TAVILY_API_KEY", exa: "EXA_API_KEY", firecrawl: "FIRECRAWL_API_KEY", parallel: "PARALLEL_API_KEY", tinyfish: "TINYFISH_API_KEY" };
    (environment as NodeJS.ProcessEnv)[names[loaded.settings.search.provider]] = loaded.searchKey;
  }
  const secrets = settingsSecrets(loaded);
  const server = await startLocalServer({ url: `http://127.0.0.1:${await availablePort()}`, directory, signal: options.signal, environment, sandbox: isolation, redact: secrets, executable: options.executable, onProgress: options.onProgress });
  const delegate = new OpenCodeRuntime({ baseUrl: server.url, password: server.password, username: "opencode", timeoutMs: 900_000, signal: options.signal, onInteraction: options.onInteraction, onSession: options.onSession, nativeInteractions: options.nativeInteractions, workspaceRoot: directory });
  try {
    await delegate.check();
    await delegate.waitForProjectGuard(directory);
    return { runtime: new ConfiguredRuntime(delegate, loaded, directory, options.signal, undefined, undefined, { tracker: options.usage ?? new UsageTracker(directory), server }), server, isolation };
  } catch (error) { await server.close(); throw error; }
}
