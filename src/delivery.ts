import { open } from "node:fs/promises";
import { withinProject } from "./boundary.js";
import type { State } from "./domain.js";

/** Read usage documentation without executing commands or inferring an unverified launch procedure. */
export async function deliveryGuide(state: State): Promise<State["delivery"]> {
  const start = state.conversationStartedAt ?? state.conversation?.findLast(message => message.role === "user" && message.text === state.project.context.goal)?.at;
  const tasks = state.tasks.filter(task => task.status === "merged" && task.runs.some(run => run.status === "merged" && run.validatedHead) && (!start || task.updatedAt >= start));
  if (!tasks.length) return;
  const taskIDs = tasks.map(task => task.id);
  for (const name of ["README.md", "readme.md", "README.MD", "README.txt"]) {
    let text: string;
    try {
      const file = await open(await withinProject(state.project.directory, name), "r");
      try { const data = Buffer.alloc(24_000); const read = await file.read(data, 0, data.length, 0); text = data.subarray(0, read.bytesRead).toString("utf8"); }
      finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // A missing or inaccessible document does not undo an accepted implementation.
      continue;
    }
    const sections = text.split(/\n(?=#{1,3}\s)/);
    const intro = sections[0]?.replace(/^#\s+[^\n]+\n/, "").trim() ?? "";
    const usage = sections.slice(1).filter(section => /^#{1,3}\s+.*(?:快速开始|使用|启动|操作|安装|前提|限制|quick\s*start|getting\s*started|usage|installation|running|prerequisites|limitations)/i.test(section));
    let markdown = [intro.split(/\n\s*\n/).slice(0, 3).join("\n\n"), ...usage].filter(Boolean).join("\n\n").slice(0, 8_000);
    const limitations = intro.match(/[^。\n]*(?:未提供|不提供|不支持|not supported|does not support)[^。\n]*[。.]?/gi) ?? [];
    const extra = limitations.map(line => line.trim()).filter(line => line && !markdown.includes(line));
    if (extra.length) markdown += "\n\n" + [...new Set(extra)].map(line => `> ${line}`).join("\n\n");
    if (!markdown.trim()) continue;
    return { goal: state.project.context.goal, taskIDs, createdAt: new Date().toISOString(), source: name, markdown };
  }
  return { goal: state.project.context.goal, taskIDs, createdAt: new Date().toISOString(), markdown: "" };
}
