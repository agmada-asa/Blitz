/**
 * Installs Blitz as a desktop app on macOS, Windows, or Linux
 * (`npm run desktop:install`). It is the one command a learner runs after
 * `npm ci`:
 *
 * 1. Creates the local database if this checkout has none (`install-home.mjs`).
 * 2. Sets up the Blitz home (`~/.blitz`) with a release built from `main`.
 * 3. Packages a small Electron shell and installs it where the system looks
 *    for apps: `~/Applications/Blitz.app` on macOS, the Start menu on Windows,
 *    the applications menu on Linux. Each registers `blitz://` links (see
 *    `electron/open-links.mjs`).
 *
 * The shell holds Electron, the icon and a small entry point. The entry runs
 * `electron/main.mjs` from the current release (`~/.blitz/current`), so the
 * app runs released code and updates itself from `main` while it is open; it
 * falls back to this checkout only when there is no release. Installing again
 * is only needed after Electron's version changes. The shell is unsigned and
 * built for the computer that runs this command, not for sharing.
 *
 * `--ref <branch>` builds the first release from a local branch or commit
 * instead of `main`, such as one under review; the app still updates from `main`.
 */

import { packager } from "@electron/packager"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import sharp from "sharp"
import { isServerInstalled } from "../electron/background-server.mjs"
import { blitzHome, readServerConfig } from "../electron/release-manager.mjs"
import { desktopExecQuote, packIco } from "./desktop-files.mjs"
import { ensureLocalDatabase, mainCheckout, setUpHome } from "./install-home.mjs"

/** Display name, bundle name and executable name. */
const APP_NAME = "Blitz"
/** The URL scheme the app registers; matches `LINK_SCHEME` in `electron/open-links.mjs`. */
const LINK_SCHEME = "blitz"
/**
 * The app's identity on Linux: the `.desktop` file's name, the icon's name,
 * and the window class Electron reports, which must all match.
 */
const LINUX_APP_ID = "dev.blitz.Blitz"
/** Apple's tool for updating the Launch Services database, which maps URL schemes to apps. */
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

/**
 * Runs a command and throws with its output when it fails.
 * @param {string} command The program.
 * @param {string[]} args Its arguments.
 * @param {import("node:child_process").SpawnSyncOptions} [options] Extra options, such as `env`.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message}`)
}

/**
 * Returns the value after a `--name` flag.
 * @param {string} name The flag without dashes.
 */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
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
 * Draws the bolt from `app/icon.svg` on a dark rounded tile, centred on a
 * transparent 1024 px canvas, and returns it as a PNG. macOS wants Apple's
 * icon grid: an 824 px tile with a soft shadow. Windows and Linux draw no
 * shadow and expect the tile to fill most of the canvas. The web icon stays a
 * full square because phones and browsers apply their own mask.
 * @param {string} sourceSvg The app icon.
 * @param {{tile: number, shadow: boolean}} layout The tile's width and whether it casts a shadow.
 * @returns {Promise<Buffer>} A 1024 px PNG.
 */
async function renderIcon(sourceSvg, { tile, shadow }) {
  const mark = readFileSync(sourceSvg, "utf8")
    .replace(/<svg[^>]*>/, "")
    .replace("</svg>", "")
    .replace(/<rect[^>]*\/>/, "")
  const path = squirclePath(512, tile / 2)
  const inset = (1024 - tile) / 2
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <path d="${path}" fill="#0c0c0e"${shadow ? ' filter="url(#shadow)"' : ""}/>
  <path d="${path}" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="3"/>
  <svg x="${inset}" y="${inset}" width="${tile}" height="${tile}" viewBox="0 0 1000 1000" fill="none">${mark}</svg>
</svg>`)
  )
    .png()
    .toBuffer()
}

/** The icon as macOS draws it. */
const MAC_ICON = { tile: 824, shadow: true }
/** The icon as Windows and Linux draw it. */
const FLAT_ICON = { tile: 960, shadow: false }

/**
 * Builds an `.icns` from the app icon with sips and iconutil, which ship with
 * macOS, so no derived image is committed.
 * @param {string} sourceSvg The app icon.
 * @param {string} workDirectory A scratch folder.
 * @returns {Promise<string>} The `.icns` path.
 */
async function buildIcns(sourceSvg, workDirectory) {
  const sourcePng = join(workDirectory, `${APP_NAME}.png`)
  writeFileSync(sourcePng, await renderIcon(sourceSvg, MAC_ICON))
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

/**
 * Builds a Windows `.ico` with the sizes Explorer and the taskbar use.
 * @param {string} sourceSvg The app icon.
 * @param {string} workDirectory A scratch folder.
 * @returns {Promise<string>} The `.ico` path.
 */
async function buildIco(sourceSvg, workDirectory) {
  const source = await renderIcon(sourceSvg, FLAT_ICON)
  const images = await Promise.all(
    [16, 24, 32, 48, 64, 128, 256].map(async (size) => ({
      size,
      png: await sharp(source).resize(size, size).png().toBuffer(),
    }))
  )
  const ico = join(workDirectory, `${APP_NAME}.ico`)
  writeFileSync(ico, packIco(images))
  return ico
}

/**
 * Writes the shell's own app: package metadata and an entry point. The entry
 * loads the current release (`$BLITZ_HOME/current`, by default
 * `~/.blitz/current`) when one exists, so the app runs released code from the
 * tracked branch rather than whatever this checkout has checked out. Without
 * a release it falls back to this checkout.
 *
 * On macOS the entry also queues `blitz://` links on `globalThis.blitzLinkQueue`
 * until the loaded code takes them, because macOS can deliver the link that
 * launched the app before that import has finished. Windows and Linux pass
 * the link on the command line, which the loaded code reads itself.
 * @param {string} directory A scratch folder.
 * @param {string} checkout This checkout.
 * @returns {string} The shell's app folder.
 */
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
      // Electron's identity on Linux; it must match the installed `.desktop` file.
      desktopName: `${LINUX_APP_ID}.desktop`,
    })
  )
  const checkoutMain = JSON.stringify(join(checkout, "electron", "main.mjs"))
  writeFileSync(
    join(shell, "main.mjs"),
    `import { app, dialog } from "electron"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const home = process.env.BLITZ_HOME?.trim() || join(homedir(), ".blitz")
const release = join(home, "current", "electron", "main.mjs")
const main = existsSync(release) ? release : ${checkoutMain}
const links = []
const queueLink = (event, link) => {
  event.preventDefault()
  links.push(link)
}
app.on("open-url", queueLink)
globalThis.blitzLinkQueue = { links, stop: () => app.off("open-url", queueLink) }
try {
  await import(pathToFileURL(main).href)
} catch (error) {
  await app.whenReady()
  dialog.showErrorBox(
    "Blitz could not start",
    "Could not load Blitz from " + main + ". Run npm run desktop:install from the checkout again.\\n\\n" + error.message
  )
  app.quit()
}
`
  )
  return shell
}

/**
 * Packages the shell for this computer's platform into the ignored `out` folder.
 * @param {string} checkout This checkout.
 * @param {string} workDirectory A scratch folder.
 * @returns {Promise<string>} The packaged folder, which holds `Blitz.app`,
 *   `Blitz.exe`, or the Linux `blitz` executable.
 */
async function packageShell(checkout, workDirectory) {
  const { platform } = process
  const icon = join(checkout, "app", "icon.svg")
  const [bundle] = await packager({
    dir: writeEntryPoint(workDirectory, checkout),
    out: join(checkout, "out"),
    name: APP_NAME,
    // Linux programs are conventionally lowercase.
    executableName: platform === "linux" ? "blitz" : APP_NAME,
    platform,
    arch: process.arch,
    electronVersion: JSON.parse(
      readFileSync(join(checkout, "node_modules", "electron", "package.json"), "utf8")
    ).version,
    icon:
      platform === "darwin"
        ? await buildIcns(icon, workDirectory)
        : platform === "win32"
          ? await buildIco(icon, workDirectory)
          : undefined,
    overwrite: true,
    asar: false,
    prune: false,
    ...(platform === "darwin"
      ? {
          appBundleId: "dev.blitz.desktop",
          appCategoryType: "public.app-category.education",
          protocols: [{ name: APP_NAME, schemes: [LINK_SCHEME] }],
          usageDescription: {
            Microphone:
              "Blitz listens when you ask the tutor a question with the mic. Recordings stay on this Mac.",
          },
        }
      : {}),
    ...(platform === "win32"
      ? { win32metadata: { ProductName: APP_NAME, FileDescription: APP_NAME } }
      : {}),
  })
  return bundle
}

/**
 * Removes an earlier install and copies the new one in its place.
 * @param {string} source The packaged app.
 * @param {string} destination Where it is installed.
 * @throws With what to do when the old copy is still running and locked.
 */
async function replaceInstall(source, destination) {
  try {
    await rm(destination, { recursive: true, force: true })
  } catch (error) {
    // Windows refuses to delete a running program's files.
    if (["EBUSY", "EPERM"].includes(/** @type {NodeJS.ErrnoException} */ (error).code))
      throw new Error(`Blitz is running from ${destination}. Quit it, then run npm run desktop:install again.`)
    throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, verbatimSymlinks: true })
}

/**
 * Signs and installs `Blitz.app` in `~/Applications`, and points `blitz://`
 * links at it.
 * @param {string} bundle The packaged folder.
 * @returns {Promise<string>} Where to find the app, for the closing message.
 */
async function installMac(bundle) {
  const built = join(bundle, `${APP_NAME}.app`)
  // Renaming the bundle invalidates Electron's signature, and macOS only keeps
  // a microphone permission for an app whose signature checks out.
  run("codesign", ["--force", "--deep", "--sign", "-", built])
  const destination = join(homedir(), "Applications", `${APP_NAME}.app`)
  await replaceInstall(built, destination)
  // Point `blitz://` links at the installed copy straight away, not at the
  // build left in `out`, which has the same bundle ID.
  // Unregistering a build macOS never saw fails harmlessly.
  spawnSync(LSREGISTER, ["-u", built])
  run(LSREGISTER, ["-f", destination])
  return `Installed ${destination}. Open Blitz from Launchpad or Spotlight; quit any running copy first.`
}

/**
 * Installs Blitz for this Windows user, without administrator rights: the
 * program in `%LOCALAPPDATA%\Programs\Blitz`, a Start menu shortcut, and
 * `blitz://` links in the user's registry hive.
 * @param {string} bundle The packaged folder.
 * @returns {Promise<string>} Where to find the app, for the closing message.
 */
async function installWindows(bundle) {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
  const roamingAppData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
  const destination = join(localAppData, "Programs", APP_NAME)
  await replaceInstall(bundle, destination)
  const executable = join(destination, `${APP_NAME}.exe`)
  // Paths travel as environment variables and the script as UTF-16 Base64,
  // so nothing needs quoting through the Windows command line.
  const script = `
$ErrorActionPreference = 'Stop'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BLITZ_SHORTCUT)
$shortcut.TargetPath = $env:BLITZ_EXE
$shortcut.WorkingDirectory = $env:BLITZ_DIR
$shortcut.Save()
$key = 'HKCU:\\Software\\Classes\\' + $env:BLITZ_SCHEME
$command = $key + '\\shell\\open\\command'
New-Item -Path $command -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Blitz'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
$q = [char]34
Set-ItemProperty -Path $command -Name '(default)' -Value ($q + $env:BLITZ_EXE + $q + ' ' + $q + '%1' + $q)
`
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env: {
      ...process.env,
      BLITZ_SHORTCUT: join(roamingAppData, "Microsoft", "Windows", "Start Menu", "Programs", `${APP_NAME}.lnk`),
      BLITZ_EXE: executable,
      BLITZ_DIR: destination,
      BLITZ_SCHEME: LINK_SCHEME,
    },
  })
  return `Installed ${executable}. Open Blitz from the Start menu.`
}

/**
 * Reports whether this Linux kernel stops programs creating user namespaces,
 * which Chromium's default sandbox needs: Debian's switch, or Ubuntu's
 * AppArmor rule from 23.10. Chromium then falls back to `chrome-sandbox`,
 * which only works when it is owned by root with the setuid bit.
 */
function userNamespacesRestricted() {
  /** Reads a kernel setting, or nothing when this kernel lacks it. */
  const setting = (path) => {
    try {
      return readFileSync(path, "utf8").trim()
    } catch {
      return undefined
    }
  }
  return (
    setting("/proc/sys/kernel/unprivileged_userns_clone") === "0" ||
    setting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1"
  )
}

/**
 * Installs Blitz for this Linux user: the program under
 * `$XDG_DATA_HOME/blitz/app`, an icon, and a `.desktop` entry that puts it in
 * the applications menu and answers `blitz://` links. Where the kernel
 * restricts user namespaces, `sudo` makes Chromium's sandbox helper setuid
 * root, which a per-user install cannot do on its own.
 * @param {string} bundle The packaged folder.
 * @returns {Promise<string>} Where to find the app, for the closing message.
 */
async function installLinux(bundle) {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
  const destination = join(dataHome, "blitz", "app")
  await replaceInstall(bundle, destination)
  const executable = join(destination, "blitz")

  const iconPath = join(dataHome, "icons", "hicolor", "512x512", "apps", `${LINUX_APP_ID}.png`)
  await mkdir(dirname(iconPath), { recursive: true })
  await sharp(await renderIcon(join(resolve(import.meta.dirname, ".."), "app", "icon.svg"), FLAT_ICON))
    .resize(512, 512)
    .png()
    .toFile(iconPath)

  const applications = join(dataHome, "applications")
  await mkdir(applications, { recursive: true })
  await writeFile(
    join(applications, `${LINUX_APP_ID}.desktop`),
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${APP_NAME}`,
      "Comment=Learn your course material",
      `Exec=${desktopExecQuote(executable)} %u`,
      `Icon=${LINUX_APP_ID}`,
      "Terminal=false",
      "Categories=Education;",
      `MimeType=x-scheme-handler/${LINK_SCHEME};`,
      `StartupWMClass=${LINUX_APP_ID}`,
      "",
    ].join("\n")
  )
  // Both are optional desktop tools; without them the menu still finds the
  // entry, and the app registers itself for links when it starts.
  spawnSync("update-desktop-database", [applications], { stdio: "ignore" })
  spawnSync("xdg-mime", ["default", `${LINUX_APP_ID}.desktop`, `x-scheme-handler/${LINK_SCHEME}`], {
    stdio: "ignore",
  })

  if (userNamespacesRestricted()) {
    const helper = join(destination, "chrome-sandbox")
    console.log(
      "This Linux restricts the sandbox Blitz's window runs in, so its helper needs to be owned by root. sudo may ask for your password."
    )
    const owned = spawnSync("sudo", ["chown", "root:root", helper], { stdio: "inherit" })
    const setuid =
      owned.status === 0 && spawnSync("sudo", ["chmod", "4755", helper], { stdio: "inherit" })
    if (!setuid || setuid.status !== 0) {
      // Single-quoted for the shell, so a path with spaces pastes as one argument.
      const quoted = `'${helper.replaceAll("'", `'\\''`)}'`
      console.log(
        `Blitz won't open until this is done. Run:\n  sudo chown root:root ${quoted} && sudo chmod 4755 ${quoted}`
      )
    }
  }
  return `Installed ${executable}. Open Blitz from your applications menu.`
}

/** Sets up the database and release, then packages and installs the app. */
async function main() {
  const installers = { darwin: installMac, win32: installWindows, linux: installLinux }
  const install = installers[/** @type {keyof typeof installers} */ (process.platform)]
  if (!install) throw new Error(`Blitz has no desktop app for ${process.platform}.`)
  const checkout = resolve(import.meta.dirname, "..")
  const sharedRoot = mainCheckout(checkout)
  await ensureLocalDatabase(sharedRoot)
  await setUpHome({ home: blitzHome(), checkout, sharedRoot, ref: option("ref") })
  // A home set up earlier may follow another branch, which it keeps.
  const branch = (await readServerConfig(blitzHome()))?.branch ?? "main"

  console.log("Packaging the app…")
  const workDirectory = await mkdtemp(join(tmpdir(), "blitz-desktop-"))
  try {
    const bundle = await packageShell(checkout, workDirectory)
    console.log(await install(bundle))
    console.log(
      isServerInstalled()
        ? "It opens the background server, which keeps Blitz up to date."
        : `While it is open, Blitz updates itself from ${branch} every 15 minutes.`
    )
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
