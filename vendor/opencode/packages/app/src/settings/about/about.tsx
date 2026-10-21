import { useDialog } from "@opencode/ui/context/dialog"
import { Wordmark } from "@opencode/ui/wordmark"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { appName } from "@/runtime/product"
import { ExternalLink } from "@/runtime/platform/external-link"
import { showToast } from "@/shell/notifications/toast"

export function SettingsAbout(_props: { active: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  let noticesButton: HTMLButtonElement | undefined

  const showNotices = async () => {
    const loaded = await import("./notices/dialog").catch(() => undefined)

    if (!loaded) {
      showToast({ variant: "error", title: language.t("settings.about.notices.loadFailed") })

      return
    }

    void dialog.show(() => (
      <loaded.default
        onCloseAutoFocus={(event) => {
          if (!noticesButton?.isConnected) return
          event.preventDefault()
          noticesButton.focus({ preventScroll: true })
        }}
      />
    ))
  }

  return (
    <div class="settings-about-content">
      <div class="settings-about-intro">
        <h2>{appName}</h2>
        <p>{language.t("settings.about.version", { version: platform.version ?? language.t("settings.about.devVersion") })}</p>
        <p>{language.t("settings.about.license")}</p>
      </div>
      <Wordmark class="settings-about-wordmark" muted={false} fade={false} />
      <div class="settings-about-details">
        <p>{language.t("settings.about.openagi.description")}</p>
        <p>{language.t("settings.about.openagi.workflow")}</p>
        <p>{language.t("settings.about.openagi.configuration")}</p>
        <p>{language.t("settings.about.openagi.build")}</p>
      </div>
      <div class="settings-about-details">
        <p>{language.t("settings.about.openagi.attribution")}</p>
        <p>
          <ExternalLink href="https://github.com/anomalyco/opencode/tree/v2">
            {language.t("settings.about.openagi.source")}
          </ExternalLink>
        </p>
        <p>
          <button ref={noticesButton} type="button" class="settings-about-link" onClick={() => void showNotices()}>
            {language.t("settings.about.notices.title")}
          </button>
        </p>
      </div>
    </div>
  )
}
