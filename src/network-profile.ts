import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configureOutboundProxy } from "./proxy.js";

export const DEFAULT_PROXY = "http://127.0.0.1:7892";
export const NetworkProfile = z.object({ enabled: z.boolean(), proxyURL: z.string(), noProxy: z.string() });
export type NetworkProfile = z.infer<typeof NetworkProfile>;
export function networkDirectory(): string {
  return process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "OpenAGI")
    : process.platform === "win32" ? join(process.env.APPDATA ?? homedir(), "OpenAGI")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "OpenAGI");
}
export function loopbackNoProxy(value = ""): string {
  const entries = value.split(",").map(item => item.trim()).filter(Boolean);
  for (const host of ["localhost", "127.0.0.1", "::1"]) if (!entries.some(entry => entry.toLowerCase() === host)) entries.push(host);
  return [...new Set(entries)].join(",");
}
export function validateNetwork(input: NetworkProfile): NetworkProfile {
  const profile = NetworkProfile.parse(input);
  let url: URL;
  try { url = new URL(profile.proxyURL); } catch { throw new Error("代理地址无效，请填写完整的 HTTP 或 HTTPS 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("代理地址只支持 HTTP/HTTPS 的主机和端口，不支持密钥、路径或查询参数。");
  return { ...profile, proxyURL: url.origin, noProxy: loopbackNoProxy(profile.noProxy) };
}
export async function readNetworkProfile(directory = networkDirectory()): Promise<NetworkProfile> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(directory, "network.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (value === undefined) return { enabled: true, proxyURL: DEFAULT_PROXY, noProxy: loopbackNoProxy() };
  // Preserve the existing desktop profile when upgrading; explicit disable must survive relaunch.
  const old = z.object({ enabled: z.boolean().optional(), proxyURL: z.string().optional(), httpProxy: z.string().optional(), httpsProxy: z.string().optional(), noProxy: z.string().optional() }).parse(value);
  return validateNetwork({ enabled: old.enabled ?? true, proxyURL: old.proxyURL ?? old.httpsProxy ?? old.httpProxy ?? DEFAULT_PROXY, noProxy: old.noProxy ?? "" });
}
export async function saveNetworkProfile(input: NetworkProfile, directory = networkDirectory()): Promise<NetworkProfile> {
  const profile = validateNetwork(input);
  await mkdir(directory, { recursive: true });
  const file = join(directory, "network.json"); const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...profile, httpProxy: profile.enabled ? profile.proxyURL : "", httpsProxy: profile.enabled ? profile.proxyURL : "" }, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file); await chmod(file, 0o600);
  return profile;
}
export function applyNetworkProfile(profile: NetworkProfile): void {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) process.env[key] = profile.enabled ? profile.proxyURL : "";
  process.env.NO_PROXY = process.env.no_proxy = loopbackNoProxy(profile.noProxy);
  configureOutboundProxy();
}
export async function loadNetworkProfile(directory = networkDirectory()): Promise<NetworkProfile> {
  const profile = await saveNetworkProfile(await readNetworkProfile(directory), directory);
  applyNetworkProfile(profile); return profile;
}
