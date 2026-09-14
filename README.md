# Blitz

![Blitz](app/icon.svg)

Blitz turns source material into a scrolling learning feed for Android and the web. Local Mac workers prepare explanations, questions, and replies through the provider selected in Blitz settings.

## Run locally

Use Node.js 22.13 or newer, with at least one supported local provider installed and signed in. Codex is the default provider. Claude Code 2.1.248 or newer can run replies and card generation with tools disabled. OpenCode v1.18.21 or newer within v1 supports native tool permissions. Google Antigravity ACP supports interactive workspace chat. Development has been verified with Node.js 24 on macOS.

```bash
npm ci
npm run dev:lan
```

The launcher starts Next.js, local Convex, the preparation, card chat, and research workers. Open the printed LAN address on a phone connected to the same Wi-Fi. Keep the process running while using the web app. Pressing `Ctrl+C` stops every process group; a service that does not exit within three seconds is killed so it cannot retain a development port. Set `BLITZ_PORT` to change the web port from `3001`.

For separate terminals:

```bash
npx convex dev
npm run dev
npm run worker:ingestion
npm run worker
npm run worker:chat
npm run worker:research
```

The workers load `.env.local`. `BLITZ_CONVEX_URL` can point them at a loopback address while `NEXT_PUBLIC_CONVEX_URL` points browser clients at the LAN address. No cloud deployment or API key is required for this local setup.

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

In development, **Test requests** in the composer runs a local fixture for all
four request modes. It is useful for checking the UI without relying on a
provider or MCP server that supports structured elicitation.

Interactive chat treats attached project material as its primary evidence. If
that material cannot resolve a question or a tool would materially improve the
answer, Codex chat can use live web search when the provider allows it. External
findings stay separate from attached source citations.

Background card preparation and card replies always use restricted policies regardless of saved full access. Claude removes all tools; OpenCode denies all native tools. Antigravity is unavailable for these background tasks: its ACP default mode allows reads, and there is no advertised tool-off mode. The installed `agy` CLI's `--prompt`/`--print` selects one-shot output, not tool isolation. A local CLI 1.1.22 probe with a custom agent declaring `tools: []` still advertised shell, file, browser, and network tools. The adapter does not treat that as a security boundary.

For Antigravity, Blitz first checks `BLITZ_ANTIGRAVITY_ACP_COMMAND`, its own managed runtime directory, common ACP client directories, and the macOS file index for a compatible `agy_acp_server.par`. If no shared copy exists, **Install and connect** downloads the current machine-specific package from the [official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json), installs it under Blitz application data, and starts personal Google login. Once installed, Settings exposes every authentication method and model variant advertised by the runtime. Antigravity bundles its reasoning tier into each native model choice, and Blitz reapplies that exact choice with ACP `session/set_config_option` before a turn. The Antigravity desktop app, the `agy` CLI, and Antigravity ACP keep separate authentication state.

Claude passes supported reasoning selections with `--effort`. Haiku and OpenCode expose only the provider default. Antigravity reports model-specific reasoning tiers as distinct native model choices. Legacy unsupported effort selections are normalized to the provider default. Native permission references: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input), [OpenCode permissions](https://opencode.ai/docs/permissions/), [Antigravity CLI headless behavior](https://antigravity.google/docs/cli/headless/). Antigravity ACP modes were verified against Google's official `agy_acp_server_1.1.1` distribution; its defaults differ from CLI print mode.

The ACP client negotiates `session/load` and `session/resume`. If neither is supported, it fails before accepting a turn so workspace chat can rebuild its saved history in a new session. Historical load notifications are excluded from the new answer. Both adapters bound stdout and assistant output, decode split UTF-8 safely, and terminate on transport failures or deadlines.

## Learn

Create a project in Library and add files, pasted notes, or a public link. Preparation runs in the background and can resume from a saved section. The home feed mixes projects; Filter narrows it to a project or topic.

Open a project or topic for a focused feed, Study with immediate feedback, or a Test with results at the end. Topics can be renamed or excluded from the mixed feed.

Choose `Study` then `Written answers` for a separate writing activity. Save a draft or compare your response with the prepared reference. Written activities resume where you left off and do not award an automatic score.

Questions use single choice, multiple answers, or true/false. Answers receive server-scored feedback. Reading and skipping never count as knowing a concept. `Ask in chat` attaches a card and its source section to your own question, and follow-ups reuse the conversation. Web and Android replies stream as they arrive, with Markdown formatting and saved history after reconnecting.

Imports accept text PDFs, Markdown, plain text, and PowerPoint `.pptx` files. Public links can return those formats or HTML. Source URLs and page/slide markers are retained. Scanned PDFs need OCR elsewhere, and each extracted source is currently limited to 120,000 characters.

Use `Find sources` within a project to ask Blitz for a proposed learning scope and references discovered through web search. Review the links before selecting which to import. Imported sources join the same preparation queue. Proposed note outlines are previews only.

## Android

The React Native app lives in `mobile/` with its own dependencies and checks. It connects to the same printed LAN address. Prepared cards are cached, and offline answers wait for server feedback after sync. New source generation and chat replies need the Mac worker online.

See [Android setup](docs/mobile.md) for development and the bundled debug APK build. Browser imports remain available through the native Library action.

After building the APK, `npm run dev:lan` also prints its download link. The launcher uses the ignored `build/android/blitz-android-debug.apk` when present; set `BLITZ_ANDROID_APK_PATH` to serve a different local build.

## Checks and implementation

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Run native checks from `mobile/`. The [product brief](PRODUCT_BRIEF.md) records the intended experience; the [working protocol](WORKING_PROTOCOL.md) records the overnight review and delivery boundaries. Implementation details are in [source preparation](docs/source-preparation.md), [learning API](docs/learning-api.md), and [card chat](docs/card-chat.md).

This version is a personal local app without account authentication. It is not configured for public hosting. Android offline storage and the local agent are separate from any future cloud sync service. Creating proposed notes, richer diagrams, and moving topics are still outside this version. Android now includes native project browsing, creation, rename, and deletion. Written activities and source imports still use the browser. The product brief records the wider direction, not a completed feature checklist.
