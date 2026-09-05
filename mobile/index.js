/**
 * Registers Blitz's root component for Expo Go and generated native builds.
 * Keeping this entrypoint JavaScript lets Expo's standard AppEntry contract
 * work while the application implementation remains type checked in TSX.
 */

import { registerRootComponent } from "expo"
import { SafeAreaProvider } from "react-native-safe-area-context"

import App from "./App"

/** Provides safe-area insets to every native screen before registration. */
function BlitzRoot() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  )
}

registerRootComponent(BlitzRoot)
