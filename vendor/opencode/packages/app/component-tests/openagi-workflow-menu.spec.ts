import { expect, sourceURL, story } from "../../storybook/playwright/story"

story("Integrated OpenAGI workflow has no redundant header or titlebar menu", async ({ mount, page }) => {
  await mount("ui-line-comment--editor")

  const result = await page.evaluate(async modules => {
    const [{ mountExtensions, until }, definition, renderer] = await Promise.all([import(modules.fixture), import(modules.definition), import(modules.renderer)])
    const host = mountExtensions({ definitions: [{ ...definition.default, renderer: () => Promise.resolve(renderer) }], titlebar: true })
    host.release(); await until(() => host.ready()); await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    return { failure: host.failure("openagi"), status: host.status("openagi"), panels: host.entries("panel"), titlebar: host.entries("titlebar-item"), slots: host.entries("slot"), settings: host.entries("settings-page"), commands: host.entries("command") }
  }, {
    fixture: sourceURL(new URL("./extension-host.fixture.tsx", import.meta.url)),
    definition: sourceURL(new URL("../../gui-extensions/src/openagi/index.ts", import.meta.url)),
    renderer: sourceURL(new URL("../../gui-extensions/src/openagi/renderer.tsx", import.meta.url)),
  })

  expect(result).toEqual({ failure: undefined, status: "active", panels: 0, titlebar: 0, slots: 0, settings: 3, commands: 5 })
  await expect(page.getByRole("button", { name: "OpenAGI workflow menu" })).toHaveCount(0)
})
