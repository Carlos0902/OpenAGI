import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { withinProject } from "./boundary.js";
import { z } from "zod";
import type { AgentRuntime, AgentRequest, AgentReply, SearchSource, RunMode } from "./runtime.js";

export interface OpenCodeOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  /** Active execution budget; time spent awaiting explicit human forms/permissions is excluded. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onInteraction?: (pending: PendingInteraction) => Promise<InteractionReply[]>;
  workspaceRoot?: string;
  onSession?: (session: { sessionId: string; directory: string; mode: RunMode; purpose?: string; label: string }) => void;
  nativeInteractions?: boolean;
  workflow?: { mainSessionId: string; directory: string };
}

export interface PendingInteraction { sessionId: string; permissions: Record<string, unknown>[]; forms: Record<string, unknown>[] }
export type InteractionReply =
  | { kind: "permission"; id: string; decision: "once" | "always" | "reject" }
  | { kind: "form"; id: string; answer: Record<string, string | number | boolean | string[]> };

export class OpenCodeError extends Error {
  constructor(
    public readonly kind: "version" | "http" | "contract" | "session" | "failed" | "pending" | "interrupted" | "timeout" | "aborted" | "transport",
    message: string,
    public readonly sessionId?: string,
    public readonly pending?: { permissions: unknown[]; forms: unknown[] },
    public readonly connection?: { url: string; code?: string },
    public readonly status?: number,
  ) {
    super(sessionId ? `${message} (OpenCode session ${sessionId})` : message);
    this.name = "OpenCodeError";
  }
}

const SessionResponse = z.object({ data: z.object({ id: z.string().startsWith("ses"), location: z.object({ directory: z.string() }), metadata: z.record(z.string(), z.unknown()).optional() }) });
const AdmissionResponse = z.object({ data: z.object({ id: z.string().startsWith("msg_"), sessionID: z.string(), type: z.literal("user") }) });
const Message = z.object({
  id: z.string(), type: z.string(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
  error: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional(), name: z.string().optional(), state: z.object({ input: z.unknown().optional(), error: z.unknown().optional() }).passthrough().optional() })).optional(),
});
const MessagesResponse = z.object({ data: z.array(Message), cursor: z.object({ next: z.string().nullish(), previous: z.string().nullish() }) });
const PendingResponse = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) });
const SearchResponse = z.object({ data: z.object({
  providerID: z.string(),
  results: z.array(z.object({ url: z.string().url(), title: z.string().nullish(), content: z.string().nullish(), time: z.object({ published: z.number().nullish() }) })),
}) });

/** A thin adapter over v2's durable sessions, existing tools, and web search. */
export class OpenCodeRuntime implements AgentRuntime {
  private readonly baseUrl: URL;
  private readonly headers: Headers;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private verified = false;

  constructor(private readonly options: OpenCodeOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? "http://127.0.0.1:4096");
    if (!["http:", "https:"].includes(this.baseUrl.protocol)) throw new Error("OpenCode URL must use HTTP or HTTPS");
    if (this.baseUrl.search || this.baseUrl.hash) throw new Error("OpenCode URL must not contain query parameters or a fragment");
    const username = options.username ?? (this.baseUrl.username ? decodeURIComponent(this.baseUrl.username) : "opencode");
    const password = options.password ?? (this.baseUrl.password ? decodeURIComponent(this.baseUrl.password) : undefined);
    this.baseUrl.username = "";
    this.baseUrl.password = "";
    this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/$/, "");
    this.headers = new Headers({ "content-type": "application/json", accept: "application/json" });
    if (password !== undefined) this.headers.set("authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) throw new Error("pollIntervalMs must be positive");
  }

  async check(): Promise<void> {
    const timeout = AbortSignal.timeout(Math.min(this.timeoutMs, 10_000));
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    try { await this.verify(signal); }
    catch (error) {
      if (signal.aborted) throw new OpenCodeError(timeout.aborted ? "timeout" : "aborted", `连接 OpenCode 服务${timeout.aborted ? "超时" : "已取消"}：${this.baseUrl}`, undefined, undefined, { url: this.baseUrl.toString() });
      if (error instanceof OpenCodeError) throw error;
      throw new OpenCodeError("contract", `服务没有返回可识别的 OpenCode v2 信息：${this.baseUrl}。${describe(error)}`);
    }
  }
  async waitForProjectGuard(directory: string): Promise<void> {
    const timeout = AbortSignal.timeout(20_000);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const query = new URLSearchParams({ "location[directory]": directory });
    while (true) {
      signal.throwIfAborted();
      const response = z.object({ data: z.array(z.object({ id: z.string().nullish(), state: z.object({ status: z.string(), error: z.string().optional() }) })) }).parse(await this.request("GET", `/api/plugin?${query}`, undefined, signal));
      const guard = response.data.find(plugin => plugin.id === "openagi.project.guard");
      if (guard?.state.status === "active") return;
      if (guard?.state.status === "failed") throw new OpenCodeError("contract", "当前项目的文件访问保护插件未能启动；已停止模型执行。");
      await delay(100, undefined, { signal });
    }
  }

  /** A durable native view container; creating it never admits a model prompt. */
  async workflowSession(directory: string, title: string, savedId?: string): Promise<string> {
    if (this.options.workspaceRoot) await withinProject(this.options.workspaceRoot, directory);
    const deadline = AbortSignal.timeout(20_000);
    const signal = this.options.signal ? AbortSignal.any([deadline, this.options.signal]) : deadline;
    await this.verify(signal);
    if (savedId) {
      let existing;
      try { existing = SessionResponse.parse(await this.request("GET", `/api/session/${encodeURIComponent(savedId)}`, undefined, signal)).data; }
      catch (error) { if (!(error instanceof OpenCodeError && error.status === 404)) throw error; }
      if (existing) {
        const owner = z.object({ kind: z.literal("workflow"), directory: z.string() }).safeParse(existing.metadata?.openagi);
        if (resolve(existing.location.directory) !== resolve(directory) || !owner.success || resolve(owner.data.directory) !== resolve(directory)) throw new OpenCodeError("session", "The saved workflow view belongs to a different project", savedId);
        await this.request("PATCH", `/api/session/${encodeURIComponent(savedId)}`, { title }, signal);
        return savedId;
      }
    }
    const owned = z.object({ kind: z.literal("workflow"), directory: z.string() });
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ directory: resolve(directory), limit: "100" });
      if (cursor) query.set("cursor", cursor); else query.set("order", "desc");
      const listed = z.object({ data: z.array(SessionResponse.shape.data), cursor: z.object({ next: z.string().nullish() }) }).parse(await this.request("GET", `/api/session?${query}`, undefined, signal));
      const existing = listed.data.find(item => { const owner = owned.safeParse(item.metadata?.openagi); return owner.success && resolve(item.location.directory) === resolve(directory) && resolve(owner.data.directory) === resolve(directory); });
      if (existing) { await this.request("PATCH", `/api/session/${encodeURIComponent(existing.id)}`, { title }, signal); return existing.id; }
      cursor = listed.cursor.next ?? undefined;
    } while (cursor);
    return SessionResponse.parse(await this.request("POST", "/api/session", {
      title, agent: "build", location: { directory: resolve(directory) },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      metadata: { openagi: { kind: "workflow", directory: resolve(directory) } },
    }, signal)).data.id;
  }

  /** Associate an existing native transcript without changing its context, permissions or execution. */
  async linkWorkflowSession(sessionId: string, owner: { mainSessionId: string; directory: string; mode: string; label: string }): Promise<void> {
    const deadline = AbortSignal.timeout(20_000);
    const signal = this.options.signal ? AbortSignal.any([deadline, this.options.signal]) : deadline;
    await this.verify(signal);
    const existing = SessionResponse.parse(await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}`, undefined, signal)).data;
    await withinProject(owner.directory, existing.location.directory);
    const openagi = { kind: "module", ...owner };
    if (JSON.stringify(existing.metadata?.openagi) === JSON.stringify(openagi)) return;
    await this.request("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { metadata: { ...existing.metadata, openagi } }, signal);
  }

  async run(request: AgentRequest): Promise<AgentReply> {
    if (this.options.workspaceRoot) await withinProject(this.options.workspaceRoot, request.directory);
    const deadline = new AbortController();
    const timeout = deadline.signal;
    let remaining = this.timeoutMs;
    let started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => deadline.abort(new DOMException("Execution timed out", "TimeoutError")), remaining);
    const waitingForUser = (waiting: boolean) => {
      if (waiting && timer) {
        clearTimeout(timer); timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - started));
      } else if (!waiting && !timer && !timeout.aborted) {
        started = Date.now();
        timer = setTimeout(() => deadline.abort(new DOMException("Execution timed out", "TimeoutError")), remaining);
      }
    };
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const waiting = new AbortController();
    let sessionId = request.sessionId;
    let admitted = false;
    const lease = randomUUID();
    let refreshedAt = 0;
    let leased = false;
    const keepInteractionAlive = async (pending: PendingInteraction) => {
      if (!sessionId || Date.now() - refreshedAt < 60_000) return;
      // v2 expires location services after an hour without a durable Session event,
      // even while Form.ask awaits input. Polling GET endpoints does not renew that lease.
      const current = SessionResponse.parse(await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}`, undefined, signal)).data;
      await this.request("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { metadata: {
        ...current.metadata, openagiInteraction: { lease, waitingSince: new Date().toISOString(), forms: pending.forms.map(form => form.id), permissions: pending.permissions.map(permission => permission.id) },
      } }, signal);
      refreshedAt = Date.now(); leased = true;
    };
    const releaseInteraction = async () => {
      if (!leased || !sessionId) return;
      const cleanup = AbortSignal.timeout(5_000);
      const current = SessionResponse.parse(await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}`, undefined, cleanup)).data;
      const marker = z.object({ lease: z.string() }).safeParse(current.metadata?.openagiInteraction);
      if (!marker.success || marker.data.lease !== lease) return;
      const metadata = { ...current.metadata }; delete metadata.openagiInteraction;
      await this.request("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { metadata }, cleanup);
      leased = false;
    };
    try {
      await this.verify(signal);
      const permissions = rules(request.mode, !!this.options.workspaceRoot);
      const workflow = this.options.workflow ? { openagi: { kind: "module", mainSessionId: this.options.workflow.mainSessionId, directory: this.options.workflow.directory, mode: request.mode, label: request.label ?? request.mode } } : undefined;
      if (sessionId) {
        const session = SessionResponse.parse(await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}`, undefined, signal)).data;
        if (resolve(session.location.directory) !== resolve(request.directory)) throw new OpenCodeError("session", "Session directory does not match the requested project", sessionId);
        if (workflow) await this.request("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { metadata: { ...session.metadata, ...workflow } }, signal);
        if (request.label?.trim()) await this.request("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { title: request.label.trim().slice(0, 100) }, signal);
        this.options.onSession?.({ sessionId, directory: request.directory, mode: request.mode, purpose: request.purpose, label: request.label ?? request.mode });
        const pending = await this.pending(sessionId, signal);
        if (pending.permissions.length || pending.forms.length) {
          if (!this.options.onInteraction && !this.options.nativeInteractions) throw interactionRequired(sessionId, pending);
          admitted = true;
          waitingForUser(true);
          await keepInteractionAlive({ sessionId, ...pending });
          if (this.options.onInteraction) await this.answerInteractions(sessionId, pending, signal);
          else {
            let remaining = pending;
            while (remaining.permissions.length || remaining.forms.length) { await keepInteractionAlive({ sessionId, ...remaining }); await delay(this.pollIntervalMs, undefined, { signal }); remaining = await this.pending(sessionId, signal); }
          }
        }
        waitingForUser(false);
        const isActive = async () => z.object({ data: z.record(z.string(), z.object({ type: z.literal("running") })) }).parse(await this.request("GET", "/api/session/active", undefined, signal)).data[sessionId!];
        let active = await isActive();
        if (active && !this.options.onInteraction && !this.options.nativeInteractions) throw new OpenCodeError("session", "The previous execution is still running. Wait for it to finish before resuming the OpenAGI task", sessionId);
        while (active) {
          admitted = true;
          const interactions = await this.pending(sessionId, signal);
          waitingForUser(!!(interactions.permissions.length || interactions.forms.length));
          if (interactions.permissions.length || interactions.forms.length) await keepInteractionAlive({ sessionId, ...interactions });
          if ((interactions.permissions.length || interactions.forms.length) && this.options.onInteraction) await this.answerInteractions(sessionId, interactions, signal);
          await delay(this.pollIntervalMs, undefined, { signal });
          active = await isActive();
        }
        await this.request("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { permissions }, signal);
        if (request.model) await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/model`, { model: model(request) }, signal);
      } else {
        sessionId = SessionResponse.parse(await this.request("POST", "/api/session", {
          agent: "build", model: model(request), location: { directory: resolve(request.directory) }, permissions,
          ...(workflow ? { metadata: workflow } : {}),
          ...(request.label?.trim() ? { title: request.label.trim().slice(0, 100) } : {}),
        }, signal)).data.id;
        this.options.onSession?.({ sessionId, directory: request.directory, mode: request.mode, purpose: request.purpose, label: request.label ?? request.mode });
      }
      const path = `/api/session/${encodeURIComponent(sessionId)}`;
      // Admission may commit even if its HTTP response is lost or times out.
      admitted = true;
      const input = AdmissionResponse.parse(await this.request("POST", `${path}/prompt`, { text: request.prompt, delivery: "steer", resume: true, metadata: { displayText: request.label ?? request.purpose ?? request.mode, comments: [], collapsed: true, ...(request.resultKeys?.length ? { resultPresentation: { keys: request.resultKeys } } : {}) } }, signal)).data;
      if (input.sessionID !== sessionId) throw new OpenCodeError("contract", "Prompt was admitted to an unexpected session", sessionId);
      // Wait is upstream's idle boundary. Poll pending UI interactions while it blocks.
      const waitSignal = AbortSignal.any([signal, waiting.signal]);
      let settled: { error?: unknown } | undefined;
      const wait = this.wait(sessionId, waitSignal)
        .then(() => { settled = {}; }, (error: unknown) => { settled = { error }; });
      while (true) {
        signal.throwIfAborted();
        const pending = await this.pending(sessionId, signal);
        if (pending.permissions.length || pending.forms.length) {
          if (!this.options.onInteraction && !this.options.nativeInteractions) throw interactionRequired(sessionId, pending);
          waitingForUser(true);
          await keepInteractionAlive({ sessionId, ...pending });
          if (this.options.onInteraction) await this.answerInteractions(sessionId, pending, signal);
          else await delay(this.pollIntervalMs, undefined, { signal });
          continue;
        }
        waitingForUser(false);
        if (settled?.error) throw settled.error;
        if (settled) {
          const messages = await this.messages(sessionId, input.id, signal);
          const boundary = messages.findIndex((item) => item.id === input.id && item.type === "user");
          const current = boundary === -1 ? [] : messages.slice(0, boundary);
          const idle = current.find((item) => item.type === "idle");
          if (idle) {
            const assistant = current.find((item) => item.type === "assistant");
            if (idle.outcome !== "succeeded") {
              const tools = current.flatMap(message => message.content ?? []);
              const questions = tools.filter(tool => tool.type === "tool" && tool.name === "question" && tool.state?.error).flatMap(tool => {
                const parsed = z.object({ questions: z.array(z.object({ question: z.string() })) }).safeParse(tool.state?.input);
                return parsed.success ? parsed.data.questions.map(question => question.question) : [];
              });
              const detail = idle.error ?? assistant?.error ?? tools.find(tool => tool.state?.error)?.state?.error;
              const reason = questions.length ? `执行在等待以下问题时中断：${questions.join("；")}。这是当前任务的阻塞上下文，恢复时必须处理该问题，不能只重复继续指令。` : detail ? describe(detail) : "OpenCode 已结束本次执行但未附加错误信息；应由 OpenAGI 检查并恢复会话，用户无需排查内部错误。";
              throw new OpenCodeError(idle.outcome === "interrupted" ? "interrupted" : "failed", `Execution ${idle.outcome ?? "failed"}: ${reason}`, sessionId);
            }
            if (assistant?.error) throw new OpenCodeError("failed", describe(assistant.error), sessionId);
            let text = assistant?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
            if (request.resultKeys?.length) {
              // A structured answer may span consecutive assistant messages (e.g. output-token continuation).
              // Stop at tools and this admission's user boundary; never mix earlier turns or tool output.
              let combined = "";
              for (const message of current) {
                if (message.type !== "assistant") continue;
                if (message.content?.some(part => part.type === "tool")) break;
                combined = (message.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("") ?? "") + combined;
                try {
                  const value = JSON.parse(combined.trim().replace(/^```(?:json)?\s*\n|\n```$/g, ""));
                  if (value && typeof value === "object" && !Array.isArray(value) && request.resultKeys.every(key => Object.hasOwn(value, key))) { text = combined; break; }
                } catch { /* Keep collecting only this uninterrupted structured reply. */ }
              }
            }
            if (!text?.trim()) throw new OpenCodeError("contract", "Execution completed without assistant text", sessionId);
            return { sessionId, text };
          }
        }
        // A wait can race the scheduled wakeup; require this prompt's own idle marker.
        if (settled) await delay(this.pollIntervalMs, undefined, { signal });
        else await Promise.race([wait, delay(this.pollIntervalMs, undefined, { signal })]);
      }
    } catch (error) {
      const aborted = signal.aborted;
      let interruption = "";
      if (admitted && sessionId && !(error instanceof OpenCodeError && error.kind === "pending")) {
        try {
          const settlement = AbortSignal.timeout(5_000);
          await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, { resume: false }, settlement);
          // Upstream acknowledges interruption before its finalizers publish the
          // terminal event and release the durable claim. Wait for that boundary
          // with a fresh, bounded signal before callers stop the backend.
          await this.wait(sessionId, settlement);
        } catch { interruption = "; remote interruption settlement could not be confirmed"; }
      }
      if (aborted) throw new OpenCodeError(timeout.aborted ? "timeout" : "aborted", `${timeout.aborted ? "Execution timed out" : "Execution aborted"}${interruption}`, sessionId);
      if (error instanceof OpenCodeError && (!sessionId || error.sessionId)) throw error;
      throw new OpenCodeError(error instanceof z.ZodError ? "contract" : error instanceof OpenCodeError ? error.kind : "transport", `${describe(error)}${interruption}`, sessionId);
    } finally {
      if (timer) clearTimeout(timer); waiting.abort();
      // A lost lease cleanup cannot replace the real execution outcome.
      await releaseInteraction().catch(() => undefined);
    }
  }

  async search(request: { directory: string; query: string; limit?: number }): Promise<SearchSource[]> {
    if (this.options.workspaceRoot) await withinProject(this.options.workspaceRoot, request.directory);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    try {
      await this.verify(signal);
      const query = new URLSearchParams({ "location[directory]": resolve(request.directory) });
      const response = SearchResponse.parse(await this.request("POST", `/api/websearch?${query}`, { query: request.query }, signal));
      return response.data.results.slice(0, request.limit ?? 8).map((item) => ({
        title: item.title ?? item.url, url: item.url, description: item.content ?? "",
        ...(item.time.published != null ? { publishedAt: item.time.published } : {}),
      }));
    } catch (error) {
      if (signal.aborted) throw new OpenCodeError(timeout.aborted ? "timeout" : "aborted", "Web search was interrupted");
      if (error instanceof OpenCodeError) throw error;
      throw new OpenCodeError(error instanceof z.ZodError ? "contract" : "transport", describe(error));
    }
  }

  private async verify(signal: AbortSignal) {
    if (this.verified) return;
    const info = z.object({ version: z.string() }).parse(await this.request("GET", "/api/info", undefined, signal));
    if (!/^2\./.test(info.version)) throw new OpenCodeError("version", `OpenAGI requires OpenCode v2; server reports ${info.version}`);
    this.verified = true;
  }

  private async answerInteractions(sessionId: string, pending: { permissions: Record<string, unknown>[]; forms: Record<string, unknown>[] }, signal: AbortSignal) {
    const replies = await this.options.onInteraction!({ sessionId, ...pending });
    if (!replies.length) throw interactionRequired(sessionId, pending as { permissions: { id: string }[]; forms: { id: string }[] });
    const seen = new Set<string>();
    for (const reply of replies) {
      const offered = reply.kind === "permission" ? pending.permissions : pending.forms;
      const key = `${reply.kind}:${reply.id}`;
      if (!offered.some(item => item.id === reply.id) || seen.has(key)) throw new OpenCodeError("contract", "Interaction reply does not match a pending request", sessionId);
      seen.add(key);
      const base = `/api/session/${encodeURIComponent(sessionId)}`;
      if (reply.kind === "permission") {
        await this.request("POST", `${base}/permission/${encodeURIComponent(reply.id)}/reply`, { decision: z.enum(["once", "always", "reject"]).parse(reply.decision) }, signal);
      } else {
        const answer = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).parse(reply.answer);
        await this.request("POST", `${base}/form/${encodeURIComponent(reply.id)}/reply`, { answer }, signal);
      }
    }
  }

  private async pending(sessionId: string, signal: AbortSignal) {
    const path = `/api/session/${encodeURIComponent(sessionId)}`;
    const [permissions, forms] = await Promise.all([
      this.request("GET", `${path}/permission`, undefined, signal),
      this.request("GET", `${path}/form`, undefined, signal),
    ]);
    return { permissions: PendingResponse.parse(permissions).data, forms: PendingResponse.parse(forms).data };
  }

  private async messages(sessionId: string, promptId: string, signal: AbortSignal) {
    const result: z.infer<typeof Message>[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor); else query.set("order", "desc");
      const response = MessagesResponse.parse(await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}/message?${query}`, undefined, signal));
      result.push(...response.data);
      if (response.data.some((item) => item.id === promptId)) break;
      cursor = response.cursor.next ?? undefined;
    } while (cursor);
    return result;
  }

  private async wait(sessionId: string, signal: AbortSignal): Promise<unknown> {
    // This read-only request holds its response until execution becomes idle.
    // A transport deadline ends only the waiter, so safely rejoin the same
    // execution instead of interrupting it or admitting another prompt.
    while (true) {
      signal.throwIfAborted();
      try { return await this.request("POST", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, undefined, signal); }
      catch (error) {
        const code = error instanceof OpenCodeError ? error.connection?.code : connectionCode(error);
        if (signal.aborted || !["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code ?? "")) throw error;
        await delay(this.pollIntervalMs, undefined, { signal });
      }
    }
  }

  private async request(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.toString().replace(/\/$/, "")}${path}`, {
        method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const code = connectionCode(error);
      const detail = code === "ECONNREFUSED" ? "该地址没有服务在监听" : code === "ENOTFOUND" ? "无法解析服务主机名" : describe(error);
      throw new OpenCodeError("transport", `无法连接 OpenCode 服务 ${this.baseUrl}：${detail}${code ? ` (${code})` : ""}`, undefined, undefined, { url: this.baseUrl.toString(), code });
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new OpenCodeError("http", `OpenCode ${method} ${path.split("?")[0]} returned ${response.status}: ${detail}`, undefined, undefined, undefined, response.status);
    }
    return response.status === 204 ? undefined : response.json();
  }
}

function connectionCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof value.code === "string") return value.code;
  return connectionCode(value.cause) ?? value.errors?.map(connectionCode).find(code => code !== undefined);
}

function rules(mode: RunMode, bounded = false) {
  const restriction = bounded ? [
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "read", resource: ".openagi/*", effect: "deny" },
    { action: "edit", resource: ".openagi/*", effect: "deny" },
    { action: "read", resource: "**/.env*", effect: "deny" },
  ] : [];
  if (mode === "build") return restriction;
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "webfetch", "websearch"].map((action) => ({ action, resource: "*", effect: "allow" })),
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    ...restriction,
  ];
}

function model(request: AgentRequest) {
  return request.model ? { providerID: request.model.providerID, id: request.model.modelID, ...(request.model.variant ? { variant: request.model.variant } : {}) } : undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === undefined) return "No error details supplied";
  return JSON.stringify(error);
}

function interactionRequired(sessionId: string, pending: { permissions: { id: string }[]; forms: { id: string }[] }) {
  const ids = [...pending.permissions, ...pending.forms].map((item) => item.id).join(", ");
  return new OpenCodeError("pending", `User input is required in OpenCode: ${ids}. Reply to the pending permission or form in that session`, sessionId, pending);
}
