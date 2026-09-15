/** Owns the native bottom navigation using the same glyphs as the web shell. */

import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Pressable, StyleSheet, View } from "react-native"
import type { ComponentType } from "react"

import {
  WebChatIcon,
  WebFolderIcon,
  WebHomeIcon,
  WebNotificationIcon,
  WebSettingsIcon,
  type WebIconProps,
} from "./web-icon"

/** Stable destinations exposed by the native bottom navigation. */
export type MobileNavigationKey =
  "home" | "library" | "chat" | "activity" | "settings"

/** One navigation item with the same single stroke glyph in each state. */
type NavigationItem = {
  readonly key: MobileNavigationKey
  readonly label: string
  readonly icon: ComponentType<WebIconProps>
}

/** Props required to render and activate the native bottom navigation. */
export type BottomNavigationProps = {
  readonly activeKey: MobileNavigationKey
  readonly onSelect: (key: MobileNavigationKey) => void
}

const navigationItems: readonly NavigationItem[] = [
  {
    key: "home",
    label: "Home",
    icon: WebHomeIcon,
  },
  {
    key: "library",
    label: "Library",
    icon: WebFolderIcon,
  },
  {
    key: "chat",
    label: "Chat",
    icon: WebChatIcon,
  },
  {
    key: "activity",
    label: "Activity",
    icon: WebNotificationIcon,
  },
  {
    key: "settings",
    label: "Settings",
    icon: WebSettingsIcon,
  },
]

/** Renders large, touch-safe icons while keeping labels available to assistive technology. */
export function BottomNavigation({
  activeKey,
  onSelect,
}: BottomNavigationProps) {
  const insets = useSafeAreaInsets()

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {navigationItems.map((item) => {
          const active = activeKey === item.key
          const Icon = item.icon
          return (
            <Pressable
              key={item.key}
              accessibilityLabel={item.label}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(item.key)}
              style={({ pressed }) => [
                styles.item,
                active && styles.itemActive,
                pressed && styles.itemPressed,
              ]}
            >
              <Icon
                accessible={false}
                size={25}
                color={active ? "#ff8065" : "#eeeeee"}
                strokeWidth={active ? 2 : 1.8}
              />
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    zIndex: 5,
  },
  bar: {
    alignItems: "center",
    backgroundColor: "rgba(9,9,9,0.97)",
    borderTopColor: "#252525",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: 68,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  item: {
    alignItems: "center",
    borderRadius: 18,
    flex: 1,
    height: 48,
    justifyContent: "center",
    marginHorizontal: 2,
  },
  itemActive: {
    backgroundColor: "rgba(255,128,101,0.13)",
  },
  itemPressed: {
    opacity: 0.72,
  },
})
