/**
 * Colours and spacing shared by the native Teach, Practice, and Home screens.
 * They mirror the web app's dark theme tokens in `app/globals.css` (the app
 * is dark only), so the phone and desktop read as one product. Older screens
 * still inline the same values.
 */

/** Semantic colours, named after the web tokens they mirror. */
export const colors = {
  background: "#101010",
  card: "#191919",
  cardRaised: "#1f1f1f",
  muted: "#242424",
  border: "#303030",
  foreground: "#f7f7f7",
  text: "#dddddd",
  mutedForeground: "#aaaaaa",
  faint: "#777777",
  brand: "#ff8065",
  brandForeground: "#1b0d0a",
  /** The brand colour at low strength, for tinted panels. */
  brandTint: "#2a1713",
  brandBorder: "#5a2e24",
  correct: "#5fd48a",
  correctTint: "#123b26",
  incorrect: "#ff756e",
  incorrectTint: "#3b1919",
} as const

/** Brand colour at an opacity, for concept strength and tints. */
export function brandAlpha(alpha: number): string {
  const channel = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
  return `${colors.brand}${channel}`
}

/** Corner radii matching the web cards and buttons. */
export const radius = { sm: 10, md: 14, lg: 18, xl: 22, pill: 999 } as const

/** Minimum touch target, from the platform guidelines. */
export const TOUCH_TARGET = 44
