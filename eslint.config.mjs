/** Applies Next.js lint rules while excluding generated and build output. */

import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

/** Repository ESLint configuration for handwritten application code. */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "Projects/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "convex/_generated/**",
    // The native package owns its React Native checks and generated Android files.
    "mobile/**",
  ]),
  // Electron's sandbox preload only supports CommonJS in this host version.
  {
    files: ["electron/preload.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
])

export default eslintConfig
