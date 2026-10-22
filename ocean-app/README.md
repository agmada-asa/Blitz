# Blitz in Ocean

Blitz's mini app for Ocean, a phone and desktop assistant. It shows Today, the Library, each module's units and Review on the phone or Mac, without opening the web app. Ocean is a separate, optional host; Blitz also runs on its own in a browser or its desktop shell.

`ocean.plugin.json` at the repository root makes the repository an Ocean plug-in. Ocean then:

- runs `mcp/server.mjs` with `BLITZ_OCEAN=1` and gives its tools to Ocean's agents, so material they add is attributed and logged
- shows the Today widget from the `ocean://widgets/today` resource (`mcp/ocean.mjs`)
- opens this app, built into `ocean-app/dist`, in a WebView on the phone or an iframe on the Mac

The app reaches nothing directly. Every read and answer is a call to one of the server's tools through Ocean's bridge (`src/bridge.ts`, the MCP Apps message format). The `app_*` tools are reserved for the user: agents keep the plain text tools and never answer review questions on the user's behalf.

## Screens

- **Today**: XP against the daily goal, the streak and the last seven days, the lesson to continue, and concepts due.
- **Library** and **module**: each module's progress; a module's units with what's been taught and practised. A unit opens its Teach session in Blitz in the browser (at the Mac's Tailscale address) or takes notes and links.
- **Review**: the same feed as `/review`, using Blitz's own `FeedCardView`. Blitz scores each answer, so it counts towards XP, the streak and review timing. "Ask in chat" starts an Ocean chat about the card.

Teach itself stays in the web app: it streams from the Next server and the learner's provider.

## Build

Ocean builds it when `ocean-app/src` is newer than the build. To build it yourself:

```sh
npm run build:ocean
```

The bundle reuses `components/` through the `@/` paths and compiles `app/globals.css`, so it looks like the web app. Mermaid is left out to keep it near 1 MB; a diagram in a card shows its source instead.

To install it in Ocean, link the repository into Ocean's plug-ins folder once:

```sh
ln -s ~/Documents/Blitz ~/.ocean/plugins/blitz
```
