# Local desktop host

[The desktop app](#the-desktop-app) is Blitz's Electron shell on macOS,
Windows, and Linux. It opens the
Blitz that is already serving: the background server on `3007`, which it
starts when it is installed but stopped (see [local server](local-server.md)),
or `npm run dev:lan`. Only when neither exists does the shell start the same
local services itself, in production mode, on loopback: Convex on the port pair
saved in `.convex/local/default/config.json` (or the next free pair from
`3220`), `next start` at `3008`, and the background worker
(`scripts/worker.ts`). Run from a release it also checks for updates; run from
a checkout it builds that checkout into `.next-production` first, which takes
about a minute after a change. The packaged app's icon is drawn from `app/icon.svg` at install
time: on Apple's icon grid for macOS, and as a flat rounded tile in a `.ico`
(Windows) or a 512 px PNG (Linux); the shared square PNG is only used when
running the shell unpackaged. The window opens straight away and shows that Blitz is starting
until Next answers.

The desktop supervisor in `electron/service-manager.mjs` owns each process
group, and `npm run dev:lan` uses the same supervisor. Closing the window or
quitting the app sends `SIGTERM` to every group and escalates to `SIGKILL` after
three seconds, so the worker and its Codex child processes do not remain behind.
Windows has no process groups, so there it stops each service's own process
in the same two steps.

Any service that exits unexpectedly, including Next and Convex, restarts with
exponential backoff from half a second up to 30 seconds. The backoff resets
after a service stays up for a minute. One failing service never stops the
others. Every five seconds after startup the supervisor also probes Next and
Convex; `convex dev` keeps running when the database it hosts dies, so a
service that misses three probes in a row is killed and restarted as
`unresponsive`. The worker starts only after Next and Convex answer.

The worker is one Node process that runs two isolated loops: `ingestion`
(source recovery) and `research` (Deep Research imports and proposals). A
failing step is logged and retried after 3 seconds, doubling up to 30 seconds,
while the other loop keeps running; if the process itself exits, the
supervisor restarts it like any other service. The Kokoro speech worker is
started on demand by Next and is not part of this process. Startup waits
up to 60 seconds (override with `BLITZ_DESKTOP_HEALTH_TIMEOUT_MS`).

Browsers rewrite a local `NEXT_PUBLIC_CONVEX_URL` to the hostname that served
the page (`lib/client/convex-url.ts`), so the same build works on this computer, from
a phone on the LAN, over Tailscale, and after the computer changes networks. The
app shows `Reconnecting to Blitz…` while its live connection is down.

The host takes the normal `.env.local` configuration and supports
`BLITZ_PORT` plus `BLITZ_DATA_DIR`. The data root defaults to
`~/Documents/Blitz`; project-scoped native actions resolve files under the
same hashed `Projects/project-<id-hash>` layout used by the local file store.
The preload bridge exposes only service status, open, and show-in-folder methods.
Uploads use Chromium's file input and streaming request body, avoiding a second
full-file copy through Electron IPC. Renderer access uses
context isolation, disabled Node integration, and a sandboxed preload. Native
paths are checked after realpath resolution to block traversal and symlink
escapes.

For a desktop session that
also serves browser clients, set `BLITZ_LAN_ADDRESS` to the computer's
LAN address before opening the app; the host then binds Next for that LAN
while the BrowserWindow continues to use loopback.

## The desktop app

`npm run desktop:install` (`scripts/install-desktop.mjs`) is the one command
to run after `npm ci`. It creates the checkout's local Convex database if
there is none, sets up the Blitz home (`~/.blitz`) with a release built from
`main` (the same home the [background server](local-server.md) uses, so
installing both builds once), then packages the shell and installs it:

| System | Installed at | Registered in |
| --- | --- | --- |
| macOS | `~/Applications/Blitz.app` | Launch Services, for `blitz://` |
| Windows | `%LOCALAPPDATA%\Programs\Blitz\Blitz.exe` | A Start menu shortcut, and `blitz://` under `HKCU\Software\Classes` |
| Linux | `~/.local/share/blitz/app/blitz` | `dev.blitz.Blitz.desktop` in `~/.local/share/applications`, for the applications menu and `blitz://` |

None of them needs administrator rights, with one exception: where Linux
restricts unprivileged user namespaces (Ubuntu 23.10 and later, or Debian with
the switch off), Chromium's sandbox helper `chrome-sandbox` must be setuid root,
so the installer runs `sudo chown` and `sudo chmod` on it and prints the
commands if that fails.

The shell holds Electron, the icon and a small entry point. The entry loads
`electron/main.mjs` from the current release (`~/.blitz/current`), so the app
runs released code rather than whatever branch the checkout is on, and hosts
the stack with the updater: while it is open, it checks `main` every 15
minutes and switches to each new commit as the
[background server](local-server.md#how-an-update-works) does. Without a
release it runs from the checkout it was built in, including uncommitted
edits. Installing again is only needed after Electron's version changes. On
Windows, quit Blitz first, since Windows locks a running program's files.
`--ref <branch>` builds the first release from a local branch instead of
`main`; CI uses it to install the commit under test. The shell is unsigned and
for the computer that built it, not an installer to share; Windows may show a
SmartScreen warning the first time.

The Blitz menu has `Check for updates…` and `Rebuild Blitz now`. They ask the
background server (or the app's own updater when it hosts the stack) and report
the outcome; a failed build offers its log. Updates and failures that happen in
the background appear as notifications.

Opened from Finder or a Linux applications menu, the app reads `PATH` and the
other variables from the login shell, because macOS and Linux desktops start
apps without what the shell profile adds (such as nvm's Node). Windows apps
inherit the user's full `PATH`. Service output goes to `blitz.log` in the
app's log folder (`~/Library/Logs/Blitz` on macOS, `%APPDATA%\Blitz\logs` on
Windows, `~/.config/Blitz/logs` on Linux), with the last launch's beside it as
`blitz.log.previous`. Next is bound to loopback unless `BLITZ_LAN_ADDRESS` is
set, which an app opened from Finder or the applications menu only picks up
from the login shell.

If Convex and Next already answer, from the background server (preferred),
`npm run dev:lan`, or a host that crashed, the window loads that stack instead
of starting a second one over the same database. Quitting then leaves that stack
running.

### Opening links in the app

The app answers `blitz://` links: `blitz://projects/<id>/learn/<unit>` opens
that page in the window, and `blitz://` alone opens the Library. A link that
arrives while Blitz is starting waits until the app has loaded
(`electron/open-links.mjs`). macOS hands the link to the running app;
Windows and Linux start a second copy with the link on its command line, which
passes it to the first and quits.

Ordinary `http` links keep working on a phone. On macOS, when one opens in a
browser on this Mac, the page hands itself to the app through a hidden frame, so the
browser tab stays usable, and shows a notice with `Open again`. It does this
only on a fresh arrival from a link (not a reload, back or forward, or a page
reached from Blitz itself), only in a browser on the Mac that runs the server
and finds an installed app that declares the scheme (`/api/desktop`; another
Mac or a browser driven by an agent or test stays put), and only while
Settings › Desktop app › `Open links in the app` is on. That choice is saved per browser and address. A browser may
ask before it opens the app. On Windows and Linux, `http` links stay in the
browser for now; `blitz://` links still open the app.

## Source files and retrieval

Original uploads use `POST /api/sources/upload` with `x-blitz-project-id`,
`x-blitz-filename`, and the raw file body. The same endpoint accepts browser and
Electron requests. Originals stream to the project folder
without an application byte limit. Local PDF
extraction uses file-backed range reads, while approved public research downloads
retain their separate 5 MB network boundary. Persisted extracted text is limited
to 500 KB in UTF-8. Inputs that cross a parsing or text bound stay saved for
agent inspection without partial indexing; Blitz never silently truncates
searchable evidence.

The worker's `ingestion` loop recovers queued uploads and expired five-minute ingestion
leases through `/api/sources/retry`. Failed files require an explicit retry.
A source is ready to teach as soon as ingestion completes; no lesson
generation job follows it.

Chat searches indexed chunks for each question, including projects attached in
earlier turns. Context is bounded and retains filename and location citations.
Exact text search remains the retrieval baseline; semantic indexing is not enabled.

Derived text is cached privately with `POST /api/projects/<id>/derived` using
`sourceKey` and `text`. `GET` lists review metadata, and `GET ?id=<id>` returns
bounded review text. An explicit POST with `action: "approve"` and the item ID
imports a labelled derived source through normal ingestion. Pending items are
not indexed. The artifact `Add to sources` action also copies its bytes into
`Sources/` through normal ingestion.

The default data directory may also be the development checkout. `Projects/`
and `.next-*` are therefore excluded from Git, lint, and Tailwind scanning.
Deleting a Convex project removes its associated metadata but retains local files
for recovery.

## Remaining agent limitation

Writable project-agent execution is disabled. The installed app-server protocol
supports broad workspace writes but does not provide the external filesystem
broker needed to exclude `.blitz/` reads and `Sources/` writes while allowing
other project files. The API returns 503, and the interface shows the capability
as unavailable. No prompt-only restriction or unrestricted fallback is used.

The task and artifact tables, scoped file access, and explicit promotion action
are available. Automatic creation, move/delete synchronization, and agent recovery
still need an enforceable execution backend. The complete agent/restart/phone
workflow has not been verified.

## Verification

Verified locally with TypeScript, ESLint, 138 Node tests, and a production build.
Live fixture checks covered a 240 KB upload with a cited fact at chunk 53,
original-byte downloads, duplicates, retry, derived approval gating, artifact
promotion, and denied symlink downloads. Temporary fixture projects were deleted.
Electron loaded Blitz on port 3901 with an isolated Next output directory and
shut down cleanly. The project file interface was inspected at 390 px and 1280 px.
