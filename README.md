# Blitz

Blitz turns personal study material into a short vertical learning feed. This first prototype runs on a Mac, uses Codex CLI for generation, and stores projects and progress in a local Convex deployment.

## Run on Mac and phone

Requirements:

- Node.js 20 or newer
- Codex CLI installed and signed in
- Mac and phone connected to the same Wi-Fi network

Install dependencies once:

```bash
npm install
```

Start the web app and Convex together:

```bash
npm run dev:lan
```

The command prints two addresses. Open the `localhost` address on the Mac or the `192.168...` address on a phone. Keep the terminal running while using Blitz.

If port `3001` is occupied, choose another one:

```bash
BLITZ_PORT=3010 npm run dev:lan
```

## Current loop

1. Create a project.
2. Paste notes or upload a PDF, Markdown, or text file.
3. Wait for Codex CLI to create a summary and 10 learning cards.
4. Open the study feed.
5. Reveal answers, complete quizzes, and mark cards as `Again` or `Got it`.

Projects, sources, cards, and attempts persist in the local Convex database under `.convex/`.

## Supported source material

- Text PDFs with page references
- Markdown files
- Plain text files
- Pasted text

Scanned PDFs are not supported because this version has no OCR. Generation accepts up to 120,000 extracted characters per source.

## Useful checks

```bash
npm run typecheck
npm run lint
npm run build
```

## Prototype limits

- Single user with no authentication
- Local network use only
- No offline sync
- No RAG chat or vector search yet
- No editable notes or card regeneration
- No Electron or React Native client yet

The Next.js generation route starts a sandboxed, read-only, ephemeral `codex exec` process. Uploaded source text is passed through standard input and never interpolated into a shell command. Do not expose this development server to the public internet.
