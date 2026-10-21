import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
export function loopbackNoProxy(value?: string) {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
  for (const host of ["localhost", "127.0.0.1", "::1"])
    if (!entries.some((entry) => entry.toLowerCase() === host)) entries.push(host)
  return entries.join(",")
}

/** Finder and CLI launches share the persisted app-wide proxy configuration. */
export async function loadOpenagiNetwork(directory: string) {
  const { loadNetworkProfile } = await import("@openagi/network")
  await loadNetworkProfile(directory)
}

export function privateSidecarRoot(directory: string) {
  return path.join(directory, "backend")
}

export function privateServiceFile(directory: string) {
  return path.join(privateSidecarRoot(directory), "state", "opencode", "service.json")
}

/** A new base client database, with no global OpenCode config or credential environment. */
export function privateSidecarEnvironment(directory: string, inherited: NodeJS.ProcessEnv = process.env) {
  const root = privateSidecarRoot(directory)
  const environment: Record<string, string> = {}
  // Service.ensure merges env into process.env, so explicitly mask private variables.
  for (const key of Object.keys(inherited))
    if (/API_?KEY|TOKEN|SECRET|PASSWORD|^OPENCODE_|^OTEL_/i.test(key)) environment[key] = ""
  return {
    ...environment,
    HOME: path.join(root, "home"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: path.join(root, "models.json"),
    OPENCODE_CLIENT: "desktop",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      share: "disabled",
      update: "disable",
      warming: false,
      plugins: ["-opencode.models.dev", "-opencode.config.instruction", "-opencode.config.skill"],
    }),
    HTTP_PROXY: inherited.HTTP_PROXY ?? inherited.http_proxy ?? "",
    HTTPS_PROXY: inherited.HTTPS_PROXY ?? inherited.https_proxy ?? "",
    NO_PROXY: loopbackNoProxy(inherited.NO_PROXY ?? inherited.no_proxy),
  }
}

export async function preparePrivateSidecar(directory: string) {
  const environment = privateSidecarEnvironment(directory)
  await Promise.all(
    ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]
      .map((key) => mkdir(environment[key as keyof typeof environment], { recursive: true })),
  )
  await writeFile(environment.OPENCODE_MODELS_PATH, "{}", { mode: 0o600 })
  return environment
}
