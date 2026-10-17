#!/usr/bin/env node
/**
 * Builds the Blitz mini app for Ocean into ocean-app/dist: the React app bundled by esbuild
 * (with the `@/` paths from tsconfig.json, so it reuses Blitz's own components), its CSS compiled
 * by Tailwind from app/globals.css, and index.html. Ocean runs this itself (see `app.build` in
 * ocean.plugin.json) when the sources are newer than the build, so dist is never committed.
 * Run it by hand with `npm run build:ocean`.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import tailwind from "@tailwindcss/postcss"
import { build } from "esbuild"
import postcss from "postcss"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const dist = join(here, "dist")

/**
 * Leaves Mermaid (about 5 MB with its layout engines) out of the bundle, which the phone loads
 * through Ocean. Review cards rarely hold diagrams; one that does shows Blitz's usual "could not
 * be rendered" note with its source.
 */
const withoutMermaid = {
  name: "without-mermaid",
  setup(build) {
    build.onResolve({ filter: /^mermaid$/ }, () => ({
      path: "mermaid",
      namespace: "without-mermaid",
    }))
    build.onLoad({ filter: /.*/, namespace: "without-mermaid" }, () => ({
      contents:
        'export default { initialize() {}, render() { throw new Error("Diagrams aren\'t drawn in Ocean") } }',
      loader: "js",
    }))
  },
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

// The app: one script, with the CSS it imports (fonts, KaTeX) in app.css and their files beside it.
await build({
  entryPoints: [join(here, "src/main.tsx")],
  outfile: join(dist, "app.js"),
  tsconfig: join(root, "tsconfig.json"),
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
  // Shared components pull in a little of Next (next/link), which reads its build settings from
  // process.env; outside Next there are none.
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [withoutMermaid],
  logLevel: "error",
})

// Tailwind reads the mini app and the web app's components for the classes they use.
// Left unoptimised: Lightning CSS rewrites the Review cards' `animation-range: entry 0% exit 100%`
// to `entry exit 0%`, which leaves every card faded.
const input = join(here, "src/styles.css")
const css = await postcss([tailwind({ base: root, optimize: false })]).process(
  await readFile(input, "utf8"),
  { from: input, to: join(dist, "styles.css") }
)
await writeFile(join(dist, "styles.css"), css.css)

await copyFile(join(here, "index.html"), join(dist, "index.html"))
console.log(`Built the Ocean mini app into ${dist}`)
