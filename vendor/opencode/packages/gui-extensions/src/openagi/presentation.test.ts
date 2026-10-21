import { expect, test } from "bun:test"
import { legacyWorkflowPrompt } from "./presentation"

test("legacy generated instructions collapse only in a managed workflow session, ordinary messages stay visible", () => {
  const input = { managed: true, title: "Tutor · function-finder", text: "You are OpenAGI Tutor's function-finder. Find improvements." }
  expect(legacyWorkflowPrompt(input)).toEqual({ displayText: input.title, collapsed: true, resultPresentation: { keys: ["proposals"] } })
  expect(legacyWorkflowPrompt({ ...input, managed: false })).toBeUndefined()
  expect(legacyWorkflowPrompt({ ...input, text: "帮我做一个贪吃蛇" })).toBeUndefined()
  expect(legacyWorkflowPrompt({ ...input, title: "My own chat" })).toBeUndefined()
  expect(legacyWorkflowPrompt({ managed: true, title: "Collector", text: "Consolidate these project improvement candidates." })?.resultPresentation).toEqual({ keys: ["groups"] })
  expect(legacyWorkflowPrompt({ managed: true, title: "OpenAGI task", text: "Design executable static/test checks for this repository and selected task." })?.resultPresentation).toEqual({ keys: ["explanation", "checks"] })
  expect(legacyWorkflowPrompt({ managed: true, title: "Worker · task", text: "Implement this selected OpenAGI task." })?.resultPresentation).toBeUndefined()
})
