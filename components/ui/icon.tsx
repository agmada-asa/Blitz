/** Adapts the selected Hugeicons glyphs to a consistent React component API. */

import {
  Add01Icon,
  AiSparklesIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  BookOpen01Icon,
  BulbIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CheckIcon as CheckmarkIcon,
  ClipboardIcon,
  ComputerIcon,
  File01Icon,
  FileUploadIcon,
  Folder01Icon,
  HelpCircleIcon,
  Layers01Icon,
  Link02Icon,
  Loading03Icon,
  Moon02Icon,
  RotateLeft01Icon,
  Sun03Icon,
  ZapIcon as ZapGlyph,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react"

/** Props accepted by each bound icon except the already-selected glyph. */
type IconProps = Omit<HugeiconsIconProps, "icon">

/** Binds one Hugeicons glyph to a reusable component that forwards display props. */
const makeIcon = (icon: HugeiconsIconProps["icon"]) =>
  /** Renders the bound glyph with caller-supplied accessible and visual props. */
  function Icon(props: IconProps) {
    return <HugeiconsIcon icon={icon} {...props} />
  }

/** Add action glyph. */
export const AddIcon = makeIcon(Add01Icon)
/** Downward direction glyph. */
export const ArrowDownIcon = makeIcon(ArrowDown01Icon)
/** Back navigation glyph. */
export const ArrowLeftIcon = makeIcon(ArrowLeft01Icon)
/** External or forward navigation glyph. */
export const ArrowUpRightIcon = makeIcon(ArrowUpRight01Icon)
/** Study and reading glyph. */
export const BookOpenIcon = makeIcon(BookOpen01Icon)
/** Explanation card glyph. */
export const BulbLineIcon = makeIcon(BulbIcon)
/** Cancel and close glyph. */
export const CancelIcon = makeIcon(Cancel01Icon)
/** Completed item glyph. */
export const CheckCircleIcon = makeIcon(CheckmarkCircle02Icon)
/** Confirmation glyph. */
export const CheckIcon = makeIcon(CheckmarkIcon)
/** Paste action glyph. */
export const ClipboardPasteIcon = makeIcon(ClipboardIcon)
/** System theme glyph. */
export const ComputerIconComponent = makeIcon(ComputerIcon)
/** Source file glyph. */
export const FileIcon = makeIcon(File01Icon)
/** File upload glyph. */
export const FileUploadIconComponent = makeIcon(FileUploadIcon)
/** Project folder glyph. */
export const FolderIcon = makeIcon(Folder01Icon)
/** Recall prompt glyph. */
export const HelpIcon = makeIcon(HelpCircleIcon)
/** Source collection glyph. */
export const LayersIcon = makeIcon(Layers01Icon)
/** Connection card glyph. */
export const LinkIcon = makeIcon(Link02Icon)
/** Indeterminate progress glyph. */
export const LoadingIcon = makeIcon(Loading03Icon)
/** Dark theme glyph. */
export const MoonIcon = makeIcon(Moon02Icon)
/** Retry glyph. */
export const RotateLeftIcon = makeIcon(RotateLeft01Icon)
/** Generation glyph. */
export const SparklesIcon = makeIcon(AiSparklesIcon)
/** Light theme glyph. */
export const SunIcon = makeIcon(Sun03Icon)
/** Blitz brand and energy glyph. */
export const ZapIcon = makeIcon(ZapGlyph)
