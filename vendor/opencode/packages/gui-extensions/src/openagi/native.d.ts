declare module "@openagi/native" {
  export function createOpenAGIBridge(options: { signal: AbortSignal }): Promise<{
    saveProvider(input: { name?: string; models?: readonly { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }[]; headers?: readonly { key: string; value: string }[]; id: string; type: "openai-compatible" | "openai" | "anthropic" | "google"; baseURL: string; apiKey?: string; contextWindow: number; maxOutputTokens: number }): Promise<void>
    removeProvider(id: string): Promise<void>
    providerModels(id: string): Promise<{ id: string; name: string; contextWindow?: number; maxOutputTokens?: number }[]>
    selectModel(role: "heavy" | "light", ref: { providerID: string; modelID: string }): Promise<void>
    saveJev(apiKey: string): Promise<void>
    networkConfig(input: { enabled: boolean; proxyURL: string; noProxy: string }): Promise<void>
    testNetwork(): Promise<{ ok: boolean; message: string }>
    state(): import("./contract").WorkflowState
    project(directory: string, input?: { select?: boolean }): Promise<void>
    rememberSessions(sessions: readonly import("./contract").WorkflowSession[]): void | Promise<void>
    run(directory: string, options: { summary?: string; resume?: boolean }): Promise<void>
    config(directory: string): Promise<void>
    answer(directory: string, id: string, text: string): Promise<void>
    submit(directory: string, text: string): Promise<void>
    pause(directory: string): Promise<void>
    forget(directory: string): Promise<void>
    subscribe(listener: () => void): () => void
    onSession(listener: (session: import("./contract").WorkflowSession) => void): () => void
    close(): Promise<void>
  }>
}
