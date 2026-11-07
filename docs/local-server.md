# Local server and automatic updates

Blitz runs as a production server (`next start`) for everyday use, and keeps
`next dev` for coding. A development server holds every compiled route, source
map, and hot reload state in memory, and recompiles each time the checkout
changes branch or commit, so a day of use can grow it to many gigabytes. A
production server does not compile anything while it runs and stays at a few
hundred megabytes.

## Ways to run Blitz

| Command | What runs | Port |
| --- | --- | --- |
| `npm run server -- install` | The background server: a launchd agent serving the newest release of `main`, updated automatically | 3007 |
| `npm run dev:lan` | Points at the background server when it is installed; otherwise builds this checkout into `.next-production` (again only after the code changes) and serves it | 3007 |
| `npm run dev` | `next dev` from this checkout, for coding | 3007, or 3009 beside a running server |
| Blitz.app | Opens the running server, starting the background server if it is installed; otherwise hosts the stack itself in production mode | 3007, else 3008 |

`npm run dev` checks whether another Blitz already serves the database. If one
does, it starts only Next, on port 3009, against that database, and does not
push this checkout's Convex functions or start workers. To work on Convex
functions, stop the server first with `npm run server -- stop`.

## The background server

`npm run server -- install` sets up the Blitz home, `~/.blitz` (or `BLITZ_HOME`):

- `config.json`: the repository to fetch, the branch to follow (`main`), and
  `sharedRoot`, the checkout whose `.env.local` and local Convex database the
  server uses. Each check rereads it.
- `repo.git`: a bare clone that releases are checked out from.
- `releases/<commit>-<time>`: one detached worktree per build, with its own
  `node_modules` and `.next`. The newest three are kept.
- `current`: a link to the release being served.
- `logs/`: `server.log` (the server's own messages), `services.log` (Next,
  Convex, and the worker; trimmed above 20 MB), and one `build-*.log` per build.
- `run/state.json`: the release, the last check, and the last failure, read by
  the desktop app and `npm run server -- status`.

The agent `dev.blitz.server` runs `scripts/dev-lan.mjs --service` from
`current`, restarts it after a crash, and starts it at login. Installing needs
a local Convex database in the checkout, so run `npm run dev` there once
before the first install. `--ref <branch>` installs a local branch that is not
on GitHub yet; the server still follows `main` afterwards and switches as soon
as `main` contains the server code. The plist records the Node binary that ran
the install, so run `install` again after changing Node versions. Run
`npm run desktop:install` afterwards so Blitz.app loads its code from `current`.

Other commands: `status`, `check` (check for updates now), `rebuild` (build
the newest commit again, even after a failure), `stop`, `start`, and
`uninstall` (keeps `~/.blitz`). Blitz.app has `Check for updates…` and
`Rebuild Blitz now` in its Blitz menu.

## How an update works

On launch and every 15 minutes the server fetches `main`. When it has moved:

1. The new commit is checked out into a fresh release. Dependencies are cloned
   from a kept release with the same `package-lock.json` (APFS copy on write,
   seconds and almost no disk) or installed with `npm ci`. `next build` runs at
   low CPU priority. A failure here changes nothing.
2. The new Next server starts on a spare port and must serve `/`.
3. The server waits until no chat reply is streaming (`activeChatRuns` in
   `/api/health`), for at most ten minutes.
4. The new Convex functions are pushed to the running backend. The push is
   atomic: if the schema does not match the stored data, nothing changes.
5. Every service restarts from the new release, so Blitz is offline for a few
   seconds.
6. `current` is pointed at the new release.

Steps 4 to 6 succeed or are undone together. If any of them fails, including a
push that times out after the backend may already have taken the new
functions, the previous release's functions are pushed back and its services
run again; if that push fails too, the previous release restarts, which pushes
them as Convex starts. If the previous release will not start again either,
the new one keeps running and is recorded as the release being served. A crash
during these steps needs no recovery: the next launch serves `current`, still
the previous release, and Convex pushes its functions as it starts.

A commit that fails is not retried every 15 minutes; a newer commit, `rebuild`,
or `Rebuild Blitz now` tries again. The desktop app shows a notification with
the build log. When an update changes the server code itself
(`RUNNER_FILES` in `electron/auto-update.mjs`), the server exits after
switching and launchd starts it again from the new release.

`check` and `rebuild` write a request file to `run/requests/` and signal the
server, which answers each request by ID in `run/state.json`. A request sent
while the server is starting waits until it is serving, and one sent while a
launch is waiting to retry makes it retry now. A rebuild asked for during a
plain check runs after that check, instead of being answered by it.

A commit that does not contain `electron/release-manager.mjs` is never served,
since it could not update itself again.

## Convex

The local database stays in the shared checkout (`.convex/local/default`), and
every release links to it. Convex runs as `convex dev` from the current
release without type checks or code generation; because a release never
changes, the functions it pushes always match the code being served. Each
update pushes the new release's functions just before switching (step 4).

Only one Convex backend may open the database. Every launcher checks the saved
port's `/instance_name` first and refuses to start a second backend, and each
records its process groups in `~/.blitz/run/*-services.json` so the next launch
stops any it left behind after being killed. That includes release builds and
trial servers, and `next dev`, which the supervisor runs directly rather than
through `scripts/dev.mjs`. Each group is recorded with its leader's start time,
so a process that later reuses the ID is never stopped. Stopping a service
waits until every process in its group is gone, killing survivors after five
seconds, so nothing keeps a port or the database open into the next start.

## Phone access

The server listens on every interface at port 3007. Over Tailscale, open
`http://<Mac's full Tailscale DNS name>:3007`; Convex must be reachable on its
own port (3212 by default) too. A page served over HTTPS (for example through
`tailscale serve`) cannot open the plain `ws://` Convex connection, so use the
HTTP address.
