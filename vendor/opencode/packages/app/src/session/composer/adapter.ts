import type { Accessor } from "solid-js"
import type { ActiveComposerAdapter, ComposerControls } from "@/composer/adapter"
import { useComposerState } from "@/composer/persistence"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useOpenAGIWorkflow, workflowSessionMetadata } from "@/runtime/extension/openagi-workflow"
import { useLanguage } from "@/runtime/i18n/language"
import { buildPromptRequest } from "@/composer/request"
import { showToast } from "@/shell/notifications/toast"

export function createActiveComposerAdapter(input: {
  sessionID: string
  controls: Accessor<ComposerControls>
  submitted: () => void
  setEditor: (element: HTMLDivElement) => void
}) {
  const id = input.sessionID

  const prompt = useComposerState()
  prompt.current()
  const state = prompt.capture()
  const data = useData()
  const server = useServerSDK()
  const location = useWorkspaceLocation()
  const workflow = useOpenAGIWorkflow()
  const language = useLanguage()
  const unavailable = () => new Error(language.t("openagi.workflow.unavailable"))

  const adapter: ActiveComposerAdapter = {
    kind: "active-session",
    state,
    ready: prompt.ready,
    controls: input.controls,
    working: () =>
      data.session.status(id) === "running" ||
      (workflow.active() && workflow.project()?.phase !== "idle" && !!workflow.project()),
    submitted: input.submitted,
    setEditor: input.setEditor,
    session: () => ({
      id,
      directory: location().directory,
      api: server.api.session,
      data,
      current: () => data.session.get(id),
      admitted: (messageID) => data.session.input.has(id, messageID) || !!data.session.message.get(id, messageID),
    }),
    interrupt: () =>
      workflow.active()
        ? Promise.resolve()
            .then(async () => {
              const client = workflow.client()
              const directory =
                workflow.project()?.directory ?? workflowSessionMetadata(data.session.get(id))?.directory
              // Explicit shell commands keep the native master's own execution and interruption ownership.
              if (data.session.status(id) === "running")
                await server.api.session.interrupt({ sessionID: id, resume: false })
              if (!client || !directory) throw unavailable()
              return client.pause({ directory })
            })
            .then(() => undefined)
            .catch((error) => {
              showToast({
                title: language.t("common.requestFailed"),
                description: error instanceof Error ? error.message : String(error),
              })
            })
        : server.api.session
            .interrupt({ sessionID: id, resume: true })
            .then(() => undefined)
            .catch(() => undefined),
    submission: {
      enabled: workflow.active,
      send: async (input) => {
        const client = workflow.client()
        const directory = workflow.project()?.directory ?? workflowSessionMetadata(data.session.get(id))?.directory
        if (!client || !directory) throw unavailable()
        if (input.prompt.some((item) => item.type === "image"))
          throw new Error(language.t("openagi.workflow.imageUnsupported"))
        const request = buildPromptRequest({ ...input, images: [], sessionDirectory: directory })
        const text = [request.text, ...request.files.map((file) => `Reference: ${file.uri}`)].filter(Boolean).join("\n")
        await client.submit({ directory, text })
      },
    },
  }

  return adapter
}
