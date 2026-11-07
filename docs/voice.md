# Local voice

Voice input and speech synthesis run on the host Mac. No cloud speech API or other application is required. Spoken questions use the same chat provider and saved history as typed questions. The configured reply provider receives the transcript and source context.

## Setup

Use an Apple silicon Mac with Python 3.10 through 3.13. Run:

```sh
sh scripts/setup-kokoro.sh
npm run dev:lan
```

The desktop app and LAN runner supervise the voice service automatically. If starting Next separately, also run `node --experimental-strip-types scripts/voice-service.ts` with the same `BLITZ_PORT`. The service binds only to loopback, using the app port plus 100: 3107 for the LAN runner, 3108 for the default desktop app. Set `BLITZ_VOICE_PORT` to change it.

The first microphone use downloads Whisper large-v3-turbo and warms it. Voice mode also downloads Silero VAD and Smart Turn v3.2. Speech uses MLX Kokoro on Apple silicon, with ONNX retained for older speech-only installations. Model downloads require a network connection; subsequent recognition and synthesis run locally. Initial startup can take several minutes. Cancel microphone or End voice releases a pending session.

Intel Macs and other operating systems do not currently have a Whisper backend. The rest of the app still works without installing speech dependencies.

## Phone access

Microphone capture needs HTTPS, or localhost on the Mac. With Tailscale installed and connected:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3007
tailscale serve --bg --https=8443 --set-path=/voice http://127.0.0.1:3107/voice
tailscale serve --bg --https=8443 --set-path=/convex http://127.0.0.1:3212
```

Open the Mac's tailnet HTTPS hostname on port 8443. This leaves other HTTPS ports alone. An HTTPS page cannot open plain `ws://` to local Convex, so it reaches Convex through `/convex` on its own origin; use the Convex port from `.convex/local/default/config.json` if it is not 3212. The voice service discovers this Mac's exact tailnet hostname and allows that origin. For another proxy, configure the exact comma-separated HTTPS origins in `BLITZ_VOICE_ORIGINS`, and proxy `/voice` to the loopback voice service and `/convex` to local Convex. Set `BLITZ_VOICE_HTTPS_PORT` if using a different tailnet port.

## Controls

- The composer microphone starts dictation. Words appear in the box about once a second while you talk; tap again to stop, then edit or send. Dictation never sends a message by itself.
- Read aloud is available while a reply is being written. Read replies aloud in chat Options or the Teach menu reads newly generated replies automatically. Stop reading stops playback. The microphone does not interrupt ordinary read aloud.
- Talk, beside the composer's microphone, starts a hands-free conversation in chat. A voice bar takes the composer's place: the bolt, in your accent colour, has a spark running round it that moves with your voice and with the reply and speeds up while Blitz thinks; the label says whether Blitz is listening, hearing you, thinking or speaking, and the caption shows your words as you say them, then the sentence being spoken. Finished turns send automatically. Talking over a reply stops it; the words you didn't hear are struck through, and the model is told privately how much you heard, so your message stays exactly what you said. Speaking again before a reply begins stops it and answers both messages together; the stopped reply shows as "Stopped". Mute prevents audio packets leaving the browser and discards a turn still being transcribed, so words spoken before muting are never sent. On a keyboard, Space mutes and Escape ends voice.
- Voice, in the Teach header, reads the lesson aloud as it is written. The lesson holds only lesson content: anything you say goes to the side chat, which opens with your question, and its answer is read aloud. The lesson then carries on from the sentence it was stopped at, while it keeps writing in the meantime. While the side chat shows, the voice bar sits under it; on a phone the side chat closes again when the lesson resumes, unless you had opened it yourself. The next button, N, or saying "next", "go on" or "continue" moves to the next section once the current one has finished writing.
- A hidden page ends the microphone session, including while models warm or the permission prompt is open, so the microphone never starts in a background tab. Stopping dictation before any audio arrives reports that nothing was heard. Voice mode requests a screen wake lock when the browser supports it. A failed or lost session offers Try again or Type instead; saved chat history remains available.

## Runtime

The browser streams echo-cancelled mono PCM16 at 16 kHz in 512-sample packets. Both modes use Silero and Smart Turn in a per-connection listening worker. While you speak, the current stretch of speech is transcribed about every 900 ms (one transcription at a time, at most the last 20 s) and sent as a `caption`. Dictation commits each finished stretch at a turn boundary, or after 25 s without a pause, and joins the stretches when you stop. Whisper starts speculatively at a pause; resumed speech invalidates that transcript. End-of-turn probability is 0.5, checked after 200 ms silence and every 400 ms afterwards, with a 1400 ms silence limit.

In voice mode, detected speech only turns the reply down. It stops once a caption or the finished turn holds real words, so a cough, a door or people talking nearby only dip it. A transcript of punctuation alone, or one of the phrases Whisper writes for noise when it stands alone ("Thank you.", "you", "Thanks for watching"), is dropped and listening carries on. A turn that is only an opener ("Okay.", "Um, so") waits a second for the rest of the thought and joins it; if nothing follows, it is sent alone. When words stopped a reply but no turn went out (they were dropped, the learner muted, or the turn failed to send), the reply carries on from the sentence it was stopped at, and a failed send shows in the bar for a few seconds. The listening worker stamps its events with the turn they belong to, so a detector event still on its way when a turn is taken can't open an empty one. A conversation turn longer than two minutes is taken as it stands rather than ending the session. A session closes after 30 minutes without microphone audio, for example when left muted, and the bar says so.

The browser posts recognized turns through the existing chat UI and route, with `spoken: true`. Teach keeps its selected model and lesson Markdown. Spoken chat uses Haiku on Claude Code, a runtime-discovered mini or Spark model on Codex when available, or the current provider's selection otherwise. `BLITZ_VOICE_MODEL` overrides the spoken chat model on the same provider. No extra provider account is required.

Growing replies pass through Markdown-safe piece boundaries into the existing priority speech queue and Web Audio player. Unread metadata can change as a lesson streams; changing already consumed text stops playback. Every piece is a whole sentence or block, the first included, because a cut mid-sentence makes the voice restart its intonation. A sentence over 360 characters is split at its clearest break: a semicolon, colon or dash, then a comma, and a word boundary only as a last resort. Code and other nonspoken blocks stay silent. The player schedules at most two pieces ahead, trims synthesis edge silence, and highlights exact prose matches in browsers supporting CSS Custom Highlight. Maths spoken as words may not have a matching visual highlight. Interrupted conversations include an estimate of the words actually heard, based on piece playback position.

Next owns the shared Whisper and Kokoro processes, so dictation, voice mode and read aloud reuse the same loaded models within this app. The socket service owns only listening workers. This avoids a second synthesis queue or a second persistence path. Models unload after idle time; listening workers exit with their socket or parent process.

## Local logs and privacy

As requested, voice logging includes recognized words and reply text, plus detection, transcription, synthesis-request and playback timing records. Files are private to the OS user under the app data directory's `voice/turns.jsonl`. The default macOS location is `~/Library/Application Support/Blitz/voice/`. A 10 MiB log rotates to one previous file. Individual replies are bounded to keep socket messages small. Delete both files to clear diagnostics.

Raw recordings are kept in memory for at most one turn. Whisper receives a private temporary WAV, removed after inference even if the caller cancels. The audio cache for read aloud has its own existing size and age limits. Logs and cached audio are local data, separate from the saved chat history.

## Verification

Automated coverage checks structured Markdown boundaries, audio scheduling and cancellation, resuming a stopped reply, worker parent death, and supervision of the voice service. `tests/voice-lifecycle.test.ts` covers hidden-page startup, muting during transcription and empty dictation; `tests/voice-turn-taking.test.ts` covers dropped noise, held openers and interrupting only on words. Synthetic speech has been exercised through MLX Kokoro, Silero, Smart Turn and Whisper, and through browser dictation without sending a chat. Physical phone microphone quality, echo cancellation in a room, and perceived interruption latency require listening on the target device; synthetic tests do not establish those results.
