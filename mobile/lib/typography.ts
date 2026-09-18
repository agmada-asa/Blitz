/** Centralizes the bundled Instrument Sans faces used by the native app. */

import type { TextStyle } from "react-native"

/** Static Instrument Sans family names loaded before native content renders. */
export const MOBILE_FONT_FAMILIES = {
  regular: "InstrumentSans_400Regular",
  medium: "InstrumentSans_500Medium",
  semibold: "InstrumentSans_600SemiBold",
  bold: "InstrumentSans_700Bold",
} as const

/** Maps React Native weight hints to the closest bundled Instrument Sans face. */
export function fontFamilyForWeight(weight: TextStyle["fontWeight"]): string {
  switch (weight) {
    case "500":
      return MOBILE_FONT_FAMILIES.medium
    case "600":
      return MOBILE_FONT_FAMILIES.semibold
    case "700":
    case "bold":
    case "800":
    case "900":
      return MOBILE_FONT_FAMILIES.bold
    default:
      return MOBILE_FONT_FAMILIES.regular
  }
}
