import { readFile } from "node:fs/promises";
import { Check, Model, ProjectConfig, moduleNames } from "./domain.js";
import { withinProject } from "./boundary.js";

export function parseModel(value: string | undefined) {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error("Model must be provider/model (variant can be set in config JSON)");
  return Model.parse({ providerID: value.slice(0, separator), modelID: value.slice(separator + 1) });
}

export async function inferredChecks(directory: string) {
  try {
    const pkg = JSON.parse(await readFile(await withinProject(directory, "package.json"), "utf8")) as { packageManager?: string; scripts?: Record<string, string> };
    const manager = pkg.packageManager?.split("@")[0] ?? "npm";
    const command = ["npm", "pnpm", "yarn", "bun"].includes(manager) ? manager : "npm";
    return ["lint", "typecheck", "test"].filter(name => pkg.scripts?.[name] && !pkg.scripts[name]?.includes("no test specified")).map(name => ({ name, command, args: ["run", name], timeoutMs: 120_000 }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const [file, check] of [
    ["Cargo.toml", { name: "Rust tests", command: "cargo", args: ["test"], timeoutMs: 120_000 }],
    ["go.mod", { name: "Go tests", command: "go", args: ["test", "./..."], timeoutMs: 120_000 }],
  ] as const) {
    try { await readFile(await withinProject(directory, file)); return [{ ...check, args: [...check.args] }]; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return [];
}

export interface RunProjectOptions {
  summary?: string;
  modules?: string;
  name?: string;
  audience?: string;
  constraints?: string;
  opencodeUrl?: string;
  model?: string;
  roleModels?: Partial<Record<"discovery" | "collector" | "guider" | "worker" | "validator", string>>;
  checks?: CheckInput[];
  noChecks?: boolean;
  config?: unknown;
}
type CheckInput = { name: string; command: string; args: string[]; timeoutMs: number };

export async function runProjectConfig(directory: string, summary: string, options: RunProjectOptions): Promise<ProjectConfig> {
  const fallback = parseModel(options.model);
  const input = options.config ?? {
    name: options.name ?? directory.split("/").at(-1),
    modules: options.modules?.split(",").map(value => value.trim()) ?? [...moduleNames],
    context: { goal: summary, audience: options.audience, constraints: options.constraints },
    opencode: { url: options.opencodeUrl },
    models: Object.fromEntries(["discovery", "collector", "guider", "worker", "validator"].map(role => [role, parseModel(options.roleModels?.[role as keyof NonNullable<RunProjectOptions["roleModels"]>]) ?? fallback])),
    validation: { checks: options.checks ? options.checks.map(check => Check.parse(check)) : await inferredChecks(directory), requireChecks: !options.noChecks },
  };
  return ProjectConfig.parse({ ...(input as object), directory, context: { ...((input as { context?: object }).context ?? {}), goal: summary } });
}
