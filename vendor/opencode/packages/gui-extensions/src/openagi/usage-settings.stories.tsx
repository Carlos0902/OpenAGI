import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useExtension } from "../sdk"
import type definition from "./index"
import type { WorkflowProject } from "./contract"
import UsageSettings from "./usage-settings"

export default { title: "OpenAGI/Usage", id: "openagi-usage", component: UsageSettings }

export const ProjectUsage = { render: () => <UsageFixture /> }

function UsageFixture() {
  const extension = useExtension<typeof definition>()

  const [state, setState] = createStore<{ projects: WorkflowProject[] }>({ projects: [
    { directory: "/projects/ledger", name: "Ledger", phase: "running", messages: [], tasks: [], usage: { total: 1000, requests: 2, unreported: 0, models: [
      { providerID: "primary", modelID: "heavy", requests: 2, unreported: 0, input: 500, output: 100, reasoning: 200, cache: { read: 150, write: 50 }, total: 1000 },
    ] } },
    { directory: "/projects/game", name: "Game", phase: "idle", messages: [], tasks: [], usage: { total: 90, requests: 2, unreported: 1, models: [
      { providerID: "primary", modelID: "heavy", requests: 1, unreported: 1, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
      { providerID: "typesafe", modelID: "jev-latest", requests: 1, unreported: 0, input: 80, output: 10, reasoning: 0, cache: { read: 0, write: 0 }, total: 90 },
    ] } },
  ] })

  return <div class="settings-panel">
    <Button onClick={() => setState("projects", 0, "usage", "error", "sync")}>Simulate unavailable backend</Button>
    <UsageSettings ctx={extension} projects={() => state.projects} directory={() => "/projects/ledger"} />
  </div>
}
