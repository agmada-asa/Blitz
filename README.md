# Blitz

Blitz turns source material into a scrolling learning feed for Android and the web. A local Mac worker prepares explanations and questions through Codex App Server using your existing Codex sign-in.

## Run locally

Use Node.js 22.13 or newer, with Codex CLI installed and signed in. Development has been verified with Node.js 24 on macOS.

```bash
npm ci
npm run dev:lan
```

The launcher starts Next.js, local Convex, the preparation, card chat, and research workers. Open the printed LAN address on a phone connected to the same Wi-Fi. Keep the process running while using the web app. Pressing `Ctrl+C` stops every process group; a service that does not exit within three seconds is killed so it cannot retain a development port. Set `BLITZ_PORT` to change the web port from `3001`.

For separate terminals:

```bash
npx convex dev
npm run dev
npm run worker
npm run worker:chat
npm run worker:research
```

The workers load `.env.local`. `BLITZ_CONVEX_URL` can point them at a loopback address while `NEXT_PUBLIC_CONVEX_URL` points browser clients at the LAN address. No cloud deployment or API key is required for this local setup.

## Learn

Create a project in Library and add files, pasted notes, or a public link. Preparation runs in the background and can resume from a saved section. The home feed mixes projects; Filter narrows it to a project or topic.

Open a project or topic for a focused feed, Study with immediate feedback, or a Test with results at the end. Topics can be renamed or excluded from the mixed feed.

Choose `Study` then `Written answers` for a separate writing activity. Save a draft or compare your response with the prepared reference. Written activities resume where you left off and do not award an automatic score.

Questions use single choice, multiple answers, or true/false. Answers receive server-scored feedback. Reading and skipping never count as knowing a concept. `Ask in chat` attaches a card and its source section to your own question, and follow-ups reuse the conversation. Web and Android replies stream as they arrive, with Markdown formatting and saved history after reconnecting.

Imports accept text PDFs, Markdown, plain text, and PowerPoint `.pptx` files. Public links can return those formats or HTML. Source URLs and page/slide markers are retained. Scanned PDFs need OCR elsewhere, and each extracted source is currently limited to 120,000 characters.

Use `Find sources` within a project to ask Codex for a proposed learning scope and references discovered through web search. Review the links before selecting which to import. Imported sources join the same preparation queue. Proposed note outlines are previews only.

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
