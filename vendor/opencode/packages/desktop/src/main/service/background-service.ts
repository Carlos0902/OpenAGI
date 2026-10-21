import { app } from "electron"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { BackgroundServiceState } from "./background-service-state"
import { cleanStages } from "./cli-stages"
import { DesktopCli } from "./desktop-cli"
import { SidecarCredentials } from "./sidecar-credentials"
import { sidecarProbe } from "./sidecar-probe"
import { preparePrivateSidecar, privateServiceFile } from "../openagi/environment"
import { Shutdown } from "../lifecycle/shutdown"

export * as BackgroundService from "./background-service"

export interface Interface {
  readonly connection: Effect.Effect<SidecarCredentials.Data>
  readonly reconnect: Effect.Effect<SidecarCredentials.Data>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | DesktopCli.Service>()
    const shutdown = yield* Shutdown.Service
    const remove = yield* shutdown.add(
      Effect.promise(async () => {
        const { Service } = await import("@opencode/client/service")
        await Service.stop({ file: privateServiceFile(app.getPath("userData")), pty: "clear" })
      }).pipe(Effect.catch((error) => Effect.logWarning("private OpenAGI backend shutdown failed", { error }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(remove))

    return Service.of(
      yield* BackgroundServiceState.make({
        initial: connect("initial").pipe(Effect.provide(context)),
        reconnect: connect("reconnect").pipe(Effect.provide(context), Effect.orDie),
      }),
    )
  }),
)

const connect = Effect.fn("BackgroundService.connect")(function* (mode: "initial" | "reconnect") {
  yield* Effect.logInfo("starting v2 background service")
  const desktopCli = yield* DesktopCli.Service
  const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>())
  const cli = yield* desktopCli.resolve
  const version = mode === "initial" ? cli.version : undefined
  const environment = yield* Effect.promise(() => preparePrivateSidecar(app.getPath("userData")))
  const client = yield* Effect.promise(() => import("@opencode/client/service"))

  const ensure = () =>
    client.Service.ensure({
      file: privateServiceFile(app.getPath("userData")),
      env: environment,
      version,
      // The private service registration serializes contenders; never discover or
      // replace an unrelated OpenCode service in the user's global state directory.
      command: [
        ...cli.command,
        "serve",
        "--service",
        "--hostname", "127.0.0.1", "--port", "0",
      ],
      onStart: (reason, previousVersion) =>
        runFork(Effect.logInfo("v2 CLI background service starting", { reason, previousVersion })),
    })

  // A compatible service the entry module already found is adopted at once; ensure() still runs
  // afterwards for its side effects (terminal handoff completion), off the renderer's path.
  const early = mode === "initial" ? yield* Effect.promise(sidecarProbe) : undefined

  if (early) yield* Effect.sync(() => void ensure().catch(() => undefined))
  const service = early ?? (yield* Effect.tryPromise(ensure))

  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")
  const url = new URL(service.url)

  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
  yield* Effect.logInfo("v2 CLI background service ready", {
    version,
    probed: !!early,
    ...endpoint(url.origin),
  })

  // Only packaged and isolated builds run a staged copy; any other binary sits in the source tree.
  // The service now runs the current version, so an older copy at most belongs to a process still exiting.
  if (mode === "initial" && app.isPackaged && cli.binary)
    runFork(
      cleanStages(cli.binary).pipe(
        Effect.catch((error) => Effect.logError("failed to clean staged v2 CLIs", { error })),
      ),
    )
  const ready = { url: url.origin, password: service.auth.password } satisfies SidecarCredentials.Data
  SidecarCredentials.set(ready)

  return ready
})

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)

  return { url, hostname: parsed.hostname, port: parsed.port }
}
