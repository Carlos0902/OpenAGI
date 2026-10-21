import { expect, story } from "../../storybook/playwright/story"

story("usage scopes update model rows and preserve recorded values when refresh fails", async ({ mount }) => {
  const root = await mount("openagi-usage--project-usage")
  await expect(root.getByRole("rowheader", { name: "heavy primary" })).toBeVisible()
  await expect(root.getByRole("rowheader", { name: "jev-latest typesafe" })).toHaveCount(0)
  await root.getByRole("combobox", { name: "Project scope" }).selectOption("*")
  await expect(root.getByRole("row", { name: "heavy primary 3 500 100 200 150 50 1,000 1" })).toBeVisible()
  await expect(root.getByRole("rowheader", { name: "jev-latest typesafe" })).toBeVisible()
  await root.getByRole("button", { name: "Simulate unavailable backend" }).click()
  await expect(root.getByRole("alert")).toContainText("Showing the last recorded data")
  await expect(root.getByRole("row", { name: "heavy primary 3 500 100 200 150 50 1,000 1" })).toBeVisible()
  await root.getByRole("combobox", { name: "Project scope" }).selectOption("/projects/game")
  await expect(root.getByRole("alert")).toHaveCount(0)
  await expect(root.getByRole("row", { name: "heavy primary 1 0 0 0 0 0 0 1" })).toBeVisible()
})
