/** Older workflow sessions predate prompt presentation metadata. Match only our generated instructions. */
export function legacyWorkflowPrompt(input: { managed: boolean; title: string; text: string }) {
  if (!input.managed) return
  const prompts = [
    { title: "Tutor · ", text: "You are OpenAGI Tutor's ", keys: ["proposals"] },
    { title: "Collector", text: "Consolidate these project improvement candidates.", keys: ["groups"] },
    { title: "Collector", text: "You are Jev, OpenAGI's independent Collector.", keys: ["groups"] },
    { title: "Guider · ", text: "You are OpenAGI's Problem Solving Guider.", keys: ["summary", "approach", "alternatives", "integrationSteps", "risks", "dependencies", "validationPlan"] },
    { title: "Worker · ", text: "Implement this selected OpenAGI task.", keys: [] },
    { title: "Worker · ", text: "Continue the existing task after resolving any pending upstream interaction.", keys: [] },
    { title: "Validator · ", text: "You are the independent OpenAGI Validator in a NEW session,", keys: ["criteria", "summary"] },
    { title: "OpenAGI task", text: "Design executable static/test checks for this repository and selected task.", keys: ["explanation", "checks"] },
    { title: "Validator · ", text: "Design executable static/test checks for this repository and selected task.", keys: ["explanation", "checks"] },
    { title: "OpenAGI task", text: "You are OpenAGI's conversational project tutor.", keys: ["reply", "action", "taskId", "updateContext"] },
    { title: "Tutor · Discussion", text: "You are OpenAGI's conversational project tutor.", keys: ["reply", "action", "taskId", "updateContext"] },
  ]
  const prompt = prompts.find((prompt) => input.title.startsWith(prompt.title) && input.text.startsWith(prompt.text))
  if (!prompt) return
  return { displayText: input.title, collapsed: true, resultPresentation: prompt.keys.length ? { keys: prompt.keys } : undefined }
}
