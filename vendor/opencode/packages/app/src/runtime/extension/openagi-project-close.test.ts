import { expect, test } from "bun:test"
import { Schema } from "effect"
import { createStore } from "solid-js/store"
import { createServerProjects, ServerConnection } from "../server/registry"
import { serverState } from "../server/persistence"
import { ServerScope } from "../server/scope"
import { Persistence } from "../persistence/schema"

test("native close keeps the upstream recent-project behavior and publishes one scoped OpenAGI lifecycle event", () => {
  const schema = Persistence.withInitial(serverState(), {
    list: [],
    hidden: {},
    projects: {},
    lastProject: {},
    recentlyClosed: {},
  })
  const [store, setStore] = createStore(Schema.decodeUnknownSync(schema)({}))
  const scope = ServerScope.fromServerKey(ServerConnection.Key.make("openagi:project"))
  const projects = createServerProjects({ store, setStore, scope: () => scope })
  const events: unknown[] = []
  const receive = (event: Event) => events.push((event as CustomEvent).detail)
  window.addEventListener("openagi:project-closed", receive)
  try {
    projects.open("/project")
    projects.close("/project")
    expect(projects.list()).toEqual([])
    expect(projects.recentlyClosed()).toEqual(["/project"])
    expect(events).toEqual([{ server: "openagi:project", directory: "/project" }])
    projects.open("/project")
    expect(projects.list()).toEqual([{ worktree: "/project", expanded: true }])
    expect(projects.recentlyClosed()).toEqual([])
    // Internal normalization/removal is still distinct from the explicit Close project action.
    projects.remove("/project")
    expect(events).toHaveLength(1)
  } finally {
    window.removeEventListener("openagi:project-closed", receive)
  }
})
