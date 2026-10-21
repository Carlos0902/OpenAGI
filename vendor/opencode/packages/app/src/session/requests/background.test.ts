import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SessionInfo, SessionMessageAssistant, ShellInfo } from "@opencode/client/promise"
import { createSessionBackground } from "./background"

const info = (id: string) => ({ id, title: id }) as SessionInfo
const shell = (id: string, sessionID: string): ShellInfo => ({
  id,
  metadata: { sessionID },
  status: "running",
  command: "npm test",
  cwd: "/project/.openagi/worktrees/task",
  shell: "/bin/zsh",
  file: "/project/output",
  time: { started: 1 },
})

test("the main workflow tracks simultaneous real module tools, background shells and subagents", () =>
  createRoot((dispose) => {
    const tool: SessionMessageAssistant = {
      id: "msg_worker",
      type: "assistant",
      agent: "build",
      model: { providerID: "primary", id: "model" },
      time: { created: 1 },
      content: [
        {
          id: "tool_shell",
          type: "tool",
          name: "shell",
          time: { created: 1 },
          state: { status: "running", input: { command: "npm test" }, metadata: { shellID: "sh_worker" } },
        },
      ],
    }
    const model = createSessionBackground({
      sessionID: () => "ses_main",
      members: () => ["ses_worker", "ses_tutor"],
      sessions: () => [info("ses_main"), info("ses_worker"), info("ses_tutor"), info("ses_other")],
      messages: (id) => (id === "ses_worker" ? [tool] : []),
      status: (id) => (id !== "ses_main" ? "running" : "idle"),
      shells: () => [shell("sh_worker", "ses_worker"), shell("sh_tutor", "ses_tutor"), shell("sh_other", "ses_other")],
    })
    expect(model.blocking()).toEqual([{ type: "shell", partID: "tool_shell", id: "sh_worker", label: "npm test" }])
    expect(model.tasks().map((task) => task.id)).toEqual(["ses_worker", "ses_tutor", "sh_tutor"])
    dispose()
  }))

test("completed workflow members no longer appear as running work", () =>
  createRoot((dispose) => {
    const model = createSessionBackground({
      sessionID: () => "ses_main",
      members: () => ["ses_worker", "ses_tutor"],
      messages: () => [],
      sessions: () => [info("ses_worker"), info("ses_tutor")],
      status: () => "idle",
      shells: () => [],
    })
    expect(model.blocking()).toEqual([])
    expect(model.tasks()).toEqual([])
    dispose()
  }))

test("an ordinary native session does not absorb unrelated independent module records", () =>
  createRoot((dispose) => {
    const model = createSessionBackground({
      sessionID: () => "ses_chat",
      messages: () => [],
      sessions: () => [info("ses_worker")],
      status: () => "running",
      shells: () => [shell("sh_worker", "ses_worker")],
    })
    expect(model.tasks()).toEqual([])
    dispose()
  }))
