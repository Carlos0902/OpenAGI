import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { withinProject } from "./boundary.js";

// The desktop bundler supplies its source root; CLI src/ and dist/ share a parent.
declare const __OPENAGI_ROOT__: string;
export function openagiRoot(): string {
  const root = process.env.OPENAGI_ROOT ?? (typeof __OPENAGI_ROOT__ === "string" ? __OPENAGI_ROOT__ : fileURLToPath(new URL("../", import.meta.url)));
  if (!isAbsolute(root)) throw new Error("OPENAGI_ROOT 必须是 OpenAGI 根目录的绝对路径");
  return root;
}
export function settingsDirectory(directory: string, input?: string): string { return input === undefined ? openagiRoot() : directory; }
export async function settingsFile(directory: string, input?: string): Promise<string> {
  return withinProject(settingsDirectory(directory, input), input ?? ".openagi/config.json");
}
