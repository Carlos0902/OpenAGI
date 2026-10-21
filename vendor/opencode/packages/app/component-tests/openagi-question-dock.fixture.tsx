import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { CurrentSessionProviders, emptySessionDocument } from "@opencode/session-ui/storybook"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { LanguageProvider } from "../src/runtime/i18n/language"
import { WorkflowQuestionDock } from "../src/session/requests/openagi-question-dock"

export function mountWorkflowQuestionDock() {
  const host = document.createElement("main")
  host.dataset.testid = "workflow-question-fixture"
  host.style.cssText = "position:fixed;inset:24px;z-index:1000;display:flex;flex-direction:column;background:var(--v2-background-bg-base)"
  document.body.appendChild(host)
  function Fixture() {
    const [answer, setAnswer] = createSignal("")
    const [open, setOpen] = createSignal(true)
    const [secret, setSecret] = createSignal(false)
    return <LanguageProvider locale="en"><DialogProvider><QueryClientProvider client={new QueryClient()}>
      <CurrentSessionProviders document={emptySessionDocument}>
        <div class="flex-1">Conversation remains interactive <button onClick={() => setAnswer("conversation-clicked")}>Inspect conversation</button></div>
        <button onClick={() => { setSecret(true); setOpen(true) }}>Request hidden key</button>
        <output>{answer()}</output>
        <div data-component="session-composer-dock">
          <Show when={open()}><WorkflowQuestionDock
            prompt={() => ({ id: secret() ? "secret" : "choice", text: secret() ? "Enter your key" : "How should this task continue?", secret: secret(), choices: [{ value: "save", label: "Save baseline" }, { value: "retry", label: "Retry" }] })}
            sessionID="ses_workflow"
            reply={async (id, text) => { setAnswer(id === "secret" ? "secret-received" : `${id}:${text}`); setOpen(false) }}
            cancel={async () => { setAnswer("paused"); setOpen(false) }}
            onSubmit={() => {}}
          /></Show>
          <textarea aria-label="Message composer" />
        </div>
      </CurrentSessionProviders>
    </QueryClientProvider></DialogProvider></LanguageProvider>
  }
  render(() => <Fixture />, host)
}
