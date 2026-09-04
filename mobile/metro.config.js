/**
 * Configures Expo Metro for the standalone mobile app and the shared Blitz
 * learning module that lives one directory above this app.
 */

const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, "..")
const config = getDefaultConfig(projectRoot)

// Metro must watch the workspace root before it can resolve ../lib imports.
config.watchFolders = [workspaceRoot]

// Keep package resolution anchored to the mobile app's own lockfile. The
// workspace root is available as a watched source tree, not a dependency tree.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")]

module.exports = config
