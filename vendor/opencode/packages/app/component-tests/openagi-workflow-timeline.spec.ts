import { expect, sourceURL, story } from "../../storybook/playwright/story"

story(
  "shows concurrent and sequential modules in one native conversation with real tool groups and folded results",
  async ({ mount, page }) => {
    await mount("ui-line-comment--editor")
    await page.evaluate(
      async (fixture) => {
        const { mountWorkflowTimeline } = await import(fixture)
        mountWorkflowTimeline()
      },
      sourceURL(new URL("./openagi-workflow-timeline.fixture.tsx", import.meta.url)),
    )
    const root = page.getByTestId("workflow-timeline-fixture")
    await expect(root.getByText("Unmet acceptance requirement: Restart preserves the initial state", { exact: true })).toBeVisible()
    await expect(root.getByText("A stale timer survives restart.", { exact: true })).toBeVisible()
    await expect(root.getByText("Performance observation (does not block delivery): Rendering p95 improves by 20%", { exact: true })).toBeVisible()
    await expect(root.getByText("Measured improvement was 15%; behavior is correct.", { exact: true })).toBeVisible()
    await expect(root.getByText("Delivered changes have passed acceptance and been merged.", { exact: true })).toBeVisible()
    await expect(root.getByText("How to use this project", { exact: true })).toBeVisible()
    await expect(root.getByText("Open index.html and choose Start. Arrow keys move the piece.", { exact: false })).toBeVisible()
    const cards = root.locator('[data-component="openagi-workflow-module"]')
    await expect(cards).toHaveCount(2)
    const first = cards.first()
    const moduleTrigger = first.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
    await expect(moduleTrigger).toHaveAttribute("aria-expanded", "false")
    await expect(moduleTrigger).toContainText("Working")
    await expect(first.getByText("Tutor · function-finder is checking the project.", { exact: true })).toBeVisible()
    const tools = first.locator('[data-component="collapsed-tool-group"] [data-slot="collapsible-trigger"]').first()
    await expect(tools).toHaveText(/^Used\s*2\s*Glob, Grep$/)
    await expect(root.getByText("hidden-machine-result", { exact: false })).toHaveCount(0)
    await tools.click()
    await expect(first.getByText("pattern=src/timeline/**/*.{ts,tsx}", { exact: true })).toBeVisible()
    const thought = first.locator('[data-component="reasoning-part"] [data-slot="collapsible-trigger"]')
    await thought.click()
    await expect(
      first.getByText("I will follow the projection from current messages to rendered row keys.", { exact: false }),
    ).toBeVisible()
    await root.getByRole("button", { name: "Stream progress", exact: true }).click()
    await expect(first.getByText("New streaming progress.", { exact: true })).toBeVisible()
    await expect(moduleTrigger).toHaveAttribute("aria-expanded", "false")
    await moduleTrigger.click()
    const result = first.locator('[data-slot="collapsible-trigger"]').filter({ hasText: "Internal result" })
    await expect(result).toHaveAttribute("aria-expanded", "false")
    await result.click()
    await expect(first.locator('[data-component="markdown"]').filter({ hasText: /"proposals"/ })).toBeVisible()
    await moduleTrigger.click()
    await expect(first.getByText('"proposals"', { exact: false })).toHaveCount(0)
    await root.getByRole("button", { name: "Complete and continue", exact: true }).click()
    await expect(cards).toHaveCount(4)
    await expect(cards.nth(2).getByRole("button", { name: "Worker Finished", exact: true })).toBeVisible()
    await expect(cards.nth(3).getByRole("button", { name: "Validator Finished", exact: true })).toBeVisible()
    await expect(cards.nth(2).locator('[data-slot="basic-tool-tool-subtitle"]').first()).toHaveText("Finished")
    const worker = cards.nth(2)
    const progress = worker.locator('[data-timeline-part-id="worker:msg_assistant_research_result:text:0"]')
    const before = await progress.elementHandle()
    await expect(progress).toContainText("Worker is preparing the implementation.")
    expect((await progress.locator('[data-component="markdown"]').innerText()).length).toBeLessThanOrEqual(320)
    await expect(
      worker.getByText("Detailed worker delivery remains available in the expanded transcript.", { exact: true }),
    ).toHaveCount(0)
    await root.getByRole("button", { name: "Update Worker progress", exact: true }).click()
    await expect(progress).toContainText("Worker is preparing the updated implementation.")
    expect(
      await before!.evaluate(
        (element) =>
          element === document.querySelector('[data-timeline-part-id="worker:msg_assistant_research_result:text:0"]'),
      ),
    ).toBe(true)
    await worker.getByRole("button", { name: "Worker Working", exact: true }).click()
    await expect(
      worker.getByText("Detailed worker delivery remains available in the expanded transcript.", { exact: true }),
    ).toBeVisible()
    await worker.getByRole("button", { name: "Worker Working", exact: true }).click()
    await expect(
      worker.getByText("Detailed worker delivery remains available in the expanded transcript.", { exact: true }),
    ).toHaveCount(0)
    await root.getByRole("button", { name: "Pause Worker", exact: true }).click()
    await expect(cards.nth(2).getByRole("button", { name: "Worker Interrupted", exact: true })).toBeVisible()
    await root.getByRole("button", { name: "Resume Worker", exact: true }).click()
    await expect(cards.nth(2).getByRole("button", { name: "Worker Working", exact: true })).toBeVisible()
    await root.getByRole("button", { name: "Finish Worker", exact: true }).click()
    await expect(cards.nth(2).getByRole("button", { name: "Worker Finished", exact: true })).toBeVisible()
    await expect(root.locator('[role="tab"]')).toHaveCount(0)
    await root.getByRole("button", { name: "Assess result", exact: true }).click()
    const collector = cards.nth(4)
    await expect(collector.getByRole("button", { name: "Collector Working", exact: true })).toBeVisible()
    await root.getByRole("button", { name: "Fail assessment", exact: true }).click()
    await expect(collector.getByRole("button", { name: "Collector Failed", exact: true })).toBeVisible()
    await root.getByRole("button", { name: "Complete assessment", exact: true }).click()
    await expect(collector.getByRole("button", { name: "Collector Finished", exact: true })).toBeVisible()
    await expect(cards).toHaveCount(5)
    await expect(collector.getByText("If the user later requests touch input", { exact: false })).toHaveCount(0)
    await collector.getByRole("button", { name: "Collector Finished", exact: true }).click()
    const continuation = collector.getByRole("button", { name: "Internal result continuation (not a user request)", exact: true })
    await expect(continuation).toBeVisible()
    await continuation.click()
    await expect(collector.getByText("If the user later requests touch input", { exact: false })).toBeVisible()
    await collector.getByRole("button", { name: "Collector Finished", exact: true }).click()
    await expect(root.getByText("hidden-machine-result", { exact: false })).toHaveCount(0)
    await expect(root.locator('[role="tab"]')).toHaveCount(0)
  },
)
