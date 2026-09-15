/** Reuses Blitz's web Hugeicons glyphs in native controls for visual parity. */

import { HugeiconsIcon, type HugeiconsProps } from "@hugeicons/react-native"
import {
  AlertCircleIcon,
  AiSearch01Icon,
  AiSparklesIcon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Chat01Icon,
  Cancel01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  Download01Icon,
  File01Icon,
  Folder01Icon,
  HelpCircleIcon,
  Home01Icon,
  Layers01Icon,
  Loading03Icon,
  Menu01Icon,
  MoreHorizontalIcon,
  Notification02Icon,
  PauseIcon,
  Refresh04Icon,
  Settings02Icon,
  SendIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons"

/** Props accepted by a native Hugeicons glyph after its web glyph is bound. */
export type WebIconProps = Omit<HugeiconsProps, "icon">

/** Binds one web Hugeicons glyph to a small native component. */
function bindWebIcon(icon: HugeiconsProps["icon"]) {
  /** Renders the selected web glyph with native SVG props. */
  return function BoundWebIcon(props: WebIconProps) {
    return <HugeiconsIcon icon={icon} {...props} />
  }
}

/** Home navigation glyph shared with the web app shell. */
export const WebHomeIcon = bindWebIcon(Home01Icon)
/** Project library navigation glyph shared with the web app shell. */
export const WebFolderIcon = bindWebIcon(Folder01Icon)
/** Chat navigation glyph shared with the web app shell. */
export const WebChatIcon = bindWebIcon(Chat01Icon)
/** Activity navigation glyph shared with the web app shell. */
export const WebNotificationIcon = bindWebIcon(Notification02Icon)
/** Settings navigation glyph shared with the web app shell. */
export const WebSettingsIcon = bindWebIcon(Settings02Icon)
/** Back navigation glyph shared with the web workspace. */
export const WebArrowLeftIcon = bindWebIcon(ArrowLeft01Icon)
/** Forward navigation glyph shared with the web workspace. */
export const WebArrowRightIcon = bindWebIcon(ArrowRight01Icon)
/** Downward disclosure glyph shared with web study controls. */
export const WebArrowDownIcon = bindWebIcon(ArrowDown01Icon)
/** Close glyph shared with web dialogs and sheets. */
export const WebCancelIcon = bindWebIcon(Cancel01Icon)
/** Overflow menu glyph shared with the web workspace. */
export const WebMoreIcon = bindWebIcon(MoreHorizontalIcon)
/** Menu glyph shared with the web chat workspace. */
export const WebMenuIcon = bindWebIcon(Menu01Icon)
/** Learning-path glyph shared with the web workspace. */
export const WebLayersIcon = bindWebIcon(Layers01Icon)
/** AI tools glyph shared with the web workspace. */
export const WebSparklesIcon = bindWebIcon(AiSparklesIcon)
/** Deeper-search glyph shared with web walkthrough cards. */
export const WebAiSearchIcon = bindWebIcon(AiSearch01Icon)
/** Help glyph shared with web quick-check cards. */
export const WebHelpIcon = bindWebIcon(HelpCircleIcon)
/** Answer confirmation glyph shared with web answer controls. */
export const WebCheckIcon = bindWebIcon(CheckIcon)
/** Completed-state glyph shared with web activity rows. */
export const WebCheckCircleIcon = bindWebIcon(CheckmarkCircle02Icon)
/** Error-state glyph shared with web activity rows. */
export const WebAlertIcon = bindWebIcon(AlertCircleIcon)
/** In-progress glyph shared with web activity rows. */
export const WebLoadingIcon = bindWebIcon(Loading03Icon)
/** Import glyph shared with web activity rows. */
export const WebDownloadIcon = bindWebIcon(Download01Icon)
/** Source file glyph shared with the web project workspace. */
export const WebFileIcon = bindWebIcon(File01Icon)
/** Refresh and card-flip glyph shared with web walkthrough controls. */
export const WebRefreshIcon = bindWebIcon(Refresh04Icon)
/** Ask Blitz glyph shared with web walkthrough controls. */
export const WebZapIcon = bindWebIcon(ZapIcon)
/** Add glyph shared with web creation controls. */
export const WebAddIcon = bindWebIcon(Add01Icon)
/** Send glyph shared with web chat composition. */
export const WebSendIcon = bindWebIcon(SendIcon)
/** Stop glyph shared with web chat composition. */
export const WebPauseIcon = bindWebIcon(PauseIcon)
