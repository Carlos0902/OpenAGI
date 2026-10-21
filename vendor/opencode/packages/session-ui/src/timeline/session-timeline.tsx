import { For, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Predicate } from "effect"
import { precedingResultText, structuredResult } from "./presentation"
import type { SessionDocument } from "../document"
import type { SessionUserActions } from "../actions"
import type { TimelineDetail } from "./detail"
import { createReactiveTimelineProjection, Timeline, TimelineRow, type ReasoningMode } from "./projection"
import { createSessionTimelineRowRenderer, type SessionUserPresentation } from "./session-timeline-row"

export type { SessionUserPresentation } from "./session-timeline-row"

export type SessionTimelineProps = {
  document: SessionDocument
  presentation?: Record<string, SessionUserPresentation | undefined>
  actions?: SessionUserActions
  reasoningMode?: ReasoningMode
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  timelineDetail?: TimelineDetail
  class?: string
  /** Compact preview of real activity in a parent workflow; the full transcript stays available on expansion. */
  preview?: boolean
}

export function SessionTimeline(props: SessionTimelineProps) {
  const projection = createReactiveTimelineProjection({
    sessionMessages: () => props.document.messages,
    status: () => props.document.status,
    reasoningMode: () => props.reasoningMode ?? "compact",
    shellToolDefaultOpen: () => props.shellToolDefaultOpen ?? false,
    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,
    timelineDetail: props.timelineDetail && (() => props.timelineDetail!),
  })

  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>({})

  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => props.document.sessionID,
    status: () => props.document.status,
    projection,
    presentation: (message) => props.presentation?.[message.id],
    actions: props.actions,
    preview: () => !!props.preview,
    reasoningMode: () => props.reasoningMode ?? "compact",
    shellToolDefaultOpen: () => props.shellToolDefaultOpen ?? false,
    editToolDefaultOpen: () => props.editToolDefaultOpen ?? false,
    timelineDetail: props.timelineDetail && (() => props.timelineDetail!),
    disclosure: {
      value: (key) => toolOpen[key],
      set: (key, open) => setToolOpen(key, open),
    },
  })

  const rowKeys = createMemo(() => {
    if (!props.preview) return projection.rows().map(TimelineRow.key)

    const userID = props.document.messages.findLast((message) => message.type === "user")?.id

    const rows = projection.rows().filter((row) => {
      if (userID && row.userMessageID !== userID) return false

      if (
        Predicate.isTagged(row, "Thinking") ||
        Predicate.isTagged(row, "Error") ||
        Predicate.isTagged(row, "Retry") ||
        Predicate.isTagged(row, "Shell")
      )
        return true

      if (!Predicate.isTagged(row, "AssistantPart")) return false

      if (row.group.type !== "part") return true

      const message = projection.messageByID().get(row.group.ref.messageID)
      const content = Timeline.resolveContent(message, row.group.ref.partID)

      if (content?.type !== "text") return true

      const result = structuredResult(content.text, props.presentation?.[row.userMessageID]?.resultPresentation, props.presentation?.[row.userMessageID]?.resultPresentation ? precedingResultText(projection.messageByID().values(), row.userMessageID, row.group.ref.messageID, content) : "")

      return result ? !!result.visibleText.trim() : !!content.text.trim()
    })

    // Reuse the original reasoning and tool groups, bounded to the most recent activity.
    const text = rows.findLast(
      (row) =>
        Predicate.isTagged(row, "AssistantPart") &&
        row.group.type === "part" &&
        Timeline.resolveContent(projection.messageByID().get(row.group.ref.messageID), row.group.ref.partID)?.type ===
          "text",
    )

    return rows
      .filter((row) => {
        if (!Predicate.isTagged(row, "AssistantPart") || row.group.type !== "part") return true

        return (
          Timeline.resolveContent(projection.messageByID().get(row.group.ref.messageID), row.group.ref.partID)?.type !==
            "text" || row === text
        )
      })
      .slice(-6)
      .map(TimelineRow.key)
  })

  function Row(props: { rowKey: string }) {
    const initial = projection.rowByKey().get(props.rowKey)!
    const row = createMemo(() => projection.rowByKey().get(props.rowKey) ?? initial)

    return <renderer.Row row={row} />
  }

  return (
    <div data-component="session-timeline" class={props.class}>
      <For each={rowKeys()}>{(rowKey) => <Row rowKey={rowKey} />}</For>
    </div>
  )
}
