/** Draws the native feed's ambient coral and blue light using built-in radial gradients and compositor animation. */

import { useEffect, useRef } from "react"
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native"

/** Drifts two non-interactive light fields, stopping completely when motion is disabled or the feed is hidden. */
export function FeedBackdrop({ motionEnabled }: { motionEnabled: boolean }) {
  const { width, height } = useWindowDimensions()
  const drift = useRef(new Animated.Value(0)).current
  const size = Math.max(width, height) * 1.1
  useEffect(() => {
    if (!motionEnabled) {
      drift.setValue(0)
      return
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 28000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 28000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ])
    )
    animation.start()
    return () => animation.stop()
  }, [drift, motionEnabled])
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Animated.View
        style={[
          styles.light,
          styles.warm,
          {
            width: size,
            height: size,
            top: -size * 0.5,
            right: -size * 0.4,
            transform: [
              {
                translateX: drift.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -width * 0.2],
                }),
              },
              {
                translateY: drift.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, height * 0.18],
                }),
              },
            ],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.light,
          styles.cool,
          {
            width: size,
            height: size,
            bottom: -size * 0.5,
            left: -size * 0.4,
            transform: [
              {
                translateX: drift.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, width * 0.2],
                }),
              },
              {
                translateY: drift.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -height * 0.15],
                }),
              },
            ],
          },
        ]}
      />
    </View>
  )
}

/** Gradients use React Native 0.86's existing background-image renderer; no new native dependency is needed. */
const styles = StyleSheet.create({
  light: { position: "absolute" },
  warm: {
    experimental_backgroundImage:
      "radial-gradient(ellipse at center, rgba(255,128,101,0.2) 0%, rgba(255,128,101,0.06) 35%, transparent 68%)",
  },
  cool: {
    experimental_backgroundImage:
      "radial-gradient(ellipse at center, rgba(59,130,246,0.17) 0%, rgba(59,130,246,0.04) 38%, transparent 68%)",
  },
})
