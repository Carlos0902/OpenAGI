import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
export async function launchDesktop(directory: string, summary?: string) {
  const main = fileURLToPath(new URL("../../vendor/opencode/packages/desktop/out/main/index.js", import.meta.url));
  const packaged = fileURLToPath(new URL(`../../release/mac-${process.arch}/OpenAGI.app/Contents/MacOS/OpenAGI`, import.meta.url));
  let binary: string; let packagedApp = false;
  try { if (process.platform !== "darwin") throw new Error(); await access(packaged); binary = packaged; packagedApp = true; }
  catch { binary = createRequire(import.meta.url)("electron") as string; }
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [...(packagedApp ? [] : [main]), "--project", directory, ...(summary ? ["--summary", summary] : [])], { cwd: directory, env: environment, detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
