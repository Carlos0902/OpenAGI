import { z } from "zod";
import type { PendingInteraction, InteractionReply } from "./opencode.js";
import type { ConversationIO } from "./terminal.js";

const Option = z.object({ value: z.string(), label: z.string(), description: z.string().nullish() });
const Field = z.object({
  key: z.string(), type: z.enum(["string", "number", "integer", "boolean", "multiselect", "external"]),
  title: z.string().nullish(), description: z.string().nullish(), required: z.boolean().nullish(), hidden: z.boolean().nullish(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullish(),
  options: z.array(Option).nullish(), custom: z.boolean().nullish(), url: z.string().nullish(),
  when: z.array(z.object({ key: z.string(), op: z.enum(["eq", "neq"]), value: z.union([z.string(), z.number(), z.boolean()]) })).nullish(),
  minimum: z.number().nullish(), maximum: z.number().nullish(), minLength: z.number().nullish(), maxLength: z.number().nullish(),
  minItems: z.number().nullish(), maxItems: z.number().nullish(), pattern: z.string().nullish(),
});
export class SessionStopped extends Error { constructor() { super("交互已结束；执行记录会保留，重新运行 openagi run 可继续。"); } }
const stopWords = new Set(["/退出", "/exit", "/quit"]);
export async function requiredAnswer(io: ConversationIO, prompt: string, secret = false): Promise<string> {
  const answer = await (secret && io.secret ? io.secret(prompt) : io.ask(prompt));
  if (answer === null || stopWords.has(answer.trim().toLowerCase())) throw new SessionStopped();
  return answer.trim();
}

export async function answerOpenCode(io: ConversationIO, pending: PendingInteraction): Promise<InteractionReply[]> {
  const replies: InteractionReply[] = [];
  for (const raw of pending.permissions) {
    const permission = z.object({ id: z.string(), action: z.string(), resources: z.array(z.string()).default([]), metadata: z.unknown().optional() }).parse(raw);
    io.write(`\n执行需要授权：${permission.action}\n${permission.resources.join("\n")}${permission.metadata ? `\n详情：${JSON.stringify(permission.metadata)}` : ""}`);
    while (true) {
      const response = await requiredAnswer(io, "允许这一次？[y 允许 / n 拒绝 / /退出 暂停] > ");
      if (["y", "yes", "是", "允许", "好"].includes(response.toLowerCase())) { replies.push({ kind: "permission", id: permission.id, decision: "once" }); break; }
      if (["n", "no", "否", "拒绝"].includes(response.toLowerCase())) { replies.push({ kind: "permission", id: permission.id, decision: "reject" }); break; }
      io.write("请输入 y 或 n，授权不会默认通过。");
    }
  }
  for (const raw of pending.forms) {
    const form = z.object({ id: z.string(), title: z.string(), fields: z.array(Field) }).parse(raw);
    io.write(`\n${form.title}`);
    const answer: Record<string, string | number | boolean | string[]> = {};
    for (const field of form.fields) {
      if (field.when?.some(condition => {
        const previous = answer[condition.key];
        if (previous === undefined) return true;
        const equals = Array.isArray(previous) ? previous.includes(String(condition.value)) : previous === condition.value;
        return condition.op === "eq" ? !equals : equals;
      })) continue;
      if (field.type === "external") { io.write(`${field.title ?? field.key}: ${field.url ?? ""}`); continue; }
      if (field.hidden && field.default != null) { answer[field.key] = field.default; continue; }
      if (field.description) io.write(field.description);
      field.options?.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
      while (true) {
        const value = await requiredAnswer(io, `${field.title ?? field.key}${field.type === "multiselect" ? "（多个选项用逗号分隔）" : ""}${field.default != null ? ` [默认 ${Array.isArray(field.default) ? field.default.join(",") : field.default}]` : ""} > `, /password|api.?key|token|secret|密码|密钥/i.test(field.key + " " + field.title));
        if (!value) {
          if (field.default != null) { answer[field.key] = field.default; break; }
          if (!field.required) break;
          io.write("这项需要回答。"); continue;
        }
        let parsed: string | number | boolean | string[];
        if (field.type === "boolean") {
          if (["y", "yes", "true", "是"].includes(value.toLowerCase())) parsed = true;
          else if (["n", "no", "false", "否"].includes(value.toLowerCase())) parsed = false;
          else { io.write("请输入 是/否 或 true/false。"); continue; }
        } else if (field.type === "number" || field.type === "integer") {
          parsed = Number(value);
          if (!Number.isFinite(parsed) || (field.type === "integer" && !Number.isInteger(parsed)) || (field.minimum != null && parsed < field.minimum) || (field.maximum != null && parsed > field.maximum)) { io.write("请输入符合范围的数字。"); continue; }
        } else {
          const values = field.type === "multiselect" ? value.split(/[,，]/).map(part => part.trim()).filter(Boolean) : [value];
          const selected = values.map(part => /^\d+$/.test(part) && field.options?.[Number(part) - 1] ? field.options[Number(part) - 1]!.value : part);
          if (field.options?.length && !field.custom && selected.some(part => !field.options!.some(option => option.value === part))) { io.write("请填写列出的选项编号或值。"); continue; }
          if (field.type === "multiselect") {
            parsed = [...new Set(selected)];
            if ((field.minItems != null && parsed.length < field.minItems) || (field.maxItems != null && parsed.length > field.maxItems)) { io.write("选择的数量不符合要求。"); continue; }
          } else {
            parsed = selected[0]!;
            if ((field.minLength != null && parsed.length < field.minLength) || (field.maxLength != null && parsed.length > field.maxLength) || (field.pattern && !new RegExp(field.pattern).test(parsed))) { io.write("输入不符合这项的格式要求。"); continue; }
          }
        }
        answer[field.key] = parsed; break;
      }
    }
    replies.push({ kind: "form", id: form.id, answer });
  }
  return replies;
}
