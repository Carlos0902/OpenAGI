import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
const platforms = { "darwin:arm64": "darwin-aarch64", "darwin:x64": "darwin-x64", "linux:arm64": "linux-aarch64", "linux:x64": "linux-x64", "win32:arm64": "windows-aarch64", "win32:x64": "windows-x64" };
const platform = platforms[`${process.platform}:${process.arch}`];
if (!platform) throw new Error("Unsupported build platform");
const bun = join(root, ".openagi/tools/node_modules", `@oven/bun-${platform}`, "bin", process.platform === "win32" ? "bun.exe" : "bun");
for (const name of ["desktop", "app", "gui-extensions"]) {
  const result = spawnSync(bun, ["run", "typecheck"], { cwd: join(root, pin.source, "packages", name), stdio: "inherit", env: { ...process.env, PATH: `${dirname(bun)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
