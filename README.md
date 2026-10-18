# Blitz

![Blitz](app/icon.svg)

Blitz teaches you your own course material. Drop in a week's lecture slides, transcripts, and notes, and it teaches them back in short sessions, quizzes you, and keeps returning to what hasn't stuck. In exam season, import past papers and sit mock exams marked against the mark scheme.

It runs on your Mac and uses the AI coding agent you already pay for (Codex, Claude Code, OpenCode, or Google Antigravity) instead of an API key. Your material and progress stay in a local database.

## Quick start

You need Node.js 22.13 or newer and one supported agent installed and signed in. Codex is the default. Blitz is developed and tested on macOS; other platforms are untested.

```bash
git clone https://github.com/agmada-asa/Blitz.git
cd Blitz
npm ci
npm run dev:lan
```

Open the printed address, create a project, add a week's material, and open its first unit to start a Teach session. The address also works on a phone on the same Wi-Fi.

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

Questions use single choice, multiple answers, or true/false. Answers receive server-scored feedback. Reading and skipping never count as knowing a concept. `Ask in chat` attaches a card and its source section to your own question, and follow-ups reuse the conversation. Web and Android replies stream as they arrive, with Markdown formatting and saved history after reconnecting.

Imports accept text PDFs, Markdown, plain text, and PowerPoint `.pptx` files. Public links can return those formats or HTML. Source URLs and page/slide markers are retained. Scanned PDFs need OCR elsewhere, and each extracted source is currently limited to 120,000 characters.

Use `Find sources` within a project to ask Blitz for a proposed learning scope and references discovered through web search. Review the links before selecting which to import. Imported sources appear as unsorted sources; use `Group into a unit` on the module page to teach them. Proposed note outlines are previews only.

## Run locally in detail

Use Node.js 22.13 or newer, with at least one supported local provider installed and signed in. Codex is the default provider. Claude Code 2.1.248 or newer can run replies and card generation with tools disabled. OpenCode v1.18.21 or newer within v1 supports native tool permissions. Google Antigravity ACP supports interactive workspace chat. Development has been verified with Node.js 24 on macOS.

```bash
npm ci
npm run dev:lan
```

The launcher starts Next.js, local Convex, and the source recovery and Deep Research workers, then prints the LAN address and a QR code. Open that address on a phone connected to the same Wi-Fi. A crashed or unresponsive service restarts automatically with backoff instead of stopping Blitz; restarts are printed as `[blitz] <service> stopped … Restarting`. Without Wi-Fi, Blitz still runs on this Mac. Pressing `Ctrl+C` or closing its terminal stops every process group; a service that does not exit within three seconds is killed so it cannot retain a development port. Set `BLITZ_PORT` to change the web port from `3007`.

For separate terminals:

```bash
npx convex dev
npm run dev
npm run worker:ingestion
npm run worker:research
```

The workers load `.env.local`. `BLITZ_CONVEX_URL` points server code and workers at Convex. Browsers rewrite a local `NEXT_PUBLIC_CONVEX_URL` to the hostname that served the page, so one value works on the Mac, on the LAN, and through Tailscale IPs or full `.ts.net` DNS names. With Tailscale connected on both devices, open `http://<Mac's full Tailscale DNS name>:3007`. Both the web port and the local Convex port must be reachable over the tailnet. Next.js discovers this Mac's exact Tailscale names and IPs using `tailscale status --json` so development scripts can load through those addresses. If the CLI is unavailable, set `BLITZ_TAILNET_HOST` to the full DNS hostname before starting Next.js. Restart Next.js after changing the Mac's tailnet identity. No cloud deployment or API key is required for this local setup.

## Provider controls

Settings reports installation and account state separately for every provider. The Provider connections panel starts login, refreshes status, and clears local provider credentials after confirmation. Blitz also rejects a disconnected provider before saving settings or starting a turn. Claude Code uses the documented `sonnet`, `opus`, and `haiku` aliases; older saved `claude-*` aliases are translated when a turn starts.

Provider access is saved separately for each provider. Chat's **Provider policy** option uses that setting; explicit **Full access** uses the provider's native bypass mode. **Project access** remains Codex-only because the other adapters do not supply an equivalent workspace-only OS sandbox. Provider-native tool rules are not an OS sandbox, and administrator policies still apply.

| Provider        | Deny requests                                           | Ask when needed                                               | Full access                                      |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Codex           | Read-only sandbox, approvals `never`                    | `on-request`, or `untrusted`                                  | `danger-full-access`, approvals `never`          |
| Claude Code     | Restricted mode with all tools disabled                 | Explicit tool ask rules and the SDK's stdin approval protocol | `bypassPermissions`                              |
| OpenCode        | Dedicated agent with `permission["*"] = "deny"`         | Dedicated agent with `permission["*"] = "ask"`                | Dedicated agent with `permission["*"] = "allow"` |
| Antigravity ACP | Native `default` mode; Blitz denies permission requests | Native `default` mode; Blitz reviews permission requests      | Native `yolo` mode                               |

Claude and ACP requests use the composer request panel. Codex approvals,
native provider tool asks, Blitz-owned Codex questions and confirmation
checkpoints, and supported MCP form or URL handoffs appear in the same panel
above the message field. Decisions grant
one operation or turn only; Blitz never sends persistent permission updates or
ACP `allow_always`. Missing handlers, oversized requests, cancellation, and
failed reviews use safe denial responses. Modes are reasserted on resumed
sessions. Claude disables local customizations and MCP servers. OpenCode uses
`--pure`, disables project configuration, and creates a distinct agent per
process so saved agents cannot override its selected policy. Agent delegation
and mode switching tools stay disabled in OpenCode.

Interactive chat treats attached project material as its primary evidence. If
that material cannot resolve a question or a tool would materially improve the
answer, Codex chat can use live web search when the provider allows it. External
findings stay separate from attached source citations.

Background card preparation and card replies always use restricted policies regardless of saved full access. Claude removes all tools; OpenCode denies all native tools. Antigravity is unavailable for these background tasks: its ACP default mode allows reads, and there is no advertised tool-off mode. The installed `agy` CLI's `--prompt`/`--print` selects one-shot output, not tool isolation. A local CLI 1.1.22 probe with a custom agent declaring `tools: []` still advertised shell, file, browser, and network tools. The adapter does not treat that as a security boundary.

For Antigravity, Blitz first checks `BLITZ_ANTIGRAVITY_ACP_COMMAND`, its own managed runtime directory, common ACP client directories, and the macOS file index for a compatible `agy_acp_server.par`. If no shared copy exists, **Install and connect** downloads the current machine-specific package from the [official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json), installs it under Blitz application data, and starts personal Google login. Once installed, Settings exposes every authentication method and model variant advertised by the runtime. Antigravity bundles its reasoning tier into each native model choice, and Blitz reapplies that exact choice with ACP `session/set_config_option` before a turn. The Antigravity desktop app, the `agy` CLI, and Antigravity ACP keep separate authentication state.

Claude passes supported reasoning selections with `--effort`. Haiku and OpenCode expose only the provider default. Antigravity reports model-specific reasoning tiers as distinct native model choices. Legacy unsupported effort selections are normalized to the provider default. Native permission references: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input), [OpenCode permissions](https://opencode.ai/docs/permissions/), [Antigravity CLI headless behavior](https://antigravity.google/docs/cli/headless/). Antigravity ACP modes were verified against Google's official `agy_acp_server_1.1.1` distribution; its defaults differ from CLI print mode.

The ACP client negotiates `session/load` and `session/resume`. If neither is supported, it fails before accepting a turn so workspace chat can rebuild its saved history in a new session. Historical load notifications are excluded from the new answer. Both adapters bound stdout and assistant output, decode split UTF-8 safely, and terminate on transport failures or deadlines.

## Use from other agents

`node mcp/server.mjs` is an MCP server that lets other agents see what's due, read the Library and add material to a unit while Blitz is running. See [the MCP server](mcp/README.md).

## Android

The React Native app lives in `mobile/` with its own dependencies and checks. It connects to the same printed LAN address. Prepared cards are cached, and offline answers wait for server feedback after sync. The app is frozen during the overhaul: card chat questions, pasted notes, and links added from Android are saved but no longer answered or prepared.

See [Android setup](docs/mobile.md) for development and the bundled debug APK build. Browser imports remain available through the native Library action.

After building the APK, `npm run dev:lan` also prints its download link. The launcher uses the ignored `build/android/blitz-android-debug.apk` when present; set `BLITZ_ANDROID_APK_PATH` to serve a different local build.

## Checks and implementation

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run check:runtimes
```

`npm run check:runtimes` reports when an installed provider CLI no longer matches what Blitz relies on. See [AI model settings](docs/ai-model-settings.md).

Run native checks from `mobile/`. The [overhaul plan](docs/overhaul-plan.md) records the current direction, and [`docs/history`](docs/history/README.md) keeps the early planning notes. Implementation details are in [Teach](docs/teach.md), [source ingestion](docs/source-ingestion.md), [learning API](docs/learning-api.md), and [Codex text turns and legacy card chat](docs/card-chat.md).

## Known limits

This version is a personal local app without account authentication. It is not configured for public hosting. Android offline storage and the local agent are separate from any future cloud sync service. Creating proposed notes, richer diagrams, and moving topics are still outside this version. Android now includes native project browsing, creation, rename, and deletion. Written activities and source imports still use the browser.

- The agents, local database, and speech run on the computer hosting Blitz; a phone is only a client of it.
- Six local processes (Next.js, Convex, and workers) run under one supervisor. Consolidating the workers is planned.
- The Android app is frozen during the overhaul.
- Citations land on a page, slide, timestamp, or heading when the source has one; other passages only get a section label.

## Credits

Read aloud and podcasts use [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0), downloaded on first use. The voice previews in `public/audio/voices/` were generated with it.

## License

[MIT](LICENSE)
