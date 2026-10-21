import { expect, story } from "../../storybook/playwright/story"

story("spaces an error between a shell result and expanded updates", async ({ mount }) => {
  const timeline = await mount("current-session-error-spacing--error-and-updates")
  const shell = timeline.locator('[data-component="bash-output"]')
  const error = timeline.locator('[data-kind="session-error-card"]')
  const updates = timeline.locator('[data-component="collapsed-tool-group"] [data-slot="collapsible-trigger"]')
  const shellBox = (await shell.boundingBox())!
  const errorBox = (await error.boundingBox())!
  const updatesBox = (await updates.boundingBox())!
  expect(errorBox.y - (shellBox.y + shellBox.height)).toBe(24)
  expect(updatesBox.y - (errorBox.y + errorBox.height)).toBe(8)
  expect(updatesBox.x).toBe(errorBox.x)
  await updates.click()
  const notice = timeline.locator('[data-slot="session-timeline-notice"]')
  await expect(notice).toContainText("Instructions updated")
  const expandedBox = (await updates.boundingBox())!
  expect((await notice.boundingBox())!.y - (expandedBox.y + expandedBox.height)).toBe(0)
  expect((await notice.boundingBox())!.x - expandedBox.x).toBe(12)
  expect(expandedBox.height).toBe(28)
})

for (const streaming of [false, true]) {
  story(`renders Mermaid in the ${streaming ? "streaming" : "completed"} timeline`, async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    const root = await mount("current-session-mermaid--diagrams", { args: { streaming } })
    const timeline = root.locator('[data-component="session-timeline"]')
    const diagrams = timeline.locator('[data-component="markdown-mermaid"] > svg')
    await expect(diagrams).toHaveCount(2)
    await expect(diagrams.nth(0)).toBeVisible()
    await expect(diagrams.nth(0)).toContainText("Client")
    await expect(diagrams.nth(1)).toBeVisible()
    await expect(diagrams.nth(1)).toContainText("Send prompt")
    await expect(timeline.locator('[data-mermaid-ready="true"]')).toHaveCount(2)
    await expect(timeline.locator('[data-mermaid-ready="true"] > pre:visible')).toHaveCount(0)

    if (streaming) {
      await root.getByRole("button", { name: "Complete response" }).click()
      await expect(timeline.locator('[data-markdown-complete="true"]')).toHaveCount(2)
      await expect(diagrams).toHaveCount(2)
      await expect(diagrams.nth(0)).toBeVisible()
      await expect(diagrams.nth(1)).toBeVisible()
    }
  })
}

story("aligns the retry icon with the error label", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--provider-retry")
  const card = timeline.locator('[data-kind="session-retry-card"]')
  const icon = card.locator('[data-slot="icon-svg"]')
  const label = card.locator('[data-slot="session-turn-retry-message"]')
  await expect(icon).toBeVisible()
  await expect(label).toBeVisible()

  const [iconY, labelY] = await Promise.all([
    icon.evaluate((element) => element.getBoundingClientRect().y),
    label.evaluate((element) => element.getBoundingClientRect().y),
  ])

  expect(iconY).toBe(labelY)
})

story("centers the error icon on the first line of short and wrapped errors", async ({ mount }) => {
  const timeline = await mount("current-session-error-card--provider-errors")
  const cards = timeline.locator('[data-kind="session-error-card"]')

  await expect(cards).toHaveCount(2)

  const geometry = await cards.evaluateAll((elements) =>
    elements.map((card) => {
      const icon = card.querySelector('[data-slot="icon-svg"]')!.getBoundingClientRect()
      const message = card.querySelector('[data-slot="icon-svg"] + div')!
      const line = parseFloat(getComputedStyle(message).lineHeight)
      const box = message.getBoundingClientRect()

      return {
        lines: Math.round(box.height / line),
        offset: icon.top + icon.height / 2 - (box.top + line / 2),
      }
    }),
  )

  expect(geometry.map((card) => card.lines > 1)).toEqual([false, true])
  geometry.forEach((card) => expect(card.offset).toBeCloseTo(0, 0))
})

// Moved from packages/app/e2e/regression/session-timeline-context-state.spec.ts
story("preserves a collapsed context group through count and status updates", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "exploration" } })
  const group = timeline.locator('[data-timeline-part-ids="tool_context_read,tool_context_glob"]')
  const trigger = group.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Complete read" }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Complete glob" }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

// Moved from packages/app/e2e/regression/session-timeline-file-projection.spec.ts
story("renders a completed write through the production file component", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "write" } })
  const write = timeline.locator('[data-timeline-part-id="prt_file_projection_write"]')
  const file = write.getByRole("button", { name: /write\.ts/ })
  await expect(file).toHaveAttribute("aria-expanded", "false")
  await file.click()
  await expect(write.locator('[data-component="file"]')).toContainText("export const written = true")
})

// Moved from packages/app/e2e/regression/session-timeline-file-state.spec.ts
story("keeps patch file disclosures independent", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "patch" } })
  const wrapper = timeline.locator('[data-timeline-part-id="prt_nested_patch"]')
  const modified = wrapper.locator('[data-scope="apply-patch"] [data-type="update"] button')
  const added = wrapper.locator('[data-scope="apply-patch"] [data-type="add"] button')
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"] button')
  await expect(wrapper.locator('[data-scope="apply-patch"] [aria-expanded="false"]')).toHaveCount(3)
  await deleted.click()
  await expect(deleted).toHaveAttribute("aria-expanded", "true")
  await expect(modified).toHaveAttribute("aria-expanded", "false")
  await modified.click()
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await deleted.click()
  await expect(deleted).toHaveAttribute("aria-expanded", "false")
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await expect(added).toHaveAttribute("aria-expanded", "false")
  await added.click()
  await expect(added).toHaveAttribute("aria-expanded", "true")
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await expect(deleted).toHaveAttribute("aria-expanded", "false")
})


story("collapses internal instructions by default and lets the user inspect them without hiding the assistant response", async ({ mount }) => {
  const root = await mount("current-session-timeline-rows--internal-prompt")
  const trigger = root.getByRole("button", { name: "Tutor · function-finder", exact: true })
  const instructions = root.getByText("Private orchestration instructions and output schema.", { exact: true })
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(instructions).not.toBeVisible()
  await expect(root.getByText("I have the typed rows in place.", { exact: false })).toBeVisible()
  await trigger.click()
  await expect(instructions).toBeVisible()
  await trigger.click()
  await expect(instructions).not.toBeVisible()
  await root.getByRole("button", { name: "Reset", exact: true }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

story("collapses streaming structured results while preserving progress prose, original tool groups and explicit detail choices", async ({ mount }) => {
  const root = await mount("current-session-timeline-rows--internal-result")
  const result = root.locator('[data-slot="collapsible-trigger"]').filter({ hasText: "Internal result" })
  const tools = root.locator('[data-component="collapsed-tool-group"] [data-slot="collapsible-trigger"]').first()
  await expect(root.getByText("I am checking the next useful change.", { exact: true })).toBeVisible()
  await expect(tools).toHaveText(/^Used\s*1\s*Read$/)
  await expect(result).toHaveAttribute("aria-expanded", "false")
  await expect(root.getByText("hidden-machine-result", { exact: false })).toHaveCount(0)
  await result.click()
  await expect(root.getByText("hidden-machine-result", { exact: false })).toBeVisible()
  await root.getByRole("button", { name: "Complete result", exact: true }).click()
  await expect(result).toHaveAttribute("aria-expanded", "true")
  await expect(root.getByText("The analysis is complete.", { exact: true }).first()).toBeVisible()
  await result.click()
  await expect(root.getByText("hidden-machine-result", { exact: false })).toHaveCount(0)
  await tools.click()
  await expect(root.getByText("Check existing source before planning.", { exact: false })).not.toBeVisible()
  await expect(root.locator('[data-timeline-part-id="tool_internal_read"]')).toBeVisible()
  const thought = root.locator('[data-component="reasoning-part"] [data-slot="collapsible-trigger"]')
  await expect(thought).toHaveCount(1)
  await thought.click()
  await expect(root.getByText("Check existing source before planning.", { exact: false })).toBeVisible()
  await root.getByRole("button", { name: "Show ordinary JSON", exact: true }).click()
  await expect(result).toHaveCount(0)
  await expect(root.getByText("hidden-machine-result", { exact: false })).toBeVisible()
  await root.getByRole("button", { name: "Reply normally", exact: true }).click()
  await expect(root.getByText("The implementation is ready.", { exact: true })).toBeVisible()
})
