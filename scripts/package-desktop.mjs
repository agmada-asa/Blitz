/**
 * Builds Blitz.app under the ignored `out` folder and, with `--install`, copies
 * it to `~/Applications`. The bundle holds Electron, the icon and a small entry
 * point; it runs `electron/main.mjs` and the rest of Blitz from this checkout,
 * so code changes need only a relaunch. It is unsigned and for this Mac only.
 */

import { packager } from "@electron/packager"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import sharp from "sharp"

/** Display name, bundle name and executable name. */
const APP_NAME = "Blitz"

/** Runs a command and throws with its output when it fails. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
}

/**
 * Returns a superellipse path, the continuous curve of a macOS icon's corners
 * that a plain rounded rectangle only approximates.
 */
function squirclePath(center, radius, exponent = 5, steps = 360) {
  const points = Array.from({ length: steps }, (_, step) => {
    const angle = (step / steps) * 2 * Math.PI
    /** Moves along one axis, keeping the sign the fractional power would lose. */
    const along = (value) =>
      Math.sign(value) * Math.abs(value) ** (2 / exponent) * radius + center
    return `${along(Math.cos(angle)).toFixed(2)} ${along(Math.sin(angle)).toFixed(2)}`
  })
  return `M${points.join("L")}Z`
}

/**
 * Draws the bolt from `app/icon.svg` on Apple's icon grid: an 824 px tile with a
 * soft shadow, centred on a transparent 1024 px canvas. The web icon stays a
 * full square because phones and browsers apply their own mask; macOS does not.
 */
async function renderMacIcon(sourceSvg, destination) {
  const mark = readFileSync(sourceSvg, "utf8")
    .replace(/<svg[^>]*>/, "")
    .replace("</svg>", "")
    .replace(/<rect[^>]*\/>/, "")
  const tile = squirclePath(512, 412)
  await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <path d="${tile}" fill="#0c0c0e" filter="url(#shadow)"/>
  <path d="${tile}" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="3"/>
  <svg x="100" y="100" width="824" height="824" viewBox="0 0 1000 1000" fill="none">${mark}</svg>
</svg>`)
  )
    .png()
    .toFile(destination)
}

/**
 * Builds an `.icns` from the app icon with sips and iconutil, which ship with
 * macOS, so no derived image is committed.
 */
async function buildIcns(sourceSvg, workDirectory) {
  const sourcePng = join(workDirectory, `${APP_NAME}.png`)
  await renderMacIcon(sourceSvg, sourcePng)
  const iconset = join(workDirectory, `${APP_NAME}.iconset`)
  mkdirSync(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [
      [1, ""],
      [2, "@2x"],
    ]) {
      const pixels = String(size * scale)
      run("sips", [
        "-z",
        pixels,
        pixels,
        sourcePng,
        "--out",
        join(iconset, `icon_${size}x${size}${suffix}.png`),
      ])
    }
  }
  const icns = join(workDirectory, `${APP_NAME}.icns`)
  run("iconutil", ["-c", "icns", iconset, "-o", icns])
  return icns
}

/** Writes the bundle's own app: package metadata and an entry point into this checkout. */
function writeEntryPoint(directory, checkout) {
  const shell = join(directory, "app")
  mkdirSync(shell)
  writeFileSync(
    join(shell, "package.json"),
    JSON.stringify({
      name: "blitz",
      productName: APP_NAME,
      version: JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"))
        .version,
      type: "module",
      main: "main.mjs",
    })
  )
  const main = JSON.stringify(
    pathToFileURL(join(checkout, "electron", "main.mjs")).href
  )
  writeFileSync(
    join(shell, "main.mjs"),
    `import { app, dialog } from "electron"
try {
  await import(${main})
} catch (error) {
  await app.whenReady()
  dialog.showErrorBox(
    "Blitz could not start",
    "Could not load Blitz from " + ${JSON.stringify(checkout)} + ". Run npm run desktop:install from the checkout again.\\n\\n" + error.message
  )
  app.quit()
}
`
  )
  return shell
}

/** Packages the app and optionally installs it, replacing an earlier copy. */
async function main() {
  if (process.platform !== "darwin")
    throw new Error("Blitz.app is built for macOS only.")
  const checkout = resolve(import.meta.dirname, "..")
  const workDirectory = await mkdtemp(join(tmpdir(), "blitz-desktop-"))
  try {
    const [bundle] = await packager({
      dir: writeEntryPoint(workDirectory, checkout),
      out: join(checkout, "out"),
      name: APP_NAME,
      executableName: APP_NAME,
      appBundleId: "dev.blitz.desktop",
      appCategoryType: "public.app-category.education",
      platform: "darwin",
      arch: process.arch,
      electronVersion: JSON.parse(
        readFileSync(
          join(checkout, "node_modules", "electron", "package.json"),
          "utf8"
        )
      ).version,
      icon: await buildIcns(join(checkout, "app", "icon.svg"), workDirectory),
      overwrite: true,
      asar: false,
      prune: false,
      usageDescription: {
        Microphone:
          "Blitz listens when you ask the tutor a question with the mic. Recordings stay on this Mac.",
      },
    })
    const built = join(bundle, `${APP_NAME}.app`)
    // Renaming the bundle invalidates Electron's signature, and macOS only keeps
    // a microphone permission for an app whose signature checks out.
    run("codesign", ["--force", "--deep", "--sign", "-", built])
    console.log(`Built ${built}`)
    if (!process.argv.includes("--install")) return
    const destination = join(homedir(), "Applications", `${APP_NAME}.app`)
    await mkdir(join(homedir(), "Applications"), { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await cp(built, destination, { recursive: true, verbatimSymlinks: true })
    console.log(
      `Installed ${destination}. Quit any running copy before opening the new one.`
    )
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
