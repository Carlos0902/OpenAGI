/// <reference path="../../../../gui-extensions/src/openagi/native.d.ts" />

/** The build aliases these entry points to the separately checked OpenAGI project. */
declare module "@openagi/native" {
  export function initializeOpenagiNative(options: { cli?: string; appData?: string }): Promise<void>
  export function acceptOpenagiLaunch(argv: string[]): Promise<void>
  export function ownsOpenagiServer(id: string, url: string): boolean
  export function shutdownOpenagiNative(): Promise<void>
  export function installOpenagiCLI(options: { executable: string; appData?: string }): Promise<string>
}

declare module "@openagi/proxy" {
  export function configureOutboundProxy(environment?: NodeJS.ProcessEnv): void
}

declare module "@openagi/network" {
  export function loadNetworkProfile(directory: string): Promise<{ enabled: boolean; proxyURL: string; noProxy: string }>
  export function loopbackNoProxy(value?: string): string
}
