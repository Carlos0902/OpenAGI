import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function contains(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Resolve the nearest existing ancestor too: new files cannot escape through a symlink. */
export async function withinProject(root: string, input: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const target = resolve(root, input);
  let ancestor = target;
  while (true) {
    try {
      await lstat(ancestor);
      const canonicalTarget = resolve(await realpath(ancestor), relative(ancestor, target));
      if (!contains(canonicalRoot, canonicalTarget)) throw new Error("路径超出当前项目目录或通过符号链接指向项目外，已拒绝访问。");
      return canonicalTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
