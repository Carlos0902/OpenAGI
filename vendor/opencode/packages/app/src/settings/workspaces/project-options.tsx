import { Show, type Component } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import { fileManagerApp } from "@/home/projects/file-manager"
import { useRevealProject } from "@/home/projects/reveal"
import { useProjectManagerActions } from "@/runtime/extension/projects"
import { showToast } from "@/shell/notifications/toast"

export const ProjectOptions: Component<{
  server: ServerConnection.Any
  project: LocalProject
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onEdit?: () => void
  onRename?: () => void
  onClose?: () => void
  class?: string
  size?: "small" | "normal" | "large"
}> = (props) => {
  const language = useLanguage()
  const global = useGlobal()
  const platform = usePlatform()
  const revealProject = useRevealProject()
  const actions = useProjectManagerActions()
  const context = () => global.ensureServerCtx(props.server)

  const unseen = () =>
    [props.project.worktree, ...(props.project.sandboxes ?? [])].reduce(
      (total, directory) => total + context().notification.project.unseenCount(directory),
      0,
    )

  const clearNotifications = () => {
    const notification = context().notification
    const directories = [props.project.worktree, ...(props.project.sandboxes ?? [])]
    directories
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))
  }

  const report = (error: Error) => showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: error.message,
  })

  const close = () => {
    const finish = () => {
      context().projects.close(props.project.worktree)
      props.onClose?.()
    }

    if (actions.handles(props.server)) {
      void actions.close(props.server, props.project.worktree).then(finish).catch(report)

      return
    }

    finish()
  }

  const remove = () => {
    void actions.remove(props.server, props.project.worktree).then(() => props.onClose?.()).catch(report)
  }

  return (
    <Menu
      gutter={4}
      modal={false}
      placement="bottom-end"
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <Menu.Trigger
        as={IconButton}
        variant="ghost-muted"
        size={props.size ?? "small"}
        class={props.class}
        icon={<Icon name="outline-dots" />}
        aria-label={language.t("common.moreOptions")}
      />
      <Menu.Portal>
        <Menu.Content>
          <Show when={props.onEdit} keyed>
            {(edit) => <Menu.Item onSelect={edit}>{language.t("common.edit")}</Menu.Item>}
          </Show>
          <Show when={props.onRename} keyed>
            {(rename) => <Menu.Item onSelect={rename}>{language.t("common.rename")}</Menu.Item>}
          </Show>
          <Show when={revealProject.available(props.server)}>
            <Menu.Item onSelect={() => revealProject.reveal(props.server, props.project)}>{language.t(fileManagerApp(platform.os ?? "unknown").actionLabel)}</Menu.Item>
          </Show>
          <Menu.Item disabled={unseen() === 0} onSelect={clearNotifications}>
            {language.t("sidebar.project.clearNotifications")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={close}>{language.t("common.close")}</Menu.Item>
          <Show when={actions.handles(props.server)}>
            <Menu.Item onSelect={remove}>{language.t("common.remove")}</Menu.Item>
          </Show>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
