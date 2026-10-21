import { useDialog } from "@opencode/ui/context/dialog"
import { createMemo, mapArray, onCleanup } from "solid-js"
import { commandPaletteOptions, useCommand } from "@/shell/commands/command"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import {
  createCommandPaletteCommandEntry,
  createServerSessionEntries,
  type CommandPaletteEntry,
  type PaletteHighlight,
} from "@/shell/commands/palette"
import { CommandPaletteView, matchesCommandPaletteEntry } from "@/shell/commands/dialog"

export function HomeCommandPalette(props: {
  servers: ServerConnection.Any[]
  onSelectSession: (entry: CommandPaletteEntry) => void
}) {
  const command = useCommand()
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const state: PaletteHighlight = { cleanup: undefined, committed: false }

  const commandEntries = createMemo(() => {
    const category = language.t("palette.group.commands")

    return commandPaletteOptions(command.options).map((option) => createCommandPaletteCommandEntry(option, category))
  })

  const sessions = mapArray(
    () => props.servers,
    (conn) => {
      const server = global.ensureServerCtx(conn)

      return createServerSessionEntries({
        server: ServerConnection.key(conn),
        opened: server.projects.list,
        stored: () => server.sync.data.project,
        load: (search, signal) => server.sdk.api.session.list({ parentID: null, search, limit: 50 }, { signal }),
        get: (sessionID, signal) => server.sdk.api.session.get({ sessionID }, { signal }),
        untitled: () => language.t("command.session.new"),
        category: () => language.t("command.category.session"),
        recentCategory: () => language.t("palette.group.recentSessions"),
      })
    },
  )

  const highlight = (item: CommandPaletteEntry | undefined) => {
    state.cleanup?.()
    state.cleanup = undefined

    if (item?.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()

    if (item.type === "command") {
      void item.option?.onSelect?.("palette")

      return
    }

    if (item.type === "session") props.onSelectSession(item)
  }

  const items = (query: string) => {
    if (!query) return commandEntries().slice(0, 5)

    return commandEntries().filter((entry) => matchesCommandPaletteEntry(entry, query))
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return (
    <CommandPaletteView
      placeholder={language.t("palette.search.placeholder.home")}
      items={items}
      sources={sessions()}
      highlight={highlight}
      select={select}
      close={() => dialog.close()}
    />
  )
}
