import { describe, expect, test } from "bun:test"
import { loopbackNoProxy, privateServiceFile, privateSidecarEnvironment } from "./environment"

describe("OpenAGI desktop private backend contract", () => {
  test.each([
    [undefined, "localhost,127.0.0.1,::1"],
    ["example.com,localhost", "example.com,localhost,127.0.0.1,::1"],
    ["LOCALHOST,127.0.0.1,::1", "LOCALHOST,127.0.0.1,::1"],
  ])("keeps loopback requests direct for %s", (input, output) => {
    expect(loopbackNoProxy(input)).toBe(output)
  })

  test("cannot adopt global OpenCode credentials or discovery while keeping the outbound proxy", () => {
    const directory = "/private/test/OpenAGI"
    const environment = privateSidecarEnvironment(directory, {
      HOME: "/private/test/global-home",
      XDG_STATE_HOME: "/private/test/global-state",
      ANTHROPIC_API_KEY: "global-key",
      OPENAI_API_KEY: "global-key",
      OPENCODE_PASSWORD: "global-password",
      OPENCODE_CONFIG_CONTENT: "global-config",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://global-telemetry",
      HTTP_PROXY: "http://127.0.0.1:7892",
      HTTPS_PROXY: "http://127.0.0.1:7892",
      NO_PROXY: "internal.local",
    })
    expect(privateServiceFile(directory)).toBe("/private/test/OpenAGI/backend/state/opencode/service.json")
    expect(environment.HOME).toBe("/private/test/OpenAGI/backend/home")
    expect(environment.XDG_STATE_HOME).toBe("/private/test/OpenAGI/backend/state")
    expect(environment.ANTHROPIC_API_KEY).toBe("")
    expect(environment.OPENAI_API_KEY).toBe("")
    expect(environment.OPENCODE_PASSWORD).toBe("")
    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("")
    expect(environment.OPENCODE_CONFIG_CONTENT).not.toBe("global-config")
    expect(environment.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1")
    expect(environment.HTTP_PROXY).toBe("http://127.0.0.1:7892")
    expect(environment.HTTPS_PROXY).toBe("http://127.0.0.1:7892")
    expect(environment.NO_PROXY).toBe("internal.local,localhost,127.0.0.1,::1")
  })
})
