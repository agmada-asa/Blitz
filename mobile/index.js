/**
 * Registers Blitz's root component for Expo Go and generated native builds.
 * Keeping this entrypoint JavaScript lets Expo's standard AppEntry contract
 * work while the application implementation remains type checked in TSX.
 */

import { registerRootComponent } from "expo"

import App from "./App"

registerRootComponent(App)
