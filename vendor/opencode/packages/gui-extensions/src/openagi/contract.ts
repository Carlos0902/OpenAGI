import { Schema } from "effect"
import { Ipc } from "../sdk"

const OptionalString = Schema.optional(Schema.String)

export const UsageSummary = Schema.Struct({
  total: Schema.Number,
  requests: Schema.Number,
  unreported: Schema.Number,
  updatedAt: OptionalString,
  error: OptionalString,
  models: Schema.Array(Schema.Struct({
    providerID: Schema.String, modelID: Schema.String, requests: Schema.Number, unreported: Schema.Number,
    input: Schema.Number, output: Schema.Number, reasoning: Schema.Number,
    cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }), total: Schema.Number,
  })),
})

export const WorkflowSession = Schema.Struct({
  serverId: Schema.String,
  directory: Schema.String,
  sessionId: Schema.String,
  mainSessionId: OptionalString,
  mode: Schema.String,
  purpose: OptionalString,
  label: Schema.String,
  focus: Schema.optional(Schema.Boolean),
  outcome: Schema.optional(Schema.Literals(["running", "succeeded", "failed", "interrupted"])),
})

export const WorkflowProject = Schema.Struct({
  usage: Schema.optional(UsageSummary),
  directory: Schema.String,
  name: Schema.String,
  summary: OptionalString,
  draftSummary: OptionalString,
  awaitingInput: Schema.optional(Schema.Boolean),
  delivery: Schema.optional(Schema.Struct({ goal: Schema.String, taskIDs: Schema.Array(Schema.String), createdAt: Schema.String, source: OptionalString, markdown: Schema.String })),
  mainSessionId: OptionalString,
  queuedInput: Schema.optional(Schema.Number),
  error: OptionalString,
  phase: Schema.Literals(["idle", "running", "configuring", "stopping"]),
  activity: Schema.optional(Schema.Literals(["discovering", "collecting", "assessing", "planning", "preparing", "researching", "implementing", "validating", "merging", "discussing", "handoff"])),
  config: Schema.optional(Schema.Struct({ heavy: Schema.String, light: Schema.String })),
  prompt: Schema.optional(Schema.Struct({ id: Schema.String, text: Schema.String, secret: Schema.Boolean, choices: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String, description: OptionalString }))) })),
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, role: Schema.String, text: Schema.String, at: Schema.String }),
  ),
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.String,
      status: Schema.String,
      priority: Schema.Number,
      acceptanceCriteria: Schema.Array(Schema.String),
      rationale: Schema.String,
      run: Schema.optional(
        Schema.Struct({
          status: Schema.String,
          branch: OptionalString,
          sessionId: OptionalString,
          error: OptionalString,
          checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean })),
          acceptance: OptionalString,
          acceptanceDetails: Schema.optional(Schema.Array(Schema.Struct({ criterion: Schema.String, passed: Schema.Boolean, evidence: Schema.String, kind: Schema.Literals(["requirement", "measurement"]) }))),
        }),
      ),
    }),
  ),
})

export const NetworkProfile = Schema.Struct({ enabled: Schema.Boolean, proxyURL: Schema.String, noProxy: Schema.String })

const ProviderType = Schema.Literals(["openai-compatible", "openai", "anthropic", "google"])

const ModelSelection = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })

const ProviderModel = Schema.Struct({ id: Schema.String, name: OptionalString, contextWindow: Schema.optional(Schema.Number), maxOutputTokens: Schema.optional(Schema.Number) })

const ProviderEdit = Schema.Struct({ name: OptionalString, models: Schema.optional(Schema.Array(ProviderModel)), headers: Schema.optional(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))), id: Schema.String, type: ProviderType, baseURL: Schema.String, apiKey: OptionalString, contextWindow: Schema.Number, maxOutputTokens: Schema.Number })

export const ConfigurationView = Schema.Struct({ file: Schema.String, providers: Schema.Array(Schema.Struct({ id: Schema.String, type: ProviderType, baseURL: Schema.String, contextWindow: Schema.Number, maxOutputTokens: Schema.Number, name: OptionalString, models: Schema.optional(Schema.Array(ProviderModel)), headerNames: Schema.optional(Schema.Array(Schema.String)), hasKey: Schema.Boolean })), models: Schema.Struct({ heavy: ModelSelection, light: ModelSelection }), jevConfigured: Schema.Boolean })

export const WorkflowState = Schema.Struct({
  configuration: Schema.optional(ConfigurationView),
  network: Schema.optional(NetworkProfile),
  selectedProject: OptionalString,
  projects: Schema.Array(WorkflowProject),
  servers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      directory: Schema.String,
      state: Schema.Literals(["connected", "starting", "stopped"]),
      http: Schema.optional(Schema.Struct({ url: Schema.String, username: OptionalString, password: OptionalString })),
    }),
  ),
  sessions: Schema.Array(WorkflowSession),
})

export const ProjectTarget = Schema.Struct({ server: Schema.String, directory: Schema.String })

/** Only local backend credentials cross this bridge; provider and TypeSafe keys never occur in its state. */
export const OpenAGI = Ipc.define({
  id: "openagi",
  state: WorkflowState,
  methods: {
    saveProvider: { input: ProviderEdit },
    removeProvider: { input: Schema.Struct({ id: Schema.String }) },
    providerModels: { input: Schema.Struct({ id: Schema.String }), output: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, contextWindow: Schema.optional(Schema.Number), maxOutputTokens: Schema.optional(Schema.Number) })) },
    selectModel: { input: Schema.Struct({ role: Schema.Literals(["heavy", "light"]), providerID: Schema.String, modelID: Schema.String }) },
    saveJev: { input: Schema.Struct({ apiKey: Schema.String }) },
    networkConfig: { input: NetworkProfile },
    testNetwork: { output: Schema.Struct({ ok: Schema.Boolean, message: Schema.String }) },
    pickProject: { output: Schema.NullOr(ProjectTarget) },
    project: { input: Schema.Struct({ directory: Schema.String }), output: ProjectTarget },
    run: {
      input: Schema.Struct({
        directory: Schema.String,
        summary: OptionalString,
        resume: Schema.optional(Schema.Boolean),
      }),
    },
    config: { input: Schema.Struct({ directory: Schema.String }) },
    answer: { input: Schema.Struct({ directory: Schema.String, id: Schema.String, text: Schema.String }) },
    submit: { input: Schema.Struct({ directory: Schema.String, text: Schema.String }) },
    pause: { input: Schema.Struct({ directory: Schema.String }) },
    forget: { input: Schema.Struct({ directory: Schema.String }) },
  },
  events: { session: WorkflowSession },
})

export type WorkflowState = typeof WorkflowState.Type

export type WorkflowProject = typeof WorkflowProject.Type

export type WorkflowSession = typeof WorkflowSession.Type

/** The app's tiny route adapter consumes this event through its existing tab controller. */
export const OPEN_SESSION_EVENT = "openagi:open-session"
