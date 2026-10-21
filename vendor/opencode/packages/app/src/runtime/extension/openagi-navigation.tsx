import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { ProjectManagerInventory } from "./projects"
import { openagiSessionTarget } from "./openagi-session"
import { useOpenAGIClient } from "./openagi-workflow"
import { useCurrentRoute } from "@/shell/state/layout"

/** Additive OpenAGI route hook. All tab ownership, restoration and navigation remain in the original controller. */
export function OpenAGISessionNavigation() {
  const tabs = useTabs()
  const global = useGlobal()
  const workflow = useOpenAGIClient()
  const route = useCurrentRoute()
  const [pending, setPending] = createSignal<ReturnType<typeof openagiSessionTarget>>()
  const receive = (event: Event) => {
    const target = openagiSessionTarget((event as CustomEvent).detail)
    if (target) setPending(target)
  }
  window.addEventListener("openagi:open-session", receive)
  onCleanup(() => window.removeEventListener("openagi:open-session", receive))

  createEffect(() => {
    const session = pending()
    if (!session) return
    const server = global.servers.list().find((item) => ServerConnection.key(item) === session.serverId)
    if (!server) return
    // Follow the same registry path as original Home.openProjectSession; no separate project list is created.
    const context = global.ensureServerCtx(server)
    context.projects.open(session.directory)
    context.projects.touch(session.directory)
    const tab = tabs.addSessionTab({ server: ServerConnection.key(server), sessionId: session.sessionId })
    tabs.select(tab)
    setPending(undefined)
  })
  // Upgrade restored module tabs to the project's durable master. Closing layout never deletes a native session.
  createEffect(() => {
    const state = workflow.state()
    const known = tabs.store.filter((item) => item.type === "session")
    const current = untrack(route)
    if (!state) return
    state.projects.forEach((project) => {
      const main = project.mainSessionId
      const server = state.servers.find((item) => item.directory === project.directory)
      if (!main || !server) return
      const connection = global.servers.list().find((item) => ServerConnection.key(item) === server.id)
      if (!connection) return
      const members = new Set(
        state.sessions
          .filter(
            (item) => item.serverId === server.id && item.directory === project.directory && item.sessionId !== main,
          )
          .map((item) => item.sessionId),
      )
      const old = known.filter(
        (item) => item.type === "session" && item.server === server.id && members.has(item.sessionId),
      )
      const routed = known.find(
        (item) =>
          item.type === "session" &&
          item.server === server.id &&
          item.sessionId === main &&
          !!item.routeSessionId &&
          members.has(item.routeSessionId),
      )
      if (!old.length && !routed) return
      const selected = current.type === "session" && current.server === server.id && members.has(current.sessionId)
      const master = tabs.addSessionTab({ server: ServerConnection.key(connection), sessionId: main })
      if (master.type === "session") tabs.rememberSessionRoute(master, main)
      old.forEach((item) => {
        if (item.type === "session") tabs.removeSessionTab({ server: item.server, sessionId: item.sessionId })
      })
      if (selected && (!state.selectedProject || state.selectedProject === project.directory)) tabs.select(master)
    })
  })
  return <ProjectManagerInventory />
}
