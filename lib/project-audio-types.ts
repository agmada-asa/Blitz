/** Defines the public audio metadata shared by server routes and listening UI. */

/** Kind of generated recording stored for a project. */
export type ProjectAudioKind = "audiobook" | "podcast"
/** Persisted job state shown while audio is created. */
export type ProjectAudioStatus =
  "queued" | "generating" | "completed" | "failed"
/** Stage reported during a long local generation job. */
export type ProjectAudioStage =
  "preparing" | "adapting" | "writing" | "recording" | "finishing"

/** Public metadata for one locally stored project recording. */
export type ProjectAudioItem = {
  id: string
  kind: ProjectAudioKind
  title: string
  status: ProjectAudioStatus
  createdAt: number
  durationMinutes?: number
  error?: string
  audioUrl?: string
  sourceId?: string
  stage?: ProjectAudioStage
  completedChunks?: number
  totalChunks?: number
}

/** A readable passage timed within measured WAV sections for follow-along playback. */
export type ProjectAudioSegment = {
  index: number
  startSeconds: number
  endSeconds: number
  text: string
  /** Exact speech spelling for new recordings; absent on older transcripts. */
  spokenText?: string
  speaker: "narrator" | "host1" | "host2"
}

/** Transcript consumed by the listening room and selected-passage chat. */
export type ProjectAudioTranscript = {
  title: string
  kind: ProjectAudioKind
  durationSeconds: number
  segments: ProjectAudioSegment[]
}
