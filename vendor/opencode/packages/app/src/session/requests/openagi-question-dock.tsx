import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { useOpenAGIWorkflow } from "@/runtime/extension/openagi-workflow"
import { useLanguage } from "@/runtime/i18n/language"
import type { WorkflowProject } from "@opencode/gui-extensions/openagi/contract"
import { SessionQuestionDock } from "./session-question-dock"

type Prompt = NonNullable<WorkflowProject["prompt"]>

/** OpenAGI requests occupy the original composer dock, with the original question interactions. */
export function OpenAGIQuestionDock(props: { onSubmit: () => void }) {
  const workflow = useOpenAGIWorkflow()
  const language = useLanguage()
  const [dismissed, setDismissed] = createSignal("")
  const prompt = createMemo<Prompt | undefined>(() => {
    if (!workflow.active()) return
    const project = workflow.project()
    if (!project) return
    if (project.prompt) return project.prompt
    if (project.phase !== "idle" || project.error || project.awaitingInput) return
    const id = `start:${project.mainSessionId}:${project.summary ?? ""}`
    if (dismissed() === id) return
    return { id, secret: false, text: language.t(project.summary ? "session.workflow.startAgain" : "session.workflow.startHint"),
      choices: project.summary ? [{ value: "/resume", label: language.t("session.workflow.resume") }] : [], }
  })
  return <Show when={prompt()?.id} keyed>
    {id => <WorkflowQuestionDock
      prompt={() => prompt()?.id === id ? prompt() : undefined}
      sessionID={workflow.project()?.mainSessionId ?? ""}
      reply={async (id, text) => {
        const project = workflow.project()
        const client = workflow.client()
        if (!project || !client || prompt()?.id !== id) throw new Error(language.t("session.workflow.questionUnavailable"))
        if (project.prompt) await client.answer({ directory: project.directory, id, text })
        else if (text.trim()) await client.submit({ directory: project.directory, text })
        else throw new Error(language.t("session.workflow.startHint"))
      }}
      cancel={async () => {
        if (prompt()?.id !== id) throw new Error(language.t("session.workflow.questionUnavailable"))
        const project = workflow.project()
        if (project?.prompt) await workflow.client()?.pause({ directory: project.directory })
        else setDismissed(prompt()?.id ?? "")
      }}
      onSubmit={props.onSubmit}
    />}
  </Show>
}

/** The same native form UI can answer a workflow request without creating a model session. */
export function WorkflowQuestionDock(props: {
  prompt: Accessor<Prompt | undefined>
  sessionID: string
  reply(id: string, text: string): Promise<void>
  cancel(): Promise<void>
  onSubmit(): void
}) {
  const language = useLanguage()
  const prompt = props.prompt()
  if (!prompt) return null
  const [validationError, setValidationError] = createSignal("")
  return <div>
    <Show when={validationError()}><p role="alert" class="p-3 text-13-regular text-v2-text-text-negative">{validationError()}</p></Show>
    <Show when={prompt.secret} fallback={
    <SessionQuestionDock
      request={{ id: prompt.id, sessionID: props.sessionID, title: language.t("session.workflow.answer"), fields: [{
        type: "string", key: "answer", title: language.t("session.workflow.answer"), description: prompt.text,
        options: [...(prompt.choices ?? [])], custom: true,
      }] }}
      onSubmit={props.onSubmit}
      response={{
        reply: async (answer) => {
          const value = answer.answer
          if (typeof value !== "string") {
            const message = language.t("session.workflow.responseRequired")
            setValidationError(message)
            throw new Error(message)
          }
          setValidationError("")
          await props.reply(prompt.id, value)
        },
        cancel: props.cancel,
      }}
    />
  }>
    <SecretQuestionDock prompt={prompt} reply={props.reply} cancel={props.cancel} onSubmit={props.onSubmit} />
  </Show>
  </div>
}

function SecretQuestionDock(props: {
  prompt: Prompt
  reply(id: string, text: string): Promise<void>
  cancel(): Promise<void>
  onSubmit(): void
}) {
  const language = useLanguage()
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [minimized, setMinimized] = createSignal(false)
  const [error, setError] = createSignal("")
  const send = async (cancel: boolean) => {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
      if (cancel) await props.cancel()
      else await props.reply(props.prompt.id, value())
      setValue("")
      props.onSubmit()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  return <DockPrompt kind="question"
    header={<>
      <div data-slot="question-header-title">{language.t("session.workflow.answer")}</div>
      <IconButton variant="ghost" icon={<Icon name="chevron-down" size="small" />} aria-label={language.t(minimized() ? "session.question.restore" : "session.question.minimize")} onClick={() => setMinimized(!minimized())} />
    </>}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); void send(true) }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void send(false) }
    }}
    footer={<>
      <Button variant="ghost" disabled={busy()} onClick={() => void send(true)}>{language.t("ui.common.dismiss")}</Button>
      <Button variant="submit" disabled={busy()} onClick={() => void send(false)}>{language.t("ui.common.submit")}</Button>
    </>}
  >
    <Show when={!minimized()}>
    <p class="whitespace-pre-wrap p-3 text-14-regular">{props.prompt.text}</p>
    <TextInput type="password" autocomplete="off" aria-label={language.t("session.workflow.secret")} value={value()} disabled={busy()} onInput={event => setValue(event.currentTarget.value)} />
    <Show when={error()}><p role="alert" class="p-3 text-v2-text-text-negative">{error()}</p></Show>
    </Show>
  </DockPrompt>
}
