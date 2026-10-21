import { describe, expect, test } from "bun:test"
import type { FormInfo, PermissionRequest, SessionInfo } from "@opencode/client/promise"
import {
  sessionPermissionRequest,
  sessionFormRequest,
  sessionTreeIDs,
  workflowRequestIDs,
} from "@/session/requests/session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as SessionInfo

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string" }],
  }) as FormInfo

test("syncs live invocations and parked requests without fan-out over completed module history", () => {
  const members = [
    "main",
    ...Array.from({ length: 2000 }, (_item, index) => `done-${index}`),
    "new-worker",
    "running-worker",
    "parked-form",
  ]
  expect(
    workflowRequestIDs({
      main: "main",
      members,
      recent: ["new-worker"],
      running: ["running-worker", "other-project"],
      parked: ["parked-form", "other-form"],
    }),
  ).toEqual(["main", "new-worker", "running-worker", "parked-form"])
})

describe("sessionTreeIDs", () => {
  test("returns only the current session and its descendants", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "sibling", parentID: "root" }),
      session({ id: "other" }),
    ]

    expect(sessionTreeIDs(sessions, "child")).toEqual(["child", "grand"])
    expect(sessionTreeIDs(sessions, "root")).toEqual(["root", "child", "sibling", "grand"])
    expect(sessionTreeIDs(sessions)).toEqual([])
  })
  test("includes independent workflow members and their real subagents without leaking another project", () => {
    const sessions = [
      session({ id: "main" }),
      session({ id: "worker" }),
      session({ id: "nested", parentID: "worker" }),
      session({ id: "other" }),
    ]
    expect(sessionTreeIDs(sessions, "main", ["worker", "worker"])).toEqual(["main", "worker", "nested"])
    expect(sessionTreeIDs(sessions, undefined, ["worker"])).toEqual([])
  })
})

const tree = [
  session({ id: "root" }),
  session({ id: "child", parentID: "root" }),
  session({ id: "grand", parentID: "child" }),
  session({ id: "other" }),
]

const search = (id: string, sessionID: string) => ({
  ...question(id, sessionID),
  metadata: { kind: "websearch.provider" },
})

describe("sessionPermissionRequest", () => {
  const both = { root: [permission("perm-root", "root")], child: [permission("perm-child", "child")] }

  test.each([
    ["prefers the current session permission", both, undefined, "perm-root"],
    [
      "returns a nested child permission",
      { grand: [permission("perm-grand", "grand")], other: [permission("perm-other", "other")] },
      undefined,
      "perm-grand",
    ],
    [
      "returns undefined without a matching tree permission",
      { other: [permission("perm-other", "other")] },
      undefined,
      undefined,
    ],
    [
      "skips filtered permissions in the current tree",
      both,
      (item: PermissionRequest) => item.id !== "perm-root",
      "perm-child",
    ],
    ["returns undefined when all tree permissions are filtered out", both, () => false, undefined],
  ])("%s", (_name, permissions, include, id) => {
    expect(sessionPermissionRequest(tree, permissions, "root", include)?.id).toBe(id)
  })
  test("exposes a Worktree Worker's permission using its real session ID", () => {
    const requests = { worker: [permission("perm-worker", "worker")], other: [permission("perm-other", "other")] }
    const result = sessionPermissionRequest(
      [session({ id: "main" }), session({ id: "worker" }), session({ id: "other" })],
      requests,
      "main",
      undefined,
      ["worker"],
    )
    expect(result).toEqual(permission("perm-worker", "worker"))
    expect(sessionPermissionRequest(tree, requests, "main")).toBeUndefined()
  })
})

describe("sessionFormRequest", () => {
  test("exposes a workflow member's original question and web search consent", () => {
    const sessions = [session({ id: "main" }), session({ id: "guider" }), session({ id: "worker" })]
    const forms = { guider: [search("search-guider", "guider")], worker: [question("q-worker", "worker")] }
    expect(sessionFormRequest(sessions, forms, "main", ["guider", "worker"])?.sessionID).toBe("guider")
    expect(sessionFormRequest(sessions, forms, "main", ["worker"])?.sessionID).toBe("worker")
  })
  test.each([
    [
      "prefers the current session question",
      { root: [question("q-root", "root")], child: [question("q-child", "child")] },
      "q-root",
    ],
    ["returns a nested child question", { grand: [question("q-grand", "grand")] }, "q-grand"],
    [
      "skips unsupported forms",
      { root: [{ ...question("form", "root"), metadata: { kind: "integration" } }] },
      undefined,
    ],
    ["finds web search consent in a nested child session", { child: [search("search", "child")] }, "search"],
    [
      "keeps web search ahead of a later question",
      { root: [search("search", "root"), question("q", "root")] },
      "search",
    ],
    ["keeps a question ahead of a later web search", { root: [question("q", "root"), search("search", "root")] }, "q"],
    [
      "keeps the current session ahead of a child question",
      { root: [search("search", "root")], child: [question("q", "child")] },
      "search",
    ],
  ])("%s", (_name, forms, id) => {
    expect(sessionFormRequest(tree, forms, "root")?.id).toBe(id)
  })
})
