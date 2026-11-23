# Blitz

<img src="app/icon.svg" alt="Blitz" width="96" height="96">

Blitz teaches you your own course material. Drop in a week's lecture slides, transcripts, and notes, and it teaches them back in short sessions, quizzes you, and keeps returning to what hasn't stuck. In exam season, import past papers and sit mock exams marked against the mark scheme.

It runs on your computer and uses the AI coding agent you already pay for (Codex, Claude Code, OpenCode, or Antigravity) instead of an API key. Your material and progress stay in a local database.

## Quick start

You need Node.js 22.13 or newer, Git, and one supported agent installed and signed in. Codex is the default. Blitz works on macOS, Windows, and Linux. It's built on a Mac, so Windows and Linux have had less real use; see [Windows](#windows) and [Linux](#linux) for what's different there.

```bash
git clone https://github.com/agmada-asa/Blitz.git
cd Blitz
npm ci
npm run desktop:install
```

That's the whole setup. It creates the local database, builds Blitz (a few minutes the first time), and installs the app: in `~/Applications` on macOS, the Start menu on Windows, and the applications menu on Linux. Open Blitz from there, create a project, add a week's material, and open its first unit to start a Teach session.

While it's open, Blitz checks for a new version every 15 minutes and switches to it on its own, so you don't need to install it again to get updates. The Blitz menu also has `Check for updates…`. See [the desktop app](docs/local-desktop-host.md#the-desktop-app).

### Keeping it running in the background

To use Blitz from a phone or a browser without the app open, run `npm run server -- install` as well (macOS and Linux). Blitz then runs in the background at http://localhost:3007, starts when you log in, and keeps updating itself. The app then opens that server instead of running its own copy. See [local server](docs/local-server.md).

### Working on the code

```bash
npm run dev
```

This runs Blitz from your checkout and reloads as you edit. It opens in your browser when it has started; if it doesn't, open the printed address. If the installed app or the background server is already serving the database, it starts on port `3009` against the same database. See [Run locally in detail](#run-locally-in-detail).

## What it does

- **Teach**: each upload is filed into a unit (a week or a lecture). Opening a unit starts a live lesson with an outline, citations back to your sources, and quick checks along the way. See [Teach](docs/teach.md).
- **Practice**: a question bank per unit, drills weighted towards weak concepts, and a single action to relearn a concept you keep missing.
- **Exam mode**: import past papers, sit mock exams, and get written answers marked. See [exam mode](docs/exam-mode.md).
- **Chat**: ask about your material with the attached sources as evidence, or ask about any question card.
- **Today and Review**: the Library shows your streak, today's XP, the lesson to continue, and a link to Review, a scroll of questions on what's due.

## Learn

Create a project in Library and add files, pasted notes, or a public link. Each upload is filed into a unit, usually a week or a lecture, and is ready to teach as soon as its text is extracted. Opening a unit starts a live Teach session; see [Teach](docs/teach.md). The Library is the start page. Its Today panel links to the lesson in progress and to Review, a feed that mixes projects; Filter narrows it to a project or topic.

Open a project or topic for a focused feed, Study with immediate feedback, or a Test with results at the end. Topics can be renamed or excluded from the mixed feed.

Choose `Study` then `Written answers` for a separate writing activity. Save a draft or compare your response with the prepared reference. Written activities resume where you left off and do not award an automatic score.

Questions are mostly single choice, multiple answers, or true/false, with fill-in-the-blank, ordering, matching, and code output where they fit. Answers receive server-scored feedback. Reading and skipping never count as knowing a concept. `Ask in chat` attaches a card and its source section to your own question, and follow-ups reuse the conversation. Web replies stream as they arrive, with Markdown formatting and saved history after reconnecting.

Imports accept text PDFs, PowerPoint `.pptx`, Word `.docx`, Markdown, plain text, `.vtt` and `.srt` subtitles, HTML, and code files. Public links can return PDF, PowerPoint, Markdown, text, or HTML. Source URLs and page, slide, and timestamp markers are retained. Scanned PDFs need OCR elsewhere. A whole textbook can be imported (up to 3,000 PDF pages or 20 million characters) and becomes a reference the tutor searches. See [adding material](docs/source-import.md).

Use `Find sources` within a project to ask Blitz for a proposed learning scope and references discovered through web search. Review the links before selecting which to import. Imported sources appear as unsorted sources; use `Group into a unit` on the module page to teach them. Proposed note outlines are previews only.

## Run locally in detail

Use Node.js 22.13 or newer, with at least one supported local provider installed and signed in. Codex is the default provider and needs Codex CLI 0.164.0 or newer within v0. Claude Code 2.1.248 or newer can run replies and card generation with tools disabled. OpenCode 2.3.0 or newer within v2 supports native tool permissions; v1 is no longer supported. Antigravity CLI 1.5.0 or newer runs through its own `agy acp` server, signed in with the same Google account as `agy`. Development has been verified with Node.js 24 on macOS.

```bash
npm ci
npm run dev
```

`npm run dev` starts Next.js in development mode, local Convex, and one background worker for source recovery and Deep Research, then prints "Blitz has started" with its address and the phone address, and opens it in your browser. Their output goes to `~/.blitz/logs/dev.log`; only errors and restarts reach the terminal. To keep the full output as it was, with the QR code and no browser, run `npm run dev:verbose`, or set `BLITZ_VERBOSE=1` to make that the default. Add `-- --no-open` to keep the browser closed. Pages compile the first time you open them, so the first visit to each is slow. For long everyday use, `npm run dev:lan` runs the same stack from a production build instead (about a minute to build the first time, and again only after the code changes), which stays faster and uses less memory over a long session. To use Blitz on a phone, open the phone address it prints on a phone connected to the same Wi-Fi. A crashed or unresponsive service restarts automatically with backoff instead of stopping Blitz; restarts are printed as `[blitz] <service> stopped … Restarting`. Without Wi-Fi, Blitz still runs on this computer. Pressing `Ctrl+C` or closing its terminal stops every process group; a service whose processes have not all exited within five seconds is killed so it cannot retain a development port. Set `BLITZ_PORT` to change the web port from `3007`.

For separate terminals:

```bash
npx convex dev
node scripts/dev.mjs
node --experimental-strip-types scripts/worker.ts
```

These run the development server, which grows in memory over a long session; use them for coding rather than everyday use.

The worker runs source recovery, Find sources research, and chat thread housekeeping as three loops in one process; a failing loop is logged and retried with backoff while the others keep running. `--only ingestion`, `--only research`, or `--only threads` runs only one loop, and `--once` runs a single pass. See [architecture](docs/architecture.md#the-background-worker). The worker loads `.env.local`. `BLITZ_CONVEX_URL` points server code and the worker at Convex through `lib/server/convex.ts`. Browsers rewrite a local `NEXT_PUBLIC_CONVEX_URL` to the hostname that served the page, so one value works on this computer, on the LAN, and through Tailscale IPs or full `.ts.net` DNS names. With Tailscale connected on both devices, open `http://<this computer's full Tailscale DNS name>:3007`. Both the web port and the local Convex port must be reachable over the tailnet. Next.js discovers this computer's exact Tailscale names and IPs using `tailscale status --json` so development scripts can load through those addresses. If the CLI is unavailable, set `BLITZ_TAILNET_HOST` to the full DNS hostname before starting Next.js. Restart Next.js after changing this computer's tailnet identity. No cloud deployment or API key is required for this local setup.

### Windows

Run the commands from PowerShell or Command Prompt. `npm run desktop:install` installs Blitz for your user only, with no administrator prompt, and adds it to the Start menu. It isn't signed, so Windows may show a SmartScreen warning the first time; choose `More info`, then `Run anyway`. Quit Blitz before installing again. Provider CLIs installed with npm (such as `codex.cmd`) are found on PATH. Claude Code runs the copy bundled with Blitz's Claude SDK and uses your existing Claude sign-in, unless `BLITZ_CLAUDE_CODE_COMMAND` names another. What doesn't work on Windows yet:

- `npm run server` installs a background service on macOS and Linux only, so on Windows Blitz runs and updates while the app is open.
- Read-aloud and podcasts use a local speech model that runs only on macOS and Linux, and spoken questions need an Apple silicon Mac.
- Cleaning up processes left behind by a launcher that crashed is macOS and Linux only. If a later start says a port is taken, end the leftover `node` processes in Task Manager.

Signing in to OpenCode or Antigravity from Settings opens a Command Prompt window for the sign-in.

### Linux

`npm run desktop:install` installs Blitz for your user and adds it to your applications menu. On Ubuntu 23.10 and later, the app's sandbox helper has to be owned by root, so the installer runs `sudo` once and may ask for your password. Read-aloud and podcasts work too: run `sh scripts/setup-kokoro.sh` (on Debian and Ubuntu, first `sudo apt install python3-venv`). See [local Kokoro](docs/local-kokoro.md). What doesn't work on Linux yet:

- Spoken questions and voice mode need an Apple silicon Mac.

`npm run server -- install` runs Blitz in the background as a systemd user service; see [local server](docs/local-server.md). Signing in to OpenCode or Antigravity from Settings opens your desktop's terminal. On a machine without a desktop, run `opencode auth login` or `agy acp --login` yourself.

## Provider controls

Settings reports installation and account state separately for every provider. The Provider connections panel starts login, refreshes status, and clears local provider credentials after confirmation. Blitz also rejects a disconnected provider before saving settings or starting a turn. Claude Code uses the documented `sonnet`, `opus`, `haiku`, and `fable` aliases; older saved `claude-*` aliases are translated when a turn starts.

Provider access is saved separately for each provider. Chat's **Provider policy** option uses that setting; explicit **Full access** uses the provider's native bypass mode. **Project access** remains Codex-only because the other adapters do not supply an equivalent workspace-only OS sandbox. Provider-native tool rules are not an OS sandbox, and administrator policies still apply.

| Provider        | Deny requests                                           | Ask when needed                                               | Full access                                      |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Codex           | Read-only sandbox, approvals `never`                    | `on-request`, or `untrusted`                                  | `danger-full-access`, approvals `never`          |
| Claude Code     | Restricted mode with all tools disabled                 | Explicit tool ask rules and the SDK's stdin approval protocol | `bypassPermissions`                              |
| OpenCode        | Dedicated agent with `permission["*"] = "deny"`         | Dedicated agent with `permission["*"] = "ask"`                | Dedicated agent with `permission["*"] = "allow"` |
| Antigravity     | `--sandbox`, every permission request refused           | The CLI's own requests before edits and commands              | Every permission request allowed once            |

Claude and ACP requests use the composer request panel. Codex approvals,
native provider tool asks, Blitz-owned Codex questions and confirmation
checkpoints, and supported MCP form or URL handoffs appear in the same panel
above the message field. Decisions grant
one operation or turn only; Blitz never sends persistent permission updates or
ACP `allow_always`. Missing handlers, oversized requests, cancellation, and
failed reviews use safe denial responses. Modes are reasserted on resumed
sessions. Claude disables local customizations and MCP servers. OpenCode
disables project configuration and defines Blitz's own agent in each process
so saved agents cannot override its selected policy. Agent delegation
and mode switching tools stay disabled in OpenCode. Antigravity sessions open
in the CLI's configured mode, which out of the box asks before edits and
commands.

Interactive chat treats attached project material as its primary evidence. If
that material cannot resolve a question or a tool would materially improve the
answer, Codex chat can use live web search when the provider allows it. External
findings stay separate from attached source citations.

Background card preparation and card replies always use restricted policies regardless of saved full access. Claude removes all tools; OpenCode denies all native tools; Antigravity runs sandboxed and every permission request is refused.

Claude passes supported reasoning selections with `--effort`. OpenCode and Antigravity expose only the provider default. Legacy unsupported effort selections are normalized to the provider default. Native permission references: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input), [OpenCode permissions](https://opencode.ai/docs/permissions/). Settings saved under Blitz's first Antigravity integration move to Gemini 3.8 Flash.

The ACP client negotiates `session/load` and `session/resume`. If neither is supported, it fails before accepting a turn so workspace chat can rebuild its saved history in a new session. Historical load notifications are excluded from the new answer. Both adapters bound stdout and assistant output, decode split UTF-8 safely, and terminate on transport failures or deadlines.

## Blitz MCP

`node mcp/server.mjs` is an MCP server that lets other agents see what's due, read the Library and add material to a unit while Blitz is running. See [the MCP server](mcp/README.md).

## Checks and implementation

The CI workflow in `.github/workflows/provider-runtimes.yml` runs the full `npm test` suite on macOS with Node.js 24 for every pull request and every push to `main`, without path filters. The macOS runner also exercises the two transcription tests that would skip on Linux because transcription is restricted to macOS. It uses the npm download cache and `npm ci`; test failures fail the job, and the log includes test totals. Tests use local fixtures and doubles, so no running database, provider login, or deployment is needed. On Windows and Linux it starts Blitz from the checkout and opens a project (`scripts/smoke-start.mjs`). On macOS, Windows, and Linux it runs `npm run desktop:install`, opens the installed app, saves a project through it, and checks that the app can fetch `main` for updates (`scripts/smoke-desktop.mjs`). The same workflow retains the scheduled provider compatibility check and supports manual runs.

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run check:runtimes
```

`npm run check:runtimes` reports when OpenCode, Antigravity or the Codex model catalogue no longer matches what Blitz relies on; Codex and Claude Code compatibility is checked by [agent-engines](docs/agent-engines.md). See [AI model settings](docs/ai-model-settings.md).

Implementation details are in [the docs](docs/README.md), starting with [architecture](docs/architecture.md).

## Known limits

This version is a personal local app without account authentication. It is not configured for public hosting. The local agent is separate from any future cloud sync service. Creating proposed notes, richer diagrams, and moving topics are still outside this version.

- The agents, local database, and speech run on the computer hosting Blitz; a phone is only a client of it.
- Four local services (Next.js, Convex, the voice service, and one worker) run under one supervisor; the speech workers start on demand.
- Citations land on a page, slide, timestamp, or heading when the source has one; other passages only get a section label.

## Credits

Read aloud and podcasts use [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0), downloaded on first use. Spoken questions are transcribed on the Mac with [Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) (MIT) through MLX, also downloaded on first use; see [local speech](docs/local-kokoro.md). The voice previews in `public/audio/voices/` were generated with Kokoro.

## License

[MIT](LICENSE)
