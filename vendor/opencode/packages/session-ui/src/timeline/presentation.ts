/** Presentation of a machine-readable response to an internal prompt. */
export type SessionResultPresentation = {
  /** Top-level schema properties. Unmarked prose and unrelated JSON remain visible. */
  keys: readonly string[]
}

/** Preserve progress prose while recognizing a structured result, including an unfinished stream. */
export function structuredResult(text: string, presentation: SessionResultPresentation | undefined, prefix = "") {
  if (!presentation?.keys.length) return
  if (prefix) {
    const start = /(?:^|\n)\s*(?:```(?:json)?\s*\n\s*)?\{\s*"([^"\n]+)"\s*:/.exec(prefix);
    if (start && presentation.keys.includes(start[1]!)) {
      let depth = 0, quoted = false, escaped = false;
      for (const character of prefix.slice(prefix.indexOf("{", start.index))) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{" || character === "[") depth++;
        else if (character === "}" || character === "]") depth--;
      }
      if (depth > 0) return { visibleText: "", continuation: true };
    }
  }
  const match = /(?:^|\n)\s*(?:```(?:json)?\s*\n\s*)?\{\s*"([^"\n]+)"\s*:/.exec(text)
  if (!match) {
    const trimmed = text.trim();
    if (/^(?:"(?:[^"\\]|\\.)*"\s*[,}:\]]|[}\]])/.test(trimmed) && /[}\]]$/.test(trimmed)) return { visibleText: "", continuation: true };
    return;
  }
  if (!presentation.keys.includes(match[1]!)) return
  return { visibleText: text.slice(0, match.index).trimEnd(), continuation: false }
}


/** Prior text within this user turn, excluding tool output and earlier requests. */
export function precedingResultText(
  messages: Iterable<{ id: string; type: string; content?: readonly { type: string; text?: string }[] }>,
  userID: string,
  messageID: string,
  content: { type: string; text?: string },
) {
  let active = false;
  let prefix = "";
  for (const message of messages) {
    if (message.id === userID) { active = true; continue; }
    if (!active) continue;
    if (message.type === "user") break;
    for (const part of message.content ?? []) {
      if (message.id === messageID && part === content) return prefix;
      if (part.type === "tool") prefix = "";
      if (message.type === "assistant" && part.type === "text") prefix += part.text ?? "";
    }
    if (message.id === messageID) break;
  }
  return prefix;
}
