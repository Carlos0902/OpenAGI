import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@opencode/ui/context/dialog"
import type { SessionDocument } from "@opencode/session-ui/document"
import { CurrentSessionProviders, inspectAndExplainDocument } from "@opencode/session-ui/storybook"
import { LanguageProvider } from "../src/runtime/i18n/language"
import { WorkflowDelivery } from "../src/session/workflow-delivery"
import { WorkflowAcceptanceDetails } from "../src/session/workflow-acceptance-details"
import { OpenAGIWorkflowModule } from "../src/session/openagi-workflow-module"

function moduleDocument(id: string, label: string): SessionDocument {
  return {
    ...structuredClone(inspectAndExplainDocument),
    sessionID: id,
    status: { type: "busy" },
    messages: inspectAndExplainDocument.messages.map((message) => {
      const copy = structuredClone(message)
      if (copy.type === "user")
        return {
          ...copy,
          id: `${id}:${copy.id}`,
          text: "Private instructions and internal schema.",
          metadata: { displayText: label, comments: [], collapsed: true, resultPresentation: { keys: ["proposals"] } },
        }
      if (copy.type !== "assistant") return { ...copy, id: `${id}:${copy.id}` }
      return {
        ...copy,
        id: `${id}:${copy.id}`,
        content: copy.content.map((content) =>
          content.type === "tool"
            ? { ...content, id: `${id}:${content.id}` }
            : content.type === "text"
              ? {
                  ...content,
                  text:
                    id === "worker"
                      ? `Worker is preparing the implementation. ${"More context. ".repeat(35)}\n\nDetailed worker delivery remains available in the expanded transcript.\n\n- Implemented the game.\n- Verified movement.\n- Verified collisions.`
                      : `${label} is checking the project.\n{ "proposals": [{ "title": "hidden-machine-result" }] }`,
                }
              : content,
        ),
      }
    }),
  }
}

export function mountWorkflowTimeline() {
  const host = document.createElement("main")
  host.dataset.testid = "workflow-timeline-fixture"
  host.style.cssText = "position:fixed;inset:24px;z-index:1000;overflow:auto;background:var(--v2-background-bg-base)"
  document.body.appendChild(host)
  function Fixture() {
    const [store, setStore] = createStore({
      collectorOutcome: undefined as "running" | "failed" | "succeeded" | undefined,
      modules: [
        { label: "Tutor · function-finder", document: moduleDocument("function", "Tutor · function-finder") },
        { label: "Tutor · UI Designer", document: moduleDocument("design", "Tutor · UI Designer") },
      ],
    })
    const collectorSource = moduleDocument("collector", "Collector")
    const collectorAssistant = collectorSource.messages.findLast(message => message.type === "assistant")
    if (!collectorAssistant || collectorAssistant.type !== "assistant") throw new Error("Missing fixture assistant")
    const collector: SessionDocument = { ...collectorSource, status: { type: "idle" }, messages: [
      ...collectorSource.messages.filter(message => message.type !== "idle"),
      { ...collectorAssistant, id: "collector-json-start", content: [{ type: "text", text: '{"proposals":[{"reevaluateWhen":[' }] },
      { ...collectorAssistant, id: "collector-json-tail", content: [{ type: "text", text: '"If the user later requests touch input, reassess."]}]}' }] },
    ] }
    const stream = () =>
      setStore("modules", 0, "document", "messages", (messages) =>
        messages.map((message) =>
          message.type === "assistant"
            ? {
                ...message,
                content: message.content.map((content) =>
                  content.type === "text" ? { ...content, text: 'New streaming progress.\n{ "proposals": [' } : content,
                ),
              }
            : message,
        ),
      )
    return (
      <LanguageProvider>
        <DialogProvider>
          <button onClick={stream}>Stream progress</button>
          <button
            onClick={() => {
              setStore("modules", (modules) =>
                modules.map((module) => ({ ...module, document: { ...module.document, status: { type: "idle" } } })),
              )
              setStore("modules", (modules) => [
                ...modules,
                {
                  label: "Worker · Implement game",
                  document: { ...moduleDocument("worker", "Worker"), status: { type: "idle" } },
                },
                {
                  label: "Validator · Check game",
                  document: { ...moduleDocument("validator", "Validator"), status: { type: "idle" } },
                },
              ])
            }}
          >
            Complete and continue
          </button>
          <button
            disabled={store.modules.length < 3}
            onClick={() => {
              setStore("modules", 2, "document", "status", { type: "idle" })
              setStore("modules", 2, "document", "messages", (messages) => [
                ...messages,
                {
                  id: "worker-interrupted",
                  type: "idle" as const,
                  outcome: "interrupted" as const,
                  time: { created: 1735689680000 },
                },
              ])
            }}
          >
            Pause Worker
          </button>
          <button
            disabled={store.modules.length < 3}
            onClick={() => setStore("modules", 2, "document", "status", { type: "busy" })}
          >
            Resume Worker
          </button>
          <button
            disabled={store.modules.length < 3}
            onClick={() => {
              setStore("modules", 2, "document", "messages", (messages) => [
                ...messages,
                {
                  id: "worker-succeeded",
                  type: "idle" as const,
                  outcome: "succeeded" as const,
                  time: { created: 1735689690000 },
                },
              ])
              setStore("modules", 2, "document", "status", { type: "idle" })
            }}
          >
            Finish Worker
          </button>
          <button
            disabled={store.modules.length < 3}
            onClick={() => {
              setStore("modules", 2, "document", "status", { type: "busy" })
              setStore("modules", 2, "document", "messages", (messages) =>
                messages.map((message) =>
                  message.type === "assistant"
                    ? {
                        ...message,
                        content: message.content.map((content) =>
                          content.type === "text"
                            ? {
                                ...content,
                                text: `Worker is preparing the updated implementation. ${"More context. ".repeat(35)}\n\nDetailed worker delivery remains available in the expanded transcript.`,
                              }
                            : content,
                        ),
                      }
                    : message,
                ),
              )
            }}
          >
            Update Worker progress
          </button>
          <button onClick={() => setStore("collectorOutcome", "running")}>Assess result</button>
          <button onClick={() => setStore("collectorOutcome", "failed")}>Fail assessment</button>
          <button onClick={() => setStore("collectorOutcome", "succeeded")}>Complete assessment</button>
          <CurrentSessionProviders document={collector}>
            <WorkflowDelivery guide={{ source: "README.md", markdown: "Open `index.html` and choose Start. Arrow keys move the piece." }} />
          </CurrentSessionProviders>
          <WorkflowAcceptanceDetails title="Acceptance fixture" criteria={[
            { criterion: "Restart preserves the initial state", passed: false, evidence: "A stale timer survives restart.", kind: "requirement" },
            { criterion: "Rendering p95 improves by 20%", passed: false, evidence: "Measured improvement was 15%; behavior is correct.", kind: "measurement" },
          ]} />
          <div data-component="workflow-main-conversation">
            <For each={store.modules}>
              {(module) => (
                <CurrentSessionProviders document={module.document}>
                  <OpenAGIWorkflowModule
                    label={module.label}
                    document={module.document}
                    presentation={Object.fromEntries(
                      module.document.messages
                        .filter((message) => message.type === "user")
                        .map((message) => [
                          message.id,
                          { displayText: module.label, collapsed: true, resultPresentation: { keys: ["proposals"] } },
                        ]),
                    )}
                  />
                </CurrentSessionProviders>
              )}
            </For>
            <Show when={store.collectorOutcome}>
              <CurrentSessionProviders document={collector}>
                <OpenAGIWorkflowModule
                  label="Collector"
                  document={collector}
                  invocationOutcome={store.collectorOutcome}
                  presentation={Object.fromEntries(
                    collector.messages
                      .filter((message) => message.type === "user")
                      .map((message) => [
                        message.id,
                        { collapsed: true, displayText: "Collector", resultPresentation: { keys: ["proposals"] } },
                      ]),
                  )}
                />
              </CurrentSessionProviders>
            </Show>
          </div>
        </DialogProvider>
      </LanguageProvider>
    )
  }
  return render(Fixture, host)
}
