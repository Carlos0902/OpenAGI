import { dialog } from "electron"
import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { createOpenAGIBridge } from "@openagi/native"
import type { MainSetup } from "../sdk/main"
import { OpenAGI } from "./contract"
import type definition from "./index"
import { rememberWorkspace, restoreWorkspace } from "./workspace"

const setup: MainSetup<typeof definition> = async (ctx) => {
  const bridge = await createOpenAGIBridge({ signal: ctx.scope.signal })
  ctx.scope.addFinalizer(() => bridge.close())
  if (ctx.scope.signal.aborted) return
  const saved = ctx.stores.workspace
  // Register the original persisted server inventory before the renderer advertises readiness.
  await restoreWorkspace(bridge, saved.value, ctx.scope.signal)
  if (ctx.scope.signal.aborted) return
  const persist = () => {
    const value = rememberWorkspace(bridge.state())
    if (JSON.stringify(value) !== JSON.stringify(saved.value)) saved.set(value)
  }
  persist()
  const projectTarget = async (directory: string) => {
    if (!isAbsolute(directory)) throw new Error("Choose an absolute project folder")
    const root = await realpath(directory)
    await bridge.project(root)
    const server = bridge.state().servers.find((server) => server.directory === root)
    if (!server) throw new Error("The project closed before it could be opened")
    return { server: server.id, directory: root }
  }

  const provider = ctx.provide(OpenAGI, {
    state: () => bridge.state(),
    saveProvider: (input) => bridge.saveProvider(input),
    removeProvider: (input) => bridge.removeProvider(input.id),
    providerModels: (input) => bridge.providerModels(input.id),
    selectModel: (input) => bridge.selectModel(input.role, { providerID: input.providerID, modelID: input.modelID }),
    saveJev: (input) => bridge.saveJev(input.apiKey),
    networkConfig: (input) => bridge.networkConfig(input),
    testNetwork: () => bridge.testNetwork(),
    async pickProject(_, caller) {
      const options = { title: ctx.t("project"), properties: ["openDirectory"] as const }
      const window = ctx.windows.get(caller.window)
      const picked = window
        ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      if (picked.canceled || !picked.filePaths[0] || caller.signal.aborted) return null
      return projectTarget(picked.filePaths[0])
    },
    project: (input) => projectTarget(input.directory),
    run: (input) => bridge.run(input.directory, { summary: input.summary, resume: input.resume }),
    config: (input) => bridge.config(input.directory),
    answer: (input) => bridge.answer(input.directory, input.id, input.text),
    submit: (input) => bridge.submit(input.directory, input.text),
    pause: (input) => bridge.pause(input.directory),
    forget: (input) => bridge.forget(input.directory),
  })

  ctx.scope.addFinalizer(
    bridge.subscribe(() => {
      persist()
      provider.changed()
    }),
  )
  ctx.scope.addFinalizer(bridge.onSession((session) => provider.emit("session", session)))
}

export default setup
