import { describe, expect, test } from "bun:test"
import { openagiSessionTarget, workflowSessionMetadata } from "./openagi-session"
import type { SessionInfo } from "@opencode/client/promise"

describe("OpenAGI native session routing", () => {
  test("routes real isolated backend sessions without passing orchestration metadata", () => {
    expect(
      openagiSessionTarget({
        serverId: "openagi:project_ab123",
        sessionId: "ses_123abc",
        directory: "/project",
        label: "Worker",
      }),
    ).toEqual({ serverId: "openagi:project_ab123", sessionId: "ses_123abc", directory: "/project" })
  })
  test("routes a module selection to its project's actual durable main session", () => {
    expect(
      openagiSessionTarget({
        serverId: "openagi:project",
        sessionId: "ses_worker",
        mainSessionId: "ses_main",
        directory: "/project",
      }),
    ).toEqual({ serverId: "openagi:project", sessionId: "ses_main", directory: "/project" })
    expect(
      openagiSessionTarget({
        serverId: "openagi:project",
        sessionId: "ses_worker",
        mainSessionId: "ses_main/../settings",
        directory: "/project",
      }),
    ).toBeUndefined()
  })
  test("rejects unrelated servers, path injection, and malformed event data", () => {
    for (const detail of [
      undefined,
      null,
      [],
      "ses_123",
      { serverId: "sidecar", sessionId: "ses_123", directory: "/project" },
      { serverId: "http://remote", sessionId: "ses_123", directory: "/project" },
      { serverId: "openagi:../../remote", sessionId: "ses_123", directory: "/project" },
      { serverId: "openagi:project", sessionId: "ses_123/../../settings", directory: "/project" },
      { serverId: "openagi:project", sessionId: "msg_123", directory: "/project" },
      { serverId: "openagi:project", sessionId: 123, directory: "/project" },
    ])
      expect(openagiSessionTarget(detail)).toBeUndefined()
  })
  test("registers only an absolute owner directory, rejecting relative paths, traversal and injected control characters", () => {
    const target = { serverId: "openagi:project", sessionId: "ses_123" }
    for (const directory of [
      undefined,
      "",
      "project",
      "./project",
      "/project/../other",
      "/project/./child",
      "C:relative",
      "http://host/project",
      "file:///project",
      "/project\u0000/other",
      "/project\nother",
    ]) {
      expect(openagiSessionTarget({ ...target, directory })).toBeUndefined()
    }
    for (const directory of [
      "/parent/project",
      "/project with spaces",
      "C:\\Projects\\Project",
      "\\\\server\\share\\project",
    ]) {
      expect(openagiSessionTarget({ ...target, directory })?.directory).toBe(directory)
    }
  })
})

test("recognizes durable workflow metadata without treating other native sessions as modules", () => {
  const info = (openagi: NonNullable<SessionInfo["metadata"]>[string]): SessionInfo => ({
    id: "ses_main",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/project" },
    metadata: { openagi },
  })
  expect(workflowSessionMetadata(info({ kind: "workflow", directory: "/project" }))).toEqual({
    kind: "workflow",
    directory: "/project",
    mainSessionId: "ses_main",
  })
  expect(workflowSessionMetadata(info({ kind: "module", directory: "/project", mainSessionId: "ses_main" }))).toEqual({
    kind: "module",
    directory: "/project",
    mainSessionId: "ses_main",
  })
  expect(workflowSessionMetadata(info({ kind: "ordinary", directory: "/project" }))).toBeUndefined()
})
