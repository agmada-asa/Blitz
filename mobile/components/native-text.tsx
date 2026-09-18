/** Applies the bundled Instrument Sans faces to every native text surface. */

import {
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from "react-native"

import { fontFamilyForWeight, MOBILE_FONT_FAMILIES } from "../lib/typography"

/** Resolves an explicit family first, then selects a bundled face by weight. */
function familyForStyle(style: TextStyle | TextStyle[] | undefined): string {
  const flattened = StyleSheet.flatten(style)
  return (
    flattened?.fontFamily ??
    fontFamilyForWeight(flattened?.fontWeight) ??
    MOBILE_FONT_FAMILIES.regular
  )
}

/** Renders text with the same Instrument Sans family as the web app. */
export function Text({ style, ...props }: TextProps) {
  return (
    <NativeText
      {...props}
      style={[style, { fontFamily: familyForStyle(style as TextStyle) }]}
    />
  )
}

/** Renders editable text with the same Instrument Sans family as the web app. */
export function TextInput({ style, ...props }: TextInputProps) {
  return (
    <NativeTextInput
      {...props}
      style={[style, { fontFamily: familyForStyle(style as TextStyle) }]}
    />
  )
}
