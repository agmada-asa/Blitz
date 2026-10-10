/**
 * Converts subtitle transcripts (WebVTT and SRT) into readable paragraphs that
 * start with `[m:ss]` timestamps.
 *
 * Ingestion recognises those timestamps as source markers, so Teach and chat
 * citations can point at the moment in a lecture where an idea was said.
 */

/** A cue's start time in seconds and its cleaned text. */
type Cue = { start: number; text: string }

/** Cue timing line shared by WebVTT (`.`) and SRT (`,`) millisecond separators. */
const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/

/** Seconds of speech grouped into one paragraph before a sentence end allows a break. */
const PARAGRAPH_SECONDS = 30

/** Hard limit on one paragraph's duration even without a sentence end. */
const MAX_PARAGRAPH_SECONDS = 60

/** Returns whether text looks like a WebVTT or SRT subtitle file. */
export function isSubtitleTranscript(filename: string, text: string): boolean {
  if (/\.(vtt|srt)$/i.test(filename)) return true
  const head = text.replace(/^﻿/, "").trimStart()
  return head.startsWith("WEBVTT") || /^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)
}

/** Parses `hh:mm:ss.mmm` or `mm:ss,mmm` into whole seconds. */
function seconds(timestamp: string): number {
  const parts = timestamp.replace(",", ".").split(":").map(Number)
  return Math.floor(parts.reduce((total, part) => total * 60 + part, 0))
}

/** Formats seconds as `m:ss`, or `h:mm:ss` from one hour. */
export function formatTranscriptTime(total: number): string {
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = String(total % 60).padStart(2, "0")
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`
}

/** Removes voice, styling, and timestamp tags plus common HTML entities from cue text. */
function cleanCueText(text: string): string {
  return text
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Reads cues in order, skipping headers, notes, styles, and identifiers. */
function parseCues(raw: string): Cue[] {
  const cues: Cue[] = []
  const blocks = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split("\n")
    const timingIndex = lines.findIndex((line) => TIMING.test(line))
    if (timingIndex < 0) continue
    const timing = TIMING.exec(lines[timingIndex])!
    const text = cleanCueText(lines.slice(timingIndex + 1).join(" "))
    if (text) cues.push({ start: seconds(timing[1]), text })
  }
  return cues
}

/**
 * Drops text repeated from the previous cue. Auto-generated captions often
 * roll each line into the next cue, which would otherwise duplicate speech.
 */
function removeRollingOverlap(previous: string, current: string): string {
  if (!previous) return current
  if (previous === current || previous.endsWith(current)) return ""
  const words = current.split(" ")
  for (let take = Math.min(words.length - 1, 40); take > 0; take--) {
    const prefix = words.slice(0, take).join(" ")
    if (previous.endsWith(prefix)) return words.slice(take).join(" ")
  }
  return current
}

/**
 * Converts a subtitle file into timestamped paragraphs.
 *
 * Cues are joined into paragraphs of roughly 30 seconds that end at a sentence
 * boundary (never longer than a minute), each prefixed with its start time.
 *
 * @param raw Full WebVTT or SRT file text.
 * @returns Paragraphs separated by blank lines, or an empty string when no cue has text.
 */
export function subtitleToTranscript(raw: string): string {
  const paragraphs: string[] = []
  let current: string[] = []
  let currentStart = 0
  let previous = ""
  /** Emits the paragraph being built, if any. */
  const flush = () => {
    if (current.length)
      paragraphs.push(`[${formatTranscriptTime(currentStart)}] ${current.join(" ")}`)
    current = []
  }
  for (const cue of parseCues(raw)) {
    const text = removeRollingOverlap(previous, cue.text)
    previous = cue.text
    if (!text) continue
    // A cue far past the paragraph start opens a new paragraph rather than joining it.
    if (current.length && cue.start - currentStart >= MAX_PARAGRAPH_SECONDS) flush()
    if (!current.length) currentStart = cue.start
    current.push(text)
    if (cue.start - currentStart >= PARAGRAPH_SECONDS && /[.!?]["')\]]?$/.test(text))
      flush()
  }
  flush()
  return paragraphs.join("\n\n")
}
