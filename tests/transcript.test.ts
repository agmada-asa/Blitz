/** Verifies WebVTT and SRT transcripts become timestamped paragraphs that ingestion can cite. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  formatTranscriptTime,
  isSubtitleTranscript,
  subtitleToTranscript,
} from "../lib/transcript.ts"
import { detectSourceMarkers } from "../lib/server/source-ingestion/normalize.ts"

const vtt = `WEBVTT
Kind: captions

NOTE This comment is ignored

00:00:01.000 --> 00:00:04.000
<v Lecturer>Hi everyone, welcome to week one.

intro
00:00:04.000 --> 00:00:09.500
Today we look at <c.highlight>integer multiplication</c>.

00:00:31.000 --> 00:00:35.000
First, the schoolbook method.

00:01:40.000 --> 00:01:44.000
Then Karatsuba&amp;Ofman's trick.
`

test("detects subtitle files by extension or header", () => {
  assert.equal(isSubtitleTranscript("lecture.vtt", ""), true)
  assert.equal(isSubtitleTranscript("lecture.SRT", ""), true)
  assert.equal(isSubtitleTranscript("notes.txt", vtt), true)
  assert.equal(isSubtitleTranscript("notes.txt", "Hi everyone, welcome."), false)
})

test("groups WebVTT cues into timestamped paragraphs and strips tags", () => {
  assert.equal(
    subtitleToTranscript(vtt),
    [
      "[0:01] Hi everyone, welcome to week one. Today we look at integer multiplication. First, the schoolbook method.",
      "[1:40] Then Karatsuba&Ofman's trick.",
    ].join("\n\n")
  )
})

test("parses SRT timing with comma milliseconds", () => {
  const srt = "1\n00:00:02,500 --> 00:00:05,000\nHello.\n\n2\n01:02:03,000 --> 01:02:06,000\nLater.\n"
  assert.equal(subtitleToTranscript(srt), "[0:02] Hello.\n\n[1:02:03] Later.")
})

test("removes rolling caption overlap", () => {
  const rolling = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "the cost of",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "the cost of multiplying two numbers",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "multiplying two numbers",
  ].join("\n")
  assert.equal(subtitleToTranscript(rolling), "[0:00] the cost of multiplying two numbers")
})

test("formats hours when needed", () => {
  assert.equal(formatTranscriptTime(5), "0:05")
  assert.equal(formatTranscriptTime(754), "12:34")
  assert.equal(formatTranscriptTime(3723), "1:02:03")
})

test("produces markers that ingestion records as time references", () => {
  const markers = detectSourceMarkers(subtitleToTranscript(vtt))
  assert.deepEqual(
    markers.map((marker) => [marker.kind, marker.value]),
    [
      ["time", "0:01"],
      ["time", "1:40"],
    ]
  )
})
