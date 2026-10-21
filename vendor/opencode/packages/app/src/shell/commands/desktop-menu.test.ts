import { expect, test } from "bun:test"
import { desktopMenuWithExtensions } from "./desktop-menu"

test("native menu extensions keep declared insertion order without changing the base menu", () => {
  const base = Object.freeze([
    { key: "about", entry: "About" },
    { key: "settings", entry: "Settings" },
  ])

  const extra = [
    { id: "first", after: "about", label: "First" },
    { id: "second", after: "first", label: "Second" },
    { id: "append", after: "absent", label: "Append" },
  ]

  const menu = desktopMenuWithExtensions(base, extra)

  expect(menu.map((item) => item.key)).toEqual(["about", "first", "second", "settings", "append"])
  expect(base.map((item) => item.key)).toEqual(["about", "settings"])
  expect(menu[1].entry).toBe(extra[0])
  expect(menu[2].entry).toBe(extra[1])
})
